import { fetch as realFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "./test-port.js";

let testPort = 0;
let prevGatewayPort: string | undefined;
let prevGatewayToken: string | undefined;
let prevGatewayPassword: string | undefined;

const pwMocks = vi.hoisted(() => ({
  cookiesGetViaPlaywright: vi.fn(async () => ({
    cookies: [{ name: "session", value: "abc123" }],
  })),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "secret" })),
}));

const routeCtxMocks = vi.hoisted(() => {
  const profileCtx = {
    profile: { cdpUrl: "http://127.0.0.1:9222", driver: "openclaw" },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      url: "http://127.0.0.1:8080/secret",
    })),
    stopRunningBrowser: vi.fn(async () => {}),
  };

  return {
    profileCtx,
    createBrowserRouteContext: vi.fn(() => ({
      state: () => ({
        resolved: {
          evaluateEnabled: true,
          ssrfPolicy: {},
        },
      }),
      forProfile: vi.fn(() => profileCtx),
      mapTabError: vi.fn((err: unknown) => {
        if (err instanceof Error && err.name === "SsrFBlockedError") {
          return { status: 400, message: err.message };
        }
        return null;
      }),
    })),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
        evaluateEnabled: true,
        defaultProfile: "openclaw",
        ssrfPolicy: { allowPrivateNetwork: false },
        profiles: {
          openclaw: { cdpPort: testPort + 1, color: "#FF4500" },
        },
      },
    }),
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

vi.mock("./server-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-context.js")>();
  return {
    ...actual,
    createBrowserRouteContext: routeCtxMocks.createBrowserRouteContext,
  };
});

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("./server.js");

describe("browser strict tab navigation guard", () => {
  beforeEach(async () => {
    testPort = await getFreePort();
    prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = String(testPort - 2);
    prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    pwMocks.cookiesGetViaPlaywright.mockClear();
    pwMocks.snapshotAiViaPlaywright.mockClear();
    routeCtxMocks.profileCtx.ensureTabAvailable.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
    }
    if (prevGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
    }
    if (prevGatewayPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = prevGatewayPassword;
    }
    await stopBrowserControlServer();
  });

  it("blocks later reads after a tab moves to loopback", async () => {
    await startBrowserControlServerFromConfig();
    const base = `http://127.0.0.1:${testPort}`;

    const cookiesRes = await realFetch(`${base}/cookies`);
    const cookiesBody = (await cookiesRes.json()) as { error?: string };
    expect(cookiesRes.status).toBe(400);
    expect(cookiesBody.error).toBeTruthy();
    expect(pwMocks.cookiesGetViaPlaywright).not.toHaveBeenCalled();

    const snapshotRes = await realFetch(`${base}/snapshot?format=ai`);
    const snapshotBody = (await snapshotRes.json()) as { error?: string };
    expect(snapshotRes.status).toBe(400);
    expect(snapshotBody.error).toBeTruthy();
    expect(pwMocks.snapshotAiViaPlaywright).not.toHaveBeenCalled();
  });
});
