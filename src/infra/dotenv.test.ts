import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "./dotenv.js";

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const prevEnv = { ...process.env };
  const prevCwd = process.cwd();
  try {
    await run();
  } finally {
    process.chdir(prevCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
  const cwdDir = path.join(base, "cwd");
  const stateDir = path.join(base, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await run({ base, cwdDir, stateDir });
}

describe("loadDotEnv", () => {
  it("loads ~/.openclaw/.env as fallback without overriding CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-cwd");
        expect(process.env.BAR).toBe("1");
      });
    });
  });

  it("does not override an already-set env var from the shell", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        process.env.FOO = "from-shell";

        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
      });
    });
  });

  it("ignores gateway URL and browser executable overrides from the working directory", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "FOO=from-cwd",
            "OPENCLAW_GATEWAY_URL=wss://attacker.example/ws",
            "CLAWDBOT_GATEWAY_URL=wss://legacy-attacker.example/ws",
            "OPENCLAW_BROWSER_EXECUTABLE_PATH=./evil-browser",
            "BROWSER_EXECUTABLE_PATH=./evil-browser",
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=./evil-chromium",
          ].join("\n"),
        );
        await writeEnvFile(
          path.join(stateDir, ".env"),
          [
            "OPENCLAW_GATEWAY_TOKEN=trusted-token",
            "OPENCLAW_GATEWAY_URL=wss://gateway.example/ws",
            "OPENCLAW_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium",
          ].join("\n"),
        );

        process.chdir(cwdDir);
        delete process.env.FOO;
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        delete process.env.OPENCLAW_GATEWAY_URL;
        delete process.env.CLAWDBOT_GATEWAY_URL;
        delete process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH;
        delete process.env.BROWSER_EXECUTABLE_PATH;
        delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-cwd");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(process.env.OPENCLAW_GATEWAY_URL).toBe("wss://gateway.example/ws");
        expect(process.env.CLAWDBOT_GATEWAY_URL).toBeUndefined();
        expect(process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/chromium");
        expect(process.env.BROWSER_EXECUTABLE_PATH).toBeUndefined();
        expect(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).toBeUndefined();
      });
    });
  });

  it("keeps a shell gateway URL when the working directory tries to replace it", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        process.env.OPENCLAW_GATEWAY_URL = "wss://shell.example/ws";
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "OPENCLAW_GATEWAY_URL=wss://attacker.example/ws\n",
        );

        process.chdir(cwdDir);
        loadDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_GATEWAY_URL).toBe("wss://shell.example/ws");
      });
    });
  });

  it("loads fallback state .env when CWD .env is missing", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        process.chdir(cwdDir);
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });
});
