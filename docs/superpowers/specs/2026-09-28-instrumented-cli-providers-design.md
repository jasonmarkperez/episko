# Instrumented-CLI providers, with OMP as the first

Status: design approved, not implemented.
Scope: extend Episko beyond Claude Code and Codex to a third integrated coding-agent
harness, and make the fourth cheap.

## Problem

Episko integrates two providers by two unrelated mechanisms. Claude gets a throwaway
per-launch `--settings` file whose shell hooks POST to the loopback `tiny_http`
telemetry server. Codex gets a sidecar (`codex app-server --listen ws://…`) that the
real TUI attaches to with `--remote`. Every other discovered CLI, `omp` among them
(`pty.rs`, `AgentSpec { id: "omp", … }`), is terminal-only with no manifest entry and
therefore no capabilities.

Adding a third provider the Codex way costs a second sidecar-sized control plane in
`agent.rs`. Adding a fourth costs a third. The per-vendor cost never falls.

## What does and does not generalize

Nothing generalizes at the wire. Claude ships shell hooks, Codex ships a JSON-RPC app
server, OMP ships a JS/TS extension API and a stdio RPC mode. ACP is the one real
cross-vendor standard and `omp acp` speaks it, but ACP makes the *client* render the
conversation. Episko's product is a real TUI in a PTY, so adopting ACP would replace
`panes`/`terminal` rather than add a provider. It is rejected on product shape, not
on merit.

Codex's own trick does not transfer either: it works because `codex --remote` attaches
the real TUI to the server Episko observes, so one thread has two clients. OMP has no
`--remote`; `--mode rpc` is a separate headless conversation, not an observer of the
pane.

What does generalize is **transport and launch** — Claude's mechanism, which is
already built, already supervised, and already the right shape. Translation stays
per-vendor, because the vendor vocabularies genuinely differ and translation must live
where `tsc` and vitest can see it.

## Verified basis

A throwaway extension materialized in `/tmp` and loaded with `omp -e <path>`
instruments a live session and reaches a loopback HTTP server with a custom header.
Observed under the real TUI (`hasUI: true`) and under `--mode rpc --no-ui`, at zero
model tokens:

```json
{ "sid": "launch-uuid-1234",
  "payload": { "cwd": "…", "sessionId": "01a0e74f-549d-…", "model": "claude-opus-5",
               "hasUI": true,
               "ctxUsage": { "tokens": 11757, "contextWindow": 1000000, "percent": 1.18 } } }
```

This is Claude's per-launch instrumentation without Claude's three hard constraints:
real `fetch` (no `/usr/bin/curl`, no stripped PATH), no shell at any point (no
Git-Bash-or-PowerShell parse hazard), and genuinely async handlers.

Data sources confirmed for every capability claimed below:

| Need | OMP source |
| --- | --- |
| thread id / model / title | `session_start` → `ctx.sessionManager.getSessionId()`, `ctx.model.id`, `pi.getSessionName()` |
| context meter | `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` |
| tokens and cost | `message_end` snapshot → `message.usage { input, output, cacheRead, cacheWrite, cost.total }` |
| activity | `tool_call` / `tool_result` → `toolName`, `toolCallId`, `input`, `content`, `isError` |
| plan todos | the `todo` tool's own `tool_call` input |
| waiting on you | `tool_approval_requested` / `tool_approval_resolved` |

## Architecture

```text
omp TUI in PTY                 tiny_http telemetry server        frontend
  -e /tmp/cc-launcher/   POST   (already running, supervised)  emit   main.ts:490
  omp-<uuid>.ts        ──────▶  /agent  +  X-CC-Session: uuid  ─────▶ (already routes)
                                                                        │
                                              providers/omp.ts ◀────────┘
                                              ompEvents → AgentEvent[]
                                                     │
                                              applyAgentEvent → Sess → shared UI
```

### Rust

New sibling of `write_instrument_settings` in `telemetry.rs`:

```rust
/// Materialize a provider's per-launch instrument asset and return its launch args.
/// Rust knows only which asset and which flag carries it; the asset's contents are the
/// vendor's business, exactly as write_instrument_settings owns Claude's JSON.
pub(crate) fn write_instrument(provider: &str, port: u16, session_id: &str)
    -> std::io::Result<Vec<String>>
```

