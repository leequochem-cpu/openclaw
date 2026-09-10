import { describe, expect, it } from "vitest";
import { isFeishuGroupChat } from "./chat-type.js";

describe("isFeishuGroupChat", () => {
  it("treats p2p as a direct message", () => {
    expect(isFeishuGroupChat("p2p")).toBe(false);
    expect(isFeishuGroupChat("P2P")).toBe(false);
  });

  it("treats native topic groups as group chats", () => {
    expect(isFeishuGroupChat("topic_group")).toBe(true);
  });

  it("treats ordinary groups as group chats", () => {
    expect(isFeishuGroupChat("group")).toBe(true);
  });

  it("fails closed to group for unknown non-p2p types", () => {
    expect(isFeishuGroupChat("private")).toBe(true);
    expect(isFeishuGroupChat("unknown")).toBe(true);
  });

  it("does not infer group from a missing chat_type", () => {
    expect(isFeishuGroupChat(undefined)).toBe(false);
    expect(isFeishuGroupChat("")).toBe(false);
  });
});
