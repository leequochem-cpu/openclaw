import { describe, expect, it } from "vitest";
import {
  normalizeMatrixAllowList,
  normalizeMatrixUserId,
  resolveMatrixAllowListMatch,
} from "./allowlist.js";

describe("resolveMatrixAllowListMatch", () => {
  it("matches full user IDs and prefixes without folding case", () => {
    const userId = "@Alice:Example.org";
    const direct = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([userId]),
      userId,
    });
    expect(direct.allowed).toBe(true);
    expect(direct.matchSource).toBe("id");

    const prefixedMatrix = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([`MATRIX:${userId}`]),
      userId,
    });
    expect(prefixedMatrix.allowed).toBe(true);
    expect(prefixedMatrix.matchSource).toBe("prefixed-id");

    const prefixedUser = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([`USER:${userId}`]),
      userId,
    });
    expect(prefixedUser.allowed).toBe(true);
    expect(prefixedUser.matchSource).toBe("prefixed-user");
  });

  it("ignores display names and localparts", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["alice", "Alice"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(false);
  });

  it("matches wildcard", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["*"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(true);
    expect(match.matchSource).toBe("wildcard");
  });

  it("rejects ASCII case-distinct Matrix IDs", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["@alice:example.org"]),
      userId: "@Alice:example.org",
    });
    expect(match.allowed).toBe(false);
  });

  it("rejects Unicode case-folding collisions", () => {
    const kelvinId = "@\u212A:example.org";
    expect(kelvinId.toLowerCase()).toBe("@k:example.org");
    expect(normalizeMatrixUserId(kelvinId)).toBe(kelvinId);

    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["@k:example.org"]),
      userId: kelvinId,
    });
    expect(match.allowed).toBe(false);
  });
});
