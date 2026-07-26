import { beforeEach, describe, expect, it, vi } from "vitest";

const service = {
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  isLoaded: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
};

const removeStateAndLinkedPaths = vi.fn();
const removeWorkspaceDirs = vi.fn();
const removePath = vi.fn();

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../config/config.js", () => ({
  isNixMode: false,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanFromDisk: () => ({
    stateDir: "/tmp/openclaw-state",
    configPath: "/tmp/openclaw-state/openclaw.json",
    oauthDir: "/tmp/openclaw-state/credentials",
    configInsideState: true,
    oauthInsideState: true,
    workspaceDirs: ["/tmp/openclaw-workspace"],
  }),
}));

vi.mock("./cleanup-utils.js", () => ({
  removePath: (...args: unknown[]) => removePath(...args),
  removeStateAndLinkedPaths: (...args: unknown[]) => removeStateAndLinkedPaths(...args),
  removeWorkspaceDirs: (...args: unknown[]) => removeWorkspaceDirs(...args),
}));

import { uninstallCommand } from "./uninstall.js";

describe("uninstallCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockResolvedValue(true);
    service.stop.mockResolvedValue(undefined);
    service.uninstall.mockResolvedValue(undefined);
    removeStateAndLinkedPaths.mockResolvedValue(undefined);
    removeWorkspaceDirs.mockResolvedValue(undefined);
    removePath.mockResolvedValue({ ok: true });
  });

  it("aborts state wipe when gateway stop fails and service stays loaded", async () => {
    service.stop.mockRejectedValue(new Error("permission denied"));
    service.isLoaded
      .mockResolvedValueOnce(true) // initial loaded check
      .mockResolvedValueOnce(true); // still loaded after stop failure

    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(service.uninstall).not.toHaveBeenCalled();
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Aborting state/workspace removal"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("aborts state wipe when service uninstall fails", async () => {
    service.uninstall.mockRejectedValue(new Error("disable failed"));
    service.isLoaded.mockResolvedValue(true);

    await uninstallCommand(runtime, {
      service: true,
      state: true,
      yes: true,
      nonInteractive: true,
    });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("removes state after a successful service uninstall", async () => {
    service.isLoaded
      .mockResolvedValueOnce(true) // initial
      .mockResolvedValueOnce(false); // after uninstall

    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.uninstall).toHaveBeenCalledTimes(1);
    expect(removeStateAndLinkedPaths).toHaveBeenCalledTimes(1);
    expect(removeWorkspaceDirs).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
