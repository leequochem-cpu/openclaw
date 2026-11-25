import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const LOOPBACK_IPV4_PREFIX = 127;

function canonicalPort(parsed: URL): string {
  if (parsed.port) {
    return parsed.port;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    return "80";
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
    return "443";
  }
  return "";
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host === "::") {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    return isLoopbackHostname(host.slice("::ffff:".length));
  }
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    return (
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 0xff_ff_ff_ff &&
      value >>> 24 === LOOPBACK_IPV4_PREFIX
    );
  }
  if (/^127(?:\.\d+){1,3}$/.test(host)) {
    return true;
  }
  const dotted = host.split(".");
  if (dotted.length === 4 && dotted.every((part) => /^\d+$/.test(part))) {
    return Number(dotted[0]) === LOOPBACK_IPV4_PREFIX;
  }
  return false;
}

/**
 * The browser's own debugging origin can create `file:` targets.
 * Direct `file:` navigation is already rejected; this catches the pivot
 * through that origin, including loopback hostname variants on the same port.
 */
export function isBrowserControlSurfaceUrl(rawUrl: string, cdpUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") {
    return true;
  }
  if (!cdpUrl) {
    return false;
  }
  let cdp: URL;
  try {
    cdp = new URL(cdpUrl);
  } catch {
    return false;
  }
  if (parsed.origin === cdp.origin) {
    return true;
  }
  if (parsed.protocol !== cdp.protocol) {
    return false;
  }
  if (!isLoopbackHostname(parsed.hostname) || !isLoopbackHostname(cdp.hostname)) {
    return false;
  }
  return canonicalPort(parsed) !== "" && canonicalPort(parsed) === canonicalPort(cdp);
}

export function assertBrowserControlSurfaceAllowed(opts: { url: string; cdpUrl?: string }): void {
  if (!isBrowserControlSurfaceUrl(opts.url, opts.cdpUrl)) {
    return;
  }
  let protocol = "";
  try {
    protocol = new URL(opts.url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol === "file:") {
    throw new InvalidBrowserNavigationUrlError("Navigation blocked: file URL");
  }
  throw new InvalidBrowserNavigationUrlError("Navigation blocked: browser debugging endpoint");
}

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // Browser network stacks may apply env proxy routing at connect-time, which
  // can bypass strict destination-binding intent from pre-navigation DNS checks.
  // In strict mode, fail closed unless private-network navigation is explicitly
  // enabled by policy.
  if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set",
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://).
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}
