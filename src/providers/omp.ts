// OMP's extension events -> Episko's provider-neutral agent events. The shim under
// ./instrument forwards raw payloads; every decision about what they mean lives here.

import type { AgentEvent, AgentFileTouch, ProviderEvent } from "../agents";
import type { AgentPermissionMode, AgentTokenBreakdown, AgentTokenUsage, Todo, TouchKind } from "../types";

// Ids only; the backend maps each to a whitelist and none is passed through as argv.
export const OMP_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "default",    label: "OMP config",  sub: "Uses tools.approvalMode from your config",     glyph: "◇", asks: true },
  { id: "always-ask", label: "Always ask",  sub: "Approves reads; asks before writes and commands", glyph: "◆", asks: true },
  { id: "write",      label: "Accept edits", sub: "Writes go through; commands still ask",       glyph: "✎", asks: true },
  { id: "yolo",       label: "Yolo",        sub: "Runs everything without asking",               glyph: "⚠", asks: false },
];

const obj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const text = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const clip = (v: unknown, n = 12_000): string => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const leaf = (p: string) => p.split(/[/\\]/).pop() || p;

// Bash is deliberately unmodelled: what `touch`/`>`/`sed -i` did is answered by the
// working-set card that reads git.
const TOUCH: Record<string, TouchKind> = {
  read: "read", write: "created", edit: "edited", apply_patch: "edited", notebook: "edited",
};

function fileTouches(tool: string, input: Record<string, any>): AgentFileTouch[] {
  const kind = TOUCH[tool];
  const path = text(input.path ?? input.file_path ?? input.dst);
  return kind && path ? [{ path, kind }] : [];
}

const costs = new Map<string, number>();

function usageFrom(context: unknown, message: unknown): AgentTokenUsage {
  const c = obj(context);
  const u = obj(obj(message).usage);
  const n = (v: unknown) => Number.isFinite(v) ? Number(v) : 0;
  const last: AgentTokenBreakdown = {
    totalTokens: n(c.tokens) || n(u.input) + n(u.output),
    inputTokens: n(u.input), cachedInputTokens: n(u.cacheRead),
    cacheWriteInputTokens: n(u.cacheWrite), outputTokens: n(u.output),
    reasoningOutputTokens: 0,
  };
  return {
    total: last, last,
    contextWindow: Number.isFinite(c.contextWindow) ? Number(c.contextWindow) : null,
  };
}

function todosFrom(input: Record<string, any>): Todo[] {
  const list = Array.isArray(input.list) ? input.list : [];
  const out: Todo[] = [];
  for (const phase of list) {
    for (const item of Array.isArray(obj(phase).items) ? obj(phase).items : []) {
      out.push({ content: text(item), status: "pending" });
    }
  }
  return out;
}

export function ompEvents(event: ProviderEvent): AgentEvent[] {
  const p = obj(event.params);
  switch (event.method) {
    case "session_start": {
      const out: AgentEvent[] = [{
        type: "thread", id: text(p.sessionId), model: text(p.model), title: text(p.title),
      }];
      if (p.context) out.push({ type: "usage", usage: usageFrom(p.context, null) });
      return out;
    }
    case "before_agent_start":
      return text(p.prompt) ? [{ type: "prompt", text: text(p.prompt) }] : [];
    case "agent_start":
      return [{ type: "turn-started" }];
    case "agent_end": {
      // isTerminal:false means a retry, compaction continuation or async delivery has
      // scheduled more work; closing the turn here parks a pane whose agent runs on.
      if (p.isTerminal === false) return [];
      const out: AgentEvent[] = [{
        type: "turn-completed", failed: false, detail: "", durationMs: null,
      }];
      if (p.context) out.push({ type: "usage", usage: usageFrom(p.context, null) });
      return out;
    }
    case "tool_call": {
      const tool = text(p.toolName);
      const input = obj(p.input);
      const arg = text(input.path ?? input.file_path ?? input.command ?? input.pattern);
      const out: AgentEvent[] = [{
        type: "activity-started", id: text(p.toolCallId), tool,
        arg: arg ? leaf(arg) : "", input: clip(input), desc: "",
      }];
      if (tool === "todo") out.push({ type: "plan", todos: todosFrom(input) });
      return out;
    }
    case "tool_result": {
      const tool = text(p.toolName);
      const input = obj(p.input);
      return [{
        type: "activity-completed", id: text(p.toolCallId), tool,
        input: clip(input), inputData: input, output: clip(p.content),
        failed: p.isError === true, files: fileTouches(tool, input),
      }];
    }
    case "message_end": {
      const message = obj(p.message);
      if (message.role !== "assistant") return [];
      const usage = usageFrom(null, message);
      const spent = Number(obj(obj(message.usage).cost).total);
      const out: AgentEvent[] = [{ type: "usage", usage }];
      if (Number.isFinite(spent)) {
        const total = (costs.get(event.sessionId) ?? 0) + spent;
        costs.set(event.sessionId, total);
        out.push({ type: "cost", totalUsd: total });
      }
      return out;
    }
    case "tool_approval_requested":
      return [{ type: "thread-status", status: "active", waiting: true }];
    case "tool_approval_resolved":
      return [{ type: "thread-status", status: "active", waiting: false }];
    // Start only: the reducer reads thread-status as active+not-waiting regardless, so an
    // _end arm would emit a byte-identical event. Start alone stops the pane parking at idle.
    case "auto_compaction_start":
    case "auto_retry_start":
      return [{ type: "thread-status", status: "active", waiting: false }];
    case "session_shutdown":
      return [{ type: "disconnected" }];
    default:
      return [];
  }
}
