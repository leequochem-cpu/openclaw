import type { RuntimeEnv } from "openclaw/plugin-sdk/zalouser";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listZaloGroupMembersMock = vi.hoisted(() => vi.fn(async () => []));
const listZaloGroupsMatchingMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./zalo-js.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listZaloGroupMembers: listZaloGroupMembersMock,
    listZaloGroupsMatching: listZaloGroupsMatchingMock,
  };
});

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveZalouserAccountSync: () => ({
      accountId: "default",
      profile: "default",
      name: "test",
      enabled: true,
      authenticated: true,
      config: {},
    }),
  };
});

import { zalouserPlugin } from "./channel.js";

const runtimeStub: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number): never => {
    throw new Error(`exit ${code}`);
  }) as RuntimeEnv["exit"],
};

beforeEach(() => {
  listZaloGroupMembersMock.mockClear();
  listZaloGroupsMatchingMock.mockReset();
});

describe("zalouser directory group members", () => {
  it("accepts prefixed group ids from directory groups list output", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "group:1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "1471383327500481391");
  });

  it("keeps backward compatibility for raw group ids", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "1471383327500481391");
  });

  it("accepts provider-native g- group ids without stripping the prefix", async () => {
    await zalouserPlugin.directory!.listGroupMembers!({
      cfg: {},
      accountId: "default",
      groupId: "g-1471383327500481391",
      runtime: runtimeStub,
    });

    expect(listZaloGroupMembersMock).toHaveBeenCalledWith("default", "g-1471383327500481391");
  });
});

describe("zalouser resolver group ids", () => {
  it("returns canonical group targets when resolving group names", async () => {
    listZaloGroupsMatchingMock.mockResolvedValue([
      { groupId: "1471383327500481391", name: "Team Chat", raw: {} },
    ]);

    const [result] = await zalouserPlugin.resolver!.resolveTargets({
      cfg: {},
      accountId: "default",
      inputs: ["Team Chat"],
      kind: "group",
      runtime: runtimeStub,
    });

    expect(result).toMatchObject({
      input: "Team Chat",
      resolved: true,
      id: "group:1471383327500481391",
      name: "Team Chat",
    });
  });

  it("preserves group semantics for explicit numeric group targets", async () => {
    const [result] = await zalouserPlugin.resolver!.resolveTargets({
      cfg: {},
      accountId: "default",
      inputs: ["1471383327500481391"],
      kind: "group",
      runtime: runtimeStub,
    });

    expect(result).toMatchObject({
      input: "1471383327500481391",
      resolved: true,
      id: "group:1471383327500481391",
    });
  });
});
