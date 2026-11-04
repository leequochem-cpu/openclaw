import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceHandlers } from "./devices.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { removePairedDeviceMock, revokeDeviceTokenMock } = vi.hoisted(() => ({
  removePairedDeviceMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    removePairedDevice: removePairedDeviceMock,
    revokeDeviceToken: revokeDeviceTokenMock,
  };
});

function createOptions(
  method: string,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions & {
  context: { disconnectClientsForDevice: ReturnType<typeof vi.fn> };
} {
  const options = {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      disconnectClientsForDevice: vi.fn(),
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
  };
  return options as unknown as GatewayRequestHandlerOptions & {
    context: { disconnectClientsForDevice: ReturnType<typeof vi.fn> };
  };
}

describe("device session disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects active clients after the remove response is sent", async () => {
    removePairedDeviceMock.mockResolvedValue({ deviceId: "device-1" });
    const opts = createOptions("device.pair.remove", { deviceId: " device-1 " });

    await deviceHandlers["device.pair.remove"](opts);
    await Promise.resolve();

    expect(removePairedDeviceMock).toHaveBeenCalledWith(" device-1 ");
    expect(opts.respond).toHaveBeenCalledWith(true, { deviceId: "device-1" }, undefined);
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1");
    expect(opts.respond.mock.invocationCallOrder[0]).toBeLessThan(
      opts.context.disconnectClientsForDevice.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not disconnect clients when device removal fails", async () => {
    removePairedDeviceMock.mockResolvedValue(null);
    const opts = createOptions("device.pair.remove", { deviceId: "device-1" });

    await deviceHandlers["device.pair.remove"](opts);
    await Promise.resolve();

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId" }),
    );
  });

  it("disconnects only the revoked role after the revoke response is sent", async () => {
    revokeDeviceTokenMock.mockResolvedValue({ role: "operator", revokedAtMs: 456 });
    const opts = createOptions("device.token.revoke", {
      deviceId: " device-1 ",
      role: " operator ",
    });

    await deviceHandlers["device.token.revoke"](opts);
    await Promise.resolve();

    expect(revokeDeviceTokenMock).toHaveBeenCalledWith({
      deviceId: " device-1 ",
      role: " operator ",
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { deviceId: "device-1", role: "operator", revokedAtMs: 456 },
      undefined,
    );
    expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith("device-1", {
      role: "operator",
    });
    expect(opts.respond.mock.invocationCallOrder[0]).toBeLessThan(
      opts.context.disconnectClientsForDevice.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not disconnect clients when token revocation fails", async () => {
    revokeDeviceTokenMock.mockResolvedValue(null);
    const opts = createOptions("device.token.revoke", {
      deviceId: "device-1",
      role: "operator",
    });

    await deviceHandlers["device.token.revoke"](opts);
    await Promise.resolve();

    expect(opts.context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown deviceId/role" }),
    );
  });
});
