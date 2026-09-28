# Provider-Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the shared contract every coding-agent provider fills, so the next provider inherits the work instead of rediscovering it — and fix two defects Codex has today.

**Architecture:** Five independent changes to shared code, none of which alters a capability claim or a provider's behaviour except to fix a bug. Units become part of the types and are enforced by a per-adapter fixture test; an optional history method is documented as optional; the Windows spawn wrapper gains `CREATE_NO_WINDOW`; the Usage & spend dialog grows a block for per-pane rate limits; and a pane's provider conversation id is latched in the backend so it survives a webview reload.

**Tech Stack:** Rust (Tauri v2), vanilla TypeScript (strict, no framework), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-28-provider-contract-hardening-design.md`

## Global Constraints

- Package manager is **`pnpm`**, never npm.
- Rust visibility is **`pub(crate)`, never `pub`**, including on a `#[tauri::command]` fn in a private module.
- Rust tests are **in-file `#[cfg(test)] mod tests`**. There is deliberately no `src-tauri/tests/` directory.
- `src/` must never touch a browser global at module scope (`document`, `window`, `navigator`) — vitest runs in the `node` environment — nor a node global (`process`, `Buffer`). `tsconfig.json` keeps `"types": []` to guarantee the latter.
- Comments: one or two lines, five at the very most. A comment says a non-obvious *why* or an invariant; it never restates the code. `test/comments.test.ts` gates block length and density.
- A `*view.ts` module takes data and returns a string: no `$()`, no `innerHTML`, no renderer call. The `render*` function that paints the result stays with whoever owns the element.
- Shared UI must not branch on a vendor id. `test/provider-contract.test.ts` fails if a non-Claude vendor string appears outside `src/providers/`.
- **Do not run any formatter** (`cargo fmt`, prettier, editor format-on-save). Stage only the files you meant to change.
- Gates, all of them, before handoff: `pnpm build`, `pnpm exec tsc -p tsconfig.test.json --noEmit`, `pnpm test`, and from `src-tauri/`: `cargo check`, `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- No capability claim changes in this plan. `src/providers/manifest.json` is not edited.

---

## File Structure

**Create:**
- `test/units.test.ts` — the per-adapter unit guard for `AgentRateLimit` and `HistEntry` (Task 1).

**Modify:**
- `src/types.ts:170-172` — units on `AgentRateLimit` (Task 1).
- `src/providers/index.ts:28-35` — `asked?()` documentation (Task 2).
- `src-tauri/src/agent.rs:41-55` — `CREATE_NO_WINDOW` in `process_command` (Task 3).
- `src/usageview.ts` — a per-pane limits block (Task 4).
- `src/usagedlg.ts` — nothing, unless Task 4's block needs a render trigger.
- `src-tauri/src/lib.rs:37-52` — `Session.resume_id` (Task 5).
- `src-tauri/src/telemetry.rs` — latch it on the `/agent` route (Task 5).
- `src-tauri/src/pty.rs:1275-1290` — carry it on `LiveSession` (Task 5).
- `src/panes.ts:243-275` — prefer it in `adoptSession` (Task 5).

Tasks 1–5 are independent. Any order works; the numbering is by value.

---

## Task 1: Units become contract

**Files:**
- Modify: `src/types.ts:170-172`
- Create: `test/units.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

Background. `AgentRateLimit` carries three scale-bearing fields and documents none. The proof of each unit lives in a different file from the type: `src/rl.ts:18` compares `reset * 1000` against `Date.now()` (so `resetsAt` is epoch **seconds**), and `src/footer.ts:81` passes `windowMins * 60` as a seconds length (so `windowMins` is **minutes**). `usedPercent` is 0–100. `HistEntry.last_active` (`src/history.ts:13`) already documents epoch seconds in a comment.

A provider that supplied milliseconds shipped a popover counting down `20704143d 8h`. Two reviews missed it because the design said `resets_at ← window.resetsAt` and the test asserted the raw payload number — both agreed with the bug. So the comment alone is not the deliverable; the guard is.

- [ ] **Step 1: Write the failing test**

