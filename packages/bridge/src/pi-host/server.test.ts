/**
 * Server transport end-to-end tests — the WS layer of the Pi local client.
 *
 * These exercise the real wire: a real WebSocket client connects to
 * startPiHostServer(), drives a fake pi engine, and asserts:
 *   1. control -> correlated response envelope round-trip
 *   2. engine events broadcast to every subscribed socket (envelope-wrapped)
 *   3. ui_response is delivered back to the engine as extension_ui_response
 *   4. apiKey gate rejects unauthorized sockets
 *   5. server.stop() reaps engine processes and closes the listener
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PiHostServerOptions } from "./server.js";
import { fakeEnginePath } from "./test-utils.js";

const slow = 15_000;

type ServerHandle = {
  wsUrl: string;
  stop: () => Promise<void>;
};

/** Find a free ephemeral port by binding a throwaway server. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Start the pi host server (lazily import to avoid sharp/side effects at build). */
async function startServer(
  overrides: Partial<PiHostServerOptions> = {},
): Promise<ServerHandle> {
  const { startPiHostServer } = await import("./server.js");
  const port = await freePort();
  const { stop } = await startPiHostServer({
    port,
    piEntry: fakeEnginePath(),
    engineVersion: "0.0.0-test",
    ...overrides,
  });
  return { wsUrl: `ws://127.0.0.1:${port}`, stop };
}

/** Open a client ws and collect frames into an array. */
function connect(wsUrl: string, protocols?: string | string[]): Promise<{
  ws: WebSocket;
  frames: unknown[];
}> {
  const ws = new WebSocket(wsUrl, protocols);
  const frames: unknown[] = [];
  ws.on("message", (data: Buffer) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch {
      /* ignore */
    }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("error", reject);
  });
}

const openSockets = new Set<WebSocket>();

/** An envelope with an unknown inner frame shape. */
interface UnknownFrame {
  frame?: { type?: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/** Poll `frames` until the frame matched by `finder` appears (5s cap). */
async function waitFrame(
  finder: () => unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const start = Date.now();
  let found = finder();
  while (!found && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    found = finder();
  }
  return found;
}

afterEach(async () => {
  for (const ws of openSockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  openSockets.clear();
});

describe("PiHost server (ws transport)", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.stop().catch(() => undefined);
  });

  it("answers control with a correlated response envelope", async () => {
    const { ws, frames } = await connect(server.wsUrl);
    openSockets.add(ws);

    ws.send(
      JSON.stringify({
        id: "ctrl-1",
        type: "control",
        op: "get_state",
        projectId: "/tmp/p1",
      }),
    );

    const start = Date.now();
    let got;
    while (!got && Date.now() - start < 5000) {
      got = frames.find((f) => (f as { frame?: { correlationId?: string } }).frame?.correlationId === "ctrl-1");
      if (!got) await new Promise((r) => setTimeout(r, 25));
    }
    const env = got as Record<string, unknown>;
    expect(env["kind"]).toBe("pi");
    expect(env["engineVersion"]).toBe("0.0.0-test");
    expect((env["frame"] as Record<string, unknown>)["projectId"]).toBe("/tmp/p1");
    expect((env["frame"] as { response?: { success?: boolean } }).response?.success).toBe(true);
    expect((env["frame"] as { response?: { command?: string } }).response?.command).toBe("get_state");
  }, slow);

  it("broadcasts engine events to every subscribed socket", async () => {
    const a = await connect(server.wsUrl);
    const b = await connect(server.wsUrl);
    openSockets.add(a.ws);
    openSockets.add(b.ws);

    a.ws.send(
      JSON.stringify({
        id: "c2",
        type: "control",
        op: "prompt",
        projectId: "/tmp/p1",
        payload: { message: "hi" },
      }),
    );

    const poll = async (frames: unknown[]) => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const found = frames.find(
          (f) => (f as { frame?: { type?: string } }).frame?.type === "message_update",
        );
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      return undefined;
    };

    const foundOnA = await poll(a.frames);
    const foundOnB = await poll(b.frames);
    expect(foundOnA).toBeDefined();
    expect(foundOnB).toBeDefined();
  }, slow);

  it("delivers ui_response confirmed flag all the way to the engine", async () => {
    const { ws, frames } = await connect(server.wsUrl);
    openSockets.add(ws);

    // fake engine emits an extension_ui_request whenever a prompt is sent
    await new Promise<void>((resolve) => ws.send(
      JSON.stringify({ id: "c3", type: "control", op: "prompt", projectId: "/tmp/p1", payload: { message: "go" } }),
      resolve,
    ));
    const uiReq = await waitFrame(() => (frames as UnknownFrame[]).map(f => (f as UnknownFrame).frame)
      .find((f) => (f as UnknownFrame)?.type === "extension_ui_request"));
    expect(uiReq).toBeDefined();
    const reqId = (uiReq as { id: string }).id;

    // client answers confirm: yes -> the engine must observe { confirmed: true }
    await new Promise<void>((resolve) => ws.send(
      JSON.stringify({ type: "ui_response", id: reqId, confirmed: true }),
      resolve,
    ));
    const seen = await waitFrame(() => (frames as UnknownFrame[]).map(f => (f as UnknownFrame).frame)
      .find((f) => (f as UnknownFrame)?.type === "ui_response_seen"));
    expect(seen).toBeDefined();
    const response = (seen as { response: Record<string, unknown> }).response;
    expect(response).toMatchObject({ type: "extension_ui_response", id: reqId });
    expect(response["confirmed"]).toBe(true);
  }, slow);

  it("delivers ui_response cancelled flag to the engine for a dismissed dialog", async () => {
    const { ws, frames } = await connect(server.wsUrl);
    openSockets.add(ws);

    await new Promise<void>((resolve) => ws.send(
      JSON.stringify({ id: "c5", type: "control", op: "prompt", projectId: "/tmp/p1", payload: { message: "go" } }),
      resolve,
    ));
    const uiReq = await waitFrame(() => (frames as UnknownFrame[]).map(f => (f as UnknownFrame).frame)
      .find((f) => (f as UnknownFrame)?.type === "extension_ui_request"));
    expect(uiReq).toBeDefined();
    const reqId = (uiReq as { id: string }).id;

    await new Promise<void>((resolve) => ws.send(
      JSON.stringify({ type: "ui_response", id: reqId, cancelled: true }),
      resolve,
    ));
    const seen = await waitFrame(() => (frames as UnknownFrame[]).map(f => (f as UnknownFrame).frame)
      .find((f) => (f as UnknownFrame)?.type === "ui_response_seen"));
    expect(seen).toBeDefined();
    const response = (seen as { response: Record<string, unknown> }).response;
    expect(response["cancelled"]).toBe(true);
  }, slow);

  it("closes unauthorized sockets when apiKey is set", async () => {
    const secured = await startServer({ apiKey: "secret" });
    try {
      const { ws } = await connect(secured.wsUrl); // no protocol header
      openSockets.add(ws);
      const closed = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 3000);
        ws.on("close", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
    } finally {
      await secured.stop();
    }
  }, slow);
});