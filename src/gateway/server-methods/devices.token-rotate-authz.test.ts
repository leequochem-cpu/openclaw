import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
} from "../../infra/device-pairing.js";
import { deviceHandlers } from "./devices.js";

const DEVICE_ID = "admin-approved-device";

async function setupAdminApprovedDevice(baseDir: string) {
  const request = await requestDevicePairing(
    {
      deviceId: DEVICE_ID,
      publicKey: "public-key-1",
      role: "operator",
      scopes: ["operator.admin"],
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, baseDir);
}

async function withStateDir(run: (baseDir: string) => Promise<void>) {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-token-rotate-"));
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

async function callRotate(params: { scopes?: string[]; callerScopes: string[] }) {
  const respond = vi.fn();
  const requestParams: { deviceId: string; role: string; scopes?: string[] } = {
    deviceId: DEVICE_ID,
    role: "operator",
  };
  if (params.scopes) {
    requestParams.scopes = params.scopes;
  }
  await deviceHandlers["device.token.rotate"]({
    req: { id: "req-1", type: "req", method: "device.token.rotate" },
    params: requestParams,
    client: { connect: { scopes: params.callerScopes } } as never,
    isWebchatConnect: () => false,
    respond,
    context: { logGateway: { info: vi.fn() } } as never,
  });
  return respond;
}

describe("device.token.rotate caller scope guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects a pairing caller minting an admin token for an approved device", async () => {
    await withStateDir(async (baseDir) => {
      await setupAdminApprovedDevice(baseDir);
      const before = await getPairedDevice(DEVICE_ID, baseDir);

      const respond = await callRotate({
        scopes: ["operator.admin"],
        callerScopes: ["operator.pairing"],
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "missing scope: operator.admin" }),
      );
      const after = await getPairedDevice(DEVICE_ID, baseDir);
      expect(after?.tokens?.operator?.token).toBe(before?.tokens?.operator?.token);
      expect(after?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
      expect(after?.approvedScopes).toEqual(["operator.admin"]);
    });
  });

  test("rejects a pairing caller when omitted scopes would reuse the admin token", async () => {
    await withStateDir(async (baseDir) => {
      await setupAdminApprovedDevice(baseDir);
      const before = await getPairedDevice(DEVICE_ID, baseDir);

      const respond = await callRotate({ callerScopes: ["operator.pairing"] });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "missing scope: operator.admin" }),
      );
      const after = await getPairedDevice(DEVICE_ID, baseDir);
      expect(after?.tokens?.operator?.token).toBe(before?.tokens?.operator?.token);
    });
  });

  test("still rotates within the caller scopes", async () => {
    await withStateDir(async (baseDir) => {
      await setupAdminApprovedDevice(baseDir);
      await rotateDeviceToken({
        deviceId: DEVICE_ID,
        role: "operator",
        scopes: ["operator.pairing"],
        baseDir,
      });
      const before = await getPairedDevice(DEVICE_ID, baseDir);

      const respond = await callRotate({
        scopes: ["operator.pairing"],
        callerScopes: ["operator.pairing"],
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          deviceId: DEVICE_ID,
          role: "operator",
          scopes: ["operator.pairing"],
        }),
        undefined,
      );
      const after = await getPairedDevice(DEVICE_ID, baseDir);
      expect(after?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
      expect(after?.tokens?.operator?.token).not.toBe(before?.tokens?.operator?.token);
      expect(after?.approvedScopes).toEqual(["operator.admin"]);
    });
  });

  test("allows an admin caller to rotate an admin token", async () => {
    await withStateDir(async (baseDir) => {
      await setupAdminApprovedDevice(baseDir);
      const before = await getPairedDevice(DEVICE_ID, baseDir);

      const respond = await callRotate({
        scopes: ["operator.admin"],
        callerScopes: ["operator.admin"],
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          deviceId: DEVICE_ID,
          scopes: ["operator.admin"],
        }),
        undefined,
      );
      const after = await getPairedDevice(DEVICE_ID, baseDir);
      expect(after?.tokens?.operator?.token).not.toBe(before?.tokens?.operator?.token);
      expect(after?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
    });
  });
});
