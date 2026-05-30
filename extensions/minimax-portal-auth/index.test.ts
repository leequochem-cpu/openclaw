import type {
  OpenClawPluginApi,
  ProviderAuthContext,
} from "openclaw/plugin-sdk/minimax-portal-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loginMiniMaxPortalOAuthMock = vi.fn();

vi.mock("./oauth.js", () => ({
  loginMiniMaxPortalOAuth: loginMiniMaxPortalOAuthMock,
}));

type ProviderPlugin = Parameters<OpenClawPluginApi["registerProvider"]>[0];

describe("minimax portal auth plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginMiniMaxPortalOAuthMock.mockResolvedValue({
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      resourceUrl: "https://api.minimax.io/anthropic",
    });
  });

  it("does not register the removed Lightning model during OAuth login", async () => {
    const plugin = (await import("./index.js")).default;
    let registeredProvider: ProviderPlugin | undefined;
    const api = {
      registerProvider(provider: ProviderPlugin) {
        registeredProvider = provider;
      },
    } as unknown as OpenClawPluginApi;
    plugin.register(api);

    const stop = vi.fn();
    const ctx = {
      config: {},
      isRemote: false,
      runtime: {},
      openUrl: vi.fn(),
      oauth: {},
      prompter: {
        note: vi.fn(),
        progress: vi.fn(() => ({ stop })),
      },
    } as unknown as ProviderAuthContext;

    const result = await registeredProvider?.auth[0]?.run(ctx);

    expect(
      result?.configPatch?.models?.providers?.["minimax-portal"]?.models?.map((model) => model.id),
    ).toEqual(["MiniMax-M2.5", "MiniMax-M2.5-highspeed"]);
    expect(Object.keys(result?.configPatch?.agents?.defaults?.models ?? {})).toEqual([
      "minimax-portal/MiniMax-M2.5",
      "minimax-portal/MiniMax-M2.5-highspeed",
    ]);
    expect(loginMiniMaxPortalOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "global",
      }),
    );
  });
});
