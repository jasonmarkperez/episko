// Per-launch instrumentation for the real OMP TUI, materialized by telemetry.rs with the
// port and stable launch id substituted. It forwards raw events and decides nothing;
// providers/omp.ts does the translating. Silent on failure, like Claude's `curl -s`.

const PORT = Number("__EPISKO_PORT__");
const SID = "__EPISKO_SID__";

const post = (method: string, params: unknown): void => {
  try {
    void fetch(`http://127.0.0.1:${PORT}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-CC-Session": SID },
      body: JSON.stringify({ provider: "omp", method, params }),
    }).catch(() => {});
  } catch {
    // JSON.stringify can throw synchronously (circular refs, BigInts) on raw vendor
    // payloads; swallow it here so no handler above ever sees it.
  }
};

export default function episko(pi: any): void {
  pi.on("session_start", (_event: any, ctx: any) => {
    post("session_start", {
      sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
      model: ctx.model?.id ?? null,
      title: pi.getSessionName?.() ?? null,
      context: ctx.getContextUsage?.() ?? null,
    });
  });
  pi.on("before_agent_start", (event: any) => post("before_agent_start", { prompt: event?.prompt ?? "" }));
  pi.on("agent_start", () => post("agent_start", {}));
  pi.on("agent_end", (event: any, ctx: any) => post("agent_end", {
    isTerminal: event?.isTerminal, yielded: event?.yielded,
    context: ctx?.getContextUsage?.() ?? null,
  }));
  pi.on("tool_call", (event: any) => post("tool_call", {
    toolCallId: event?.toolCallId, toolName: event?.toolName, input: event?.input ?? {},
  }));
  pi.on("tool_result", (event: any) => post("tool_result", {
    toolCallId: event?.toolCallId, toolName: event?.toolName, input: event?.input ?? {},
    content: event?.content ?? [], isError: event?.isError === true,
  }));
  pi.on("message_end", (event: any) => post("message_end", { message: event?.message ?? null }));
  pi.on("tool_approval_requested", (event: any) => post("tool_approval_requested", { toolName: event?.toolName }));
  pi.on("tool_approval_resolved", (event: any) => post("tool_approval_resolved", { toolName: event?.toolName }));
  pi.on("auto_compaction_start", () => post("auto_compaction_start", {}));
  pi.on("auto_compaction_end", () => post("auto_compaction_end", {}));
  pi.on("auto_retry_start", () => post("auto_retry_start", {}));
  pi.on("auto_retry_end", () => post("auto_retry_end", {}));
  pi.on("session_shutdown", () => post("session_shutdown", {}));
}
