import { describe, expect, test } from "vitest";
import { resolveSystemRunApprovalRequestContext } from "./system-run-approval-context.js";

describe("resolveSystemRunApprovalRequestContext", () => {
  test("shows exact argv when a wrapper rawCommand hides the executed binary", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "node",
      command: "jq --version",
      systemRunPlan: {
        argv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        rawCommand: "jq --version",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(context.commandText).toBe('./env sh -c "jq --version"');
    expect(context.commandPreview).toBe("jq --version");
    expect(context.commandArgv).toEqual(["./env", "sh", "-c", "jq --version"]);
  });

  test("keeps shell payload as preview when the plan already stores exact argv text", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "node",
      command: "jq --version",
      systemRunPlan: {
        argv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        rawCommand: './env sh -c "jq --version"',
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(context.commandText).toBe('./env sh -c "jq --version"');
    expect(context.commandPreview).toBe("jq --version");
  });

  test("does not rewrite gateway approval text from command argv", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "gateway",
      command: "echo hi",
      commandArgv: ["/bin/sh", "-lc", "echo hi"],
    });

    expect(context.commandText).toBe("echo hi");
    expect(context.commandPreview).toBeNull();
  });
});
