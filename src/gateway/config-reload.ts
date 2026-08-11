import { isDeepStrictEqual } from "node:util";
import chokidar from "chokidar";
import type { OpenClawConfig, ConfigFileSnapshot, GatewayReloadMode } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { isPlainObject } from "../utils.js";
import { buildGatewayReloadPlan, type GatewayReloadPlan } from "./config-reload-plan.js";

export { buildGatewayReloadPlan };
export type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;
const HOT_RELOAD_FAILURE_RETRY_DELAY_MS = 1_000;
const HOT_RELOAD_FAILURE_MAX_RETRIES = 3;

export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

export function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}

export type GatewayConfigReloader = {
  stop: () => Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;
  let missingConfigRetries = 0;
  let hotReloadFailureRetries = 0;

  const scheduleAfter = (wait: number) => {
    if (stopped) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const queueRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    void (async () => {
      try {
        await opts.onRestart(plan, nextConfig);
      } catch (err) {
        // Restart checks can fail (for example unresolved SecretRefs). Keep the
        // reloader alive and allow a future change to retry restart scheduling.
        restartQueued = false;
        opts.log.error(`config restart failed: ${String(err)}`);
      }
    })();
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    return true;
  };

  const applySnapshot = async (nextConfig: OpenClawConfig) => {
    const changedPaths = diffConfigPaths(currentConfig, nextConfig);
    if (changedPaths.length === 0) {
      return;
    }

    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    const plan = buildGatewayReloadPlan(changedPaths);
    const nextSettings = resolveGatewayReloadSettings(nextConfig);
    if (nextSettings.mode === "off") {
      // Still adopt the snapshot so we do not re-evaluate identical diffs forever
      // while reload remains explicitly disabled.
      currentConfig = nextConfig;
      settings = nextSettings;
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return;
    }
    if (nextSettings.mode === "restart") {
      currentConfig = nextConfig;
      settings = nextSettings;
      queueRestart(plan, nextConfig);
      return;
    }
    if (plan.restartGateway) {
      if (nextSettings.mode === "hot") {
        currentConfig = nextConfig;
        settings = nextSettings;
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        return;
      }
      currentConfig = nextConfig;
      settings = nextSettings;
      queueRestart(plan, nextConfig);
      return;
    }

    // Advance the reloader baseline only after a successful hot apply. Otherwise a
    // failed channel restart would leave runtime secrets rolled back while this
    // baseline already matched the on-disk config — silently skipping retries and
    // leaving stopped channels dead until the next unrelated edit.
    await opts.onHotReload(plan, nextConfig);
    currentConfig = nextConfig;
    settings = nextSettings;
    hotReloadFailureRetries = 0;
  };

  const runReload = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (handleMissingSnapshot(snapshot)) {
        return;
      }
      if (handleInvalidSnapshot(snapshot)) {
        return;
      }
      await applySnapshot(snapshot.config);
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
      // Hot-apply failures intentionally keep the previous baseline so the same
      // on-disk config can be retried. Queue a bounded follow-up even when
      // chokidar has no new event (channel start can fail transiently after stop).
      if (hotReloadFailureRetries < HOT_RELOAD_FAILURE_MAX_RETRIES) {
        hotReloadFailureRetries += 1;
        opts.log.warn(
          `config reload retry (${hotReloadFailureRetries}/${HOT_RELOAD_FAILURE_MAX_RETRIES}) after apply failure`,
        );
        scheduleAfter(HOT_RELOAD_FAILURE_RETRY_DELAY_MS);
      } else {
        opts.log.warn(
          `config reload gave up after ${HOT_RELOAD_FAILURE_MAX_RETRIES} apply failures; waiting for next config change`,
        );
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  let watcherClosed = false;
  watcher.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.log.warn(`config watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = null;
      watcherClosed = true;
      await watcher.close().catch(() => {});
    },
  };
}
