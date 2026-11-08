import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { CONFIG_PATH } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(async () => ({
    status: "ok",
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 12,
  })),
}));

import { runGatewayUpdate } from "../infra/update-runner.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 1_000, interval: 2 } as const;

let ws: WebSocket;
let port: number;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const connectNodeClient = async (params: {
  port: number;
  commands: string[];
  platform?: string;
  deviceFamily?: string;
  deviceIdentity?: DeviceIdentity;
  instanceId?: string;
  displayName?: string;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required for node test clients");
  }
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    clientDisplayName: params.displayName,
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.instanceId,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onEvent: params.onEvent,
    timeoutMessage: "timeout waiting for node to connect",
  });
};

const approveAllPendingPairings = async () => {
  const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
  const list = await listDevicePairing();
  for (const pending of list.pending) {
    await approveDevicePairing(pending.requestId);
  }
};

const connectNodeClientWithPairing = async (params: Parameters<typeof connectNodeClient>[0]) => {
  try {
    return await connectNodeClient(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pairing required")) {
      throw error;
    }
    await approveAllPendingPairings();
    return await connectNodeClient(params);
  }
};

const waitForNodeDisconnected = async (nodeId: string) => {
  await expect
    .poll(async () => {
      const listRes = await rpcReq<{
        nodes?: Array<{ nodeId: string; connected?: boolean }>;
      }>(ws, "node.list", {});
      return (listRes.payload?.nodes ?? []).some(
        (node) => node.connected && node.nodeId === nodeId,
      );
    }, FAST_WAIT_OPTS)
    .toBe(false);
};

const connectNodeClientWithNodePairing = async (
  params: Parameters<typeof connectNodeClient>[0],
) => {
  const { onEvent: _onEvent, ...provisionalParams } = params;
  const provisionalClient = await connectNodeClientWithPairing(provisionalParams);
  const listRes = await rpcReq<{
    nodes?: Array<{ nodeId: string; displayName?: string; connected?: boolean }>;
  }>(ws, "node.list", {});
  const provisionalNode = (listRes.payload?.nodes ?? []).find((node) => {
    if (!node.connected) {
      return false;
    }
    if (params.displayName) {
      return node.displayName === params.displayName;
    }
    return true;
  });
  const nodeId = provisionalNode?.nodeId ?? "";
  expect(nodeId).toBeTruthy();
  provisionalClient.stop();
  await waitForNodeDisconnected(nodeId);

  const { approveNodePairing, listNodePairing } = await import("../infra/node-pairing.js");
  const pending = (await listNodePairing()).pending.find((request) => request.nodeId === nodeId);
  expect(pending?.requestId).toBeTruthy();
  await approveNodePairing(pending?.requestId ?? "");

  return await connectNodeClient(params);
};

describe("gateway role enforcement", () => {
  test("enforces operator and node permissions", async () => {
    let nodeClient: GatewayClient | undefined;

    try {
      const eventRes = await rpcReq(ws, "node.event", { event: "test", payload: { ok: true } });
      expect(eventRes.ok).toBe(false);
      expect(eventRes.error?.message ?? "").toContain("unauthorized role");

      const invokeRes = await rpcReq(ws, "node.invoke.result", {
        id: "invoke-1",
        nodeId: "node-1",
        ok: true,
      });
      expect(invokeRes.ok).toBe(false);
      expect(invokeRes.error?.message ?? "").toContain("unauthorized role");

      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: [],
        instanceId: "node-role-enforcement",
        displayName: "node-role-enforcement",
      });

      const binsPayload = await nodeClient.request<{ bins?: unknown[] }>("skills.bins", {});
      expect(Array.isArray(binsPayload?.bins)).toBe(true);

      await expect(nodeClient.request("status", {})).rejects.toThrow("unauthorized role");

      const healthPayload = await nodeClient.request("health", {});
      expect(healthPayload).toBeDefined();
    } finally {
      nodeClient?.stop();
    }
  });
});

