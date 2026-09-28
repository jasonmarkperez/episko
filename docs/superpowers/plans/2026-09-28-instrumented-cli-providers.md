# Instrumented-CLI Providers (OMP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OMP a first-class integrated provider in Episko by generalizing Claude's per-launch instrumentation into a reusable "instrumented-CLI" provider kind, so a fourth harness costs a shim plus an adapter instead of a sidecar.

**Architecture:** A per-launch throwaway TS extension is materialized into `$TMPDIR/cc-launcher/` and loaded into the real `omp` TUI with `-e`. It POSTs raw OMP events to a new `/agent` route on the existing loopback `tiny_http` telemetry server, tagged with the stable launch uuid via the `X-CC-Session` header. That route emits an `agent-event` payload byte-compatible with the one `agent.rs` already emits for Codex, so `main.ts` routes it unchanged through `providerAdapter("omp").events(raw)` into `applyAgentEvent`. No sidecar process is started.

**Tech Stack:** Rust (Tauri v2, `tiny_http`, `portable-pty`), vanilla TypeScript (strict, no framework), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-28-instrumented-cli-providers-design.md`

## Global Constraints

- Package manager is **`pnpm`**, never npm.
- Rust visibility is **`pub(crate)`, never `pub`**, including on `#[tauri::command]` fns.
- Rust tests are **in-file `#[cfg(test)] mod tests`**. There is deliberately no `src-tauri/tests/` directory.
- `src/` must never touch a browser global at module scope (`document`, `window`, `navigator`) — vitest runs in the `node` environment.
- `src/` must never use a node global (`process`, `Buffer`); `tsconfig.json` has `"types": []` to guarantee that, and it must stay.
- Comments: one or two lines, five at the very most. `test/comments.test.ts` gates block length and comment density (0.3 comment lines per code line plus a small allowance) and fails CI on a violation.
- No import cycles across `src/`'s modules. Dependency direction is **state ← render ← wiring**; a logic module must not import render code or `main.ts`.
- Shared UI must not branch on a vendor id. `test/provider-contract.test.ts` fails if a non-Claude vendor string appears outside `src/providers/`.
- Every capability name must already exist in `AGENT_CAPABILITIES` (`src/types.ts:135-138`): `session-state`, `activity`, `context`, `usage`, `permissions`, `resume`, `history`, `external-terminal`, `launch-permissions`.
- Gates to run before handoff, all of them, locally: `pnpm build`, `pnpm exec tsc -p tsconfig.test.json --noEmit`, `pnpm test`, and from `src-tauri/`: `cargo check`, `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- Capabilities OMP claims, exactly: `session-state`, `activity`, `context`, `usage`, `launch-permissions`. Not `permissions`, not `history`, not `resume`, not `external-terminal`.

---

## File Structure

**Create:**
- `src/providers/instrument/omp.ts` — the shim asset. Forwards OMP extension events to `/agent`. No judgement in it. Included into the Rust binary with `include_str!` and materialized per launch with two placeholder tokens substituted.
- `src/providers/omp.ts` — `ompEvents(event: ProviderEvent): AgentEvent[]` plus `OMP_PERMISSION_MODES`. The only frontend code that knows OMP method names.
- `test/omp.test.ts` — vitest for `ompEvents`.

**Modify:**
- `src-tauri/src/telemetry.rs` — add `write_instrument` (sibling of `write_instrument_settings`) and the `/agent` route arm in `run_telemetry_server`.
- `src-tauri/src/agent.rs` — add the `"omp"` arm to `start_provider` and `omp_permission_args`.
- `src/providers/manifest.json` — add the `omp` entry.
- `src/providers/index.ts` — add the `omp` entry to `PROVIDER_ADAPTERS`.
- `docs/providers.md` — document the instrumented-CLI kind.
- `CHANGELOG.md` — one entry.
- `RELEASE.md` — add OMP to the manual session checklist.

Note: `src/providers/logos.ts` already has an `omp` entry (line 24, `../assets/agents/omp.svg?raw`), and `src-tauri/src/pty.rs` already has `AgentSpec { id: "omp", label: "OMP", bin: "omp", mark: "Om" }` at lines 747-752. Neither needs changing.

---

## Task 1: The `/agent` telemetry route

**Files:**
- Modify: `src-tauri/src/telemetry.rs:90-146` (the `run_telemetry_server` dispatch)
- Test: `src-tauri/src/telemetry.rs`, in-file `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: an `agent-event` Tauri event whose payload is `{ sessionId: String, provider: String, method: String, params: Value, requestId: null }`. Task 4's shim POSTs to it; `src/main.ts`'s existing listener consumes it.

