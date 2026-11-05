import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../../infra/device-pairing.js";
import { deviceHandlers } from "./devices.js";

async function withStateDir(run: (baseDir: string) => Promise<void>) {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-approve-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = baseDir;
  try {
    await run(baseDir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

async function queueOperatorRequest(scopes: string[]) {
  return await requestDevicePairing({
    deviceId: "pending-operator-device",
    publicKey: "public-key-pending",
    role: "operator",
    scopes,
  });
}

async function callApprove(params: { requestId: string; callerScopes: string[] }) {
  const respond = vi.fn();
  const broadcast = vi.fn();
  await deviceHandlers["device.pair.approve"]({
    req: { id: "req-1", type: "req", method: "device.pair.approve" },
    params: { requestId: params.requestId },
    client: { connect: { scopes: params.callerScopes } } as never,
    isWebchatConnect: () => false,
    respond,
    context: {
      logGateway: { info: vi.fn() },
      broadcast,
    } as never,
  });
  return { respond, broadcast };
}

describe("device.pair.approve caller scope guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects a pairing caller approving an admin device", async () => {
    await withStateDir(async () => {
      const pending = await queueOperatorRequest(["operator.admin"]);

      const { respond, broadcast } = await callApprove({
        requestId: pending.request.requestId,
        callerScopes: ["operator.pairing"],
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "missing scope: operator.admin" }),
      );
      expect(broadcast).not.toHaveBeenCalled();
      expect(await getPairedDevice("pending-operator-device")).toBeNull();
      const list = await listDevicePairing();
      expect(list.pending.map((entry) => entry.requestId)).toContain(pending.request.requestId);
    });
  });

  test("still approves a device that stays within pairing scope", async () => {
    await withStateDir(async () => {
      const pending = await queueOperatorRequest(["operator.pairing"]);

      const { respond } = await callApprove({
        requestId: pending.request.requestId,
        callerScopes: ["operator.pairing"],
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          requestId: pending.request.requestId,
          device: expect.objectContaining({
            deviceId: "pending-operator-device",
          }),
        }),
        undefined,
      );
      const paired = await getPairedDevice("pending-operator-device");
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(paired?.approvedScopes).toEqual(["operator.pairing"]);
    });
  });

  test("allows an admin caller to approve an admin device", async () => {
    await withStateDir(async () => {
      const pending = await queueOperatorRequest(["operator.admin"]);

      const { respond } = await callApprove({
        requestId: pending.request.requestId,
        callerScopes: ["operator.admin"],
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ requestId: pending.request.requestId }),
        undefined,
      );
      const paired = await getPairedDevice("pending-operator-device");
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
    });
  });

  test("keeps direct approval without caller scopes unrestricted", async () => {
    await withStateDir(async (baseDir) => {
      const pending = await requestDevicePairing(
        {
          deviceId: "local-admin-device",
          publicKey: "public-key-local",
          role: "operator",
          scopes: ["operator.admin"],
        },
        baseDir,
      );

      const approved = await approveDevicePairing(pending.request.requestId, baseDir);

      expect(approved?.device.deviceId).toBe("local-admin-device");
      const paired = await getPairedDevice("local-admin-device", baseDir);
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
    });
  });
});
