/**
 * Pi Host transport — standalone local WebSocket server exposing PiGateway.
 *
 * Wire (docs/ENGINE-INTEGRATION.md §6): the app talks to this server over
 * ws://127.0.0.1 and consumes pi frames 1:1 inside the envelope. Control
 * messages are answered with the correlated engine response frame.
 *
 * Run mode: `PI_HOST=1 npm run bridge` (see index.ts) or import directly.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PiGateway,
  PI_WIRE_PROTOCOL_VERSION,
  type PiFrameEnvelope,
  type ClientControlMessage,
} from "./pi-gateway.js";

export interface PiHostServerOptions {
  port: number;
  piEntry: string;
  engineVersion: string;
  /** projectId -> cwd. Defaults to identity (projectId is an absolute path). */
  resolveCwd?: (projectId: string) => string;
  apiKey?: string;
}

export function parsePort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export async function startPiHostServer(
  opts: PiHostServerOptions,
): Promise<{ httpServer: HttpServer; gateway: PiGateway; stop: () => Promise<void> }> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  const gateway = new PiGateway({
    piEntry: opts.piEntry,
    engineVersion: opts.engineVersion,
    protocolVersion: PI_WIRE_PROTOCOL_VERSION,
    resolveCwd: opts.resolveCwd ?? ((projectId) => projectId),
  });

  const sockets = new Set<WebSocket>();
  gateway.send = (envelope: PiFrameEnvelope) => {
    const raw = JSON.stringify(envelope);
    for (const ws of sockets) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      } catch {
        sockets.delete(ws);
      }
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    if (opts.apiKey !== undefined && opts.apiKey !== "") {
      const auth = ws.protocol === "" ? undefined : ws.protocol;
      if (auth !== opts.apiKey) {
        ws.close(4001, "unauthorized");
        return;
      }
    }
    sockets.add(ws);
    ws.on("message", (data) => {
      void (async () => {
        let msg: ClientControlMessage;
        try {
          msg = JSON.parse(String(data)) as ClientControlMessage;
        } catch {
          return;
        }
        if (msg.type !== "control") return;
        try {
          const response = await gateway.handleControl(msg);
          const frame: PiFrameEnvelope = {
            kind: "pi",
            engineVersion: opts.engineVersion,
            protocolVersion: PI_WIRE_PROTOCOL_VERSION,
            frame: {
              projectId: msg.projectId,
              correlationId: msg.id,
              response,
            },
          };
          try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); } catch { /* client gone */ }
        } catch (err) {
          const frame: PiFrameEnvelope = {
            kind: "pi",
            engineVersion: opts.engineVersion,
            protocolVersion: PI_WIRE_PROTOCOL_VERSION,
            frame: {
              projectId: msg.projectId,
              correlationId: msg.id,
              error: err instanceof Error ? err.message : String(err),
            },
          };
          try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); } catch { /* client gone */ }
        }
      })();
    });
    ws.on("close", () => {
      sockets.delete(ws);
    });
    ws.on("error", () => {
      sockets.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, "127.0.0.1", () => resolve());
  });

  const stop = async (): Promise<void> => {
    for (const ws of sockets) ws.close();
    await gateway.stopAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { httpServer, gateway, stop };
}
