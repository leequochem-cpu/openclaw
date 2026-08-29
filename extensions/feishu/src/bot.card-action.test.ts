import { describe, it, expect, vi } from "vitest";
import {
  handleFeishuCardAction,
  hasFeishuCardActionContextChatId,
  normalizeFeishuCardActionChatType,
  resolveFeishuCardActionChatId,
  resolveFeishuCardActionChatType,
  type FeishuCardActionEvent,
} from "./card-action.js";

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

import { handleFeishuMessage } from "./bot.js";

function websocketCardEvent(overrides: Partial<FeishuCardActionEvent> = {}): FeishuCardActionEvent {
  return {
    operator: { open_id: "ou_user1" },
    token: "tok-ws",
    action: { value: { command: "/status" }, tag: "button" },
    context: { open_chat_id: "oc_group_1" },
    ...overrides,
  };
}

describe("Feishu card action chat id", () => {
  it("prefers official WebSocket open_chat_id when chat_id is absent", () => {
    expect(resolveFeishuCardActionChatId(websocketCardEvent())).toBe("oc_group_1");
    expect(hasFeishuCardActionContextChatId(websocketCardEvent())).toBe(true);
  });

  it("keeps HTTP-style context.chat_id when present", () => {
    const event = websocketCardEvent({
      context: { chat_id: "oc_http_1", open_chat_id: "oc_group_1" },
    });
    expect(resolveFeishuCardActionChatId(event)).toBe("oc_http_1");
  });

  it("falls back to operator open_id only when no chat id is present", () => {
    const event = websocketCardEvent({ context: {} });
    expect(resolveFeishuCardActionChatId(event)).toBe("ou_user1");
    expect(hasFeishuCardActionContextChatId(event)).toBe(false);
  });
});

describe("Feishu card action chat type", () => {
  it("uses chat_mode and does not treat private as p2p", () => {
    expect(normalizeFeishuCardActionChatType("p2p", "private")).toBe("p2p");
    expect(normalizeFeishuCardActionChatType("group", "private")).toBe("group");
    expect(normalizeFeishuCardActionChatType("topic", "private")).toBe("group");
    expect(normalizeFeishuCardActionChatType(undefined, "public")).toBe("group");
    expect(normalizeFeishuCardActionChatType(undefined, "private")).toBeUndefined();
  });

  it("treats WebSocket group chats as group after lookup", async () => {
    const chatType = await resolveFeishuCardActionChatType({
      event: websocketCardEvent(),
      chatId: "oc_group_1",
      account: { accountId: "mock-account" } as never,
      resolveChatType: async () => "group",
    });
    expect(chatType).toBe("group");
  });

  it("treats unresolved context chat ids as group so groupPolicy stays in front", async () => {
    const chatType = await resolveFeishuCardActionChatType({
      event: websocketCardEvent(),
      chatId: "oc_group_1",
      account: { accountId: "mock-account" } as never,
      resolveChatType: async () => {
        throw new Error("chat.get unavailable");
      },
    });
    expect(chatType).toBe("group");
  });

  it("uses p2p only when no context chat id is present", async () => {
    const event = websocketCardEvent({ context: {} });
    const resolveChatType = vi.fn(async () => "group" as const);
    const chatType = await resolveFeishuCardActionChatType({
      event,
      chatId: "ou_user1",
      account: { accountId: "mock-account" } as never,
      resolveChatType,
    });
    expect(chatType).toBe("p2p");
    expect(resolveChatType).not.toHaveBeenCalled();
  });
});

describe("Feishu Card Action Handler", () => {
  const cfg = {} as never;
  const runtime = { log: vi.fn(), error: vi.fn() } as never;

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({
      cfg,
      event,
      runtime,
      resolveChatType: async () => "group",
    });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            chat_id: "chat1",
            chat_type: "group",
          }),
        }),
      }),
    );
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok2",
      action: { value: { key: "val" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"{\\"key\\":\\"val\\"}"}',
            chat_id: "u123",
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("routes official WebSocket group card clicks through group chat_type", async () => {
    await handleFeishuCardAction({
      cfg,
      event: websocketCardEvent(),
      runtime,
      botOpenId: "ou_bot",
      resolveChatType: async () => "group",
    });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "oc_group_1",
            chat_type: "group",
            content: '{"text":"/status"}',
            mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
          }),
        }),
      }),
    );
  });

  it("does not treat presence of a chat id as group when chat_mode is p2p", async () => {
    await handleFeishuCardAction({
      cfg,
      event: websocketCardEvent({
        context: { open_chat_id: "oc_dm_1" },
        action: { value: { text: "confirm" }, tag: "button" },
      }),
      runtime,
      resolveChatType: async () => "p2p",
    });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "oc_dm_1",
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });
});
