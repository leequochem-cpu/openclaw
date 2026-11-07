import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
} from "openclaw/plugin-sdk/device-pair";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCommandContext } from "../../src/plugins/types.js";

const approveDevicePairing = vi.hoisted(() => vi.fn());
const listDevicePairing = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/device-pair", () => ({
  approveDevicePairing,
  listDevicePairing,
  resolveGatewayBindUrl: vi.fn(),
  resolveTailnetHostWithRunner: vi.fn(),
  runPluginCommandWithTimeout: vi.fn(),
}));

import register from "./index.js";

const pendingAdmin = {
  requestId: "req-admin",
  deviceId: "phone-1",
  publicKey: "public-key",
  displayName: "Escalating Phone",
  platform: "ios",
  role: "operator",
  scopes: ["operator.admin"],
  ts: 1,
};

function createApi(): {
  api: OpenClawPluginApi;
  command: () => OpenClawPluginCommandDefinition;
} {
  let command: OpenClawPluginCommandDefinition | undefined;
  const api = {
    id: "device-pair",
    name: "device-pair",
    source: "test",
    config: {},
    runtime: {},
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerService() {},
    registerCommand(next: OpenClawPluginCommandDefinition) {
      command = next;
    },
  } as unknown as OpenClawPluginApi;
  register(api);
  return {
    api,
    command: () => {
      if (!command) {
        throw new Error("device-pair did not register /pair");
      }
      return command;
    },
  };
}

function createContext(overrides?: Partial<PluginCommandContext>): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: "/pair approve",
    args: "approve",
    config: {},
    ...overrides,
  };
}

describe("device-pair /pair approve", () => {
  beforeEach(() => {
    approveDevicePairing.mockReset();
    listDevicePairing.mockReset();
    listDevicePairing.mockResolvedValue({ pending: [pendingAdmin], paired: [] });
  });

  it("rejects internal callers that lack pairing scope before approval", async () => {
    const { command } = createApi();
    const result = await command().handler(
      createContext({ gatewayClientScopes: ["operator.write"] }),
    );

    expect(result).toEqual({
      text: "⚠️ This command requires operator.pairing for internal gateway callers.",
    });
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("rejects operator.admin requests from a pairing-scoped gateway client", async () => {
    approveDevicePairing.mockResolvedValueOnce({
      forbidden: true,
      missingScope: "operator.admin",
    });
    const { command } = createApi();
    const result = await command().handler(
      createContext({
        gatewayClientScopes: ["operator.write", "operator.pairing"],
      }),
    );

    expect(approveDevicePairing).toHaveBeenCalledWith("req-admin", {
      callerScopes: ["operator.write", "operator.pairing"],
    });
    expect(result).toEqual({
      text: "⚠️ Cannot approve a request requiring operator.admin.",
    });
  });

  it("approves when the gateway client holds operator.admin", async () => {
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-admin",
      device: {
        deviceId: "phone-1",
        displayName: "Escalating Phone",
        platform: "ios",
      },
    });
    const { command } = createApi();
    const result = await command().handler(
      createContext({ gatewayClientScopes: ["operator.admin"] }),
    );

    expect(approveDevicePairing).toHaveBeenCalledWith("req-admin", {
      callerScopes: ["operator.admin"],
    });
    expect(result).toEqual({ text: "✅ Paired Escalating Phone (ios)." });
  });

  it("keeps channel approvals that do not carry gateway scopes unrestricted", async () => {
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-admin",
      device: {
        deviceId: "phone-1",
        displayName: "Escalating Phone",
        platform: "ios",
      },
    });
    const { command } = createApi();
    const result = await command().handler(
      createContext({ channel: "telegram", gatewayClientScopes: undefined }),
    );

    expect(approveDevicePairing).toHaveBeenCalledWith("req-admin");
    expect(result).toEqual({ text: "✅ Paired Escalating Phone (ios)." });
  });
});
