import { afterEach, describe, expect, it } from "vitest";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";

afterEach(() => {
  clearPluginCommands();
});

describe("handlePluginCommand gateway scopes", () => {
  it("passes chat.send connect scopes through to plugin commands", async () => {
    let seen: string[] | undefined;
    const registered = registerPluginCommand("demo-plugin", {
      name: "scopeprobe",
      description: "Scope probe",
      handler: async (ctx) => {
        seen = ctx.gatewayClientScopes;
        return { text: "scoped" };
      },
    });
    expect(registered).toEqual({ ok: true });

    const result = await handlePluginCommand(
      {
        ctx: {
          GatewayClientScopes: ["operator.write", "operator.pairing"],
          AccountId: "main",
        },
        cfg: {},
        command: {
          channel: "webchat",
          isAuthorizedSender: true,
          commandBodyNormalized: "/scopeprobe",
          senderId: "webchat-client",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply).toEqual({ text: "scoped" });
    expect(seen).toEqual(["operator.write", "operator.pairing"]);
  });
});
