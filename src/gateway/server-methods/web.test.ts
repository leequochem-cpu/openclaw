import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { webHandlers } from "./web.js";

describe("web.login channel restore", () => {
  const startChannel = vi.fn(async () => {});
  const stopChannel = vi.fn(async () => {});
  const loginWithQrStart = vi.fn();
  const loginWithQrWait = vi.fn();

  beforeEach(() => {
    startChannel.mockClear();
    stopChannel.mockClear();
    loginWithQrStart.mockReset();
    loginWithQrWait.mockReset();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "whatsapp" }),
            gatewayMethods: ["web.login.start", "web.login.wait"],
            gateway: {
              loginWithQrStart,
              loginWithQrWait,
            },
          },
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  const invoke = async (
    method: "web.login.start" | "web.login.wait",
    params: Record<string, unknown> = {},
  ) => {
    const respond = vi.fn();
    await webHandlers[method]({
      req: {} as never,
      params,
      respond,
      context: {
        startChannel,
        stopChannel,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    return respond;
  };

  it("restores the channel when QR start fails after stop", async () => {
    loginWithQrStart.mockRejectedValueOnce(new Error("qr failed"));
    const respond = await invoke("web.login.start", { force: true });

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(startChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("qr failed") }),
    );
  });

  it("restores the channel when wait times out without connecting", async () => {
    loginWithQrWait.mockResolvedValueOnce({
      connected: false,
      message: "Still waiting for the QR scan.",
    });
    const respond = await invoke("web.login.wait", {});

    expect(startChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      { connected: false, message: "Still waiting for the QR scan." },
      undefined,
    );
  });

  it("starts the channel after a successful wait", async () => {
    loginWithQrWait.mockResolvedValueOnce({
      connected: true,
      message: "Linked",
    });
    const respond = await invoke("web.login.wait", {});

    expect(startChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(respond).toHaveBeenCalledWith(true, { connected: true, message: "Linked" }, undefined);
  });

  it("restores the channel when wait throws", async () => {
    loginWithQrWait.mockRejectedValueOnce(new Error("socket closed"));
    const respond = await invoke("web.login.wait", {});

    expect(startChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("socket closed") }),
    );
  });
});
