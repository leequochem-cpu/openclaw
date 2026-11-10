import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const tools = createOpenClawCodingTools({ messageProvider });
      const names = new Set(tools.map((tool) => tool.name));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("tts")).toBe(true);
  });

  it.each(["node", "NODE", " Node "])(
    "keeps node-originated runs off host exec tools: %s",
    (messageProvider) => {
      const tools = createOpenClawCodingTools({ messageProvider });
      const names = new Set(tools.map((tool) => tool.name));
      expect(names.has("exec")).toBe(false);
      expect(names.has("process")).toBe(false);
      expect(names.has("read")).toBe(false);
      expect(names.has("write")).toBe(false);
      expect(names.has("gateway")).toBe(false);
      expect(names.has("message")).toBe(false);
      expect(names.has("tts")).toBe(true);
      expect(names.has("web_fetch")).toBe(true);
      expect(names.has("web_search")).toBe(true);
    },
  );
});
