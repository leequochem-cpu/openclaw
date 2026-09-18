import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
  type GatewayHttpServer,
} from "./server-http.test-harness.js";

async function listenOnEphemeralPort(server: GatewayHttpServer) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

async function closeServer(server: GatewayHttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function sendRawHttp(params: {
  port: number;
  request: string;
  timeoutMs?: number;
}): Promise<{ body: string; closed: boolean }> {
  const timeoutMs = params.timeoutMs ?? 2_000;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: params.port }, () => {
      socket.write(params.request);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket was not closed"));
    }, timeoutMs);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ body: Buffer.concat(chunks).toString("utf8"), closed: true });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("gateway HTTP malformed websocket upgrades", () => {
  it("ends the HTTP response instead of leaking the request socket", async () => {
    await withGatewayServer({
      prefix: "upgrade-leak-dispatch",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/" });
        req.headers.upgrade = "websocket";
        const { res, end, getBody } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(400);
        expect(end).toHaveBeenCalled();
        expect(getBody()).toContain("Bad Request");
      },
    });
  });

  it("closes sockets for Upgrade: websocket requests that omit Connection: upgrade", async () => {
    await withGatewayServer({
      prefix: "upgrade-leak-tcp",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const port = await listenOnEphemeralPort(server);
        try {
          const result = await sendRawHttp({
            port,
            request: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n",
          });
          expect(result.closed).toBe(true);
          expect(result.body).toMatch(/HTTP\/1\.1 400/);
        } finally {
          await closeServer(server);
        }
      },
    });
  });

  it("still handles ordinary HTTP requests after rejecting a malformed upgrade", async () => {
    await withGatewayServer({
      prefix: "upgrade-leak-followup",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const port = await listenOnEphemeralPort(server);
        try {
          await sendRawHttp({
            port,
            request: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n",
          });
          const followup = await sendRawHttp({
            port,
            request: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
          });
          expect(followup.closed).toBe(true);
          expect(followup.body).toMatch(/HTTP\/1\.1 200/);
        } finally {
          await closeServer(server);
        }
      },
    });
  });
});
