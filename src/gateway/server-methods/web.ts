import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);

const resolveWebLoginProvider = () =>
  listChannelPlugins().find((plugin) =>
    (plugin.gatewayMethods ?? []).some((method) => WEB_LOGIN_METHODS.has(method)),
  ) ?? null;

function resolveAccountId(params: unknown): string | undefined {
  return typeof (params as { accountId?: unknown }).accountId === "string"
    ? (params as { accountId?: string }).accountId
    : undefined;
}

function respondProviderUnavailable(respond: RespondFn) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "web login provider is not available"),
  );
}

function respondProviderUnsupported(respond: RespondFn, providerId: string) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`),
  );
}

async function restartWebLoginChannel(params: {
  startChannel: (channelId: ChannelId, accountId?: string) => Promise<void>;
  channelId: ChannelId;
  accountId?: string;
}): Promise<void> {
  // stopChannel marks accounts manuallyStopped; always clear that latch on
  // failed/cancelled QR login so health-monitor/auto-start can recover, and so
  // an existing linked session is brought back online instead of staying dead.
  try {
    await params.startChannel(params.channelId, params.accountId);
  } catch {
    // Best-effort restore; the original login error is what we surface.
  }
}

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context }) => {
    if (!validateWebLoginStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
        ),
      );
      return;
    }
    const accountId = resolveAccountId(params);
    const provider = resolveWebLoginProvider();
    if (!provider) {
      respondProviderUnavailable(respond);
      return;
    }
    let stopped = false;
    try {
      await context.stopChannel(provider.id, accountId);
      stopped = true;
      if (!provider.gateway?.loginWithQrStart) {
        await restartWebLoginChannel({
          startChannel: context.startChannel,
          channelId: provider.id,
          accountId,
        });
        respondProviderUnsupported(respond, provider.id);
        return;
      }
      const result = await provider.gateway.loginWithQrStart({
        force: Boolean((params as { force?: boolean }).force),
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        verbose: Boolean((params as { verbose?: boolean }).verbose),
        accountId,
      });
      respond(true, result, undefined);
    } catch (err) {
      if (stopped) {
        await restartWebLoginChannel({
          startChannel: context.startChannel,
          channelId: provider.id,
          accountId,
        });
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "web.login.wait": async ({ params, respond, context }) => {
    if (!validateWebLoginWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
        ),
      );
      return;
    }
    const accountId = resolveAccountId(params);
    const provider = resolveWebLoginProvider();
    if (!provider) {
      respondProviderUnavailable(respond);
      return;
    }
    if (!provider.gateway?.loginWithQrWait) {
      respondProviderUnsupported(respond, provider.id);
      return;
    }
    try {
      const result = await provider.gateway.loginWithQrWait({
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        accountId,
      });
      // Always restart after wait settles. On success this picks up the new
      // session; on timeout/cancel/failure it clears manuallyStopped and
      // restores any previously linked session instead of leaving WhatsApp dead.
      await restartWebLoginChannel({
        startChannel: context.startChannel,
        channelId: provider.id,
        accountId,
      });
      respond(true, result, undefined);
    } catch (err) {
      await restartWebLoginChannel({
        startChannel: context.startChannel,
        channelId: provider.id,
        accountId,
      });
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