Background: the dispatch is an `if url.contains(...)` chain. `/permission` is held open; everything else emits `telemetry` with `kind` of `"statusline"` or `"hook"`. The `stable_sid` is already read from the `X-CC-Session` header at line 93. The route must be checked **before** the `statusline`/`hook` fallthrough. Note that `url.contains("agent")` is how the existing arms are written, and it is safe here: no other route contains that substring.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/telemetry.rs`'s `mod tests`. Model it on the existing `/hook` test around line 414, which uses the `open_post` / `read_response` / `next` helpers already defined there.

```rust
/// An instrumented CLI posts raw vendor events; the route re-emits them in the same
/// shape agent.rs emits for Codex, so the frontend router needs no second path.
#[test]
fn agent_route_emits_provider_events() {
    let (port, next, wait) = start_test_server();
    read_response(
        open_post(
            port,
            "/agent",
            &[("X-CC-Session", "ours-abc")],
            r#"{"provider":"omp","method":"agent_start","params":{"k":1}}"#,
        ),
        wait,
    );
    let ev = next();
    assert_eq!(ev["sessionId"], "ours-abc");
    assert_eq!(ev["provider"], "omp");
    assert_eq!(ev["method"], "agent_start");
    assert_eq!(ev["params"]["k"], 1);
    assert!(ev["requestId"].is_null());
}
```

Read the existing tests in that module first and match their setup helpers exactly — the names above (`start_test_server`, `open_post`, `read_response`, `next`, `wait`) are how the neighbouring `/hook` and `/statusline` tests are written, and the listener capture must be for the `agent-event` channel rather than `telemetry`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test agent_route_emits_provider_events`
Expected: FAIL — the payload arrives on the `telemetry` channel as a `hook`, so the `agent-event` capture is empty.

- [ ] **Step 3: Write minimal implementation**

In `run_telemetry_server`, immediately after the blocking `if url.contains("permission") { … continue; }` block and before the `let kind = …` line:

```rust
// An instrumented CLI's raw vendor event. Same payload agent.rs emits for Codex, so
// main.ts routes both through the provider registry with no second path.
if url.contains("agent") {
    let _ = app.emit(
        "agent-event",
        serde_json::json!({
            "sessionId": stable_sid.clone().unwrap_or_default(),
            "provider": data.get("provider").cloned().unwrap_or(serde_json::Value::Null),
            "method": data.get("method").cloned().unwrap_or(serde_json::Value::Null),
            "params": data.get("params").cloned().unwrap_or(serde_json::Value::Null),
            "requestId": serde_json::Value::Null,
        }),
    );
    let _ = request.respond(tiny_http::Response::from_string(""));
    continue;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test telemetry`
Expected: PASS, including every pre-existing telemetry test — the `/hook` and `/statusline` arms must be untouched.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/telemetry.rs
git commit -m "feat(telemetry): /agent route for instrumented-CLI providers"
```

---

## Task 2: `write_instrument` and the shim asset

**Files:**
- Create: `src/providers/instrument/omp.ts`
- Modify: `src-tauri/src/telemetry.rs` (add `write_instrument` beside `write_instrument_settings`, which starts at line 148)
- Test: `src-tauri/src/telemetry.rs`, in-file `mod tests`

**Interfaces:**
- Consumes: the `/agent` route from Task 1.
- Produces: `pub(crate) fn write_instrument(provider: &str, port: u16, session_id: &str) -> std::io::Result<Vec<String>>`, returning the launch args that load the shim. Task 3's `start_provider` arm calls it.

Two things to know. First, `write_instrument_settings` (line 148) is the precedent: it creates `$TMPDIR/cc-launcher/`, writes `instrument-<uuid>.json`, and the file is **never deleted at runtime** — do not add cleanup, because that would be a second story. Second, the shim lives under `src/` so `tsconfig.json`'s `include: ["src"]` typechecks it (strict, `lib: ["ES2020","DOM","DOM.Iterable"]`, so `fetch` is available and no node global is). It is never imported by any module, so vite never bundles it.

The two placeholder tokens must be **valid TypeScript** so `tsc` passes before substitution: `Number("__EPISKO_PORT__")` and `"__EPISKO_SID__"`.

- [ ] **Step 1: Write the shim asset**

Create `src/providers/instrument/omp.ts`:

```ts
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
```

- [ ] **Step 2: Verify the shim typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: PASS. If `noUnusedParameters` rejects `_event`, keep the leading underscore — that is the convention the flag honours.

- [ ] **Step 3: Write the failing Rust test**

Add to `src-tauri/src/telemetry.rs`'s `mod tests`:

```rust
/// The shim is materialized per launch with the port and stable id substituted, and the
/// returned args are what loads it. No placeholder may survive into the written file.
#[test]
fn write_instrument_substitutes_and_returns_launch_args() {
    let sid = "sid-omp-1";
    let args = write_instrument("omp", 45678, sid).expect("shim should be written");
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "-e");
    assert!(args[1].ends_with(&format!("omp-{sid}.ts")), "unexpected path {}", args[1]);

    let body = std::fs::read_to_string(&args[1]).unwrap();
    assert!(body.contains("45678"), "port not substituted");
    assert!(body.contains(sid), "session id not substituted");
    assert!(!body.contains("__EPISKO_PORT__"), "port placeholder survived");
    assert!(!body.contains("__EPISKO_SID__"), "sid placeholder survived");

    let _ = std::fs::remove_file(&args[1]);
}

