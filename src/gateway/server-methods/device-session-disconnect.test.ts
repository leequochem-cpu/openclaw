import { describe, expect, it, vi } from "vitest";
import type { GatewayWsClient } from "../server/ws-types.js";
import { disconnectClientsForDevice } from "./device-session-disconnect.js";

function fakeClient(params: { deviceId?: string; role?: string }) {
  const close = vi.fn();
  const client = {
    connect: {
      role: params.role,
      device: params.deviceId ? { id: params.deviceId } : undefined,
    },
    socket: { close },
  } as unknown as Pick<GatewayWsClient, "connect" | "socket">;
  return { client, close };
}

describe("disconnectClientsForDevice", () => {
  it("closes every live session for a removed device", () => {
    const operator = fakeClient({ deviceId: "device-1", role: "operator" });
    const node = fakeClient({ deviceId: "device-1", role: "node" });
    const other = fakeClient({ deviceId: "device-2", role: "operator" });
    const anonymous = fakeClient({ role: "operator" });

    disconnectClientsForDevice(
      [operator.client, node.client, other.client, anonymous.client],
      " device-1 ",
    );

    expect(operator.close).toHaveBeenCalledWith(4001, "device removed");
    expect(node.close).toHaveBeenCalledWith(4001, "device removed");
    expect(other.close).not.toHaveBeenCalled();
    expect(anonymous.close).not.toHaveBeenCalled();
  });

  it("closes only the revoked role on a device", () => {
    const operator = fakeClient({ deviceId: "device-1", role: "operator" });
    const node = fakeClient({ deviceId: "device-1", role: "node" });

    disconnectClientsForDevice([operator.client, node.client], "device-1", { role: " operator " });

    expect(operator.close).toHaveBeenCalledOnce();
    expect(node.close).not.toHaveBeenCalled();
  });

  it("ignores a socket that is already closing", () => {
    const close = vi.fn(() => {
      throw new Error("already closed");
    });
    const client = {
      connect: { role: "operator", device: { id: "device-1" } },
      socket: { close },
    } as unknown as Pick<GatewayWsClient, "connect" | "socket">;

    expect(() => disconnectClientsForDevice([client], "device-1")).not.toThrow();
  });
});
