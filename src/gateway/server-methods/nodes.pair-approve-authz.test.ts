import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { nodeHandlers } from "./nodes.js";

const pairingMocks = vi.hoisted(() => ({
  approveNodePairing: vi.fn(),
}));

vi.mock("../../infra/node-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/node-pairing.js")>(
    "../../infra/node-pairing.js",
  );
  return {
    ...actual,
    approveNodePairing: pairingMocks.approveNodePairing,
  };
});

function runApprove(scopes: string[] | undefined) {
  const respond = vi.fn();
  const broadcast = vi.fn();
  return {
    respond,
    broadcast,
    done: nodeHandlers["node.pair.approve"]({
      req: { type: "req", id: "req-1", method: "node.pair.approve" },
      params: { requestId: "pending-1" },
      respond,
      context: { broadcast } as never,
      client:
        scopes === undefined
          ? null
          : ({
              connect: { role: "operator", scopes },
            } as never),
      isWebchatConnect: () => false,
    }),
  };
}

describe("node.pair.approve caller scopes", () => {
  it("rejects a pairing-scoped caller and does not mark the request resolved", async () => {
    pairingMocks.approveNodePairing.mockResolvedValueOnce({
      status: "forbidden",
      missingScope: "operator.admin",
    });
    const { respond, broadcast, done } = runApprove(["operator.pairing"]);

    await done;

    expect(pairingMocks.approveNodePairing).toHaveBeenCalledWith("pending-1", {
      callerScopes: ["operator.pairing"],
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "missing scope: operator.admin",
      }),
    );
  });

  it("fails closed when the caller session has no scopes", async () => {
    pairingMocks.approveNodePairing.mockResolvedValueOnce({
      status: "forbidden",
      missingScope: "operator.write",
    });
    const { respond, done } = runApprove(undefined);

    await done;

    expect(pairingMocks.approveNodePairing).toHaveBeenCalledWith("pending-1", {
      callerScopes: [],
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "missing scope: operator.write" }),
    );
  });
});
