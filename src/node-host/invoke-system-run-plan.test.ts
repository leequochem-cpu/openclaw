import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatExecCommand } from "../infra/system-run-command.js";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
  revalidateApprovedMutableFileOperand,
} from "./invoke-system-run-plan.js";

type PathTokenSetup = {
  expected: string;
};

type HardeningCase = {
  name: string;
  mode: "build-plan" | "harden";
  argv: string[];
  shellCommand?: string | null;
  withPathToken?: boolean;
  expectedArgv: (ctx: { pathToken: PathTokenSetup | null }) => string[];
  expectedArgvChanged?: boolean;
  expectedCmdText?: string;
  checkRawCommandMatchesArgv?: boolean;
};

function createScriptOperandFixture(tmp: string): {
  command: string[];
  scriptPath: string;
  initialBody: string;
} {
  if (process.platform === "win32") {
    const scriptPath = path.join(tmp, "run.js");
    return {
      command: [process.execPath, "./run.js"],
      scriptPath,
      initialBody: 'console.log("SAFE");\n',
    };
  }
  const scriptPath = path.join(tmp, "run.sh");
  return {
    command: ["/bin/sh", "./run.sh"],
    scriptPath,
    initialBody: "#!/bin/sh\necho SAFE\n",
  };
}

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      name: "preserves shell-wrapper argv during approval hardening",
      mode: "build-plan",
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: "echo SAFE",
    },
    {
      name: "preserves dispatch-wrapper argv during approval hardening",
      mode: "harden",
      argv: ["env", "tr", "a", "b"],
      shellCommand: null,
      expectedArgv: () => ["env", "tr", "a", "b"],
      expectedArgvChanged: false,
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "SAFE"],
      expectedArgvChanged: true,
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: () => ["env", "poccmd", "SAFE"],
      expectedArgvChanged: false,
    },
    {
      name: "rawCommand matches hardened argv after executable path pinning",
      mode: "build-plan",
      argv: ["poccmd", "hello"],
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "hello"],
      checkRawCommandMatchesArgv: true,
    },
  ];

  for (const testCase of cases) {
    it.runIf(process.platform !== "win32")(testCase.name, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-hardening-"));
      const oldPath = process.env.PATH;
      let pathToken: PathTokenSetup | null = null;
      if (testCase.withPathToken) {
        const binDir = path.join(tmp, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const link = path.join(binDir, "poccmd");
        fs.symlinkSync("/bin/echo", link);
        pathToken = { expected: fs.realpathSync(link) };
        process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      }
      try {
        if (testCase.mode === "build-plan") {
          const prepared = buildSystemRunApprovalPlan({
            command: testCase.argv,
            cwd: tmp,
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("unreachable");
          }
          expect(prepared.plan.argv).toEqual(testCase.expectedArgv({ pathToken }));
          if (testCase.expectedCmdText) {
            expect(prepared.cmdText).toBe(testCase.expectedCmdText);
          }
          if (testCase.checkRawCommandMatchesArgv) {
            expect(prepared.plan.rawCommand).toBe(formatExecCommand(prepared.plan.argv));
          }
          return;
        }

        const hardened = hardenApprovedExecutionPaths({
          approvedByAsk: true,
          argv: testCase.argv,
          shellCommand: testCase.shellCommand ?? null,
          cwd: tmp,
        });
        expect(hardened.ok).toBe(true);
        if (!hardened.ok) {
          throw new Error("unreachable");
        }
        expect(hardened.argv).toEqual(testCase.expectedArgv({ pathToken }));
        if (typeof testCase.expectedArgvChanged === "boolean") {
          expect(hardened.argvChanged).toBe(testCase.expectedArgvChanged);
        }
      } finally {
        if (testCase.withPathToken) {
          if (oldPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = oldPath;
          }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("captures mutable shell script operands in approval plans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-script-plan-"));
    const fixture = createScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: fixture.command,
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      expect(prepared.plan.mutableFileOperand).toEqual({
        argvIndex: 1,
        path: fs.realpathSync(fixture.scriptPath),
        sha256: expect.any(String),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function withRunnerPath<T>(tmp: string, names: string[], run: () => T): T {
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of names) {
      const runnerPath = path.join(binDir, name);
      fs.writeFileSync(runnerPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(runnerPath, 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return run();
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  }

  it.runIf(process.platform !== "win32").each(["tsx", "jiti"])(
    "binds %s script files so later rewrites fail approval revalidation",
    (runner) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-runner-"));
      const scriptPath = path.join(tmp, "run.ts");
      fs.writeFileSync(scriptPath, "console.log('SAFE')\n");
      try {
        withRunnerPath(tmp, [runner], () => {
          const prepared = buildSystemRunApprovalPlan({
            command: [runner, "./run.ts"],
            cwd: tmp,
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error(prepared.message);
          }
          const operand = prepared.plan.mutableFileOperand;
          expect(operand).toEqual({
            argvIndex: 1,
            path: fs.realpathSync(scriptPath),
            sha256: expect.any(String),
          });
          if (!operand) {
            throw new Error("missing mutable file operand");
          }
          fs.writeFileSync(scriptPath, "console.log('PWNED')\n");
          expect(
            revalidateApprovedMutableFileOperand({
              snapshot: operand,
              argv: prepared.plan.argv,
              cwd: tmp,
            }),
          ).toBe(false);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("binds a bun script after its subcommand", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-bun-"));
    const scriptPath = path.join(tmp, "run.ts");
    fs.writeFileSync(scriptPath, "console.log('SAFE')\n");
    try {
      withRunnerPath(tmp, ["bun"], () => {
        const prepared = buildSystemRunApprovalPlan({
          command: ["bun", "run", "./run.ts"],
          cwd: tmp,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error(prepared.message);
        }
        expect(prepared.plan.mutableFileOperand).toMatchObject({
          argvIndex: 2,
          path: fs.realpathSync(scriptPath),
        });
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses interpreter approvals that do not pin exactly one script file",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-unbound-"));
      const hookPath = path.join(tmp, "hook.js");
      const scriptPath = path.join(tmp, "script.js");
      fs.writeFileSync(hookPath, "console.log('hook')\n");
      fs.writeFileSync(scriptPath, "console.log('script')\n");
      try {
        withRunnerPath(tmp, ["python3", "node", "true"], () => {
          const inline = buildSystemRunApprovalPlan({
            command: ["python3", "-c", "print(1)"],
            cwd: tmp,
          });
          expect(inline.ok).toBe(false);
          if (inline.ok) {
            throw new Error("unreachable");
          }
          expect(inline.message).toBe(
            "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
          );

          const ambiguous = buildSystemRunApprovalPlan({
            command: ["node", "--require", "./hook.js", "./script.js"],
            cwd: tmp,
          });
          expect(ambiguous.ok).toBe(false);
          if (ambiguous.ok) {
            throw new Error("unreachable");
          }
          expect(ambiguous.message).toBe(
            "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
          );

          const ordinary = buildSystemRunApprovalPlan({
            command: ["true", "status"],
            cwd: tmp,
          });
          expect(ordinary.ok).toBe(true);
          if (!ordinary.ok) {
            throw new Error(ordinary.message);
          }
          expect(ordinary.plan.mutableFileOperand).toBeUndefined();
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
