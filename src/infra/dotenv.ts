import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

// A cloned project can drop a `.env` in the working directory. These keys are
// read after that file is merged with the trusted state-directory `.env`:
// gateway URL overrides are dialed with whatever token is already in the
// environment, and browser executable overrides are spawned by the diffs renderer.
const BLOCKED_CWD_DOTENV_KEYS = new Set([
  "BROWSER_EXECUTABLE_PATH",
  "CLAWDBOT_GATEWAY_URL",
  "OPENCLAW_BROWSER_EXECUTABLE_PATH",
  "OPENCLAW_GATEWAY_URL",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
]);

function loadUntrustedCwdDotEnv(quiet: boolean) {
  const blockedBefore = new Map<string, string | undefined>();
  for (const key of BLOCKED_CWD_DOTENV_KEYS) {
    blockedBefore.set(key, process.env[key]);
  }

  // Same loader as before, including vault decryption. Drop only the blocked
  // keys this call introduces so a project file cannot override them.
  dotenv.config({ quiet });

  for (const [key, previous] of blockedBefore) {
    if (previous === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = previous;
  }
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first, dropping keys that redirect trusted credentials
  // or replace executed browser binaries. Other project keys still load.
  loadUntrustedCwdDotEnv(quiet);

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present. This file is operator-owned
  // and may still set gateway URL and browser executable overrides.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