For `omp` it writes `$TMPDIR/cc-launcher/omp-<uuid>.ts` with the port and the stable
launch uuid baked in — no environment plumbing through the PTY — and returns
`["-e", path]`.

`agent.rs::start_provider` gains an arm that starts **no sidecar**:

```rust
"omp" => {
    let mut args = telemetry::write_instrument("omp", state.port, launch.session_id)?;
    args.extend(omp_permission_args(launch.mode).iter().map(|a| a.to_string()));
    args.extend(["--cwd".into(), launch.workdir.into()]);
    if let Some(id) = launch.resume { args.extend(["--resume".into(), id.into()]); }
    Ok(args)
}
```

Third arm in `run_telemetry_server`'s dispatch, ahead of the `statusline`/`hook`
fallthrough:

```rust
if url.contains("agent") {
    let _ = app.emit("agent-event", json!({
        "sessionId": stable_sid, "provider": data["provider"],
        "method": data["method"], "params": data["params"], "requestId": null,
    }));
    let _ = request.respond(tiny_http::Response::from_string(""));
    continue;
}
```

That payload is byte-compatible with what `agent.rs` already emits for Codex, so
`main.ts`'s `agent-event` listener needs no change: it validates `provider` against
the pane and calls `providerAdapter(provider).events(raw)`.

Claude's `--settings` path is **not refactored**. The generalization is additive.

### Frontend

`src/providers/instrument/omp.ts` — the shim asset, roughly 60 lines, no judgement in
it:

```ts
const post = (method: string, params: unknown) =>
  fetch(`http://127.0.0.1:${PORT}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-CC-Session": SID },
    body: JSON.stringify({ provider: "omp", method, params }),
  }).catch(() => {});   // silent, like Claude's `curl -s`
