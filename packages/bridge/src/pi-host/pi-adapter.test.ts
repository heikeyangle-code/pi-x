/**
 * PiAdapter unit tests — drive routing with a fake gateway (no real pi spawn).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiAdapter, type PiGatewayLike } from "./pi-adapter.js";
import type { PiFrameEnvelope } from "./pi-gateway.js";
import { generateAutoRenameName } from "../auto-rename.js";

vi.mock("../auto-rename.js", () => ({
  generateAutoRenameName: vi.fn(),
}));

const generateMock = vi.mocked(generateAutoRenameName);

beforeEach(() => {
  generateMock.mockReset();
});

/** Minimal WebSocket stand-in (adapter only needs once()/close()). */
function fakeSocket(): {
  ws: unknown;
  close: ReturnType<typeof vi.fn>;
  listeners: Record<string, () => void>;
} {
  const listeners: Record<string, () => void> = {};
  const close = vi.fn(() => listeners["close"]?.());
  const ws = {
    once: vi.fn((ev: string, cb: () => void) => {
      listeners[ev] = cb;
    }),
    close,
  };
  return { ws, close, listeners };
}

function fakeGateway() {
  const controls: Array<Record<string, unknown>> = [];
  const responses: Array<{ id: string; value: unknown }> = [];
  const gateway: PiGatewayLike & { send?: (envelope: PiFrameEnvelope) => void } =
    {
      handleControl: vi.fn(async (msg) => {
        controls.push(msg as Record<string, unknown>);
        return { ok: true };
      }),
      respondUi: vi.fn((id: string, value: unknown) => {
        responses.push({ id, value });
        return true;
      }),
      send: undefined,
      stopAll: vi.fn(async () => {}),
    };
  return { gateway, controls, responses };
}

function makeAdapter() {
  const f = fakeGateway();
  const adapter = new PiAdapter({ gateway: f.gateway });
  const delivered: Array<Record<string, unknown>> = [];
  adapter.deliver = (_ws, msg) =>
    delivered.push(msg as Record<string, unknown>);
  return { adapter, gateway: f.gateway, controls: f.controls, responses: f.responses, delivered };
}

