import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

// CWD .env is untrusted project state. These redirects replace the trusted
// bundled plugin/hook roots and are loaded as in-process code.
const UNTRUSTED_CWD_DOTENV_KEYS = [
  "OPENCLAW_BUNDLED_HOOKS_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
] as const;

function snapshotEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function dropCwdIntroducedEnv(before: Map<string, string | undefined>) {
  for (const [key, previous] of before) {
    if (previous !== undefined) {
      continue;
    }
    if (process.env[key] !== undefined) {
      delete process.env[key];
    }
  }
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default). Ignore keys that would
  // retarget trusted bundled code; a pre-set shell value is preserved.
  const cwdProtected = snapshotEnv(UNTRUSTED_CWD_DOTENV_KEYS);
  dotenv.config({ quiet });
  dropCwdIntroducedEnv(cwdProtected);

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