/// An unknown provider has no asset, and must not write a file or invent arguments.
#[test]
fn write_instrument_rejects_unknown_provider() {
    assert!(write_instrument("nope", 45678, "sid").is_err());
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd src-tauri && cargo test write_instrument`
Expected: FAIL — `write_instrument` is not defined.

- [ ] **Step 5: Write the implementation**

Add to `src-tauri/src/telemetry.rs`, directly after `write_instrument_settings`:

```rust
/// The per-launch instrument for a provider whose own extension system carries it. The
/// asset is compiled in; only the port and our stable id are substituted, so a launch
/// mutates nothing global. Claude keeps `write_instrument_settings`; this is its sibling.
pub(crate) fn write_instrument(
    provider: &str,
    port: u16,
    session_id: &str,
) -> std::io::Result<Vec<String>> {
    let (template, ext, flag) = match provider {
        "omp" => (
            include_str!("../../src/providers/instrument/omp.ts"),
            "ts",
            "-e",
        ),
        other => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("no instrument asset for provider {other}"),
            ))
        }
    };
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{provider}-{session_id}.{ext}"));
    let body = template
        .replace("__EPISKO_PORT__", &port.to_string())
        .replace("__EPISKO_SID__", session_id);
    std::fs::write(&path, body)?;
    Ok(vec![flag.to_string(), path.to_string_lossy().to_string()])
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test write_instrument`
Expected: PASS, both tests.

- [ ] **Step 7: Commit**

```bash
git add src/providers/instrument/omp.ts src-tauri/src/telemetry.rs
git commit -m "feat(telemetry): per-launch instrument assets, with OMP's shim"
```

---

## Task 3: The `omp` launch arm

**Files:**
- Modify: `src-tauri/src/agent.rs:812-830` (the `start_provider` match) and add `omp_permission_args` beside `codex_permission_args` (line 837)
- Test: `src-tauri/src/agent.rs`, in-file `mod tests`

**Interfaces:**
- Consumes: `telemetry::write_instrument(provider, port, session_id) -> std::io::Result<Vec<String>>` from Task 2.
- Produces: launch args for an `omp` pane. `spawn_agent` in `pty.rs:912` already calls `start_provider` and passes the result to `argv_command`; that call site does not change.

`start_provider` takes `state: &AppState`, which holds the telemetry `port`. Unlike `"codex"`, this arm starts no child and registers nothing in `agent_runtimes`, so `stop_runtime` finds no entry and cleanup is already correct.

The mode string must never become an argument. `codex_permission_args` (line 837) is the precedent: a whitelist returning `&'static [&'static str]`, with an unknown id logged and degraded to the vendor's own config rather than failing the launch.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/agent.rs`'s `mod tests`:

```rust
#[test]
fn omp_permission_args_whitelists_modes() {
    assert_eq!(omp_permission_args(None), &[] as &[&str]);
    assert_eq!(omp_permission_args(Some("")), &[] as &[&str]);
    assert_eq!(omp_permission_args(Some("default")), &[] as &[&str]);
    assert_eq!(omp_permission_args(Some("always-ask")), &["--approval-mode", "always-ask"]);
    assert_eq!(omp_permission_args(Some("write")), &["--approval-mode", "write"]);
    assert_eq!(omp_permission_args(Some("yolo")), &["--approval-mode", "yolo"]);
    // An unknown id must degrade to OMP's own config, never reach argv.
    assert_eq!(omp_permission_args(Some("--yolo; rm -rf /")), &[] as &[&str]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test omp_permission_args`
