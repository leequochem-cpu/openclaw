import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => "/custom/bin:/opt/bin"),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
  };
});

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

const { createExecTool } = await import("./bash-tools.exec.js");
const { getShellPathFromLoginShell } = await import("../infra/shell-env.js");

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

const normalizePathEntries = (value?: string) =>
  normalizeText(value)
    .split(/[:\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

describe("exec PATH login shell merge", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "SHELL"]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("merges login-shell PATH for host=gateway", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = vi.mocked(getShellPathFromLoginShell);
    shellPathMock.mockClear();
    shellPathMock.mockReturnValue("/custom/bin:/opt/bin");

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call1", { command: "echo $PATH" });
    const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

    expect(entries).toEqual(["/custom/bin", "/opt/bin", "/usr/bin"]);
    expect(shellPathMock).toHaveBeenCalledTimes(1);
  });

  it("sets OPENCLAW_SHELL for host=gateway commands", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-openclaw-shell", {
      command: 'printf "%s" "${OPENCLAW_SHELL:-}"',
    });
    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(value).toBe("exec");
  });

  it("throws security violation when env.PATH is provided", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = vi.mocked(getShellPathFromLoginShell);
    shellPathMock.mockClear();

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo $PATH",
        env: { PATH: "/explicit/bin" },
      }),
    ).rejects.toThrow(/Security Violation: Custom 'PATH' variable is forbidden/);

    expect(shellPathMock).not.toHaveBeenCalled();
  });

  it("does not apply login-shell PATH when probe rejects unregistered absolute SHELL", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";
    const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-env-"));
    const unregisteredShellPath = path.join(shellDir, "unregistered-shell");
    fs.writeFileSync(unregisteredShellPath, '#!/bin/sh\nexec /bin/sh "$@"\n', {
      encoding: "utf8",
      mode: 0o755,
    });
    process.env.SHELL = unregisteredShellPath;

    try {
      const shellPathMock = vi.mocked(getShellPathFromLoginShell);
      shellPathMock.mockClear();
      shellPathMock.mockImplementation((opts) =>
        opts.env.SHELL?.trim() === unregisteredShellPath ? null : "/custom/bin:/opt/bin",
      );

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call1", { command: "echo $PATH" });
      const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

      expect(entries).toEqual(["/usr/bin"]);
      expect(shellPathMock).toHaveBeenCalledTimes(1);
      expect(shellPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          env: process.env,
          timeoutMs: 1234,
        }),
      );
    } finally {
      fs.rmSync(shellDir, { recursive: true, force: true });
    }
  });
});

describe("exec host env validation", () => {
  it("blocks LD_/DYLD_ env vars on host execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
        env: { LD_DEBUG: "1" },
      }),
    ).rejects.toThrow(/Security Violation: Environment variable 'LD_DEBUG' is forbidden/);
  });

  it("blocks package-manager and tool-config redirects on host execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call-phprc", {
        command: "echo ok",
        env: { PHPRC: "/tmp/evil-php.ini" },
      }),
    ).rejects.toThrow(/Security Violation: Environment variable 'PHPRC' is forbidden/);

    await expect(
      tool.execute("call-npm", {
        command: "echo ok",
        env: { NPM_CONFIG_REGISTRY: "https://evil.example/registry" },
      }),
    ).rejects.toThrow(
      /Security Violation: Environment variable 'NPM_CONFIG_REGISTRY' is forbidden/,
    );
  });

  it("does not run git fsmonitor from a request XDG_CONFIG_HOME", async () => {
    if (isWin) {
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-xdg-exec-"));
    const repo = path.join(root, "repo");
    const xdg = path.join(root, "xdg");
    const marker = path.join(root, "pwned");
    const fsmonitor = path.join(root, "fsmonitor");
    fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README"), "hi\n");
    fs.writeFileSync(
      fsmonitor,
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nprintf '0\\n'\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(xdg, "git", "config"),
      `[core]\n\tfsmonitor = ${fsmonitor}\n`,
      "utf8",
    );
    try {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-xdg", {
          command: "git status --short",
          workdir: repo,
          env: { XDG_CONFIG_HOME: xdg },
        }),
      ).rejects.toThrow(/Security Violation: Environment variable 'XDG_CONFIG_HOME' is forbidden/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips dangerous inherited env vars from host execution", async () => {
    if (isWin) {
      return;
    }
    const original = process.env.SSLKEYLOGFILE;
    process.env.SSLKEYLOGFILE = "/tmp/openclaw-ssl-keys.log";
    try {
      const { createExecTool } = await import("./bash-tools.exec.js");
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call1", {
        command: "printf '%s' \"${SSLKEYLOGFILE:-}\"",
      });
      const output = normalizeText(result.content.find((c) => c.type === "text")?.text);
      expect(output).not.toContain("/tmp/openclaw-ssl-keys.log");
    } finally {
      if (original === undefined) {
        delete process.env.SSLKEYLOGFILE;
      } else {
        process.env.SSLKEYLOGFILE = original;
      }
    }
  });

  it("defaults to sandbox when sandbox runtime is unavailable", async () => {
    const tool = createExecTool({ security: "full", ask: "off" });

    const result = await tool.execute("call1", {
      command: "echo ok",
    });
    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(text).toContain("ok");

    const err = await tool
      .execute("call2", {
        command: "echo ok",
        host: "gateway",
      })
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/exec host not allowed/);
    expect(err?.message).toMatch(/tools\.exec\.host=sandbox/);
  });

  it("fails closed when sandbox host is explicitly configured without sandbox runtime", async () => {
    const tool = createExecTool({ host: "sandbox", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
      }),
    ).rejects.toThrow(/sandbox runtime is unavailable/);
  });
});
