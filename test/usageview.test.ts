import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import { usagePanelHtml, usageRow } from "../src/usageview";
import { sessions, setActiveId } from "../src/state";
import { applyStatusline } from "../src/phase";
import { forecastWin, rl } from "../src/rl";
import { CLAUDE_CLI, providerCapabilities, type AgentRateLimit, type Sess } from "../src/types";

function fakeSess(rateLimits: AgentRateLimit[]): Sess {
  return {
    id: "s1", provider: "codex", rateLimits, rateLimitScope: null,
    kind: "agent", capabilities: providerCapabilities("codex"),
  } as unknown as Sess;
}

// A Sess as newSession() builds one, minus the DOM/xterm handles applyStatusline doesn't read
// (same shape as test/units.test.ts's claudeSess, since it drives the same real mutation path).
function claudeSess(): Sess {
  return {
    id: "claude1", project: "p", accent: "#fff", workdir: "/w", colorKey: "/w",
    resumeId: "claude1", branch: "main", worktree: null, title: "",
    phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null, apiMs: null, apiMsSince: 0,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null,
    git: null, res: null, lastEvent: "", activity: [], prompts: [], files: [], tally: {}, servers: [],
    kind: "agent", provider: "claude", capabilities: [...CLAUDE_CLI.capabilities], external: false,
    ...({} as Partial<Sess>),
  } as Sess;
}

describe("usagePanelHtml — per-pane rate-limit windows", () => {
  beforeEach(() => {
    store.clear(); sessions.clear(); setActiveId(null);
    // forecast5h/forecast7d read this module singleton directly; a prior test's
    // applyStatusline call otherwise leaks into every later Forecast block assertion.
    rl.h5 = null; rl.h5Reset = null; rl.d7 = null; rl.d7Reset = null;
  });

  it("stays byte-identical for a Claude pane that HAS reported rate limits (phase.ts mirrors them into s.rateLimits too)", () => {
    // Regression: Claude's own statusline populates s.rateLimits the same shape Codex/OMP use
    // (phase.ts:370-373), so a naive `s.rateLimits.length` check would double-render Claude's
    // already-metered windows under a second "Pane limits" heading.
    const s = claudeSess();
    applyStatusline(s, { rate_limits: { five_hour: { used_percentage: 43, resets_at: 1790628600 }, seven_day: { used_percentage: 12, resets_at: 1791216000 } } });
    sessions.set(s.id, s);
    expect(s.rateLimits.length).toBeGreaterThan(0); // sanity: this is the exact state that broke

    setActiveId(null);
    const withoutActive = usagePanelHtml();
    setActiveId(s.id);
    const withActive = usagePanelHtml();
    expect(withActive).toBe(withoutActive);
    expect(withActive).not.toContain("Pane limits");
  });

  it("omits the pane-limits block with no active session", () => {
    expect(usagePanelHtml()).not.toContain("Pane limits");
  });

  it("omits the pane-limits block when the active session reports no rate-limit windows", () => {
    sessions.set("s1", fakeSess([]));
    setActiveId("s1");
    expect(usagePanelHtml()).not.toContain("Pane limits");
  });

  it("names two same-span windows by their label so they read as distinct rows", () => {
    // The real-world case that motivates `label`: an account-wide and a per-model window
    // share windowMins (10080 = 7 days) but must not render as identical "7d" rows.
    sessions.set("s1", fakeSess([
      { usedPercent: 79, resetsAt: 1790628600, windowMins: 10080, label: "Claude 7 Day" },
      { usedPercent: 0, resetsAt: 1790628600, windowMins: 10080, label: "Claude 7 Day (Fable)" },
    ]));
    setActiveId("s1");
    const html = usagePanelHtml();
    expect(html).toContain("Claude 7 Day</span>");
    expect(html).toContain("Claude 7 Day (Fable)</span>");
  });

  it("falls back to a windowMins-derived name when a window has no label and matches no named span", () => {
    sessions.set("s1", fakeSess([{ usedPercent: 10, resetsAt: null, windowMins: 600 }]));
    setActiveId("s1");
    expect(usagePanelHtml()).toContain("10h</span>");
  });

  it("names a zero-length windowMins as an unknown span, not as a literal 0m", () => {
    // Regression: `len` is 0 for `windowMins: 0`, and `len != null` alone is true for 0 —
    // the naming must agree with fcWinHtml's own span guard (`len != null && len > 0`).
    sessions.set("s1", fakeSess([{ usedPercent: 30, resetsAt: null, windowMins: 0 }]));
    setActiveId("s1");
    const html = usagePanelHtml();
    const paneHtml = html.slice(html.indexOf("Pane limits"));
    expect(paneHtml).toContain("Usage window");
    expect(paneHtml).not.toContain("0m</span>");
  });

  it("draws no elapsed timeline for a window of unknown span (windowMins null), rather than an invented one", () => {
    // Reset an hour out: against a synthesized 7-day span this would read as ~99% elapsed.
    sessions.set("s1", fakeSess([{ usedPercent: 30, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowMins: null }]));
    setActiveId("s1");
    const html = usagePanelHtml();
    // Scoped to the pane row itself: the Forecast block above it also emits a 0%-width
    // track whenever rl.h5/d7 are null, which would pass this check for the wrong reason.
    const paneHtml = html.slice(html.indexOf("Pane limits"));
    expect(paneHtml).toContain("Usage window");
    expect(paneHtml).toMatch(/fc-tlel" style="width:0%"/);
  });

  it("treats a non-positive windowMins the same as an unknown span, not a divide-by-zero", () => {
    // A provider's Number.isFinite guard accepts 0; the timeline maths must not then divide by it.
    sessions.set("s1", fakeSess([{ usedPercent: 30, resetsAt: null, windowMins: 0 }]));
    setActiveId("s1");
    const html = usagePanelHtml();
    const paneHtml = html.slice(html.indexOf("Pane limits"));
    expect(paneHtml).not.toContain("NaN");
    expect(paneHtml).toMatch(/fc-tlel" style="width:0%"/);
  });

  it("shows a level and reset time only — burn rate, projection and time-to-cap all stay dashed", () => {
    sessions.set("s1", fakeSess([{ usedPercent: 42, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowMins: 300 }]));
    setActiveId("s1");
    const html = usagePanelHtml();
    expect(html).toContain("42%");
    // The stat labels render (shared fcWinHtml markup); only their values must stay dashed.
    expect(html).not.toMatch(/Burn rate<\/div><div class="fc-v">(?!—)/);
    expect(html).not.toMatch(/Projected @ reset<\/div><div class="fc-v[^"]*">(?!—)/);
    expect(html).not.toMatch(/Time to cap<\/div><div class="fc-v">(?!—)/);
  });
});

describe("usageRow — external text reaches an innerHTML sink (footer.ts's renderUsagePop)", () => {
  // Finding 1: `label` mirrors the Claude CLI's own `display_name` (rl.ts:58), external text
  // that reaches `usageRow` unescaped before rendering via `innerHTML` (footer.ts).
  it("escapes label, sub and note so a vendor-supplied string cannot inject markup", () => {
    const f = forecastWin(50, null, null);
    const html = usageRow(
      "<img src=x onerror=alert(1)>",
      "<b>sub</b>",
      f,
      "<script>alert(2)</script>",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>sub</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script>");
  });

  it("leaves a plain label untouched (no double-escaping for an ordinary caller)", () => {
    const f = forecastWin(50, null, null);
    const html = usageRow("Session", "5-hour window", f);
    expect(html).toContain(">Session<");
    expect(html).toContain(">5-hour window<");
  });
});