Create `test/units.test.ts`. It drives each adapter's real mapper with a native-shaped payload and asserts the units, so a milliseconds or fraction regression fails for whichever provider caused it.

```ts
import { describe, expect, it } from "vitest";
import { codexEvents } from "../src/providers/codex";
import type { AgentRateLimit } from "../src/types";

// Epoch seconds for a plausible "now": a milliseconds value is ~1000x larger and fails.
const EPOCH_SECONDS = { min: 1_600_000_000, max: 2_000_000_000 };

function assertUnits(windows: AgentRateLimit[]) {
  for (const w of windows) {
    expect(w.usedPercent).toBeGreaterThanOrEqual(0);
    expect(w.usedPercent).toBeLessThanOrEqual(100);
    if (w.resetsAt !== null) {
      expect(w.resetsAt, `resetsAt must be epoch SECONDS, got ${w.resetsAt}`)
        .toBeGreaterThan(EPOCH_SECONDS.min);
      expect(w.resetsAt, `resetsAt must be epoch SECONDS, got ${w.resetsAt}`)
        .toBeLessThan(EPOCH_SECONDS.max);
    }
    if (w.windowMins !== null) {
      // Minutes: a 7-day window is 10080, not 604800 (seconds) or 604800000 (ms).
      expect(w.windowMins).toBeLessThanOrEqual(60 * 24 * 90);
    }
  }
}

describe("rate-limit units are the same for every provider", () => {
  it("codex reports seconds, minutes and a 0-100 percentage", () => {
    const events = codexEvents({
      sessionId: "s1", provider: "codex", requestId: null,
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 43, resetsAt: 1790628600, windowDurationMins: 300 },
          secondary: { usedPercent: 79, resetsAt: 1791216000, windowDurationMins: 10080 },
        },
        episkoScope: "acct-1",
      },
    });
    const limits = events.find((e) => e.type === "rate-limits");
    expect(limits?.type).toBe("rate-limits");
    if (limits?.type !== "rate-limits") throw new Error("no rate-limits event");
    expect(limits.windows).toHaveLength(2);
    assertUnits(limits.windows);
  });

  it("rejects a window whose resetsAt is milliseconds", () => {
    // The guard itself must bite; this is what the shipped bug looked like.
    expect(() => assertUnits([{ usedPercent: 43, resetsAt: 1790628600281, windowMins: 300 }]))
      .toThrow();
  });

  it("rejects a usedPercent expressed as a 0-1 fraction", () => {
    expect(() => assertUnits([{ usedPercent: 0.43, resetsAt: null, windowMins: null }]))
      .not.toThrow(); // 0.43 is within 0-100; a fraction is only detectable against a real payload
  });
});
```

Note on the third case: a bare fraction cannot be distinguished from a genuinely-low percentage, so the test documents that limit rather than pretending to catch it. Delete that third `it` if you prefer not to encode a non-guarantee — but do not replace it with an assertion that cannot fail.

- [ ] **Step 2: Run the test to verify the guard bites**

Run: `pnpm test units`
Expected: the codex case PASSES (its mapper is already correct) and the milliseconds case PASSES (it asserts the guard throws). If the milliseconds case does not throw, the guard is wrong — fix it before continuing, because a guard that cannot fail is the defect this task exists to prevent.

- [ ] **Step 3: Write the units onto the type**

In `src/types.ts:170-172`:

```ts
// Units are contract, not folklore: a provider that supplied milliseconds shipped a
// countdown of 20704143d. `test/units.test.ts` fails when an adapter gets one wrong.
export interface AgentRateLimit {
  usedPercent: number;        // 0–100, not a 0–1 fraction
  resetsAt: number | null;    // epoch SECONDS (rl.ts compares reset * 1000 to Date.now())
  windowMins: number | null;  // MINUTES (footer.ts passes windowMins * 60 as seconds)
}
```

Keep any `label?: string` field if one is present on the branch you are working from.

- [ ] **Step 4: Run the gates**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.test.json --noEmit`
Expected: all green, including `test/comments.test.ts` — the comment block above is 2 lines and the inline notes are short, but the density gate counts them.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/units.test.ts
git commit -m "fix(providers): make rate-limit units contract, guarded per adapter"
```