describe("gateway update.run", () => {
  test("writes sentinel and schedules restart", async () => {
    const sigusr1 = vi.fn();
    process.on("SIGUSR1", sigusr1);

    try {
      const id = "req-update";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "update.run",
          params: {
            sessionKey: "agent:main:whatsapp:dm:+15555550123",
            restartDelayMs: 0,
          },
        }),
      );
      const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
      expect(res.ok).toBe(true);

      await vi.waitFor(() => {
        expect(sigusr1.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);
      expect(sigusr1).toHaveBeenCalled();

      const sentinelPath = path.join(os.homedir(), ".openclaw", "restart-sentinel.json");
      const raw = await fs.readFile(sentinelPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        payload?: { kind?: string; stats?: { mode?: string } };
      };
      expect(parsed.payload?.kind).toBe("update");
      expect(parsed.payload?.stats?.mode).toBe("git");
    } finally {
      process.off("SIGUSR1", sigusr1);
    }
  });

  test("uses configured update channel", async () => {
    const sigusr1 = vi.fn();
    process.on("SIGUSR1", sigusr1);

    try {
      await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ update: { channel: "beta" } }, null, 2));
      const updateMock = vi.mocked(runGatewayUpdate);
      updateMock.mockClear();

      const id = "req-update-channel";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "update.run",
          params: {
            restartDelayMs: 0,
          },
        }),
      );
      const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
      expect(res.ok).toBe(true);
      expect(updateMock).toHaveBeenCalledOnce();
    } finally {
      process.off("SIGUSR1", sigusr1);
    }
  });
});

