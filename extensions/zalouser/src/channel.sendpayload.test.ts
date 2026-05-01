import type { OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk/zalouser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zalouserPlugin } from "./channel.js";
import type { ZalouserAccountConfig } from "./types.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
}));

let mockAccountConfig: ZalouserAccountConfig = {};

const configuredOpenZalouserConfig: OpenClawConfig = {
  channels: {
    zalouser: {
      enabled: true,
      groupPolicy: "open",
    },
  },
};

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveZalouserAccountSync: () => ({
      accountId: "default",
      profile: "default",
      name: "test",
      enabled: true,
      config: mockAccountConfig,
    }),
  };
});

function baseCtx(payload: ReplyPayload, cfg: OpenClawConfig = {}) {
  return {
    cfg,
    to: "user:987654321",
    text: "",
    payload,
  };
}

describe("zalouserPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>;

  beforeEach(async () => {
    const mod = await import("./send.js");
    mockedSend = vi.mocked(mod.sendMessageZalouser);
    mockedSend.mockClear();
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-1" });
    mockAccountConfig = {};
  });

  it("text-only delegates to sendText", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-t1" });

    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({ text: "hello" }));

    expect(mockedSend).toHaveBeenCalledWith("987654321", "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-t1" });
  });

  it("group target delegates with isGroup=true and stripped threadId", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello group" }, configuredOpenZalouserConfig),
      to: "group:1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "1471383327500481391",
      "hello group",
      expect.objectContaining({ isGroup: true }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g1" });
  });

  it("blocks group targets denied by groupPolicy", async () => {
    mockAccountConfig = {
      groupPolicy: "allowlist",
      groups: {
        "g-allowed": { allow: true },
      },
    };

    await expect(
      zalouserPlugin.outbound!.sendPayload!({
        ...baseCtx(
          { text: "blocked group" },
          {
            channels: {
              zalouser: {
                enabled: true,
                groupPolicy: "allowlist",
                groups: {
                  "g-allowed": { allow: true },
                },
              },
            },
          },
        ),
        to: "group:g-blocked",
      }),
    ).rejects.toThrow(/not allowlisted/);

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("allows group targets matched by groupPolicy allowlist", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g-allowed" });
    mockAccountConfig = {
      groupPolicy: "allowlist",
      groups: {
        "g-allowed": { allow: true },
      },
    };

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx(
        { text: "allowed group" },
        {
          channels: {
            zalouser: {
              enabled: true,
              groupPolicy: "allowlist",
              groups: {
                "g-allowed": { allow: true },
              },
            },
          },
        },
      ),
      to: "group:g-allowed",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "g-allowed",
      "allowed group",
      expect.objectContaining({ isGroup: true }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g-allowed" });
  });

  it("single media delegates to sendMedia", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-m1" });

    const result = await zalouserPlugin.outbound!.sendPayload!(
      baseCtx({ text: "cap", mediaUrl: "https://example.com/a.jpg" }),
    );

    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalouser" });
  });

  it("treats bare numeric targets as direct chats for backward compatibility", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-d1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello" }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      "hello",
      expect.objectContaining({ isGroup: false }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-d1" });
  });

  it("preserves provider-native group ids when sending to raw g- targets", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g-native" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello native group" }, configuredOpenZalouserConfig),
      to: "g-1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "g-1471383327500481391",
      "hello native group",
      expect.objectContaining({ isGroup: true }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g-native" });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-2" });

    const result = await zalouserPlugin.outbound!.sendPayload!(
      baseCtx({
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      }),
    );

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenNthCalledWith(
      1,
      "987654321",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(mockedSend).toHaveBeenNthCalledWith(
      2,
      "987654321",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-2" });
  });

  it("empty payload returns no-op", async () => {
    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({}));

    expect(mockedSend).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "zalouser", messageId: "" });
  });

  it("chunking splits long text", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-c1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-c2" });

    const longText = "a".repeat(3000);
    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({ text: longText }));

    // textChunkLimit is 2000 with chunkTextForOutbound, so it should split
    expect(mockedSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockedSend.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(2000);
    }
    expect(result).toMatchObject({ channel: "zalouser" });
  });
});

describe("zalouserPlugin messaging target normalization", () => {
  it("normalizes user/group aliases to canonical targets", () => {
    const normalize = zalouserPlugin.messaging?.normalizeTarget;
    expect(normalize).toBeTypeOf("function");
    if (!normalize) {
      return;
    }
    expect(normalize("zlu:g:30003")).toBe("group:30003");
    expect(normalize("zalouser:u:20002")).toBe("user:20002");
    expect(normalize("zlu:g-30003")).toBe("group:g-30003");
    expect(normalize("zalouser:u-20002")).toBe("user:u-20002");
    expect(normalize("20002")).toBe("20002");
  });

  it("treats canonical and provider-native user/group targets as ids", () => {
    const looksLikeId = zalouserPlugin.messaging?.targetResolver?.looksLikeId;
    expect(looksLikeId).toBeTypeOf("function");
    if (!looksLikeId) {
      return;
    }
    expect(looksLikeId("user:20002")).toBe(true);
    expect(looksLikeId("group:30003")).toBe(true);
    expect(looksLikeId("g-30003")).toBe(true);
    expect(looksLikeId("u-20002")).toBe(true);
    expect(looksLikeId("Alice Nguyen")).toBe(false);
  });
});
