import type { OpenClawConfig } from "../config/config.js";
import { resolveDiscordAccount } from "./accounts.js";

function resolveDiscordExecApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveDiscordAccount(params).config.execApprovals?.approvers ?? [];
}

/** True when Discord button approvals are active and bound to an approver list. */
export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveDiscordAccount(params).config.execApprovals;
  return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}

/** True when the sender is listed in the account's Discord exec approvers. */
export function isDiscordExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  return resolveDiscordExecApprovers(params).some((approverId) => String(approverId) === senderId);
}
