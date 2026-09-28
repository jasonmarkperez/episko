import { describe, expect, it } from "vitest";
import { ompEvents } from "../src/providers/omp";
import type { AgentEvent } from "../src/agents";

const ev = (method: string, params: unknown, sessionId = "s1") =>
  ompEvents({ sessionId, provider: "omp", method, params, requestId: null });

const kinds = (out: AgentEvent[]) => out.map((e) => e.type);

describe("ompEvents", () => {
  it("opens a thread from session_start", () => {
    const out = ev("session_start", {
      sessionId: "01a0", model: "claude-opus-5", title: "Fix the build",
      context: { tokens: 11757, contextWindow: 1000000, percent: 1.18 },
    });
    expect(out[0]).toEqual({ type: "thread", id: "01a0", model: "claude-opus-5", title: "Fix the build" });
    const usage = out.find((e) => e.type === "usage");
    expect(usage && usage.type === "usage" && usage.usage.contextWindow).toBe(1000000);
  });

  it("records the prompt and opens the turn", () => {
    expect(kinds(ev("before_agent_start", { prompt: "ship it" }))).toEqual(["prompt"]);
    expect(kinds(ev("agent_start", {}))).toEqual(["turn-started"]);
  });

  it("does NOT close the turn on a non-terminal agent_end", () => {
    // isTerminal:false is a retry or compaction continuation; closing here parks a live pane.
    expect(kinds(ev("agent_end", { isTerminal: false, yielded: false }))).toEqual([]);
  });

  it("closes the turn on a terminal agent_end", () => {
    const out = ev("agent_end", { isTerminal: true, yielded: true });
    expect(out[0]).toMatchObject({ type: "turn-completed", failed: false });
  });

  it("maps a tool call to activity", () => {
    const started = ev("tool_call", { toolCallId: "t1", toolName: "read", input: { path: "/repo/a.ts" } });
    expect(started[0]).toMatchObject({ type: "activity-started", id: "t1", tool: "read" });

    const done = ev("tool_result", {
      toolCallId: "t1", toolName: "read", input: { path: "/repo/a.ts" },
      content: [{ type: "text", text: "ok" }], isError: false,
    });
    expect(done[0]).toMatchObject({ type: "activity-completed", id: "t1", failed: false });
    expect(done[0].type === "activity-completed" && done[0].files).toEqual([
      { path: "/repo/a.ts", kind: "read" },
    ]);
  });

  it("climbs a write to created and an edit to edited", () => {
    const w = ev("tool_result", {
      toolCallId: "t2", toolName: "write", input: { path: "/repo/new.ts" }, content: [], isError: false,
    });
    expect(w[0].type === "activity-completed" && w[0].files).toEqual([
      { path: "/repo/new.ts", kind: "created" },
    ]);
    const e = ev("tool_result", {
      toolCallId: "t3", toolName: "edit", input: { path: "/repo/old.ts" }, content: [], isError: false,
    });
    expect(e[0].type === "activity-completed" && e[0].files).toEqual([
      { path: "/repo/old.ts", kind: "edited" },
    ]);
  });

  it("models no file for bash", () => {
    const out = ev("tool_result", {
      toolCallId: "t4", toolName: "bash", input: { command: "touch x" }, content: [], isError: false,
    });
    expect(out[0].type === "activity-completed" && out[0].files).toEqual([]);
  });

  it("reads todos off the todo tool's own call", () => {
    const out = ev("tool_call", {
      toolCallId: "t5", toolName: "todo",
      input: { list: [{ phase: "P", items: ["do a thing"] }] },
    });
    expect(kinds(out)).toContain("plan");
  });

  it("accumulates cost across messages in one session", () => {
    const one = ev("message_end", { message: { role: "assistant",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } }, "cost-a");
    expect(one.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 0.25 });

    const two = ev("message_end", { message: { role: "assistant",
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } }, "cost-a");
    expect(two.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 0.35 });
  });

  it("keeps two sessions' costs apart", () => {
    ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } }, "cost-b");
    const other = ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } } }, "cost-c");
    expect(other.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 2 });
  });

  it("ignores a non-assistant message_end", () => {
    expect(kinds(ev("message_end", { message: { role: "user" } }))).toEqual([]);
  });

  it("says waiting while an approval is open", () => {
    expect(ev("tool_approval_requested", { toolName: "bash" })[0])
      .toMatchObject({ type: "thread-status", waiting: true });
    expect(ev("tool_approval_resolved", { toolName: "bash" })[0])
      .toMatchObject({ type: "thread-status", waiting: false });
  });

  it("says what it is doing while compacting or retrying", () => {
    expect(kinds(ev("auto_compaction_start", {}))).toEqual(["thread-status"]);
    expect(kinds(ev("auto_retry_start", {}))).toEqual(["thread-status"]);
  });

  it("disconnects on shutdown", () => {
    expect(kinds(ev("session_shutdown", {}))).toEqual(["disconnected"]);
  });

  it("drops an unknown method rather than inventing state", () => {
    expect(ev("some_future_omp_event", { a: 1 })).toEqual([]);
  });
});
