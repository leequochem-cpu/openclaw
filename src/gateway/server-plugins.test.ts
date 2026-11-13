import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  commands: [],
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics,
});

type ServerPluginsModule = typeof import("./server-plugins.js");

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

function getLastDispatchedClientScopes(): string[] {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

function enforceDispatchedScope(opts: HandleGatewayRequestOptions): void {
  const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
  const auth = authorizeOperatorScopesForMethod(opts.req.method, scopes);
  if (!auth.allowed) {
    opts.respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: `missing scope: ${auth.missingScope}`,
    });
    return;
  }
  opts.respond(true, opts.req.method === "agent" ? { runId: "run-1" } : {});
}

async function importServerPluginsModule(): Promise<ServerPluginsModule> {
  return import("./server-plugins.js");
}

function createSubagentRuntime(serverPlugins: ServerPluginsModule): PluginRuntime["subagent"] {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPlugins.loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { subagent?: PluginRuntime["subagent"] } }
    | undefined;
  if (!call?.runtimeOptions?.subagent) {
    throw new Error("Expected loadGatewayPlugins to provide subagent runtime");
  }
  return call.runtimeOptions.subagent;
}

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  handleGatewayRequest.mockReset();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  vi.resetModules();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0];
    const subagent = call?.runtimeOptions?.subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = await importServerPluginsModule();
    const runtime = createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    vi.resetModules();
    const reloaded = await importServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });

  test("keeps a write-scoped caller instead of minting operator.admin", async () => {
    const { withPluginRuntimeGatewayRequestScope } =
      await import("../plugins/runtime/gateway-request-scope.js");
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-admin"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      enforceDispatchedScope(opts);
    });

    const client = {
      connect: {
        role: "operator",
        scopes: ["operator.write"],
      },
    } as GatewayRequestOptions["client"];

    await expect(
      withPluginRuntimeGatewayRequestScope(
        {
          context: createTestContext("write-caller"),
          client,
          isWebchatConnect: () => false,
        },
        () => runtime.deleteSession({ sessionKey: "agent:main:main", deleteTranscript: true }),
      ),
    ).rejects.toThrow("missing scope: operator.admin");

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", getLastDispatchedClientScopes()).allowed,
    ).toBe(false);
  });

  test("plugin-auth HTTP routes cannot delete sessions through subagent dispatch", async () => {
    const { createGatewayPluginRequestHandler } = await import("./server/plugins-http.js");
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("plugin-http"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      enforceDispatchedScope(opts);
    });

    let deleteError: unknown;
    const handler = createGatewayPluginRequestHandler({
      registry: {
        ...createRegistry([]),
        httpRoutes: [
          {
            pluginId: "task-hook",
            path: "/hooks/task",
            auth: "plugin",
            match: "exact",
            source: "task-hook",
            handler: async () => {
              try {
                await runtime.deleteSession({
                  sessionKey: "agent:main:main",
                  deleteTranscript: true,
                });
              } catch (err) {
                deleteError = err;
              }
              return true;
            },
          },
        ],
      },
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });

    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader() {},
      end() {},
    } as unknown as ServerResponse;
    const handled = await handler({ url: "/hooks/task" } as IncomingMessage, res);

    expect(handled).toBe(true);
    expect(deleteError).toBeInstanceOf(Error);
    expect((deleteError as Error).message).toContain("missing scope: operator.admin");
    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(handleGatewayRequest.mock.calls.at(-1)?.[0]?.req.method).toBe("sessions.delete");
  });
});
