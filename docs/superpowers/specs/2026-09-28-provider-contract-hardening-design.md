# Hardening the provider-neutral contract

Status: design approved, not implemented.
Scope: the shared contract every coding-agent provider fills. This is the first of two
specs; the second is OMP filling the remaining capabilities (`permissions`, `history`,
`resume`, `usage`, and the `external-terminal` partial).

## Why this comes first

Episko integrates Claude, Codex and — since today — OMP. Adding OMP surfaced defects that
are not OMP's: fields whose unit is folklore, a neutral-looking method only Claude
implements, a Windows spawn that flashes a console for Codex, a surface with nowhere to
render one of the two rate-limit models, and an adopted pane that silently loses its
provider's conversation id.

Each was found by a reviewer or by a user looking at a pane, not by a test. Fixing them in
the contract means the fourth provider inherits the work instead of rediscovering it, and
two of the five fix bugs Codex has today.

The evidence below was gathered by reading consumers, not docs. Line numbers are from
`dev` at `521b5db`.

## 1. Units become contract

`AgentRateLimit` carries three scale-bearing fields and documents none of them. The proof
of each unit lives in a different file from the type:

- `resetsAt` is epoch **seconds** — `rl.ts:18` compares `reset * 1000` against `Date.now()`.
- `windowMins` is **minutes** — `footer.ts:81` passes `windowMins * 60` as a seconds length.
- `usedPercent` is **0–100**, not a 0–1 fraction.
- `HistEntry.last_active` is epoch **seconds**.

A provider that supplied milliseconds shipped a limits popover counting down
`20704143d 8h` — about 56,700 years. Two independent reviews passed over the mapping
without catching it, because the design line said `resets_at ← window.resetsAt` and the
test asserted the raw payload number. Both agreed with the bug.

The fields get their units in the type:

```ts
export interface AgentRateLimit {
  usedPercent: number;        // 0–100, not a 0–1 fraction
  resetsAt: number | null;    // epoch SECONDS (rl.ts compares reset * 1000 to Date.now())
  windowMins: number | null;  // MINUTES (footer.ts passes windowMins * 60 as seconds)
  label?: string;             // when the span alone cannot name the window
}
```

A comment is folklore with better formatting, so it is paired with a guard. A contract test
runs **every** adapter's captured native fixture through its own mapper and asserts:

- each `resetsAt` falls in a plausible epoch-seconds band, so a milliseconds value fails;
- each `usedPercent` is within 0–100, so a fraction fails;
- `HistEntry.last_active` likewise.

The test is per-adapter and fixture-driven, so it fails for whichever provider regresses,
and a new provider joins it by adding a fixture rather than by remembering a rule.

## 2. `asked?()` stops wearing a neutral name

`ProviderHistory` declares:

```ts
asked?(sessionId: string, cwd: string, limit: number): Promise<ProviderMessage[]>;
```

Only Claude implements it (`read_transcript_asked`); Codex falls back to `read()` and the
fallback is silent. The method stays — the fallback is the right behaviour — but its doc
says what it is: an optional *quality* improvement, returning the questions alone and from
the whole conversation rather than the tail `read()` answers with, because a day of tool
traffic buries the questions and an outline seeded from a tail lists none. Omitting it
costs fidelity, not correctness.

This is documentation, not a signature change. It exists so a provider author reading the
interface can tell a required method from an optional one, which today they cannot.

## 3. The Windows console flash

`process_command` (`agent.rs:41-55`) rewrites a spawn as `cmd.exe /D /C <bin>` for a script
shim but sets no creation flags. `platform::sys_command` (`platform.rs:70-81`) sets
`CREATE_NO_WINDOW = 0x0800_0000`. Episko is a GUI-subsystem process with no console, so
every console-subsystem child spawned without that flag allocates one.

**Codex is affected on `dev` today**: `start_codex` is `process_command`'s caller, so a
Windows user gets a console flash per pane launch. Every other short-lived CLI in the
backend (`deps.rs::run_capped`, `usage.rs::run_usage_probe`, `git.rs::git_cmd`,
`github.rs::gh`) already goes through `sys_command`.

The flag moves inside `process_command`, so present and future callers inherit it. The
`.exe`/`.com` fast path stays: a native binary needs no shell hop.

## 4. Per-pane limits get a surface

