import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeWithFollowup } from "./agent-runner-helpers.js";
import {
  clearFollowupDrainCallback,
  clearFollowupQueue,
  enqueueFollowupRun,
  kickFollowupDrainIfIdle,
} from "./queue.js";
import type { FollowupRun } from "./queue/types.js";

function createRun(prompt: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    run: {
      sessionId: "sid",
      sessionKey: "main",
      agentId: "main",
      provider: "test",
      model: "test",
      config: {} as FollowupRun["run"]["config"],
      workspaceDir: "/tmp",
      messageProvider: "test",
    },
  };
}

describe("finalizeWithFollowup drain deferral", () => {
  const keys: string[] = [];

  function freshKey(label: string): string {
    const key = `hb-defer-${label}-${Date.now()}-${keys.length}`;
    keys.push(key);
    return key;
  }

  afterEach(() => {
    for (const key of keys.splice(0, keys.length)) {
      clearFollowupQueue(key);
      clearFollowupDrainCallback(key);
    }
  });

  it("defers followup drain until kickFollowupDrainIfIdle", async () => {
    const key = freshKey("defer");
    const runFollowup = vi.fn(async () => {});
    enqueueFollowupRun(key, createRun("queued while heartbeat active"), {
      mode: "followup",
      debounceMs: 0,
      cap: 20,
    });

    finalizeWithFollowup("ok", key, runFollowup, { deferDrain: true });
    expect(runFollowup).not.toHaveBeenCalled();

    kickFollowupDrainIfIdle(key);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });
  });

  it("starts drain immediately when deferDrain is unset", async () => {
    const key = freshKey("immediate");
    const runFollowup = vi.fn(async () => {});
    enqueueFollowupRun(key, createRun("normal turn"), {
      mode: "followup",
      debounceMs: 0,
      cap: 20,
    });

    finalizeWithFollowup("ok", key, runFollowup);
    await vi.waitFor(() => {
      expect(runFollowup).toHaveBeenCalledTimes(1);
    });
  });
});
