import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import { usagePanelHtml } from "../src/usageview";
import { sessions, setActiveId } from "../src/state";
import type { AgentRateLimit, Sess } from "../src/types";

function fakeSess(rateLimits: AgentRateLimit[]): Sess {
  return { id: "s1", rateLimits, rateLimitScope: null } as unknown as Sess;
}

describe("usagePanelHtml — per-pane rate-limit windows", () => {
  beforeEach(() => { store.clear(); sessions.clear(); setActiveId(null); });

  it("omits the pane-limits block with no active session, so a Claude-only panel is unchanged", () => {
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

  it("falls back to the windowMins span when a window has no label", () => {
    sessions.set("s1", fakeSess([{ usedPercent: 10, resetsAt: null, windowMins: 300 }]));
    setActiveId("s1");
    expect(usagePanelHtml()).toContain("5h 0m");
  });

  it("shows a level and reset time only — no burn rate, projection or time-to-cap value", () => {
    sessions.set("s1", fakeSess([{ usedPercent: 42, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowMins: 300 }]));
    setActiveId("s1");
    const html = usagePanelHtml();
    expect(html).toContain("42%");
    // The stat labels render (shared fcWinHtml markup); their values must stay dashed.
    expect(html).not.toMatch(/Burn rate<\/div><div class="fc-v">(?!—)/);
    expect(html).not.toMatch(/Time to cap<\/div><div class="fc-v">(?!—)/);
  });
});
