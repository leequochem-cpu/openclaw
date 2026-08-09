import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;
// Must stay >= CHANNEL_RESTART_POLICY.maxMs in server-channels.ts (5 minutes).
// Sticky restartPending must not hide a dead channel from /ready forever.
const RESTART_PENDING_READINESS_GRACE_MS = 6 * 60_000;

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
  now: number,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but only while the stop→restart gap is still within the max backoff
  // budget. A leaked restartPending (empty catch / aborted handoff) must go red.
  if (health.reason !== "not-running" || accountSnapshot.restartPending !== true) {
    return false;
  }
  const lastStopAt = accountSnapshot.lastStopAt;
  if (typeof lastStopAt !== "number" || !Number.isFinite(lastStopAt)) {
    return false;
  }
  return now - lastStopAt <= RESTART_PENDING_READINESS_GRACE_MS;
}

export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return { ...cachedState, uptimeMs };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const failing: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health, now)) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    cachedState = { ready: failing.length === 0, failing };
    return { ...cachedState, uptimeMs };
  };
}
