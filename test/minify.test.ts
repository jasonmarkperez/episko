import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig, transformWithEsbuild } from "vite";

// esbuild miscompiles xterm's DECRQM handler, and a packaged build then dies on the first
// `CSI ? Ps $ p`; vite.config.ts carries the mechanism. These answer the only two questions
// a maintainer has: is the workaround still applied, and is it still needed?
// evanw/esbuild#4508, xtermjs/xterm.js#5800.

describe("the minifier workaround for xterm's DECRQM handler", () => {
  it("is still applied: the RESOLVED production config minifies with terser", async () => {
    // Resolved, not the config's text, and in the mode a packaged build runs: a comment
    // naming terser, a factory returning something else, or a `mode === …` override that
    // only bites in production must all fail here.
    const config = await resolveConfig(
      { configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)) },
      "build", "production",
    );
    expect(config.build.minify).toBe("terser");
    // The third precondition, and the other way out: es2021+ is clean, so a raised floor
    // (ours is Vite's default, which we never set) retires the workaround on its own.
    expect(config.build.target).toContain("es2020");
  });

  it("is still needed: esbuild at our target still drops a declaration in xterm", async () => {
    const xterm = readFileSync(
      fileURLToPath(new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url)), "utf8",
    );
    const { code } = await transformWithEsbuild(xterm, "xterm.mjs", {
      target: "es2020", minify: true, format: "esm",
    });
    // An assignment to a name that was never declared: strict-mode ESM throws on it.
    expect(code, "esbuild no longer miscompiles xterm's DECRQM enum: drop `minify: \"terser\"` "
      + "from vite.config.ts, drop the terser devDependency, and delete this file")
      .toMatch(/void 0\|\|\([A-Za-z_$]+=\{\}\)/);
  });
});
