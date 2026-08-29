import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown> | string;
    tag: string;
  };
  context?: {
    open_id?: string;
    user_id?: string;
    chat_id?: string;
    open_chat_id?: string;
    open_message_id?: string;
  };
};

const CARD_ACTION_CHAT_LOOKUP_TIMEOUT_MS = 1_500;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveFeishuCardActionChatId(event: FeishuCardActionEvent): string {
  return (
    readNonEmptyString(event.context?.chat_id) ??
    readNonEmptyString(event.context?.open_chat_id) ??
    event.operator.open_id
  );
}

export function hasFeishuCardActionContextChatId(event: FeishuCardActionEvent): boolean {
  return Boolean(
    readNonEmptyString(event.context?.chat_id) ?? readNonEmptyString(event.context?.open_chat_id),
  );
}

/**
 * Feishu `chat_mode` is the conversation type (p2p/group/topic).
 * `chat_type` is privacy (private/public) and must not be used to infer p2p —
 * private groups also report chat_type=private.
 */
export function normalizeFeishuCardActionChatType(
  chatMode?: unknown,
  chatType?: unknown,
): "p2p" | "group" | undefined {
  const mode = typeof chatMode === "string" ? chatMode.trim().toLowerCase() : "";
  if (mode === "p2p") {
    return "p2p";
  }
  if (mode === "group" || mode === "topic") {
    return "group";
  }
  const type = typeof chatType === "string" ? chatType.trim().toLowerCase() : "";
  if (type === "public") {
    return "group";
  }
  return undefined;
}

export async function lookupFeishuCardActionChatType(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
}): Promise<"p2p" | "group" | undefined> {
  const client = createFeishuClient(params.account);
  const res = await client.im.chat.get({ path: { chat_id: params.chatId } });
  if (res.code !== 0) {
    return undefined;
  }
  return normalizeFeishuCardActionChatType(res.data?.chat_mode, res.data?.chat_type);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("card-action chat lookup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function resolveFeishuCardActionChatType(params: {
  event: FeishuCardActionEvent;
  chatId: string;
  account: ResolvedFeishuAccount;
  resolveChatType?: (chatId: string) => Promise<"p2p" | "group" | undefined>;
  log?: (message: string) => void;
}): Promise<"p2p" | "group"> {
  if (!hasFeishuCardActionContextChatId(params.event)) {
    return "p2p";
  }

  try {
    const lookup = params.resolveChatType
      ? params.resolveChatType(params.chatId)
      : lookupFeishuCardActionChatType({
          account: params.account,
          chatId: params.chatId,
        });
    const resolved = await withTimeout(lookup, CARD_ACTION_CHAT_LOOKUP_TIMEOUT_MS);
    if (resolved) {
      return resolved;
    }
  } catch {
    params.log?.(
      `feishu[${params.account.accountId}]: card-action chat type lookup failed; treating as group`,
    );
  }

  // Fail closed: an oc_* id is used for both DMs and groups. Treating an
  // unresolved chat as group keeps groupPolicy in front of pairing/DM paths.
  return "group";
}

function extractCardActionContent(actionValue: FeishuCardActionEvent["action"]["value"]): string {
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      return actionValue.text;
    }
    if ("command" in actionValue && typeof actionValue.command === "string") {
      return actionValue.command;
    }
    return JSON.stringify(actionValue);
  }
  return String(actionValue);
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  resolveChatType?: (chatId: string) => Promise<"p2p" | "group" | undefined>;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const content = extractCardActionContent(event.action.value);
  const chatId = resolveFeishuCardActionChatId(event);
  const chatType = await resolveFeishuCardActionChatType({
    event,
    chatId,
    account,
    resolveChatType: params.resolveChatType,
    log,
  });

  // Card button clicks are explicit bot interactions. Without this mention,
  // default group requireMention=true would drop every group card action
  // after chat_type is correctly classified as group.
  const mentions = params.botOpenId
    ? [{ key: "@_user_1", name: "Bot", id: { open_id: params.botOpenId } }]
    : undefined;

  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: chatId,
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text: content }),
      mentions,
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