---

## Task 2: `asked?()` stops wearing a neutral name

**Files:**
- Modify: `src/providers/index.ts:28-35`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Documentation only — no signature change.

Background. `ProviderHistory` declares four methods. Three are required; `asked?()` is optional and only Claude implements it (`read_transcript_asked`). Codex falls back to `read()` silently. A provider author reading the interface cannot tell which methods they must supply.

- [ ] **Step 1: Document the distinction**

In `src/providers/index.ts`, above the interface and on the method. The existing comment on `asked` already explains *what* it returns; this adds *whether you must*:

```ts
// `list`, `read` and `reconcile` are required. `asked` is an optional quality
// improvement: without it a caller falls back to `read`, which answers with a tail.
export interface ProviderHistory {
  list(limit: number): Promise<HistEntry[]>;
  read(sessionId: string, cwd: string, limit: number): Promise<ProviderMessage[]>;
  // The questions alone, and from the whole conversation rather than the tail `read`
  // answers with: a day of tool traffic buries them, and an outline seeded from a tail
  // lists none. Optional — omitting it costs fidelity, not correctness.
  asked?(sessionId: string, cwd: string, limit: number): Promise<ProviderMessage[]>;
  reconcile(entries: Restorable[]): Promise<Restorable[]>;
}
```

Preserve the existing wording where it already says this; do not duplicate a sentence that is already there.

- [ ] **Step 2: Run the gates**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: green. `test/comments.test.ts` is the one at risk — if density fails, cut the added comment to one line.

- [ ] **Step 3: Commit**

```bash
git add src/providers/index.ts
git commit -m "docs(providers): say which ProviderHistory methods are required"
```

---

## Task 3: The Windows console flash

**Files:**
- Modify: `src-tauri/src/agent.rs:41-55`
- Test: `src-tauri/src/agent.rs`, in-file `mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

Background. `process_command` rewrites a spawn as `cmd.exe /D /C <bin>` for a script shim but sets no creation flags. `platform::sys_command` (`platform.rs:70-81`) sets `CREATE_NO_WINDOW = 0x0800_0000`. Episko is a GUI-subsystem process with no console, so every console-subsystem child spawned without that flag allocates one. **Codex is affected today**: `start_codex` is the caller, so a Windows user gets a console flash per pane launch. Every other short-lived CLI in the backend (`deps.rs::run_capped`, `usage.rs::run_usage_probe`, `git.rs::git_cmd`, `github.rs::gh`) already routes through `sys_command`.

This is Windows-only behaviour, and CI runs both OSes but cannot observe a console window. The test is therefore a source-level assertion that the flag is applied — a weaker guard than executing it, but the alternative is no guard at all. Say so in the test's comment.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/agent.rs`'s `mod tests`:

```rust
/// A GUI-subsystem process spawning a console child without CREATE_NO_WINDOW flashes a
/// console window. Not observable from CI on either OS, so this reads the source.
#[test]
fn process_command_suppresses_the_console_window() {
    let src = include_str!("agent.rs");
    let start = src.find("fn process_command").expect("process_command exists");
    let body = &src[start..start + 900];
    assert!(
        body.contains("creation_flags"),
        "process_command must set CREATE_NO_WINDOW; see platform::sys_command"
    );
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test process_command_suppresses`
Expected: FAIL — `process_command must set CREATE_NO_WINDOW`.

- [ ] **Step 3: Apply the flag**

In `process_command`'s `#[cfg(windows)]` block, set the flag on both arms — the native `.exe`/`.com` fast path and the `cmd.exe` shim path. Mirror `platform.rs:70-81`:

```rust
use std::os::windows::process::CommandExt;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
```

Keep the `.exe`/`.com` fast path: a native binary still needs no shell hop. Add a one-line comment saying why the flag is here (a GUI process has no console to inherit), not what it does.

