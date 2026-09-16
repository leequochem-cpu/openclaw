import {
  normalizeStringEntries,
  resolveAllowlistMatchByCandidates,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/matrix";

function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

function stripMatrixUserPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return trimmed.slice("matrix:".length).trim();
  }
  if (lowered.startsWith("user:")) {
    return trimmed.slice("user:".length).trim();
  }
  return trimmed;
}

function normalizeMatrixUser(raw?: string | null): string {
  // Matrix MXIDs are case-sensitive. Historical localparts and server names
  // must stay exact so distinct accounts cannot fold into one allowlist identity.
  return (raw ?? "").trim();
}

export function normalizeMatrixUserId(raw?: string | null): string {
  return normalizeMatrixUser(stripMatrixUserPrefix(raw ?? ""));
}

function normalizeMatrixAllowListEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return trimmed;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return `matrix:${normalizeMatrixUser(trimmed.slice("matrix:".length))}`;
  }
  if (lowered.startsWith("user:")) {
    return `user:${normalizeMatrixUser(trimmed.slice("user:".length))}`;
  }
  return normalizeMatrixUser(trimmed);
}

export function normalizeMatrixAllowList(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}

export type MatrixAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user"
>;
type MatrixAllowListSource = Exclude<MatrixAllowListMatch["matchSource"], undefined>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
}): MatrixAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) {
    return { allowed: false };
  }
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const userId = normalizeMatrixUserId(params.userId);
  const candidates: Array<{ value?: string; source: MatrixAllowListSource }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
  ];
  return resolveAllowlistMatchByCandidates({ allowList, candidates });
}

export function resolveMatrixAllowListMatches(params: { allowList: string[]; userId?: string }) {
  return resolveMatrixAllowListMatch(params).allowed;
}
