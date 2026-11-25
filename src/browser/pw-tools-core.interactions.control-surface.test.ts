import { describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.interactions.js");

describe("pw-tools-core interaction control surface guard", () => {
  it("does not run evaluate on the browser debugging origin", async () => {
    const evaluate = vi.fn(async () => "secret");
    const close = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      evaluate,
      close,
      url: vi.fn(() => "http://localhost:18792/json/version"),
    });

    await expect(
      mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: "() => document.body.innerText",
      }),
    ).rejects.toThrow(/debugging endpoint/);

    expect(evaluate).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("does not return evaluate output when the page moves onto the debugging origin", async () => {
    const close = vi.fn(async () => {});
    let currentUrl = "https://example.com";
    const evaluate = vi.fn(async () => {
      currentUrl = "http://127.0.0.1:18792/json/version";
      return "should-not-leak";
    });
    setPwToolsCoreCurrentPage({
      evaluate,
      close,
      url: vi.fn(() => currentUrl),
    });

    await expect(
      mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: "() => location.href",
      }),
    ).rejects.toThrow(/debugging endpoint/);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes a tab that a click navigates onto the debugging origin", async () => {
    const close = vi.fn(async () => {});
    let currentUrl = "https://example.com";
    const click = vi.fn(async () => {
      currentUrl = "http://127.0.0.1:18792/json/list";
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({
      close,
      url: vi.fn(() => currentUrl),
    });

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        ref: "1",
      }),
    ).rejects.toThrow(/debugging endpoint/);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still evaluates a public page", async () => {
    const evaluate = vi.fn(async () => "ok");
    setPwToolsCoreCurrentPage({
      evaluate,
      url: vi.fn(() => "https://example.com"),
    });

    await expect(
      mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: "() => 1",
      }),
    ).resolves.toBe("ok");
  });
});
