import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPinnedWritePlan, SANDBOX_PINNED_WRITE_PYTHON } from "./fs-bridge-write-helper.js";

async function withTempRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runPinnedWrite(params: {
  mountRoot: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  input: Buffer | string;
}) {
  const plan = buildPinnedWritePlan({
    check: {
      target: {
        hostPath: params.mountRoot,
        relativePath: params.basename,
        containerPath: "/workspace",
        writable: true,
      },
      options: { action: "write files", requireWritable: true },
    },
    pinned: {
      mountRootPath: params.mountRoot,
      relativeParentPath: params.relativeParentPath,
      basename: params.basename,
    },
    mkdir: params.mkdir,
  });
  return spawnSync("sh", ["-c", plan.script, "moltbot-sandbox-fs", ...(plan.args ?? [])], {
    input: params.input,
  });
}

describe("sandbox pinned write helper", () => {
  it("keeps the file payload on stdin instead of the python program stream", () => {
    expect(SANDBOX_PINNED_WRITE_PYTHON).toContain("sys.stdin.buffer.read");
    const plan = buildPinnedWritePlan({
      check: {
        target: {
          hostPath: "/tmp/workspace",
          relativePath: "note.txt",
          containerPath: "/workspace/note.txt",
          writable: true,
        },
        options: { action: "write files", requireWritable: true },
      },
      pinned: {
        mountRootPath: "/workspace",
        relativeParentPath: "",
        basename: "note.txt",
      },
      mkdir: false,
    });
    expect(plan.script).toContain("python3 -c \"$(cat <<'PY'");
    expect(plan.script.trimEnd().endsWith(')" "$@"')).toBe(true);
    expect(plan.script).not.toContain("python3 - \"$@\" <<'PY'");
  });

  it("creates missing parents and writes the stdin payload through a pinned directory fd", async () => {
    await withTempRoot("openclaw-write-helper-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      const result = runPinnedWrite({
        mountRoot: workspace,
        relativeParentPath: "nested/deeper",
        basename: "note.txt",
        mkdir: true,
        input: "hello",
      });

      expect(result.status, result.stderr.toString("utf8")).toBe(0);
      await expect(
        fs.readFile(path.join(workspace, "nested", "deeper", "note.txt"), "utf8"),
      ).resolves.toBe("hello");
    });
  });

  it("preserves binary stdin bytes", async () => {
    await withTempRoot("openclaw-write-helper-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const payload = Buffer.from([0, 1, 2, 255, 10, 13]);

      const result = runPinnedWrite({
        mountRoot: workspace,
        relativeParentPath: "",
        basename: "blob.bin",
        mkdir: false,
        input: payload,
      });

      expect(result.status, result.stderr.toString("utf8")).toBe(0);
      await expect(fs.readFile(path.join(workspace, "blob.bin"))).resolves.toEqual(payload);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-parent writes instead of materializing a temp file outside the mount",
    async () => {
      await withTempRoot("openclaw-write-helper-", async (root) => {
        const workspace = path.join(root, "workspace");
        const outside = path.join(root, "outside");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(workspace, "alias"));

        const result = runPinnedWrite({
          mountRoot: workspace,
          relativeParentPath: "alias",
          basename: "escape.txt",
          mkdir: false,
          input: "owned",
        });

        expect(result.status).not.toBe(0);
        await expect(fs.readFile(path.join(outside, "escape.txt"))).rejects.toThrow();
        const outsideEntries = await fs.readdir(outside);
        expect(outsideEntries.filter((entry) => entry.startsWith(".openclaw-write-"))).toEqual([]);
      });
    },
  );
});
