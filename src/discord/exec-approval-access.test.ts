import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approval-access.js";

function discordCfg(discord: Record<string, unknown>): OpenClawConfig {
  return { channels: { discord } } as OpenClawConfig;
}

describe("discord exec approval access", () => {
  it("stays inactive until approvals are enabled with at least one approver", () => {
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: discordCfg({ execApprovals: { enabled: true, approvers: [] } }),
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: discordCfg({ execApprovals: { enabled: false, approvers: ["123"] } }),
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: discordCfg({ execApprovals: { enabled: true, approvers: ["123"] } }),
      }),
    ).toBe(true);
  });

  it("matches only the configured account approver list", () => {
    const cfg = discordCfg({
      execApprovals: { enabled: true, approvers: ["111"] },
      accounts: {
        work: { execApprovals: { enabled: true, approvers: ["123"] } },
      },
    });

    expect(isDiscordExecApprovalApprover({ cfg, accountId: "work", senderId: "123" })).toBe(true);
    expect(isDiscordExecApprovalApprover({ cfg, accountId: "default", senderId: "123" })).toBe(
      false,
    );
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "  " })).toBe(false);
  });
});
