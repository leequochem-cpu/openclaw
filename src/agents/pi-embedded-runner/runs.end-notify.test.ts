import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveEmbeddedRun,
  isEmbeddedPiRunActive,
  setActiveEmbeddedRun,
  waitForEmbeddedPiRunEnd,
  type EmbeddedPiQueueHandle,
} from "./runs.js";

const ACTIVE_HANDLES = new Map<string, EmbeddedPiQueueHandle>();

function createHandle(): EmbeddedPiQueueHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => false,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded run end notification ordering", () => {
  const sessionId = "sess-end-notify-order";

  afterEach(() => {
    const handle = ACTIVE_HANDLES.get(sessionId);
    if (handle) {
      clearActiveEmbeddedRun(sessionId, handle);
      ACTIVE_HANDLES.delete(sessionId);
    }
  });

  it("keeps waiters blocked until clearActiveEmbeddedRun after teardown work", async () => {
    const handle = createHandle();
    ACTIVE_HANDLES.set(sessionId, handle);
    setActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

    let waitResolved = false;
    const waitPromise = waitForEmbeddedPiRunEnd(sessionId, 5_000).then((ended) => {
      waitResolved = true;
      return ended;
    });

    // Simulate abort teardown that still owns the transcript (flush + lock release).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(waitResolved).toBe(false);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

    clearActiveEmbeddedRun(sessionId, handle);
    ACTIVE_HANDLES.delete(sessionId);
    await expect(waitPromise).resolves.toBe(true);
    expect(waitResolved).toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });
});