Expected: FAIL — `omp_permission_args` is not defined.

- [ ] **Step 3: Write the implementation**

Add beside `codex_permission_args`:

```rust
/// Whitelist from Episko's mode ids to OMP's three approval modes; the id itself never
/// becomes an argument, and an unknown one degrades to OMP's own config.
fn omp_permission_args(mode: Option<&str>) -> &'static [&'static str] {
    match mode.map(str::trim) {
        None | Some("") | Some("default") => &[],
        Some("always-ask") => &["--approval-mode", "always-ask"],
        Some("write") => &["--approval-mode", "write"],
        Some("yolo") => &["--approval-mode", "yolo"],
        Some(other) => {
            log::warn!("ignoring unknown OMP permission mode {other:?} — using config");
            &[]
        }
    }
}
```

Then add the arm to `start_provider`'s match, before the `_ => Ok(Vec::new())` default:

```rust
// No sidecar: the shim reports into the telemetry server we already run, so there is
// no runtime to register and nothing for stop_runtime to tear down.
"omp" => {
    let mut args = crate::telemetry::write_instrument("omp", state.port, launch.session_id)
        .map_err(|e| format!("write OMP instrument: {e}"))?;
    args.extend(omp_permission_args(launch.mode).iter().map(|a| (*a).to_string()));
    args.extend(["--cwd".to_string(), launch.workdir.to_string()]);
    if let Some(id) = launch.resume {
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    Ok(args)
}
```

Note `app` is unused in this arm; it is already bound by the function signature and used by the `"codex"` arm, so no change is needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agent.rs
git commit -m "feat(agent): launch OMP with per-launch instrumentation, no sidecar"
```

---

## Task 4: The end-to-end shim smoke test

**Files:**
- Test: `src-tauri/src/telemetry.rs`, in-file `mod tests`

**Interfaces:**
- Consumes: `write_instrument` (Task 2) and the `/agent` route (Task 1).
- Produces: nothing consumed by later tasks.

This is the load-bearing test. A shim failure is silent — the same class as the statusLine bug that removed every figure at once — and no test that *reads* the generated file can catch it, because such a test agrees with our intent and the intent is the bug. So the test executes the real binary. Measured cost: 0.55s, zero model tokens, because `--mode rpc --no-ui --no-session` reaches `session_start` without a provider turn.

It must **skip** rather than fail when `omp` is not on PATH, since CI runners and most dev machines do not have it. Follow how the existing `#[ignore]`d Claude tests and the PATH-probing tests in this repo handle absence.

- [ ] **Step 1: Write the failing test**

```rust
/// Executed, never read: a test that inspects the generated shim agrees with our intent,
/// and the intent is what breaks. Zero model tokens — rpc mode reaches session_start
/// without a provider turn. Skips where omp is not installed.
#[test]
fn omp_shim_posts_agent_events() {
    let Some(bin) = crate::pty::resolve_cli("omp") else { return };
    let (port, next, wait) = start_test_server();
    let sid = "shim-smoke-1";
    let args = write_instrument("omp", port, sid).expect("shim");

    let out = std::process::Command::new(&bin)
        .args(["--mode", "rpc", "--no-ui", "--no-session"])
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    assert!(out.is_ok(), "omp failed to start");

    let ev = next();
    assert_eq!(ev["sessionId"], sid, "the stable launch id must ride the header");
    assert_eq!(ev["provider"], "omp");
    assert_eq!(ev["method"], "session_start");
    assert!(ev["params"]["context"]["contextWindow"].as_u64().unwrap_or(0) > 0);

    let _ = wait;
    let _ = std::fs::remove_file(&args[1]);
}
```