Two rate-limit models exist. Claude's is account-wide and global (`rl` / `rlScoped`, with a
forecast and burn-rate layer). Codex's and OMP's are per-pane (`Sess.rateLimits`,
`Sess.rateLimitScope`, fanned out between panes with matching scopes).

The footer popover renders both. `usageview.ts` renders only the global one
(`usagePanelHtml` → `forecastBlockHtml` → `scopedBlockHtml` read `rl`/`rlScoped`), so a
provider supplying per-pane windows has nowhere to appear in Usage & spend.

That absence is not cosmetic: it already produced a defect where the dialog fired a live
~1.3s network probe for a provider whose result it could not display. Either the surface
renders the model or the probe must not run — and rendering is the honest half.

`usageview.ts` gains a block that renders the active pane's `rateLimits` when it has any,
beside the existing global block rather than replacing it.

## 5. The conversation id survives a webview reload

A webview reload discards all frontend state while the agent process keeps running.
`adoptOrphans` then rebuilds each pane, and `adoptSession` (`panes.ts:275`) sets:

```ts
resumeId: m?.resumeId ?? o.id,
```

`m` is the roster row, and `saveRoster` (`mirror.ts:56`) only persists sessions whose
provider claims `resume`. So for any provider without that capability — and for any
provider at all before its first roster write — an adopted pane's `resumeId` becomes the
**pane id**, and the provider's real conversation id is gone.

Two consequences, both real:

- The cost baseline is keyed `provider:resumeId` (`agents.ts:88`), so it silently re-keys
  on adoption. This is what made a persisted per-pane cost total double-book, and the
  eventual fix was to stop persisting rather than to fix the identity.
- A provider that later claims `resume` cannot resume an adopted pane, because the handle
  it would need was overwritten.

Re-asking the provider does not work: OMP's shim is push-only and announces its session
once, at launch; Codex's `refresh_agent_state` already errors for a runtime-less provider.
Persisting a second frontend store would shadow the roster and still not help an orphan the
frontend has never seen.

The backend is the thing that does not reload. `Session` in `lib.rs:37-52` already exists
for exactly this — `kind` carries the comment *"kept backend-side so an orphaned PTY stays
self-describing across a webview reload"*, and `scrollback` *"refills a pane after a webview
reload"*. The conversation id belongs beside them:

- `Session` gains `resume_id: Option<String>`.
- The `/agent` telemetry route latches it when a provider event carries one.
- `live_sessions` returns it on `LiveSession` (`pty.rs:1275`), which `adoptOrphans`
  (`panes.ts:243-245`) already calls to rebuild every pane.
- `adoptSession` prefers the backend's value over the pane id.

Claude is untouched: it rotates its `session_id` on `/clear`, `/compact` and `/resume`, the
frontend already tracks that rotation, and the latch is additive rather than a replacement.

This fixes identity for every provider. It does **not** make any provider resumable — that
needs the `resume` capability and a history reader, which is spec 2.

## Out of scope, deliberately

**Unifying the two rate-limit models.** One model, one probe path and one set of units
would be better than two. But Claude's global model carries a forecast, burn-rate and
time-to-cap layer the per-pane model lacks, and it drives the most-visible surface in the
app for the most-used provider. Migrating it is its own spec with its own regression risk,
and nothing in spec 2 is blocked by the split.

**Making the roster provider-agnostic.** `saveRoster`'s `resume`-capability filter is
arguably wrong — a pane's identity should not depend on whether its provider can resume —
but changing it alters what `cc-restore` holds for existing users and touches the
dormant/shelve flow. §5 removes the harm without that risk.

**OMP's remaining capabilities.** Spec 2.

## Definition of done

- Units are stated on the types and enforced by a per-adapter fixture test that fails on a
  milliseconds or fraction regression, for any provider.
- `ProviderHistory` distinguishes required methods from optional ones in its own docs.
- `process_command` sets `CREATE_NO_WINDOW`; Codex no longer flashes a console on Windows.
- Usage & spend renders the active pane's per-pane windows when it has them.
- An adopted pane keeps its provider's conversation id across a webview reload, proven by a
  test that adopts without a roster row.
- Claude and Codex fixtures still pass; no capability claim changes in this spec.
- Frontend tests, both TypeScript projects, Cargo tests, check and Clippy pass.
