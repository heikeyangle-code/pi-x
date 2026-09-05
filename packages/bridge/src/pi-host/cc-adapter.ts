/**
 * cc-adapter — map pi events to the CC Pocket wire messages the app UI
 * already renders (transition path, docs/M2-WIRING.md).
 *
 * Pure mapping functions (no I/O) so they are unit-testable and versionable.
 * Event frames come from PiGateway envelopes (engineVersion/protocolVersion
 * attached upstream); here we translate frame content only.
 *
 * The frame shapes below follow the pi RPC protocol 1:1
 * (packages/coding-agent/docs/rpc.md in the pi monorepo):
 *
 *   message_update.assistantMessageEvent:
 *     text_start / text_delta / text_end
 *     thinking_start / thinking_delta / thinking_end
 *     toolcall_start (id, toolName) / toolcall_delta / toolcall_end (toolCall)
 *   tool_execution_start  { toolCallId, toolName, args }
 *   tool_execution_update { toolCallId, toolName, args, partialResult }
 *   tool_execution_end    { toolCallId, toolName, result, isError }
 *   bash_execution_update { id, delta }
 *   compaction_start      { reason }
 *   compaction_end        { reason, result, aborted, willRetry, errorMessage }
 *   extension_error       { extensionPath, event, error }
 *   auto_retry_start      { attempt, maxAttempts, delayMs, errorMessage }
 *   auto_retry_end        { success, attempt, finalError }
 *   agent_start / agent_end (willRetry) / agent_settled
 *   engine_exit
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
  | "stop_session";

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

/** Extension UI dialog methods that require a client response. */
const UI_DIALOG_METHODS = new Set<string>([
  "select",
  "confirm",
  "input",
  "editor",
]);

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
 *   - error             -> { message, errorCode? }
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
        case "thinking_end":
          // Streaming begins/ends on deltas; nothing to emit at boundaries.
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
        case "toolcall_delta":
          // Arguments stream as deltas; toolcall_end carries the authoritative
          // toolCall object. Emitting every chunk would flood the chat with
          // tool_result bubbles, so deltas are folded into the end event.
          return [];
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
      // Dialog methods -> the app's approval card. The app answers by id,
      // which the adapter forwards to gateway.respondUi(id, ...).
      // Fire-and-forget methods (notify/setStatus/setWidget/setTitle/
      // set_editor_text) expect no response, so they must NOT raise an
      // approval card that would block the turn.
      const id = String(frame["id"] ?? "");
      const method = String(frame["method"] ?? "confirm");
      if (!UI_DIALOG_METHODS.has(method)) return [];
      const input: Record<string, unknown> = {
        title: String(frame["title"] ?? ""),
        message: String(frame["message"] ?? ""),
      };
      if (Array.isArray(frame["options"])) input["options"] = frame["options"];
      return [{ type: "permission_request", toolUseId: id, toolName: method, input }];
    }

    case "agent_start":
      return [{ type: "status", status: "running" }];
    case "agent_end": {
      // willRetry=true means an automatic retry (or compaction retry) is about
      // to run; the agent is NOT settled, so keep the UI in running state.
      if (frame["willRetry"] === true) return [];
      return [{ type: "status", status: "idle" }];
    }
    case "agent_settled":
      return [{ type: "status", status: "idle" }];

    case "bash_execution_update": {
      // Direct RPC `bash` command output chunk: { id, delta } where id is the
      // originating command's id.
      const d = frame["delta"];
      return d === undefined
        ? []
        : [
            {
              type: "tool_result",
              toolUseId: String(frame["id"] ?? "bash"),
              content: String(d),
              toolName: "bash",
            },
          ];
    }

    case "tool_execution_start":
      return [
        {
          type: "tool_result",
          toolUseId: String(frame["toolCallId"] ?? "tool"),
          content: "",
          toolName: String(frame["toolName"] ?? ""),
        },
      ];
    case "tool_execution_update":
      // partialResult carries the accumulated output so far; emitting every
      // snapshot would stack duplicate tool_result bubbles. The authoritative
      // output arrives with tool_execution_end, so intermediate snapshots are
      // folded into that final event.
      return [];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          toolUseId: String(frame["toolCallId"] ?? "tool"),
          content: toolResultText(frame["result"] ?? frame["output"]),
          toolName: String(frame["toolName"] ?? ""),
        },
      ];

    case "compaction_start":
      return [
        {
          type: "tool_result",
          toolUseId: nonce("compaction"),
          content: "正在压缩对话上下文…",
          toolName: "compaction",
        },
      ];
    case "compaction_end": {
      const aborted = frame["aborted"] === true;
      const failed = frame["errorMessage"] !== undefined;
      const summary = (frame["result"] as PiFrame | undefined)?.["summary"];
      if (failed) {
        return [
          {
            type: "error",
            message: `压缩失败：${String(frame["errorMessage"])}`,
            errorCode: "compaction_failed",
          },
        ];
      }
      const content = aborted
        ? "压缩已取消"
        : typeof summary === "string" && summary !== ""
          ? `对话已压缩：${summary}`
          : "对话上下文已压缩";
      return [
        {
          type: "tool_result",
          toolUseId: nonce("compaction"),
          content,
          toolName: "compaction",
        },
      ];
    }

    case "extension_error":
      return [
        {
          type: "error",
          message: `扩展错误（${String(frame["extensionPath"] ?? "")} @ ${String(frame["event"] ?? "")}）：${String(frame["error"] ?? "")}`,
          errorCode: "extension_error",
        },
      ];

    case "auto_retry_start":
      return [
        {
          type: "tool_result",
          toolUseId: nonce("retry"),
          content: `自动重试中（${String(frame["attempt"] ?? "?")}/${String(frame["maxAttempts"] ?? "?")}）…${frame["errorMessage"] !== undefined ? ` ${String(frame["errorMessage"])}` : ""}`,
          toolName: "auto_retry",
        },
      ];
    case "auto_retry_end": {
      if (frame["success"] === false) {
        return [
          {
            type: "error",
            message: `自动重试失败：${String(frame["finalError"] ?? "")}`,
            errorCode: "auto_retry_failed",
          },
        ];
      }
      return [
        {
          type: "tool_result",
          toolUseId: nonce("retry"),
          content: "自动重试成功",
          toolName: "auto_retry",
        },
      ];
    }

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

/**
 * Extract display text from a tool result. pi tool results are
 * `{ content: [{ type: "text", text }], details }` objects, not strings;
 * naive String(result) would render "[object Object]".
 */
function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const obj = result as Record<string, unknown>;
  const content = obj["content"];
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b["type"] === "text" || b["type"] === "input_text") {
            return String(b["text"] ?? "");
          }
        }
        return "";
      })
      .filter((t) => t !== "");
    if (texts.length > 0) return texts.join("\n");
  }
  // Fall back to the whole object (e.g. bash output with fullOutputPath).
  const text = obj["text"];
  if (typeof text === "string") return text;
  return stringifyInput(result);
}

let nonceCounter = 0;
/** Short unique id for synthesized messages. */
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
      actions.push({ kind: "control", op: "get_state" });
      break;
  }
  return actions;
}
