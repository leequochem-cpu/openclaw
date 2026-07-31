import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigSnapshotHash } from "../../config/config.js";
import { configHandlers } from "./config.js";

describe("config write lock", () => {
  let tempDir = "";
  let configPath = "";
  let previousConfigPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-write-lock-"));
    configPath = path.join(tempDir, "openclaw.json");
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          meta: { lastTouchedVersion: "2026.3.7", lastTouchedAt: "2026-03-08T00:00:00.000Z" },
          gateway: { mode: "local" },
          channels: {
            telegram: { botToken: "token-a" },
            discord: { token: "token-b" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects the second concurrent patch when baseHash becomes stale", async () => {
    const snapshotRes = await new Promise<{
      ok: boolean;
      payload?: { hash?: string; config?: Record<string, unknown> };
      error?: { message?: string };
    }>((resolve) => {
      void configHandlers["config.get"]({
        params: {},
        respond: (ok, payload, error) => {
          resolve({
            ok,
            payload: payload as { hash?: string; config?: Record<string, unknown> },
            error: error as { message?: string } | undefined,
          });
        },
      } as never);
    });
    expect(snapshotRes.ok).toBe(true);
    const baseHash =
      snapshotRes.payload?.hash ??
      resolveConfigSnapshotHash({
        exists: true,
        path: configPath,
        raw: await fs.readFile(configPath, "utf8"),
        parsed: {},
        valid: true,
        config: snapshotRes.payload?.config ?? {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as never);
    expect(typeof baseHash).toBe("string");
    expect(baseHash).toBeTruthy();

    const context = {
      logGateway: { info: vi.fn(), warn: vi.fn() },
    };
    const client = {
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "openclaw-control-ui", mode: "ui" },
      },
      connId: "conn-a",
    };

    const patchA = new Promise<{ ok: boolean; error?: { message?: string } }>((resolve) => {
      void configHandlers["config.patch"]({
        params: {
          raw: JSON.stringify({ channels: { telegram: { botToken: "token-a2" } } }),
          baseHash,
          restartDelayMs: 60_000,
        },
        respond: (ok, _payload, error) => {
          resolve({ ok, error: error as { message?: string } | undefined });
        },
        client,
        context,
      } as never);
    });

    const patchB = new Promise<{ ok: boolean; error?: { message?: string } }>((resolve) => {
      void configHandlers["config.patch"]({
        params: {
          raw: JSON.stringify({ channels: { discord: { token: "token-b2" } } }),
          baseHash,
          restartDelayMs: 60_000,
        },
        respond: (ok, _payload, error) => {
          resolve({ ok, error: error as { message?: string } | undefined });
        },
        client: { ...client, connId: "conn-b" },
        context,
      } as never);
    });

    const [resA, resB] = await Promise.all([patchA, patchB]);
    const outcomes = [resA, resB];
    expect(outcomes.filter((res) => res.ok)).toHaveLength(1);
    expect(outcomes.filter((res) => !res.ok)).toHaveLength(1);
    expect(outcomes.find((res) => !res.ok)?.error?.message ?? "").toContain(
      "config changed since last load",
    );

    const written = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      channels?: { telegram?: { botToken?: string }; discord?: { token?: string } };
    };
    // Winner keeps its patch; loser must not silently revert the other channel token.
    const telegramToken = written.channels?.telegram?.botToken;
    const discordToken = written.channels?.discord?.token;
    expect(
      (telegramToken === "token-a2" && discordToken === "token-b") ||
        (telegramToken === "token-a" && discordToken === "token-b2"),
    ).toBe(true);
  });
});
