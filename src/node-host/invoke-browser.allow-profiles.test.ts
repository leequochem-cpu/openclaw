import { beforeEach, describe, expect, it, vi } from "vitest";

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
  })),
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    defaultProfile: "openclaw",
  })),
}));

vi.mock("../browser/control-service.js", () => controlServiceMocks);
vi.mock("../browser/routes/dispatcher.js", () => dispatcherMocks);
vi.mock("../config/config.js", () => configMocks);
vi.mock("../browser/config.js", () => browserConfigMocks);
vi.mock("../media/mime.js", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

let runBrowserProxyCommand: typeof import("./invoke-browser.js").runBrowserProxyCommand;

function allowOnlyOpenClaw() {
  configMocks.loadConfig.mockReturnValue({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
  });
}

describe("runBrowserProxyCommand allowProfiles", () => {
  beforeEach(async () => {
    vi.resetModules();
    dispatcherMocks.dispatch.mockReset();
    dispatcherMocks.createBrowserRouteDispatcher.mockReset().mockImplementation(() => ({
      dispatch: dispatcherMocks.dispatch,
    }));
    controlServiceMocks.createBrowserControlContext.mockReset().mockReturnValue({ control: true });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(true);
    configMocks.loadConfig.mockReset().mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReset().mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
    });
    ({ runBrowserProxyCommand } = await import("./invoke-browser.js"));
  });

  it("rejects unauthorized query.profile when allowProfiles is configured", async () => {
    allowOnlyOpenClaw();

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          query: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a disallowed query profile hidden behind an allowlisted top-level profile", async () => {
    allowOnlyOpenClaw();

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "openclaw",
          query: { profile: "chrome" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects unauthorized body.profile when allowProfiles is configured", async () => {
    allowOnlyOpenClaw();

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/stop",
          body: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile creation when allowProfiles is configured", async () => {
    allowOnlyOpenClaw();

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(
      "INVALID_REQUEST: browser.proxy cannot create or delete persistent browser profiles when allowProfiles is configured",
    );
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile deletion when allowProfiles is configured", async () => {
    allowOnlyOpenClaw();

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "DELETE",
          path: "/profiles/poc",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(
      "INVALID_REQUEST: browser.proxy cannot create or delete persistent browser profiles when allowProfiles is configured",
    );
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes an allowlisted body profile into the dispatched query", async () => {
    allowOnlyOpenClaw();
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/stop",
        body: { profile: "openclaw" },
        timeoutMs: 50,
      }),
    );

    expect(dispatcherMocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/stop",
        query: { profile: "openclaw" },
      }),
    );
  });

  it("preserves legacy proxy behavior when allowProfiles is empty", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/profiles/create",
        body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
        timeoutMs: 50,
      }),
    );

    expect(dispatcherMocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/profiles/create",
        body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
      }),
    );
  });
});
