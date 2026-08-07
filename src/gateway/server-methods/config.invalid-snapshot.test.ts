import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const writeConfigFile = vi.fn(async () => {});
  const readConfigFileSnapshotForWrite = vi.fn();
  const resolveConfigSnapshotHash = vi.fn(() => "snapshot-hash");
  const loadConfig = vi.fn(() => ({}) as OpenClawConfig);
  return {
    writeConfigFile,
    readConfigFileSnapshotForWrite,
    resolveConfigSnapshotHash,
    loadConfig,
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    writeConfigFile: hoisted.writeConfigFile,
    readConfigFileSnapshotForWrite: hoisted.readConfigFileSnapshotForWrite,
    resolveConfigSnapshotHash: hoisted.resolveConfigSnapshotHash,
    loadConfig: hoisted.loadConfig,
  };
});

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: () => ({ plugins: [] }),
}));

import { configHandlers } from "./config.js";

const SECRET_TOKEN = "keep-me-secret-token-value";

function invalidSnapshot() {
  return {
    path: "/tmp/openclaw-invalid.json",
    exists: true,
    raw: JSON.stringify({
      gateway: { mode: "local", auth: { token: SECRET_TOKEN } },
      channels: { telegram: { botToken: "telegram-secret-token" } },
      weirdUnknownTopLevel: true,
    }),
    parsed: {
      gateway: { mode: "local", auth: { token: SECRET_TOKEN } },
      channels: { telegram: { botToken: "telegram-secret-token" } },
      weirdUnknownTopLevel: true,
    },
    resolved: {
      gateway: { mode: "local", auth: { token: SECRET_TOKEN } },
      channels: { telegram: { botToken: "telegram-secret-token" } },
      weirdUnknownTopLevel: true,
    },
    valid: false,
    config: {
      gateway: { mode: "local", auth: { token: SECRET_TOKEN } },
      channels: { telegram: { botToken: "telegram-secret-token" } },
    } as OpenClawConfig,
    hash: "snapshot-hash",
    issues: [{ path: "weirdUnknownTopLevel", message: "unknown key" }],
    warnings: [],
    legacyIssues: [],
  };
}

async function invoke(
  method: "config.set" | "config.apply" | "config.patch",
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await configHandlers[method]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: { logGateway: { info: vi.fn(), warn: vi.fn() } } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("config writes refuse invalid snapshots", () => {
  beforeEach(() => {
    hoisted.writeConfigFile.mockClear();
    hoisted.readConfigFileSnapshotForWrite.mockReset();
    hoisted.resolveConfigSnapshotHash.mockClear();
    hoisted.loadConfig.mockClear();
    hoisted.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: invalidSnapshot(),
      writeOptions: { expectedConfigPath: "/tmp/openclaw-invalid.json" },
    });
  });

  it("rejects config.set so an empty redacted UI form cannot wipe tokens", async () => {
    const respond = await invoke("config.set", {
      raw: JSON.stringify({ gateway: { mode: "local" } }),
      baseHash: "snapshot-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid config; fix before setting"),
      }),
    );
    expect(hoisted.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects config.apply so Apply cannot persist a redacted empty snapshot", async () => {
    const respond = await invoke("config.apply", {
      raw: JSON.stringify({ gateway: { mode: "local" } }),
      baseHash: "snapshot-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid config; fix before applying"),
      }),
    );
    expect(hoisted.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps rejecting config.patch on invalid snapshots", async () => {
    const respond = await invoke("config.patch", {
      raw: JSON.stringify({ gateway: { mode: "local" } }),
      baseHash: "snapshot-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid config; fix before patching"),
      }),
    );
    expect(hoisted.writeConfigFile).not.toHaveBeenCalled();
  });
});