If `resolve_cli` is not reachable from `telemetry.rs` (it is `pty.rs`'s), use `std::process::Command::new("omp")` guarded by a `Command::new("omp").arg("--version").status()` probe that returns early on error, rather than widening `resolve_cli`'s visibility.

- [ ] **Step 2: Run test to verify it fails**

Temporarily break the shim's URL (change `/agent` to `/agentx`) and run:
Run: `cd src-tauri && cargo test omp_shim_posts_agent_events -- --nocapture`
Expected: FAIL — no `agent-event` arrives. Then restore the URL. This step exists because a test that skips silently proves nothing; you must see it fail once.

- [ ] **Step 3: Run test to verify it passes**

Run: `cd src-tauri && cargo test omp_shim_posts_agent_events -- --nocapture`
Expected: PASS in roughly a second.

- [ ] **Step 4: Probe the trusted-extension conflict**

Run: `omp --help | grep -A2 trusted-extension`
OMP's CLI reference states `--trusted-extension` cannot be combined with `-e`/`--extension`/`--hook`. Confirm whether a user *config* (not a flag) can set trusted extensions and thereby break an `-e` launch. Record the finding in the commit message. If it can, the launch must degrade to terminal-only rather than failing; capture that as a follow-up rather than widening this task.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/telemetry.rs
git commit -m "test(telemetry): execute the OMP shim against a mock server"
```

---

## Task 5: The OMP event adapter

**Files:**
- Create: `src/providers/omp.ts`
- Create: `test/omp.test.ts`

**Interfaces:**
- Consumes: the `ProviderEvent` shape `{ sessionId, provider, method, params, requestId }` (`src/agents.ts:14-17`) that Task 1's route produces.
- Produces: `export function ompEvents(event: ProviderEvent): AgentEvent[]` and `export const OMP_PERMISSION_MODES: readonly AgentPermissionMode[]`. Task 6 registers both.

The `AgentEvent` union is `src/agents.ts:22-38`; **no new variants**. `AgentTokenUsage` is `{ total: AgentTokenBreakdown; last: AgentTokenBreakdown; contextWindow: number | null }`, and `AgentTokenBreakdown` has `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`.

Copy the `obj` / `text` / `clip` / `leaf` helpers from `src/providers/codex.ts:19-25` rather than inventing new ones — same shapes, same caps.

Two rules the tests exist to pin:

1. An `agent_end` with `isTerminal === false` is a retry, compaction continuation or async delivery. It must **not** emit `turn-completed`, or the pane parks while the agent runs on.
2. `message.usage.cost.total` is **per message**. `costDelta` in `usage.ts` expects a cumulative figure, so the adapter keeps a running sum keyed by session id and emits the total.

- [ ] **Step 1: Write the failing tests**

Create `test/omp.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test omp`
Expected: FAIL — cannot resolve `../src/providers/omp`.

- [ ] **Step 3: Write the implementation**

Create `src/providers/omp.ts`. It is the only frontend module that knows OMP method names. Structure it as: the permission modes, the copied helpers, a `fileTouches(tool, input)` mapper, a module-level `Map<string, number>` of cumulative cost by session id, then one `switch (event.method)` returning `AgentEvent[]`.

```ts
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
    case "auto_compaction_start":
    case "auto_retry_start":
      return [{ type: "thread-status", status: "active", waiting: false }];
    case "auto_compaction_end":
    case "auto_retry_end":
      return [{ type: "thread-status", status: "active", waiting: false }];
    case "session_shutdown":
      return [{ type: "disconnected" }];
    default:
      return [];
  }
}

function todosFrom(input: Record<string, any>): Todo[] {
  const list = Array.isArray(input.list) ? input.list : [];
  const out: Todo[] = [];
  for (const phase of list) {
    for (const item of Array.isArray(obj(phase).items) ? obj(phase).items : []) {
      out.push({ text: text(item), status: "pending" });
    }
  }
  return out;
}
```

Before running, open `src/types.ts` and confirm `Todo`'s exact fields and `AgentPermissionMode`'s exact fields, and adjust `todosFrom` and `OMP_PERMISSION_MODES` to match. Do not guess: `tsc` will tell you, and the shapes above are written from `codex.ts`'s usage.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test omp && pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.test.json --noEmit`
Expected: PASS and clean. If `test/comments.test.ts` fails on density, cut comments — the rule is one or two lines each.

- [ ] **Step 5: Commit**

```bash
git add src/providers/omp.ts test/omp.test.ts
git commit -m "feat(providers): OMP event adapter"
```

---

## Task 6: Register OMP and prove it end to end

**Files:**
- Modify: `src/providers/manifest.json`
- Modify: `src/providers/index.ts:114-126` (the `PROVIDER_ADAPTERS` array)
- Modify: `docs/providers.md`, `CHANGELOG.md`, `RELEASE.md`

**Interfaces:**
- Consumes: `ompEvents` and `OMP_PERMISSION_MODES` from Task 5.
- Produces: a live integrated provider. Nothing later depends on it.