describe("gateway node command allowlist", () => {
  test("enforces command allowlists across node clients", async () => {
    const waitForConnectedCount = async (count: number) => {
      await expect
        .poll(async () => {
          const listRes = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean }>;
          }>(ws, "node.list", {});
          const nodes = listRes.payload?.nodes ?? [];
          return nodes.filter((node) => node.connected).length;
        }, FAST_WAIT_OPTS)
        .toBe(count);
    };

    const getConnectedNodeId = async () => {
      const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
        ws,
        "node.list",
        {},
      );
      const nodeId = listRes.payload?.nodes?.find((node) => node.connected)?.nodeId ?? "";
      expect(nodeId).toBeTruthy();
      return nodeId;
    };

    let systemClient: GatewayClient | undefined;
    let emptyClient: GatewayClient | undefined;
    let allowedClient: GatewayClient | undefined;

    try {
      systemClient = await connectNodeClientWithPairing({
        port,
        commands: ["system.run"],
        instanceId: "node-system-run",
        displayName: "node-system-run",
      });
      const systemNodeId = await getConnectedNodeId();
      const disallowedRes = await rpcReq(ws, "node.invoke", {
        nodeId: systemNodeId,
        command: "system.run",
        params: { command: "echo hi" },
        idempotencyKey: "allowlist-1",
      });
      expect(disallowedRes.ok).toBe(false);
      expect(disallowedRes.error?.message).toContain("node command not allowed");
      systemClient.stop();
      await waitForConnectedCount(0);

      emptyClient = await connectNodeClientWithPairing({
        port,
        commands: [],
        instanceId: "node-empty",
        displayName: "node-empty",
      });
      const emptyNodeId = await getConnectedNodeId();
      const missingRes = await rpcReq(ws, "node.invoke", {
        nodeId: emptyNodeId,
        command: "canvas.snapshot",
        params: {},
        idempotencyKey: "allowlist-2",
      });
      expect(missingRes.ok).toBe(false);
      expect(missingRes.error?.message).toContain("node command not allowed");
      emptyClient.stop();
      await waitForConnectedCount(0);

      let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
      const waitForInvoke = () =>
        new Promise<{ id?: string; nodeId?: string }>((resolve) => {
          resolveInvoke = resolve;
        });
      const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
      const allowedDeviceIdentity = loadOrCreateDeviceIdentity(
        path.join(os.tmpdir(), `openclaw-node-allowed-${Date.now()}-${Math.random()}.json`),
      );
      allowedClient = await connectNodeClientWithNodePairing({
        port,
        commands: ["canvas.snapshot"],
        instanceId: "node-allowed",
        displayName: "node-allowed",
        deviceIdentity: allowedDeviceIdentity,
        onEvent: (evt) => {
          if (evt.event === "node.invoke.request") {
            const payload = evt.payload as { id?: string; nodeId?: string };
            resolveInvoke?.(payload);
          }
        },
      });
      const allowedNodeId = await getConnectedNodeId();

      const invokeResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-3",
      });
      const payload = await waitForInvoke();
      const requestId = payload?.id ?? "";
      const nodeIdFromReq = payload?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestId,
        nodeId: nodeIdFromReq,
        ok: true,
        payloadJSON: JSON.stringify({ ok: true }),
      });
      const invokeRes = await invokeResP;
      expect(invokeRes.ok).toBe(true);

      const invokeNullResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-null-payloadjson",
      });
      const payloadNull = await waitForInvoke();
      const requestIdNull = payloadNull?.id ?? "";
      const nodeIdNull = payloadNull?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestIdNull,
        nodeId: nodeIdNull,
        ok: true,
        payloadJSON: null,
      });
      const invokeNullRes = await invokeNullResP;
      expect(invokeNullRes.ok).toBe(true);
    } finally {
      systemClient?.stop();
      emptyClient?.stop();
      allowedClient?.stop();
    }
  });

  test("rejects reconnect metadata spoof for paired node devices", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const deviceIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-spoof-test-device-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const deviceIdentity = loadOrCreateDeviceIdentity(deviceIdentityPath);

    let iosClient: GatewayClient | undefined;
    try {
      iosClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "ios",
        deviceFamily: "iPhone",
        instanceId: "node-platform-pin",
        displayName: "node-platform-pin",
        deviceIdentity,
      });
      iosClient.stop();
      await expect
        .poll(async () => {
          const listRes = await rpcReq<{ nodes?: Array<{ connected?: boolean }> }>(
            ws,
            "node.list",
            {},
          );
          return (listRes.payload?.nodes ?? []).filter((node) => node.connected).length;
        }, FAST_WAIT_OPTS)
        .toBe(0);

      await expect(
        connectNodeClient({
          port,
          commands: ["system.run"],
          platform: "linux",
          deviceFamily: "linux",
          instanceId: "node-platform-pin",
          displayName: "node-platform-pin",
          deviceIdentity,
        }),
      ).rejects.toThrow(/pairing required/i);
    } finally {
      iosClient?.stop();
    }
  });

  test("filters system.run for confusable iOS metadata at connect time", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const cases = [
      {
        label: "dotted-i-platform",
        platform: "İOS",
        deviceFamily: "iPhone",
      },
      {
        label: "greek-omicron-family",
        platform: "ios",
        deviceFamily: "iPhοne",
      },
    ] as const;

    for (const testCase of cases) {
      const deviceIdentityPath = path.join(
        os.tmpdir(),
        `openclaw-confusable-node-${testCase.label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      const deviceIdentity = loadOrCreateDeviceIdentity(deviceIdentityPath);
      const displayName = `node-${testCase.label}`;

      const findConnectedNode = async () => {
        const listRes = await rpcReq<{
          nodes?: Array<{
            nodeId: string;
            displayName?: string;
            connected?: boolean;
            commands?: string[];
          }>;
        }>(ws, "node.list", {});
        return (listRes.payload?.nodes ?? []).find(
          (node) => node.connected && node.displayName === displayName,
        );
      };

      let client: GatewayClient | undefined;
      try {
        client = await connectNodeClientWithNodePairing({
          port,
          commands: ["system.run", "canvas.snapshot"],
          platform: testCase.platform,
          deviceFamily: testCase.deviceFamily,
          instanceId: displayName,
          displayName,
          deviceIdentity,
        });

        await expect
          .poll(
            async () => {
              const node = await findConnectedNode();
              return node?.commands?.toSorted() ?? [];
            },
            { timeout: 2_000, interval: 10 },
          )
          .toEqual(["canvas.snapshot"]);

        const node = await findConnectedNode();
        const nodeId = node?.nodeId ?? "";
        expect(nodeId).toBeTruthy();

        const systemRunRes = await rpcReq(ws, "node.invoke", {
          nodeId,
          command: "system.run",
          params: { command: "echo blocked" },
          idempotencyKey: `allowlist-confusable-${testCase.label}`,
        });
        expect(systemRunRes.ok).toBe(false);
        expect(systemRunRes.error?.message ?? "").toContain("node command not allowed");
      } finally {
        client?.stop();
      }
    }
  });

  test("blocks declared host commands until node pairing exists", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const deviceIdentity = loadOrCreateDeviceIdentity(
      path.join(os.tmpdir(), `openclaw-node-device-only-${Date.now()}-${Math.random()}.json`),
    );
    const displayName = "node-device-paired-only";
    const findConnectedNode = async () => {
      const listRes = await rpcReq<{
        nodes?: Array<{
          nodeId: string;
          displayName?: string;
          connected?: boolean;
          commands?: string[];
        }>;
      }>(ws, "node.list", {});
      return (listRes.payload?.nodes ?? []).find(
        (node) => node.connected && node.displayName === displayName,
      );
    };

    let nodeClient: GatewayClient | undefined;
    try {
      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot", "system.run"],
        platform: "darwin",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      await expect
        .poll(async () => (await findConnectedNode())?.commands?.toSorted() ?? [], FAST_WAIT_OPTS)
        .toEqual([]);

      const nodeId = (await findConnectedNode())?.nodeId ?? "";
      expect(nodeId).toBeTruthy();

      const pairingList = await rpcReq<{
        pending?: Array<{ nodeId?: string; commands?: string[] }>;
      }>(ws, "node.pair.list", {});
      expect(pairingList.ok).toBe(true);
      expect(pairingList.payload?.pending ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId,
            commands: ["canvas.snapshot", "system.run"],
          }),
        ]),
      );

      const canvasRes = await rpcReq(ws, "node.invoke", {
        nodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "device-paired-only-canvas",
      });
      expect(canvasRes.ok).toBe(false);
      expect(canvasRes.error?.message ?? "").toContain("node command not allowed");

      const systemRunRes = await rpcReq(ws, "node.invoke", {
        nodeId,
        command: "system.run",
        params: { command: "echo blocked" },
        idempotencyKey: "device-paired-only-system-run",
      });
      expect(systemRunRes.ok).toBe(false);
      expect(systemRunRes.error?.message ?? "").toContain("node command not allowed");
    } finally {
      nodeClient?.stop();
    }
  });

  test("does not widen approved node commands on reconnect", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const deviceIdentity = loadOrCreateDeviceIdentity(
      path.join(os.tmpdir(), `openclaw-node-reconnect-${Date.now()}-${Math.random()}.json`),
    );
    const displayName = "node-reconnect-command-pin";
    const findConnectedNode = async () => {
      const listRes = await rpcReq<{
        nodes?: Array<{
          nodeId: string;
          displayName?: string;
          connected?: boolean;
          commands?: string[];
        }>;
      }>(ws, "node.list", {});
      return (listRes.payload?.nodes ?? []).find(
        (node) => node.connected && node.displayName === displayName,
      );
    };

    let nodeClient: GatewayClient | undefined;
    try {
      nodeClient = await connectNodeClientWithNodePairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "darwin",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });
      const pairedNodeId = (await findConnectedNode())?.nodeId ?? "";
      expect(pairedNodeId).toBeTruthy();
      nodeClient.stop();
      await waitForNodeDisconnected(pairedNodeId);

      nodeClient = await connectNodeClient({
        port,
        commands: ["canvas.snapshot", "system.run"],
        platform: "darwin",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      await expect
        .poll(async () => (await findConnectedNode())?.commands?.toSorted() ?? [], FAST_WAIT_OPTS)
        .toEqual(["canvas.snapshot"]);

      const connectedId = (await findConnectedNode())?.nodeId ?? "";
      const systemRunRes = await rpcReq(ws, "node.invoke", {
        nodeId: connectedId,
        command: "system.run",
        params: { command: "echo blocked" },
        idempotencyKey: "reconnect-system-run",
      });
      expect(systemRunRes.ok).toBe(false);
      expect(systemRunRes.error?.message ?? "").toContain("node command not allowed");
    } finally {
      nodeClient?.stop();
    }
  });
});
