import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  updateSessionStore,
} from "../config/sessions.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

function createHeartbeatDeps(
  sendWhatsApp: NonNullable<HeartbeatDeps["sendWhatsApp"]>,
): HeartbeatDeps {
  return { sendWhatsApp };
}

describe("heartbeat session store writes", () => {
  it("preserves concurrent sessionId updates when recording lastHeartbeat*", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-store-"));
    const storePath = path.join(workspace, "sessions.json");
    await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "- Check status\n", "utf-8");

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "old-sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      replySpy.mockImplementation(async () => {
        await updateSessionStore(storePath, (store) => {
          const current = store[sessionKey];
          if (!current) {
            return;
          }
          store[sessionKey] = {
            ...current,
            sessionId: "new-sid",
            updatedAt: Date.now(),
          };
        });
        return [{ text: "Alert: inbox needs attention" }];
      });

      const sendWhatsApp = vi
        .fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>()
        .mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(sendWhatsApp),
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(store[sessionKey]?.sessionId).toBe("new-sid");
      expect(store[sessionKey]?.lastHeartbeatText).toBe("Alert: inbox needs attention");
      expect(typeof store[sessionKey]?.lastHeartbeatSentAt).toBe("number");
    } finally {
      replySpy.mockRestore();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("prunes heartbeat turns from the configured session transcript path", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-prune-path-"));
    const storePath = path.join(workspace, "sessions.json");
    await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "- Check status\n", "utf-8");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const sessionId = "prune-sid";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "120363401234567890@g.us",
          },
        }),
      );

      const transcriptPath = resolveSessionFilePath(sessionId, undefined, {
        agentId: "main",
        sessionsDir: path.dirname(storePath),
      });
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      const originalContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n`;
      await fs.writeFile(transcriptPath, originalContent);
      const originalSize = (await fs.stat(transcriptPath)).size;

      replySpy.mockImplementation(async () => {
        await fs.appendFile(
          transcriptPath,
          `{"role":"user","content":"Read HEARTBEAT.md"}\n` +
            `{"role":"assistant","content":"HEARTBEAT_OK"}\n`,
        );
        return [{ text: "HEARTBEAT_OK" }];
      });

      await runHeartbeatOnce({
        cfg,
        deps: createHeartbeatDeps(
          vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
            messageId: "m1",
            toJid: "jid",
          }),
        ),
      });

      const afterPrune = await fs.readFile(transcriptPath, "utf-8");
      expect(afterPrune).toBe(originalContent);
      expect((await fs.stat(transcriptPath)).size).toBe(originalSize);
    } finally {
      replySpy.mockRestore();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
