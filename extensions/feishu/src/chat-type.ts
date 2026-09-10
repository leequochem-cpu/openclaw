export type FeishuChatType = "p2p" | "group" | "private" | "topic_group";

/**
 * Official Feishu/Lark `im.message.receive_v1` events use `p2p` for 1:1 chats.
 * Native topic groups send `chat_type: "topic_group"` (not `"group"`).
 * Treating only `"group"` as a group chat would skip groupPolicy and inject
 * topic-group traffic into the sender's DM session.
 */
export function isFeishuGroupChat(chatType: string | undefined | null): boolean {
  const normalized = (chatType ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "p2p";
}
