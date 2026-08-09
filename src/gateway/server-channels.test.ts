import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
}): ChannelPlugin<TestAccount> {
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => account,
    isEnabled: (resolved) => resolved.enabled !== false,
  };
  if (includeDescribeAccount) {
    config.describeAccount = (resolved) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: resolved.enabled !== false,
      configured: resolved.configured !== false,
    });
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function installTestRegistry(plugin: ChannelPlugin<TestAccount>) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: plugin.id,
    source: "test",
    plugin,
  });
  setActivePluginRegistry(registry);
}

function createManager(options?: {
  channelRuntime?: PluginRuntime["channel"];
  loadConfig?: () => Record<string, unknown>;
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: options?.loadConfig ?? (() => ({})),
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
  });
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(10);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("reconciles restartPending when restart backoff rejects without a manual stop", async () => {
    // sleepWithAbort rejects when its abort races the backoff window. The old
    // empty catch left restartPending=true forever with no task and green /ready.
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    hoisted.sleepWithAbort.mockRejectedValueOnce(new Error("aborted"));

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(hoisted.sleepWithAbort).toHaveBeenCalled();
    expect(startAccount).toHaveBeenCalledTimes(1);
    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.restartPending).toBe(false);
    expect(account?.running).toBe(false);
    expect(account?.lastError).toBe("aborted");
  });

  it("does not bind auto-restart backoff to the dying run abort signal", async () => {
    const runSignals: AbortSignal[] = [];
    const startAccount = vi.fn(async (ctx: { abortSignal: AbortSignal }) => {
      runSignals.push(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.sleepWithAbort).toHaveBeenCalled();

    const sleepSignal = hoisted.sleepWithAbort.mock.calls.at(-1)?.[1];
    expect(runSignals[0]).toBeDefined();
    expect(sleepSignal).toBeDefined();
    expect(sleepSignal).not.toBe(runSignals[0]);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(2);
  });

  it("clears restartPending when startChannelInternal throws during restart", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    let loadCount = 0;
    const manager = createManager({
      loadConfig: () => {
        loadCount += 1;
        // First start succeeds; the post-backoff restart reloads config and throws once.
        if (loadCount === 2) {
          const err = new Error("Invalid config") as Error & { code?: string };
          err.code = "INVALID_CONFIG";
          throw err;
        }
        return {};
      },
    });

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(loadCount).toBeGreaterThanOrEqual(2);
    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.restartPending).toBe(false);
    expect(account?.running).toBe(false);
    expect(account?.lastError).toMatch(/Invalid config/);
  });

  it("clears running when startAccount throws synchronously", async () => {
    const startAccount = vi.fn(() => {
      throw new Error("sync start boom");
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toBe("sync start boom");
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("passes channelRuntime through channel gateway context when provided", async () => {
    const channelRuntime = { marker: "channel-runtime" } as unknown as PluginRuntime["channel"];
    const startAccount = vi.fn(async (ctx) => {
      expect(ctx.channelRuntime).toBe(channelRuntime);
    });

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledTimes(1);
  });
});