describe("PiAdapter", () => {
  it("accepts only CC chat-turn ops (files/workspace ops stay on bridge)", () => {
    const { adapter } = makeAdapter();
    for (const t of ["start", "input", "approve", "reject", "answer", "stop_session"]) {
      expect(adapter.accepts({ type: t } as never)).toBe(true);
    }
    for (const t of ["list_directory", "get_diff", "get_usage", "client_capabilities"]) {
      expect(adapter.accepts({ type: t } as never)).toBe(false);
    }
  });

  it("start binds the socket to the project, warms the engine, replies idle", async () => {
    const { adapter, controls, delivered } = makeAdapter();
    const { ws } = fakeSocket();
    const handled = await adapter.handle(ws as never, {
      type: "start",
      projectId: "/proj",
      projectPath: "/proj",
    } as never);
    expect(handled).toBe(true);
    expect(controls[0]?.op).toBe("get_state");
    expect(controls[0]?.projectId).toBe("/proj");
    // The app navigates on session_created and correlates history by the
    // returned sessionId; a status follows so the chat is ready.
    expect(delivered).toHaveLength(2);
    const created = delivered[0];
    expect(created?.type).toBe("system");
    expect(created?.subtype).toBe("session_created");
    expect(created?.provider).toBe("pi");
    expect(created?.projectPath).toBe("/proj");
    expect(typeof created?.sessionId).toBe("string");
    expect(created?.sessionId).not.toBe("");
    expect(delivered[1]).toEqual({
      type: "status",
      status: "idle",
      sessionId: created?.sessionId,
    });
  });

  it("start keeps an app-provided sessionId (resume/new flows)", async () => {
    const { adapter, delivered } = makeAdapter();
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, {
      type: "start",
      projectPath: "/proj",
      sessionId: "app-session-1",
    } as never);
    const created = delivered[0] as Record<string, unknown>;
    expect(created?.sessionId).toBe("app-session-1");
  });

  it("projectFor falls back to the session registry for sessionId-only messages", async () => {
    const { adapter, controls } = makeAdapter();
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, {
      type: "start",
      projectPath: "/proj",
      sessionId: "s1",
    } as never);
    // Simulate a fresh socket (no binding): sessionId -> project resolution
    // must still route the prompt to /proj.
    const { ws: ws2 } = fakeSocket();
    await adapter.handle(ws2 as never, {
      type: "input",
      text: "hi",
      sessionId: "s1",
    } as never);
    const prompt = controls.find((c) => c.op === "prompt");
    expect(prompt?.projectId).toBe("/proj");
  });

  it("input routes to prompt control (project bound via start's projectPath)", async () => {
    const { adapter, controls } = makeAdapter();
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, { type: "start", projectPath: "/p" } as never);
    await adapter.handle(ws as never, { type: "input", text: "hi", sessionId: "s1" } as never);
    const prompt = controls.find((c) => c.op === "prompt");
    expect(prompt?.payload).toEqual({ message: "hi" });
    expect(prompt?.projectId).toBe("/p");
  });

  it("surfaces failed engine responses (e.g. prompt with no provider) as CC error", async () => {
    const { adapter, gateway, delivered } = makeAdapter();
    (gateway.handleControl as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "no provider configured",
    });
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, { type: "start", projectPath: "/p" } as never);
    delivered.length = 0;
    await adapter.handle(ws as never, { type: "input", text: "hi", sessionId: "s1" } as never);
    expect(delivered).toEqual([
      { type: "error", message: "no provider configured", sessionId: "s1", projectId: "/p" },
    ]);
  });

  it("approve/reject/answer route to ui responses", async () => {
    const { adapter, responses } = makeAdapter();
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, { type: "start", projectPath: "/p" } as never);
    await adapter.handle(ws as never, { type: "approve", id: "r1", sessionId: "s" } as never);
    await adapter.handle(ws as never, { type: "reject", id: "r2", sessionId: "s" } as never);
    await adapter.handle(ws as never, { type: "answer", toolUseId: "r3", result: "43", sessionId: "s" } as never);
    expect(responses).toEqual([
      { id: "r1", value: { confirmed: true } },
      { id: "r2", value: { confirmed: false } },
      { id: "r3", value: { value: "43" } },
    ]);
  });

  it("stop_session routes to abort control", async () => {
    const { adapter, controls } = makeAdapter();
    const { ws } = fakeSocket();
    await adapter.handle(ws as never, { type: "start", projectPath: "/p" } as never);
    await adapter.handle(ws as never, { type: "stop_session", sessionId: "s" } as never);
    expect(controls.some((c) => c.op === "abort")).toBe(true);
  });

  it("forwards engine frames only to sockets subscribed to that project", () => {
    const { adapter, gateway, delivered } = makeAdapter();
    const a = fakeSocket();
    const b = fakeSocket();
    void adapter.handle(a.ws as never, { type: "start", projectPath: "/p1" } as never);
    void adapter.handle(b.ws as never, { type: "start", projectPath: "/p2" } as never);
    delivered.length = 0;
    gateway.send?.({
      kind: "pi",
      engineVersion: "dev",
      protocolVersion: 1,
      frame: {
        projectId: "/p1",
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      },
    });
    expect(delivered).toEqual([{ type: "stream_delta", text: "hello" }]);
  });

  it("maps extension_ui_request to permission_request and engine_exit to idle", () => {
    const { adapter, gateway, delivered } = makeAdapter();
    const s = fakeSocket();
    void adapter.handle(s.ws as never, { type: "start", projectPath: "/p" } as never);
    delivered.length = 0;
    gateway.send?.({
      kind: "pi", engineVersion: "dev", protocolVersion: 1,
      frame: { projectId: "/p", type: "extension_ui_request", id: "u1", method: "confirm", title: "T", message: "M" },
    });
    gateway.send?.({
      kind: "pi", engineVersion: "dev", protocolVersion: 1,
      frame: { projectId: "/p", type: "agent_settled" },
    });
    expect(delivered[0]).toMatchObject({
      type: "permission_request", toolUseId: "u1", toolName: "confirm", input: { title: "T", message: "M" },
    });
    expect(delivered[1]).toEqual({ type: "status", status: "idle" });
  });

  it("unsubscribes a socket on close and stops delivering to it", () => {
    const { adapter, gateway, delivered } = makeAdapter();
    const s = fakeSocket();
    void adapter.handle(s.ws as never, { type: "start", projectPath: "/p" } as never);
    s.close();
    delivered.length = 0;
    gateway.send?.({
      kind: "pi", engineVersion: "dev", protocolVersion: 1,
      frame: { projectId: "/p", type: "agent_start" },
    });
    expect(delivered).toEqual([]);
  });

  it("drops frames for unknown projects and messages without content", () => {
    const { adapter, gateway, delivered } = makeAdapter();
    const s = fakeSocket();
    void adapter.handle(s.ws as never, { type: "start", projectPath: "/p" } as never);
    delivered.length = 0;
    gateway.send?.({
      kind: "pi", engineVersion: "dev", protocolVersion: 1,
      frame: { projectId: "/other", type: "agent_start" },
    });
    gateway.send?.({
      kind: "pi", engineVersion: "dev", protocolVersion: 1,
      frame: { projectId: "/p", type: "message_update" }, // no assistantMessageEvent
    });
    expect(delivered).toEqual([]);
  });

  it("stopAll delegates to the gateway", async () => {
    const { adapter, gateway } = makeAdapter();
    await adapter.stopAll();
    expect((gateway.stopAll as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("non-chat messages are rejected (returns false, untouched)", async () => {
    const { adapter } = makeAdapter();
    const { ws } = fakeSocket();
    const handled = await adapter.handle(ws as never, { type: "list_directory", path: "/" } as never);
    expect(handled).toBe(false);
  });

  it("autoRename on a brand-new session names it from the first input", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway, controls, delivered } = makeAdapter();
      generateMock.mockReturnValue("Auth refactor");
      const { ws } = fakeSocket();
      await adapter.handle(ws as never, {
        type: "start",
        projectPath: "/proj",
        autoRename: true,
      } as never);
      const sessionId = (delivered[0] as Record<string, unknown>).sessionId as string;
      await adapter.handle(ws as never, {
        type: "input",
        text: "refactor the auth flow",
        sessionId,
      } as never);

      // Name generation kicked off from the first input (off the hot path).
      expect(generateMock).toHaveBeenCalledWith({
        projectPath: "/proj",
        transcript: { userText: "refactor the auth flow" },
      });

      // After the engine-settle delay the name is persisted via set_session_name.
      await vi.advanceTimersByTimeAsync(800);
      const setName = controls.find((c) => c.op === "set_session_name");
      expect(setName?.projectId).toBe("/proj");
      expect(setName?.payload).toEqual({ name: "Auth refactor" });
      expect(adapter.registry.get(sessionId)?.name).toBe("Auth refactor");
      expect((gateway.handleControl as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-rename sessions that carry a sessionId or continue=true", async () => {
    const { adapter } = makeAdapter();
    const { ws } = fakeSocket();
    // resume-style start: sessionId present -> no auto-rename.
    await adapter.handle(ws as never, {
      type: "start",
      projectPath: "/p",
      sessionId: "existing",
      autoRename: true,
    } as never);
    await adapter.handle(ws as never, {
      type: "input",
      text: "hello",
      sessionId: "existing",
    } as never);
    // continue-mode start: continue=true -> no auto-rename.
    await adapter.handle(ws as never, {
      type: "start",
      projectPath: "/p2",
      autoRename: true,
      continue: true,
    } as never);
    expect(generateMock).not.toHaveBeenCalled();
  });
});