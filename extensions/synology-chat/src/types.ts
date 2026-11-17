/**
 * Type definitions for the Synology Chat channel plugin.
 */

/** Raw channel config from openclaw.json channels.synology-chat */
export interface SynologyChatChannelConfig {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  /**
   * When true, reply delivery may retarget the webhook username/nickname
   * through the Chat user list. Usernames are mutable, so this can send a
   * reply to a different person than the authorized webhook user_id.
   */
  dangerouslyAllowNameMatching?: boolean;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
  accounts?: Record<string, SynologyChatAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface SynologyChatAccountRaw {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dangerouslyAllowNameMatching?: boolean;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedSynologyChatAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  incomingUrl: string;
  nasHost: string;
  webhookPath: string;
  /** Defaults false. See SynologyChatChannelConfig.dangerouslyAllowNameMatching. */
  dangerouslyAllowNameMatching: boolean;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedUserIds: string[];
  rateLimitPerMinute: number;
  botName: string;
  allowInsecureSsl: boolean;
}

/** Payload received from Synology Chat outgoing webhook (form-urlencoded) */
export interface SynologyWebhookPayload {
  token: string;
  channel_id?: string;
  channel_name?: string;
  user_id: string;
  username: string;
  post_id?: string;
  timestamp?: string;
  text: string;
  trigger_word?: string;
}
