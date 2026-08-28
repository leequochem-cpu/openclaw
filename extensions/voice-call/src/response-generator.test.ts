import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const loadCoreAgentDepsMock = vi.hoisted(() => vi.fn());

vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: loadCoreAgentDepsMock,
}));

import { generateVoiceResponse } from "./response-generator.js";

const STORE_PATH = "/tmp/openclaw-sessions.json";
const VOICE_SESSION_KEY = "voice:15551234567";
const MAIN_SESSION_KEY = "agent:main:main";

function createDeps(overrides?: Record<string, unknown>) {
  const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
    payloads: [{ text: "Hello from voice." }],
  });
  const loadSessionStore = vi.fn().mockReturnValue({});
  const saveSessionStore = vi.fn().mockResolvedValue(undefined);
  const updateSessionStore = vi.fn(
    async (_storePath: string, mutator: (store: Record<string, unknown>) => unknown) => mutator({}),
  );

  return {
    resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
    ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
    loadSessionStore,
    saveSessionStore,
    updateSessionStore,
    resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/sessions/voice.jsonl"),
    DEFAULT_PROVIDER: "openai",
    DEFAULT_MODEL: "gpt-4o-mini",
    resolveThinkingDefault: vi.fn().mockReturnValue("off"),
    resolveAgentIdentity: vi.fn().mockReturnValue({ name: "OpenClaw" }),
    resolveAgentTimeoutMs: vi.fn().mockReturnValue(30_000),
    runEmbeddedPiAgent,
    ...overrides,
  };
}

async function generateFirstCall(deps: ReturnType<typeof createDeps>) {
  loadCoreAgentDepsMock.mockResolvedValue(deps);
  return generateVoiceResponse({
    voiceConfig: createVoiceCallBaseConfig(),
    coreConfig: {},
    callId: "call-1",
    from: "+1 (555) 123-4567",
    transcript: [],
    userMessage: "Hi",
  });
}

describe("generateVoiceResponse session store", () => {
  beforeEach(() => {
    loadCoreAgentDepsMock.mockReset();
  });

  it("creates a missing voice session inside updateSessionStore without rewriting other keys", async () => {
    const diskStore: Record<string, unknown> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "main-sid",
        updatedAt: 1_700_000_000_000,
        lastChannel: "telegram",
        lastTo: "12345",
        modelOverride: "opus",
      },
    };
    const deps = createDeps({
      loadSessionStore: vi.fn().mockReturnValue({
        // Stale unlocked snapshot is missing concurrent main-session writes.
        [MAIN_SESSION_KEY]: {
          sessionId: "main-sid",
          updatedAt: 1_699_000_000_000,
        },
      }),
      updateSessionStore: vi.fn(
        async (_storePath: string, mutator: (store: Record<string, unknown>) => unknown) =>
          mutator(diskStore),
      ),
    });

    const result = await generateFirstCall(deps);

    expect(result.text).toBe("Hello from voice.");
    expect(deps.saveSessionStore).not.toHaveBeenCalled();
    expect(deps.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(deps.updateSessionStore).toHaveBeenCalledWith(STORE_PATH, expect.any(Function));
    expect(diskStore[MAIN_SESSION_KEY]).toEqual({
      sessionId: "main-sid",
      updatedAt: 1_700_000_000_000,
      lastChannel: "telegram",
      lastTo: "12345",
      modelOverride: "opus",
    });
    expect(diskStore[VOICE_SESSION_KEY]).toEqual(
      expect.objectContaining({
        sessionId: expect.any(String),
        updatedAt: expect.any(Number),
      }),
    );
    expect(deps.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: (diskStore[VOICE_SESSION_KEY] as { sessionId: string }).sessionId,
        sessionKey: VOICE_SESSION_KEY,
      }),
    );
  });

  it("reuses an existing voice session without writing the store", async () => {
    const deps = createDeps({
      loadSessionStore: vi.fn().mockReturnValue({
        [VOICE_SESSION_KEY]: {
          sessionId: "existing-voice-sid",
          updatedAt: 1_700_000_000_000,
        },
      }),
    });

    const result = await generateFirstCall(deps);

    expect(result.text).toBe("Hello from voice.");
    expect(deps.updateSessionStore).not.toHaveBeenCalled();
    expect(deps.saveSessionStore).not.toHaveBeenCalled();
    expect(deps.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "existing-voice-sid",
        sessionKey: VOICE_SESSION_KEY,
      }),
    );
  });

  it("reuses a voice session created between the unlocked load and locked update", async () => {
    const winner = {
      sessionId: "winner-sid",
      updatedAt: 42,
    };
    const deps = createDeps({
      loadSessionStore: vi.fn().mockReturnValue({}),
      updateSessionStore: vi.fn(
        async (_storePath: string, mutator: (store: Record<string, unknown>) => unknown) =>
          mutator({
            [VOICE_SESSION_KEY]: winner,
          }),
      ),
    });

    const result = await generateFirstCall(deps);

    expect(result.text).toBe("Hello from voice.");
    expect(deps.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(deps.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "winner-sid",
        sessionKey: VOICE_SESSION_KEY,
      }),
    );
  });
});
