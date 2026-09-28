// OMP's extension events -> Episko's provider-neutral agent events. The shim under
// ./instrument forwards raw payloads; every decision about what they mean lives here.

import type { AgentEvent, AgentFileTouch, ProviderEvent } from "../agents";
import { readObj } from "../store";
import type { AgentPermissionMode, AgentTokenBreakdown, Todo, TouchKind } from "../types";

// Ids only; the backend maps each to a whitelist and none is passed through as argv.
export const OMP_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "default",    label: "OMP config",  sub: "Uses tools.approvalMode from your config",     glyph: "◇", asks: true },
  { id: "always-ask", label: "Always ask",  sub: "Approves reads; asks before writes and commands", glyph: "◆", asks: true },
  { id: "write",      label: "Accept edits", sub: "Writes go through; commands still ask",       glyph: "✎", asks: true },
  { id: "yolo",       label: "Yolo",        sub: "Runs everything without asking",               glyph: "⚠", asks: false },
];

const obj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const text = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const num = (v: unknown) => Number.isFinite(v) ? Number(v) : 0;
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

const ZERO_BREAKDOWN: AgentTokenBreakdown = {
  totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0,
};
const addBreakdown = (a: AgentTokenBreakdown, b: AgentTokenBreakdown): AgentTokenBreakdown => ({
  totalTokens: a.totalTokens + b.totalTokens, inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
});

// Keyed by pane (the launch id every event carries): the real context occupancy, last seen
// from session_start/agent_end, and the running token total across this thread's messages.
// message_end has neither on its own, and must not blank the gauge or restart the counter.
const lastContext = new Map<string, { tokens: number; contextWindow: number | null }>();
const tokenTotal = new Map<string, AgentTokenBreakdown>();

function usageEvent(pane: string): AgentEvent {
  const c = lastContext.get(pane);
  return {
    type: "usage",
    usage: {
      total: tokenTotal.get(pane) ?? ZERO_BREAKDOWN,
      last: { ...ZERO_BREAKDOWN, totalTokens: c?.tokens ?? 0 },
      contextWindow: c?.contextWindow ?? null,
    },
  };
}

// The running $ total, keyed by pane (the launch id every event carries). Persisted because a
// webview reload (./actions reloadUi) drops this module's state but not the OMP process, so the
// next message_end must not restart the sum from zero. Capped like `cc-cost-base`'s
// COST_BASE_MAX (usage.ts): `Map.set` on an existing key keeps its original position, so
// eviction from the front is a usable LRU without a separate timestamp field.
const COST_KEY = "cc-omp-cost";
const COST_MAX = 500;
let paneCost: Map<string, number> | null = null;
// Lazy: a module-scope read would hit `localStorage` at import time, before a real page
// (or a test's polyfill) has necessarily set the global.
function costMap(): Map<string, number> {
  return paneCost ??= new Map(Object.entries(readObj<number>(COST_KEY)));
}
function saveCost() {
  const map = costMap();
  for (const k of [...map.keys()].slice(0, Math.max(0, map.size - COST_MAX))) map.delete(k);
  localStorage.setItem(COST_KEY, JSON.stringify(Object.fromEntries(map)));
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
  const pane = event.sessionId;
  switch (event.method) {
    case "session_start": {
      tokenTotal.set(pane, ZERO_BREAKDOWN);
      lastContext.delete(pane);
      costMap().set(pane, 0);
      saveCost();
      const out: AgentEvent[] = [{
        type: "thread", id: text(p.sessionId), model: text(p.model), title: text(p.title),
      }];
      if (p.context) {
        lastContext.set(pane, { tokens: num(p.context.tokens), contextWindow: Number.isFinite(p.context.contextWindow) ? Number(p.context.contextWindow) : null });
        out.push(usageEvent(pane));
      }
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
      if (p.context) {
        lastContext.set(pane, { tokens: num(p.context.tokens), contextWindow: Number.isFinite(p.context.contextWindow) ? Number(p.context.contextWindow) : null });
        out.push(usageEvent(pane));
      }
      return out;
    }
    case "tool_call": {
      const tool = text(p.toolName);
      const input = obj(p.input);
      const pathArg = text(input.path ?? input.file_path);
      const arg = pathArg ? leaf(pathArg) : text(input.command ?? input.pattern);
      const out: AgentEvent[] = [{
        type: "activity-started", id: text(p.toolCallId), tool,
        arg, input: clip(input), desc: "",
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
      const u = obj(message.usage);
      const delta: AgentTokenBreakdown = {
        totalTokens: num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite),
        inputTokens: num(u.input), cachedInputTokens: num(u.cacheRead),
        cacheWriteInputTokens: num(u.cacheWrite), outputTokens: num(u.output),
        reasoningOutputTokens: 0,
      };
      tokenTotal.set(pane, addBreakdown(tokenTotal.get(pane) ?? ZERO_BREAKDOWN, delta));
      const out: AgentEvent[] = [usageEvent(pane)];
      const spent = Number(obj(u.cost).total);
      if (Number.isFinite(spent)) {
        const prevSum = costMap().get(pane) ?? 0;
        const sum = spent !== 0 ? prevSum + spent : prevSum;
        // A zero-cost reading changes nothing, so it must not rewrite an identical blob.
        if (spent !== 0) { costMap().set(pane, sum); saveCost(); }
        out.push({ type: "cost", totalUsd: sum });
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
      lastContext.delete(pane); tokenTotal.delete(pane); costMap().delete(pane); saveCost();
      return [{ type: "disconnected" }];
    default:
      return [];
  }
}
