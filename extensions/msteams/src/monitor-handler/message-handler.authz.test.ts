import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { describe, expect, it, vi } from "vitest";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

function installPassthroughRuntime(params?: { readAllowFromStore?: () => Promise<string[]> }) {
  const readAllowFromStore = vi.fn(params?.readAllowFromStore ?? (async () => []));
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void>;
        }): { enqueue: (entry: T) => Promise<void> } => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  } as unknown as PluginRuntime);
  return { readAllowFromStore };
}

function createHandlerDeps(cfg: OpenClawConfig) {
  const conversationStore = {
    upsert: vi.fn(async () => undefined),
  };
  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const deps: MSTeamsMessageHandlerDeps = {
    cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore:
      conversationStore as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: log as unknown as MSTeamsMessageHandlerDeps["log"],
  };
  return { deps, conversationStore, log };
}

describe("msteams monitor handler authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const { readAllowFromStore } = installPassthroughRuntime({
      readAllowFromStore: async () => ["attacker-aad"],
    });
    const { deps, conversationStore } = createHandlerDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default",
    });
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  it("does not treat a matched team/channel route allowlist as wildcard sender access", async () => {
    installPassthroughRuntime();
    const { deps, conversationStore, log } = createHandlerDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          teams: {
            "team-1": {},
          },
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-2",
        type: "message",
        text: "hello from a channel member",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:channel@thread.tacv2",
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-1", name: "Engineering" },
          channel: { id: "19:channel@thread.tacv2", name: "general" },
        },
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "dropping group message (groupPolicy: allowlist, no allowlist)",
      expect.objectContaining({ conversationId: "19:channel@thread.tacv2" }),
    );
  });
});