- [ ] **Step 4: Run it to see it pass, plus the OS half you cannot run**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: green. The `#[cfg(windows)]` block does not compile on macOS, so **use the cfg-flip trick** from `docs/testing.md` to typecheck the other half, and commit your real changes before running it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agent.rs
git commit -m "fix(agent): suppress the console window when spawning a provider CLI on Windows"
```

---

## Task 4: Per-pane limits get a surface

**Files:**
- Modify: `src/usageview.ts` (beside `forecastBlockHtml` at :315 and `scopedBlockHtml` at :330, rendered from `usagePanelHtml` at :341)

**Interfaces:**
- Consumes: `Sess.rateLimits: AgentRateLimit[]` and `Sess.rateLimitScope: string | null` (`src/types.ts:396-397`), whose units Task 1 documents.
- Produces: nothing later tasks depend on.

Background. Two rate-limit models exist: Claude's account-wide global one (`rl`/`rlScoped`, with forecast and burn rate) and the per-pane one (`Sess.rateLimits`). `usageview.ts` renders only the global model, so a provider supplying per-pane windows has nowhere to appear in Usage & spend. That absence already produced a defect where the dialog fired a live network probe for a provider whose result it could not display.

`usageview.ts` is a markup-only module: it takes data and returns a string. No `$()`, no `innerHTML`, no renderer call. Follow `scopedBlockHtml` for the shape and class names.

- [ ] **Step 1: Read the two existing blocks**

Read `forecastBlockHtml` (`:315`) and `scopedBlockHtml` (`:330`) in full, plus `usagePanelHtml` (`:341`). Match their markup idiom, their escaping helper and their empty-state handling exactly — a new block that invents its own classes will not inherit the panel's styling.

- [ ] **Step 2: Add the block**

Write `paneLimitsBlockHtml()` beside them: it reads the active session's `rateLimits`, returns `""` when there are none (so Claude's panel is byte-identical to today), and otherwise renders one row per window using the window's `label` when present and its `windowMins` span when not. Render it from `usagePanelHtml` immediately after `forecastBlockHtml()`.

Do not add a forecast, burn rate or projection: the per-pane model has no rate history behind it, and printing a projection from a single reading is the fabricated state `docs/providers.md` forbids. A level and a reset time is what the data supports.

- [ ] **Step 3: Verify Claude's panel is unchanged**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: green. Then confirm by inspection that with no per-pane windows the function returns `""` and `usagePanelHtml`'s output is identical to before — a Claude-only user must see no change at all.

- [ ] **Step 4: Commit**

```bash
git add src/usageview.ts
git commit -m "feat(usage): render a pane's own rate-limit windows in Usage & spend"
```

---

## Task 5: The conversation id survives a webview reload

**Files:**
- Modify: `src-tauri/src/lib.rs:37-52` (the `Session` struct)
- Modify: `src-tauri/src/telemetry.rs` (the `/agent` route arm)
- Modify: `src-tauri/src/pty.rs:1275-1290` (`LiveSession` and `live_sessions`)
- Modify: `src/panes.ts:243-275` (`adoptOrphans` / `adoptSession`)
- Test: `src-tauri/src/telemetry.rs` in-file `mod tests`; `test/` for the frontend half

**Interfaces:**
- Consumes: the `/agent` route's payload `{ sessionId, provider, method, params, requestId }`.
- Produces: `LiveSession.resume_id: Option<String>`, surfacing in TypeScript as `LiveSess.resume_id: string | null`, consumed by `adoptSession`.

Background. A webview reload discards frontend state while the agent process keeps running. `adoptSession` (`panes.ts:275`) sets `resumeId: m?.resumeId ?? o.id`, where `m` is the roster row — and `saveRoster` (`mirror.ts:56`) only persists sessions whose provider claims `resume`. So for any provider without that capability, and for any provider before its first roster write, an adopted pane's `resumeId` becomes the **pane id** and the provider's real conversation id is lost.

Two real consequences: the cost baseline is keyed `provider:resumeId` (`agents.ts:88`) so it silently re-keys on adoption, and a provider that later claims `resume` cannot resume an adopted pane.

Re-asking the provider does not work — OMP's shim is push-only and announces its session once at launch; Codex's `refresh_agent_state` errors for a runtime-less provider. The backend is the thing that does not reload, and `Session` already exists for this: `kind` is *"kept backend-side so an orphaned PTY stays self-describing across a webview reload"* and `scrollback` *"refills a pane after a webview reload"*.

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/telemetry.rs`'s `mod tests`, model it on the existing `agent_route_emits_provider_events` test — read that test and reuse its real helpers (`mock_telemetry_app`, `open_post`, `read_response` and the per-test mpsc closure) rather than inventing names.