This is the task that turns the pane on. `test/provider-contract.test.ts` enforces that manifest ids and `PROVIDER_ADAPTERS` ids match exactly, that an integrated provider claims `session-state`, that a `session-state` claimant has an events adapter, and that a `launch-permissions` claimant has `permissionModes` — so the manifest and registry edits must land together or the suite fails.

- [ ] **Step 1: Add the manifest entry**

In `src/providers/manifest.json`, after the `codex` entry:

```json
  "omp": {
    "capabilities": [
      "session-state",
      "activity",
      "context",
      "usage",
      "launch-permissions"
    ]
  }
```

- [ ] **Step 2: Add the registry entry**

In `src/providers/index.ts`, import the adapter beside the existing `codex` imports and add to `PROVIDER_ADAPTERS`:

```ts
  { id: "omp", label: "OMP", events: ompEvents, permissionModes: OMP_PERMISSION_MODES },
```

- [ ] **Step 3: Run the contract suite**

Run: `pnpm test provider-contract && pnpm test`
Expected: PASS. A failure here names exactly which of the nine invariants broke.

- [ ] **Step 4: Run every gate**

Run, all of them:

```bash
pnpm build
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm test
cd src-tauri && cargo check && cargo test && cargo clippy --all-targets -- -D warnings
```

Expected: all green. These have gone red in CI for exactly one reason: the check was never run locally.

- [ ] **Step 5: Smoke the real thing**

Run `pnpm tauri dev`, then in the app launch an OMP session in a real project and confirm, by looking at the pane and the inspector:

1. The pane leaves `idle` and shows a phase once you send a prompt.
2. The inspector's context meter fills and names the model.
3. A tool call shows current-tool and argument, and the file appears in the Context card with the right kind (`read` for a read, `created` for a write).
4. Token counts and a USD figure appear, and the USD figure **increases** across turns rather than resetting.
5. A `todo` call populates the plan.
6. The turn ends when OMP finishes, and a compaction or retry mid-turn does not park the pane.
7. Closing the pane leaves no orphaned process (`ps aux | grep omp`).

Record what you saw. This is the only proof that matters; the unit tests cover the mapping, not the wiring.

- [ ] **Step 6: Update the docs**

In `docs/providers.md`, under "Adding an integrated provider", document the instrumented-CLI kind: a provider whose own extension system carries a per-launch asset reports through `write_instrument` and the `/agent` telemetry route rather than through a sidecar in `agent.rs`, and costs a shim asset, a `<vendor>.ts` adapter, a manifest row, a `write_instrument` arm and a `logos.ts` entry.

In `CHANGELOG.md`, add one entry under the unreleased heading: OMP is now an integrated provider with session state, activity, context and usage; approvals stay in the terminal.

In `RELEASE.md`, add OMP to the manual session checklist alongside Claude and Codex, minus the approval, history and resume steps it does not claim.

- [ ] **Step 7: Commit**

```bash
git add src/providers/manifest.json src/providers/index.ts docs/providers.md CHANGELOG.md RELEASE.md
git commit -m "feat(providers): OMP as an integrated provider"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the `/agent` route and `write_instrument` to Tasks 1-2, the shim asset to Task 2, the `start_provider` arm and launch modes to Task 3, the executed smoke test to Task 4, the event mapping table to Task 5, the manifest/registry/docs to Task 6. The spec's out-of-scope list (`history`, `resume`, `permissions`, `external-terminal`, ACP) has no task, correctly.

**Deferred by design, recorded here so it is not lost:** the spec's `session_start`-not-seen-within-N-seconds log line has no task. It is a diagnostic for a failure mode Task 4's probe may prove impossible, and adding it before that probe answers would be speculative. If Task 4 Step 4 finds that a trusted-extension config can silently prevent `-e` from loading, add it then.

**Type consistency.** `write_instrument(provider, port, session_id) -> io::Result<Vec<String>>` is defined in Task 2 and called with that signature in Task 3. `ompEvents(event: ProviderEvent): AgentEvent[]` and `OMP_PERMISSION_MODES` are defined in Task 5 and registered under those names in Task 6. The `/agent` payload keys (`sessionId`, `provider`, `method`, `params`, `requestId`) are produced in Task 1 and consumed in Task 5's `ProviderEvent`. Task 5 carries an explicit instruction to verify `Todo` and `AgentPermissionMode` field names against `src/types.ts` before running, because those two shapes are written from `codex.ts`'s usage rather than read directly.
