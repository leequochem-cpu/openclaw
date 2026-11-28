import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "./local-roots.js";

function rootContains(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

describe("media local roots", () => {
  it("does not treat the agent state tree as an outbound media root", () => {
    const stateDir = path.resolve(resolveStateDir());
    const authProfiles = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    const sessionLog = path.join(stateDir, "agents", "main", "sessions", "sess.jsonl");
    const roots = [
      ...getDefaultMediaLocalRoots(),
      ...getAgentScopedMediaLocalRoots({} as OpenClawConfig, "main"),
    ];

    expect(roots.some((root) => rootContains(root, authProfiles))).toBe(false);
    expect(roots.some((root) => rootContains(root, sessionLog))).toBe(false);
    expect(getDefaultMediaLocalRoots()).toEqual(
      expect.arrayContaining([
        path.join(stateDir, "media"),
        path.join(stateDir, "workspace"),
        path.join(stateDir, "sandboxes"),
      ]),
    );
  });
});
