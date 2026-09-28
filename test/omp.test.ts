import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./localstorage"; // must precede modules that read localStorage
import { ompEvents } from "../src/providers/omp";
import type { AgentEvent } from "../src/agents";

const ev = (method: string, params: unknown, sessionId = "s1") =>
  ompEvents({ sessionId, provider: "omp", method, params, requestId: null });

const kinds = (out: AgentEvent[]) => out.map((e) => e.type);

beforeEach(() => store.clear());

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

  it("keeps the real context reading on a message_end usage event", () => {
    ev("session_start", { sessionId: "ctx-thread", model: "m", title: "t",
      context: { tokens: 5000, contextWindow: 200000, percent: 2.5 } }, "ctx-pane");
    const out = ev("message_end", { message: { role: "assistant",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }, "ctx-pane");
    const usage = out.find((e) => e.type === "usage");
    expect(usage && usage.type === "usage" && usage.usage.contextWindow).toBe(200000);
    expect(usage && usage.type === "usage" && usage.usage.last.totalTokens).toBe(5000);
  });

  it("clears the remembered context when a new thread starts without one", () => {
    ev("session_start", { sessionId: "ctx-old", model: "m", title: "t",
      context: { tokens: 9000, contextWindow: 100000, percent: 9 } }, "ctx-reset-pane");
    ev("session_start", { sessionId: "ctx-new", model: "m", title: "t", context: null }, "ctx-reset-pane");
    const out = ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, "ctx-reset-pane");
    const usage = out.find((e) => e.type === "usage");
    expect(usage && usage.type === "usage" && usage.usage.contextWindow).toBeNull();
    expect(usage && usage.type === "usage" && usage.usage.last.totalTokens).toBe(0);
  });

  it("grows the token total across messages instead of alternating shapes", () => {
    ev("session_start", { sessionId: "tok-thread", model: "m", title: "t",
      context: { tokens: 0, contextWindow: 100000, percent: 0 } }, "tok-pane");
    const one = ev("message_end", { message: { role: "assistant",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, "tok-pane");
    const two = ev("message_end", { message: { role: "assistant",
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, "tok-pane");
    const u1 = one.find((e) => e.type === "usage");
    const u2 = two.find((e) => e.type === "usage");
    expect(u1 && u1.type === "usage" && u1.usage.total.totalTokens).toBe(120);
    expect(u2 && u2.type === "usage" && u2.usage.total.totalTokens).toBe(180);
  });

  it("keeps the running cost across a reload (module state resets, storage does not)", async () => {
    ev("session_start", { sessionId: "reload-thread", model: "m", title: "t", context: null }, "reload-pane");
    ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 3 } } } }, "reload-pane");
    vi.resetModules();
    // Dynamic on purpose: reloadUi() drops this module's state, so the test needs a second,
    // independently-initialized instance sharing only the real localStorage backing.
    const fresh = await import("../src/providers/omp");
    const out = fresh.ompEvents({
      sessionId: "reload-pane", provider: "omp", method: "message_end",
      params: { message: { role: "assistant",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } } },
      requestId: null,
    });
    expect(out.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 5 });
  });

  it("resets the running cost when a new thread starts in the same pane", () => {
    ev("session_start", { sessionId: "thread-a", model: "m", title: "t", context: null }, "shared-pane");
    ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 4 } } } }, "shared-pane");
    ev("session_start", { sessionId: "thread-b", model: "m", title: "t", context: null }, "shared-pane");
    const out = ev("message_end", { message: { role: "assistant",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } }, "shared-pane");
    expect(out.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 1 });
  });

  it("keeps a shell command intact rather than trimming it to a path leaf", () => {
    const out = ev("tool_call", { toolCallId: "t9", toolName: "bash", input: { command: "cd /repo && pnpm test" } });
    expect(out[0]).toMatchObject({ type: "activity-started", arg: "cd /repo && pnpm test" });
  });

  it("closes the turn when isTerminal is entirely absent, not just when true", () => {
    expect(ev("agent_end", {})[0]).toMatchObject({ type: "turn-completed" });
  });

  it("keeps the persisted cost map bounded past its cap", () => {
    for (let i = 0; i < 505; i++) {
      ev("session_start", { sessionId: `bound-${i}`, model: "m", title: "t", context: null }, `bound-pane-${i}`);
      ev("message_end", { message: { role: "assistant",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } }, `bound-pane-${i}`);
    }
    const saved = JSON.parse(store.get("cc-omp-cost")!);
    expect(Object.keys(saved).length).toBeLessThanOrEqual(500);
    expect(saved["bound-pane-504"]).toBe(1);
  });

  it("does not evict the pane it was just asked to save, even loaded already over the cap", async () => {
    const seeded: Record<string, number> = {};
    for (let i = 0; i < 501; i++) seeded[`p${i}`] = 1; // p0 is the oldest/front entry
    store.set("cc-omp-cost", JSON.stringify(seeded));
    vi.resetModules();
    const fresh = await import("../src/providers/omp");
    const out = fresh.ompEvents({
      sessionId: "p0", provider: "omp", method: "message_end",
      params: { message: { role: "assistant",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } } },
      requestId: null,
    });
    expect(out.find((e) => e.type === "cost")).toMatchObject({ totalUsd: 3 });
    const saved = JSON.parse(store.get("cc-omp-cost")!);
    expect(saved["p0"]).toBe(3);
  });

  it("discards a legacy {tid, sum} cost entry instead of stringifying it", async () => {
    store.set("cc-omp-cost", JSON.stringify({ "legacy-pane": { tid: "x", sum: 1.23 } }));
    vi.resetModules();
    const fresh = await import("../src/providers/omp");
    const out = fresh.ompEvents({
      sessionId: "legacy-pane", provider: "omp", method: "message_end",
      params: { message: { role: "assistant",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } } },
      requestId: null,
    });
    const cost = out.find((e) => e.type === "cost") as { totalUsd: number };
    expect(typeof cost.totalUsd).toBe("number");
    expect(cost.totalUsd).toBeCloseTo(0.05);
  });
});
