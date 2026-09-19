import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it("rejects malformed runtime command shapes", () => {
    const invalidName = registerPluginCommand(
      "demo-plugin",
      // Runtime plugin payloads are untyped; guard at boundary.
      {
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
    );
    expect(invalidName).toEqual({
      ok: false,
      error: "Command name must be a string",
    });

    const invalidDescription = registerPluginCommand("demo-plugin", {
      name: "demo",
      description: undefined as unknown as string,
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidDescription).toEqual({
      ok: false,
      error: "Command description must be a string",
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "voice",
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
      handler: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({ ok: true });
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("discord")).toEqual([
      {
        name: "discordvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });
});

describe("executePluginCommand ownerOnly", () => {
  const ownerOnlyCommand = {
    name: "pair",
    description: "Generate setup codes and approve device pairing requests.",
    acceptsArgs: true,
    ownerOnly: true,
    handler: async () => ({ text: "secret-setup-code" }),
  };

  function registerOwnerOnlyPairCommand() {
    const result = registerPluginCommand("device-pair", ownerOnlyCommand);
    expect(result).toEqual({ ok: true });
    const match = matchPluginCommand("/pair");
    expect(match?.command.ownerOnly).toBe(true);
    return match!.command;
  }

  it("blocks authorized non-owners from ownerOnly commands", async () => {
    const command = registerOwnerOnlyPairCommand();
    const result = await executePluginCommand({
      command,
      senderId: "111",
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: false,
      commandBody: "/pair",
      config: {
        commands: { ownerAllowFrom: ["999"] },
      } as OpenClawConfig,
      from: "telegram:111",
    });

    expect(result.text).toBe("⚠️ This command is limited to the gateway owner.");
  });

  it("allows configured owners to run ownerOnly commands", async () => {
    const command = registerOwnerOnlyPairCommand();
    const result = await executePluginCommand({
      command,
      senderId: "999",
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/pair",
      config: {
        commands: { ownerAllowFrom: ["999"] },
      } as OpenClawConfig,
      from: "telegram:999",
    });

    expect(result.text).toBe("secret-setup-code");
  });

  it("fails closed when ownerAllowFrom is unset and senderIsOwner is omitted", async () => {
    const command = registerOwnerOnlyPairCommand();
    const result = await executePluginCommand({
      command,
      senderId: "111",
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: "/pair",
      config: {} as OpenClawConfig,
      from: "telegram:111",
    });

    expect(result.text).toBe("⚠️ This command is limited to the gateway owner.");
  });

  it("resolves ownerAllowFrom when native callers omit senderIsOwner", async () => {
    const command = registerOwnerOnlyPairCommand();
    const result = await executePluginCommand({
      command,
      senderId: "999",
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: "/pair",
      config: {
        commands: { ownerAllowFrom: ["999"] },
      } as OpenClawConfig,
      from: "telegram:42",
    });

    expect(result.text).toBe("secret-setup-code");
  });
});