```

`src/providers/omp.ts` — `ompEvents(event: ProviderEvent): AgentEvent[]`, mirroring
`codex.ts`. No new `AgentEvent` variants; the existing vocabulary covers it.

`src/providers/index.ts` — one `PROVIDER_ADAPTERS` entry:
`{ id: "omp", label: "OMP", events: ompEvents, permissionModes: OMP_PERMISSION_MODES }`.

`src/providers/manifest.json`:

```json
"omp": { "capabilities": ["session-state", "activity", "context", "usage", "launch-permissions"] }
```

No `permissions`, no `history`, no `resume`, no `external-terminal`.
`src/providers/logos.ts` needs an `omp` entry or `provider-contract.test.ts` fails.

## Event mapping

| Shim method | `AgentEvent` |
| --- | --- |
| `session_start` | `thread { id, model, title }`, then `usage` carrying the context figures |
| `before_agent_start` | `prompt { text }` (the already-transformed batch text) |
| `agent_start` | `turn-started` |
| `turn_start` / `turn_end` | dropped; Episko's turn is OMP's agent run, not its provider iteration |
| `agent_end` | `turn-completed { failed, detail, durationMs }` **only when `isTerminal !== false`** |
| `tool_call` | `activity-started { id: toolCallId, tool, arg, input, desc }` |
| `tool_result` | `activity-completed { id, tool, input, inputData, output, failed: isError, files }` |
| `tool_call` where `toolName === "todo"` | additionally `plan { todos }` |
| `message_end` (assistant) | `usage { … }` and `cost { totalUsd }` |
| `tool_approval_requested` / `_resolved` | `thread-status { status: "active", waiting: true / false }` |
| `auto_compaction_start/end`, `auto_retry_start/end` | `thread-status`, so the pane says compacting/retrying rather than looking stalled |
| `session_shutdown` | `disconnected` |

A non-terminal `agent_end` (`isTerminal: false`) means retry, compaction continuation
or async delivery has scheduled more work. Treating it as the end of a turn would park
the pane while the agent runs on; this is the single most consequential mapping rule.

Cost accumulates **in the adapter, not the shim**: `message.usage.cost.total` is
per-message, `costDelta` in `usage.ts` expects a cumulative figure, and arithmetic must
not live in the untested asset.

File touches derive from tool name and input (`read`, `write`, `edit`, `apply_patch`),
as `codex.ts`'s `fileTouches` does. `bash` is deliberately not modelled: the working-set
card that reads git already answers it correctly.

## Approvals

The terminal owns the decision. Episko does not claim `permissions`.

OMP's default approval mode is `yolo`, its TUI owns its own prompt, and the extension's
`tool_call` handler fires *before* OMP's approval gate — so an Episko allow would be
followed by a second prompt in the pane. Episko could only own approvals by launching
`--approval-mode yolo` and becoming the sole gate, which means an instrument that fails
to load leaves a session running unguarded.

So `tool_approval_requested` / `_resolved` are observed and mapped to
`thread-status { waiting }`. **This does not badge attention**, and an earlier draft of
this spec was wrong to say it does: the shared reducer acts on `thread-status` only when
`status === "active" && !waiting` or when `status === "idle"`, so a waiting reading takes
neither branch and `needsYou` — which decides the badge from `s.attention` and the phase —
never sees it. What the emission does earn is real but smaller: the pane does not park at
`idle` while OMP waits, so it floats up by recency rather than looking dormant. Badging
would require either claiming the `permissions` capability or adding a neutral event, and
inventing a phase to fake it is precisely the fabricated state `docs/providers.md` forbids.
You answer in the TUI.

Episko-owned approvals remain addable later behind a setting: OMP's handlers are async,
so the gate would be a real promise rather than a held-open HTTP request. The mapping
above does not have to change for that; only `manifest.json` and a new blocking path in
the shim would.

## Launch modes

`omp_permission_args` is the whitelist boundary; the mode string itself never becomes an
argument, matching `codex_permission_args` and Claude's `permission_mode_arg`.

| Episko mode id | OMP args |
| --- | --- |
| `default` or unset | `[]` — the user's own config wins |
| `always-ask` | `--approval-mode always-ask` |
| `write` | `--approval-mode write` |
| `yolo` | `--approval-mode yolo` |

Three modes plus a pass-through, because OMP has exactly three. Inventing a fourth would
be fabricated state.

## Lifecycle and failure

The shim file is written per launch under `$TMPDIR/cc-launcher/`, beside Claude's
`instrument-<uuid>.json`, and like it is **not** deleted at runtime: nothing in the
backend removes those files today, and the OS owns that directory. Matching the
precedent keeps one story rather than two. There is also **no runtime to stop** —
`stop_runtime` finds no entry for an `omp` pane, because no sidecar child exists. That
is the main structural saving over Codex.

If the shim never loads, no POST ever arrives and the pane is a live terminal with no
telemetry — which is precisely the terminal-only fallback, degrading honestly rather
than sticking at `idle` forever. A `session_start`-not-seen-within-N-seconds log line
records it; no UI badge, because a badge nothing can clear is worse than no badge.

Known risk to probe during implementation: `-e` cannot be combined with
`--trusted-extension`. A user whose config uses trusted extensions must fall back to
terminal-only rather than failing the launch.

## Testing

- vitest `test/omp.test.ts`: `ompEvents` against captured native fixtures, including a
  non-terminal `agent_end` and cumulative cost accumulation.
- cargo `omp_shim_posts_agent_events`: spawns the real
  `omp --mode rpc --no-ui --no-session -e <shim>` against a mock `tiny_http` and asserts
  a `/agent` POST with the right `X-CC-Session`. Measured at 0.55s and zero model
  tokens, so it is CI-affordable on both OSes. This guards the same silent-failure class
  as `statusline_command_posts_from_every_shell_claude_might_pick`.
- cargo: `omp_permission_args` unit tests.
- `test/provider-contract.test.ts` already enforces manifest/registry id parity, known
  capability names, `session-state` implies an events adapter, and no vendor literal
  outside `providers/`.
- `RELEASE.md`: the manual session checklist — start, prompt, tool activity,
  context/usage/cost, close.

The shim's `pi.on` wiring beyond the cargo smoke is untested, by the same rule that
leaves render modules untested.

## Cost of the next harness

A harness with any hook or extension system then costs: one shim asset, one
`<vendor>.ts` adapter, one `manifest.json` row, one `write_instrument` arm, one
`logos.ts` entry. No control plane, no sidecar, no new event type, no frontend wiring.

## Out of scope

- `history` and `resume`. Both are genuinely supportable — OMP's session storage is
  documented (`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`, typed
  entry taxonomy) and `--resume` accepts id prefixes — but they need a new Rust JSONL
  reader with list/read/asked/reconcile, which roughly doubles the backend work.
- `permissions`, as argued above.
- `external-terminal`, which is Claude's external-session registry and has no OMP
  analogue.
- ACP, and any change that makes Episko render the conversation.
