import { describe, expect, it } from "vitest";
import "./localstorage"; // must precede modules that read localStorage
import { codexEvents } from "../src/providers/codex";
import { applyStatusline } from "../src/phase";
import { CLAUDE_CLI, type AgentRateLimit, type Sess } from "../src/types";

// A Sess as newSession() builds one, minus the DOM/xterm handles applyStatusline doesn't read.
function claudeSess(): Sess {
  return {
    id: "s1", project: "p", accent: "#fff", workdir: "/w", colorKey: "/w",
    resumeId: "s1", branch: "main", worktree: null, title: "",
    phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null, apiMs: null, apiMsSince: 0,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null,
    git: null, res: null, lastEvent: "", activity: [], prompts: [], files: [], tally: {}, servers: [],
    kind: "agent", provider: "claude", capabilities: [...CLAUDE_CLI.capabilities], external: false,
    ...({} as Partial<Sess>),
  } as Sess;
}

// Epoch seconds for a plausible "now": a milliseconds value is ~1000x larger and fails.
const EPOCH_SECONDS = { min: 1_600_000_000, max: 2_000_000_000 };

// A bare 0-1 fraction is indistinguishable from a genuinely-low percentage, so usedPercent's range check cannot catch it.
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
    expect(limits.windows).toEqual([
      { usedPercent: 43, resetsAt: 1790628600, windowMins: 300 },
      { usedPercent: 79, resetsAt: 1791216000, windowMins: 10080 },
    ]);
    assertUnits(limits.windows);
  });

  it("rejects a window whose resetsAt is milliseconds", () => {
    // The guard itself must bite; this is what the shipped bug looked like.
    expect(() => assertUnits([{ usedPercent: 43, resetsAt: 1790628600281, windowMins: 300 }]))
      .toThrow();
  });

  it("claude statusline reports seconds, minutes and a 0-100 percentage", () => {
    const s = claudeSess();
    applyStatusline(s, { rate_limits: { five_hour: { used_percentage: 43, resets_at: 1790628600 } } });
    expect(s.rateLimits).toEqual([{ usedPercent: 43, resetsAt: 1790628600, windowMins: 300 }]);
    assertUnits(s.rateLimits);
  });
});