The test posts a provider event carrying a conversation id to `/agent` and asserts the backend latched it onto the session, retrievable through `live_sessions`. Decide from the code which event shape carries the id — for OMP it is `session_start`'s `sessionId` param, for Codex a `thread` id — and latch on the neutral fact that the adapter reports one, not on a vendor method name.

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test <your test name>`
Expected: FAIL — the field does not exist yet.

- [ ] **Step 3: Add the field and latch it**

`Session` gains `resume_id: Option<String>` with a one-line comment in the idiom of its neighbours (why it is backend-side, not what it holds). The `/agent` route arm in `run_telemetry_server` latches it when the payload carries a conversation id. `LiveSession` carries it and `live_sessions` returns it.

Keep the latch provider-neutral: the route must not learn a vendor's method names. If the id cannot be extracted neutrally from the existing payload, latch it from the `agent-event` the adapter already produces rather than adding a vendor branch in Rust — and say in your report which you chose and why.

- [ ] **Step 4: Run it to see it pass**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: green, including every pre-existing telemetry test.

- [ ] **Step 5: Prefer it in adoption**

In `src/panes.ts`, `adoptSession` currently reads `resumeId: m?.resumeId ?? o.id`. Make the backend's value win over the pane-id fallback, keeping the roster row as the middle preference: the backend knows the live conversation, the roster knows what was persisted, and the pane id remains the last resort.

Add a frontend test that adopts a session with **no roster row** and asserts the backend-supplied id is used rather than the pane id. That is the case that is broken today, so verify it fails before your change.

- [ ] **Step 6: Run every gate**

Run, all of them:

```bash
pnpm build
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm test
cd src-tauri && cargo check && cargo test && cargo clippy --all-targets -- -D warnings
```

- [ ] **Step 7: Smoke it in the real app**

Run `pnpm tauri dev`, start an agent session, send one prompt, then reload the interface (Settings › Diagnostics › Reload, which calls `reloadUi`). Confirm the adopted pane keeps running, its scrollback returns, and its cost figure does not jump or reset. Record what you saw; this is the only proof that matters for this task.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/telemetry.rs src-tauri/src/pty.rs src/panes.ts test/
git commit -m "fix(panes): keep a provider's conversation id across a webview reload"
```

---

## Self-Review

**Spec coverage.** §1 units → Task 1. §2 `asked?()` → Task 2. §3 Windows console → Task 3. §4 per-pane surface → Task 4. §5 conversation id → Task 5. The spec's out-of-scope items (unifying the rate-limit models, making the roster provider-agnostic, OMP's capabilities) have no task, correctly.

**Placeholder scan.** Tasks 4 and 5 describe two steps in prose rather than giving the literal code: Task 4 Step 2's block body and Task 5 Step 3's latch. Both are deliberate and bounded — each names the file, the neighbouring function to copy the idiom from, the exact preference order or empty-state rule, and the constraint that must hold. Writing a literal body for `paneLimitsBlockHtml` would invent class names without having read the CSS, and writing the latch literally would pre-judge whether the id can be extracted neutrally, which Step 3 explicitly asks the implementer to determine and report. Every other step carries its code.

**Type consistency.** `resume_id: Option<String>` in Rust surfaces as `resume_id: string | null` on `LiveSess` in TypeScript — Task 5's Interfaces block states both spellings, since `LiveSession` uses snake_case fields and the frontend interface mirrors them. `AgentRateLimit`'s three fields keep the names they have today; Task 1 adds comments only. `paneLimitsBlockHtml()` is named once, in Task 4.

**One risk worth naming.** Task 3's test reads source rather than executing behaviour, which this repo's conventions would normally call weak. It is justified here because the failure is a Windows-only UI artefact that neither CI runner can observe, and the alternative is no guard. The test's own comment says so.
