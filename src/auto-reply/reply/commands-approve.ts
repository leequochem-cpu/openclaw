import type { OpenClawConfig } from "../../config/config.js";
import { mergeDiscordAccountConfig } from "../../discord/accounts.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/approve";

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

/** Approver ids configured for the Discord button UI, or null when that gate is inactive. */
function resolveDiscordExecApprovers(
  cfg: OpenClawConfig,
  accountId?: string | null,
): string[] | null {
  const execApprovals = mergeDiscordAccountConfig(cfg, accountId).execApprovals;
  if (!execApprovals?.enabled) {
    return null;
  }
  const approvers = (execApprovals.approvers ?? [])
    .map((id) => String(id).trim())
    .filter((id) => id.length > 0);
  return approvers.length > 0 ? approvers : null;
}

function senderMatchesDiscordApprover(senderId: string | undefined, approvers: string[]): boolean {
  const sender = senderId?.trim();
  if (!sender) {
    return false;
  }
  return approvers.some((id) => id === sender);
}

/**
 * Discord component approvals already reject non-approvers. Text and slash
 * `/approve` must use the same list, otherwise a command-authorized channel
 * member can resolve a pending host exec request posted in that channel.
 */
function rejectDiscordNonApprover(
  params: Parameters<CommandHandler>[0],
): { shouldContinue: false; reply: { text: string } } | null {
  const channel = params.command.channelId ?? params.command.channel;
  if (channel !== "discord") {
    return null;
  }
  const approvers = resolveDiscordExecApprovers(params.cfg, params.ctx.AccountId);
  if (!approvers) {
    return null;
  }
  const allowed =
    senderMatchesDiscordApprover(params.ctx.SenderId, approvers) ||
    senderMatchesDiscordApprover(params.command.senderId, approvers);
  if (allowed) {
    return null;
  }
  logVerbose(
    `Ignoring /approve from non-approver Discord sender: ${params.command.senderId || params.ctx.SenderId || "<unknown>"}`,
  );
  return {
    shouldContinue: false,
    reply: { text: "⛔ You are not authorized to approve exec requests." },
  };
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/approve",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const discordApproverBlock = rejectDiscordNonApprover(params);
  if (discordApproverBlock) {
    return discordApproverBlock;
  }

  const resolvedBy = buildResolvedByLabel(params);
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
