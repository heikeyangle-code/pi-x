/**
 * cc-adapter — map pi events to the CC Pocket wire messages the app UI
 * already renders (transition path, docs/M2-WIRING.md).
 *
 * Pure mapping functions (no I/O) so they are unit-testable and versionable.
 * Event frames come from PiGateway envelopes (engineVersion/protocolVersion
 * attached upstream); here we translate frame content only.
 *
 * Note: final end-state is pi-frame passthrough (ENGINE-INTEGRATION §6); this
 * adapter exists so the existing CC Pocket chat/session UI can run against pi
 * before the app-side wire client lands.
 */

export type PiFrame = Record<string, unknown>;

export interface CompatMessage {
  type: string;
  [key: string]: unknown;
}

/** Inbound app messages (CC Pocket client -> host). */
export type InboundOp =
  | "start"
  | "input"
  | "approve"
  | "reject"
  | "answer"
  | "stop_session"
  | "list_sessions";

export interface InboundMessage {
  type: InboundOp;
  id?: string;
  projectId?: string;
  text?: string;
  sessionId?: string;
  toolUseId?: string;
  result?: unknown;
}

/** Control/respond actions the host should take for an inbound message. */
export interface HostAction {
  kind: "control" | "ui_response";
  op?: string;
  payload?: Record<string, unknown>;
  uiRequestId?: string;
  value?: unknown;
  stop?: boolean;
}

/**
 * pi frame -> one or more CC Pocket server messages (canonical wire schema).
 *
 * The payloads emitted here are typed as `CompatMessage` for unit tests, but
 * their field shapes are the exact canonical shapes the Flutter app's
 * `ServerMessage.fromJson` (apps/mobile/lib/models/messages.dart) validates
 * with strict casts. Every type below therefore carries ALL required fields:
 *   - status            -> { status }
 *   - stream_delta      -> { text }
 *   - thinking_delta    -> { text }
 *   - assistant         -> { message: { id, role, content: [..], model } }
 *   - tool_result       -> { toolUseId, content, toolName? }
 *   - permission_request-> { toolUseId, toolName, input }
 * Emitting a wrong/missing field makes the app throw on parse, so keep this
 * aligned with the Dart checks when evolving the mapping.
 */
export function piFrameToServerMessages(frame: PiFrame): CompatMessage[] {
  const type = String(frame["type"] ?? "");

  switch (type) {
    case "message_update": {
      const ev = frame["assistantMessageEvent"] as PiFrame | undefined;
      if (ev === undefined) return [];
      const evType = String(ev["type"] ?? "");
      switch (evType) {
        case "text_delta":
          return [{ type: "stream_delta", text: String(ev["delta"] ?? "") }];
        case "thinking_delta":
          return [{ type: "thinking_delta", text: String(ev["delta"] ?? "") }];
        case "text_start":
        case "thinking_start":
          // Streaming begins on the first delta; nothing to emit at start.
          return [];
        case "text_end": {
          const text = String(ev["content"] ?? "");
          if (text === "") return [];
          return [
            {
              type: "assistant",
              message: {
                id: String(ev["id"] ?? nonce("a")),
                role: "assistant",
                content: [{ type: "text", text }],
                model: String(frame["model"] ?? ""),
              },
            },
          ];
        }
        case "toolcall_start": {
          const id = String(ev["id"] ?? "toolcall");
          return [
            {
              type: "tool_result",
              toolUseId: id,
              content: "",
              toolName: String(ev["toolName"] ?? ""),
            },
          ];
        }
        case "toolcall_end": {
          const tool = (ev["toolCall"] as PiFrame | undefined) ?? {};
          const id = String(tool["id"] ?? ev["id"] ?? "toolcall");
          return [
            {
              type: "tool_result",
              toolUseId: id,
              content: stringifyInput(tool["input"]),
              toolName: String(tool["name"] ?? ev["toolName"] ?? ""),
            },
          ];
        }
        default:
          return [];
      }
    }

    case "extension_ui_request": {
      // Tool/extension approval -> the app's approval card. The app answers
      // by id, which the adapter forwards to gateway.respondUi(id, ...).
      const id = String(frame["id"] ?? "");
      const method = String(frame["method"] ?? "confirm");
      const input: Record<string, unknown> = {
        title: String(frame["title"] ?? ""),
        message: String(frame["message"] ?? ""),
      };
      if (Array.isArray(frame["options"])) input["options"] = frame["options"];
      return [{ type: "permission_request", toolUseId: id, toolName: method, input }];
    }

    case "agent_start":
      return [{ type: "status", status: "running" }];
    case "agent_settled":
    case "agent_end":
      return [{ type: "status", status: "idle" }];

    case "bash_execution_update": {
      const d = frame["delta"];
      return d === undefined
        ? []
        : [
            {
              type: "tool_result",
              toolUseId: String(frame["toolUseId"] ?? "bash"),
              content: String(d),
              toolName: "bash",
            },
          ];
    }

    case "tool_execution_start":
      return [
        {
          type: "tool_result",
          toolUseId: String(frame["id"] ?? "tool"),
          content: "",
          toolName: String(frame["toolName"] ?? ""),
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          toolUseId: String(frame["id"] ?? "tool"),
          content: String(frame["output"] ?? frame["result"] ?? ""),
          toolName: String(frame["toolName"] ?? ""),
        },
      ];

    case "engine_exit":
      return [{ type: "status", status: "idle" }];

    default:
      return [];
  }
}

/** Serialize a tool input to the string content a tool_result carries. */
function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

let nonceCounter = 0;
/** Short unique id for synthesized assistant messages. */
function nonce(prefix: string): string {
  nonceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nonceCounter}`;
}

/**
 * Map a CC Pocket inbound message to host actions.
 * `uiRespond` must be provided when handling approve/reject/answer.
 */
export function inboundToActions(
  msg: InboundMessage,
): HostAction[] {
  const actions: HostAction[] = [];
  switch (msg.type) {
    case "input":
      // Slash commands expand server-side (get_commands + prompt "/name").
      actions.push({
        kind: "control",
        op: "prompt",
        payload: { message: msg.text ?? "" },
      });
      break;
    case "approve":
      actions.push({
        kind: "ui_response",
        uiRequestId: msg.toolUseId ?? msg.id,
        value: { confirmed: true },
      });
      break;
    case "reject":
      actions.push({
        kind: "ui_response",
        uiRequestId: msg.toolUseId ?? msg.id,
        value: { confirmed: false },
      });
      break;
    case "answer":
      actions.push({
        kind: "ui_response",
        uiRequestId: msg.toolUseId,
        value: { value: msg.result },
      });
      break;
    case "stop_session":
      actions.push({ kind: "control", op: "abort" });
      break;
    case "start":
    case "list_sessions":
      actions.push({ kind: "control", op: "get_state" });
      break;
  }
  return actions;
}
