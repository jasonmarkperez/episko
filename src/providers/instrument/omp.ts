// Per-launch instrumentation for the real OMP TUI, materialized by telemetry.rs with the
// port and stable launch id substituted. It forwards raw events and decides nothing;
// providers/omp.ts does the translating. Silent on failure, like Claude's `curl -s`.

const PORT = Number("__EPISKO_PORT__");
const SID = "__EPISKO_SID__";

const post = (method: string, params: unknown): void => {
  void fetch(`http://127.0.0.1:${PORT}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CC-Session": SID },
    body: JSON.stringify({ provider: "omp", method, params }),
  }).catch(() => {});
};

// The pi plugin object exposes an arbitrary, undocumented event bus; every payload below
// is read defensively rather than trusted, since pi's own types are not available here.
type Handler = (event: unknown, ctx: unknown) => void;
interface PiApi {
  on(event: string, handler: Handler): void;
  getSessionName?: () => unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const call = (fn: unknown, ...args: unknown[]): unknown =>
  typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;

const field = (value: unknown, key: string): unknown => asRecord(value)?.[key];

const contextUsage = (ctx: unknown): unknown => call(field(ctx, "getContextUsage"));

export default function episko(pi: PiApi): void {
  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    const sessionManager = field(ctx, "sessionManager");
    post("session_start", {
      sessionId: call(field(sessionManager, "getSessionId")) ?? null,
      model: field(field(ctx, "model"), "id") ?? null,
      title: call(pi.getSessionName) ?? null,
      context: contextUsage(ctx) ?? null,
    });
  });
  pi.on("before_agent_start", (event: unknown) => post("before_agent_start", { prompt: field(event, "prompt") ?? "" }));
  pi.on("agent_start", () => post("agent_start", {}));
  pi.on("agent_end", (event: unknown, ctx: unknown) => post("agent_end", {
    isTerminal: field(event, "isTerminal"), yielded: field(event, "yielded"),
    context: contextUsage(ctx) ?? null,
  }));
  pi.on("tool_call", (event: unknown) => post("tool_call", {
    toolCallId: field(event, "toolCallId"), toolName: field(event, "toolName"), input: field(event, "input") ?? {},
  }));
  pi.on("tool_result", (event: unknown) => post("tool_result", {
    toolCallId: field(event, "toolCallId"), toolName: field(event, "toolName"), input: field(event, "input") ?? {},
    content: field(event, "content") ?? [], isError: field(event, "isError") === true,
  }));
  pi.on("message_end", (event: unknown) => post("message_end", { message: field(event, "message") ?? null }));
  pi.on("tool_approval_requested", (event: unknown) => post("tool_approval_requested", { toolName: field(event, "toolName") }));
  pi.on("tool_approval_resolved", (event: unknown) => post("tool_approval_resolved", { toolName: field(event, "toolName") }));
  pi.on("auto_compaction_start", () => post("auto_compaction_start", {}));
  pi.on("auto_compaction_end", () => post("auto_compaction_end", {}));
  pi.on("auto_retry_start", () => post("auto_retry_start", {}));
  pi.on("auto_retry_end", () => post("auto_retry_end", {}));
  pi.on("session_shutdown", () => post("session_shutdown", {}));
}
