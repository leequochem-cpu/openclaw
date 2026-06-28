import { rm, stat, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildMcpProxyAgentCommand } from "./mcp-agent-command.js";

function extractPayloadFile(command: string): string {
  const match = command.match(/--payload-file\s+(?:"([^"]+)"|(\S+))/);
  const payloadPath = match?.[1] ?? match?.[2];
  if (!payloadPath) {
    throw new Error(`payload file missing from command: ${command}`);
  }
  return payloadPath;
}

describe("mcp-agent-command", () => {
  it("keeps MCP server environment secrets out of the proxy command line", async () => {
    const secret = "super-secret-token";
    const command = buildMcpProxyAgentCommand({
      targetCommand: "npx @zed-industries/codex-acp",
      mcpServers: [
        {
          name: "canva",
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: [{ name: "CANVA_TOKEN", value: secret }],
        },
      ],
    });
    const payloadPath = extractPayloadFile(command);

    try {
      expect(command).toContain("--payload-file");
      expect(command).not.toContain(secret);
      expect(command).not.toContain("CANVA_TOKEN");

      const payloadStat = await stat(payloadPath);
      expect(payloadStat.mode & 0o777).toBe(0o600);
      expect(await readFile(payloadPath, "utf8")).toContain(secret);
    } finally {
      await rm(payloadPath, { force: true });
    }
  });
});
