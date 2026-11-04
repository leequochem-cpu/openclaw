import type { GatewayWsClient } from "../server/ws-types.js";

const DEVICE_REMOVED_CLOSE_CODE = 4001;
const DEVICE_REMOVED_CLOSE_REASON = "device removed";

type DisconnectableClient = Pick<GatewayWsClient, "connect" | "socket">;

/**
 * Close live gateway sockets bound to a paired device.
 * Token checks run only during connect, so revoke/remove must drop existing sessions.
 * Role limits a token revoke to that role; device removal omits role and closes every session.
 */
export function disconnectClientsForDevice(
  clients: Iterable<DisconnectableClient>,
  deviceId: string,
  opts?: { role?: string },
): void {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    return;
  }
  const role = opts?.role?.trim();
  const matched: DisconnectableClient[] = [];
  for (const gatewayClient of clients) {
    if (gatewayClient.connect.device?.id !== normalizedDeviceId) {
      continue;
    }
    if (role && gatewayClient.connect.role !== role) {
      continue;
    }
    matched.push(gatewayClient);
  }
  for (const gatewayClient of matched) {
    try {
      gatewayClient.socket.close(DEVICE_REMOVED_CLOSE_CODE, DEVICE_REMOVED_CLOSE_REASON);
    } catch {
      // Socket may already be closing.
    }
  }
}
