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

/** pi frame -> one or more CC Pocket-style server messages. */
export function piFrameToServerMessages(frame: PiFrame): CompatMessage[] {
  const type = String(frame["type"] ?? "");

  switch (type) {
    case "message_update": {
      const usage = frame["usage"];
      const ev = frame["assistantMessageEvent"] as PiFrame | undefined;
      if (ev === undefined) return [];
      const evType = String(ev["type"] ?? "");
      // stream_delta carries text/thinking chunks for the existing UI.
      if (evType === "text_delta" || evType === "thinking_delta") {
        return [
          {
            type: "stream_delta",
            delta: String(ev["delta"] ?? ""),
            kind: evType === "thinking_delta" ? "thinking" : "text",
            contentIndex: ev["contentIndex"],
            usage: usage ?? undefined,
          },
        ];
      }
      if (evType === "text_start" || evType === "thinking_start") {
        return [{ type: "assistant", role: "assistant", partial: true }];
      }
      if (evType === "text_end") {
        return [
          {
            type: "assistant",
            role: "assistant",
            content: String(ev["content"] ?? ""),
          },
        ];
      }
      if (evType === "toolcall_start") {
        return [
          {
            type: "tool_result",
            toolName: String(ev["toolName"] ?? ""),
            id: String(ev["id"] ?? ""),
            status: "running",
          },
        ];
      }
      if (evType === "toolcall_end") {
        const tool = (ev["toolCall"] as PiFrame | undefined) ?? {};
        return [
          {
            type: "tool_result",
            toolName: String(tool["name"] ?? ""),
            id: String(tool["id"] ?? ev["id"] ?? ""),
            status: "done",
            input: tool["input"] ?? {},
          },
        ];
      }
      return [];
    }

    case "extension_ui_request": {
      // permission_request-style approval the app can render as a card.
      const method = String(frame["method"] ?? "confirm");
      return [
        {
          type: "permission_request",
          id: String(frame["id"] ?? ""),
          method,
          title: String(frame["title"] ?? ""),
          message: String(frame["message"] ?? ""),
          options: Array.isArray(frame["options"])
            ? frame["options"]
            : undefined,
        },
      ];
    }

    case "agent_start":
      return [{ type: "status", state: "running" }];
    case "agent_settled":
      return [{ type: "status", state: "idle" }];

    case "bash_execution_update": {
      const d = frame["delta"];
      return d === undefined
        ? []
        : [{ type: "tool_result", status: "running", outputDelta: String(d) }];
    }

    case "tool_execution_start":
      return [
        {
          type: "tool_result",
          toolName: String(frame["toolName"] ?? ""),
          id: String(frame["id"] ?? ""),
          status: "running",
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          toolName: String(frame["toolName"] ?? ""),
          id: String(frame["id"] ?? ""),
          status: "done",
        },
      ];

    case "agent_end":
      return [{ type: "status", state: "idle" }];

    case "engine_exit":
      return [{ type: "status", state: "idle", engineExited: true }];

    default:
      return [];
  }
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
