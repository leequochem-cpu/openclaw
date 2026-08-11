import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";

function createChannelReloadPlan(channels: ChannelKind[]): GatewayReloadPlan {
  return {
    changedPaths: channels.map((channel) => `channels.${channel}`),
    restartGateway: false,
    restartReasons: [],
    hotReasons: channels.map((channel) => `channels.${channel}`),
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    restartChannels: new Set(channels),
    noopPaths: [],
  };
}

describe("gateway channel hot reload handlers", () => {
  async function withChannelReloadsEnabled(run: () => Promise<void>) {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    try {
      await run();
    } finally {
      if (previousSkipChannels === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNELS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
      }
      if (previousSkipProviders === undefined) {
        delete process.env.OPENCLAW_SKIP_PROVIDERS;
      } else {
        process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
      }
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues restarting later channels after a hot-reload start failure", async () => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      if (channel === "telegram") {
        throw new Error("start failed");
      }
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
        } as never,
        browserControl: null,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () =>
        ({
          stop: vi.fn(),
        }) as never,
    });

    await withChannelReloadsEnabled(async () => {
      await expect(
        applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
      ).rejects.toThrow("failed to restart channels during hot reload: telegram");
    });

    expect(events).toEqual(["stop:telegram", "start:telegram", "stop:discord", "start:discord"]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to restart telegram channel during hot reload: start failed",
    );
    expect(setState).not.toHaveBeenCalled();
  });
});
