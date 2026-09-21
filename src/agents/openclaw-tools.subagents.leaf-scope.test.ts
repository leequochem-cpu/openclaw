import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import "./test-helpers/fast-core-tools.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

const MAIN_KEY = "agent:main:main";
const LEAF_A = "agent:main:subagent:leaf-a";
const LEAF_B = "agent:main:subagent:leaf-b";
const ORCH = "agent:main:subagent:orch";
const ORCH_CHILD = "agent:main:subagent:orch:subagent:child";

function writeSessionStore(
  storePath: string,
  entries: Record<string, { sessionId: string; spawnDepth: number; spawnedBy: string }>,
) {
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf-8");
}

function addRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
}) {
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: params.requesterSessionKey,
    task: params.label,
    label: params.label,
    cleanup: "keep",
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
}

describe("openclaw-tools: leaf subagents cannot control siblings", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ runId: "run-steered" });
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-leaf-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    writeSessionStore(storePath, {
      [LEAF_A]: { sessionId: "sess-a", spawnDepth: 1, spawnedBy: MAIN_KEY },
      [LEAF_B]: { sessionId: "sess-b", spawnDepth: 1, spawnedBy: MAIN_KEY },
    });
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
      agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
    });
  });

  it("does not list sibling runs for a leaf caller", async () => {
    addRun({
      runId: "run-a",
      childSessionKey: LEAF_A,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-a",
    });
    addRun({
      runId: "run-b",
      childSessionKey: LEAF_B,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-b",
    });

    const tool = createSubagentsTool({ agentSessionKey: LEAF_A });
    const result = await tool.execute("call-list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      action: "list",
      callerSessionKey: LEAF_A,
      requesterSessionKey: LEAF_A,
      total: 0,
    });
    expect(listSubagentRunsForRequester(MAIN_KEY)).toHaveLength(2);
  });

  it("rejects steer of a sibling session even when targeted by key", async () => {
    addRun({
      runId: "run-a",
      childSessionKey: LEAF_A,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-a",
    });
    addRun({
      runId: "run-b",
      childSessionKey: LEAF_B,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-b",
    });

    const tool = createSubagentsTool({ agentSessionKey: LEAF_A });
    const result = await tool.execute("call-steer", {
      action: "steer",
      target: LEAF_B,
      message: "run with broader tools",
    });

    expect(result.details).toMatchObject({
      status: "error",
      action: "steer",
      target: LEAF_B,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not kill sibling runs via kill all", async () => {
    addRun({
      runId: "run-a",
      childSessionKey: LEAF_A,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-a",
    });
    addRun({
      runId: "run-b",
      childSessionKey: LEAF_B,
      requesterSessionKey: MAIN_KEY,
      label: "leaf-b",
    });

    const tool = createSubagentsTool({ agentSessionKey: LEAF_A });
    const result = await tool.execute("call-kill-all", { action: "kill", target: "all" });

    expect(result.details).toMatchObject({
      status: "ok",
      action: "kill",
      target: "all",
      killed: 0,
    });
    const remaining = listSubagentRunsForRequester(MAIN_KEY);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((entry) => !entry.endedAt)).toBe(true);
  });
});

describe("openclaw-tools: orchestrator subagents still control descendants", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "agent") {
        return { runId: "run-child-steered" };
      }
      return {};
    });
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-orch-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    writeSessionStore(storePath, {
      [ORCH]: { sessionId: "sess-orch", spawnDepth: 1, spawnedBy: MAIN_KEY },
      [ORCH_CHILD]: { sessionId: "sess-child", spawnDepth: 2, spawnedBy: ORCH },
    });
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
    });
  });

  it("lets an orchestrator steer a child it spawned", async () => {
    addRun({
      runId: "run-child",
      childSessionKey: ORCH_CHILD,
      requesterSessionKey: ORCH,
      label: "child",
    });

    const tool = createSubagentsTool({ agentSessionKey: ORCH });
    const result = await tool.execute("call-steer-child", {
      action: "steer",
      target: ORCH_CHILD,
      message: "continue the task",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      action: "steer",
      sessionKey: ORCH_CHILD,
      runId: "run-child-steered",
    });
    expect(callGatewayMock).toHaveBeenCalled();
  });
});
