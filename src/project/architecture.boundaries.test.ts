// Static "forbidden dependency" guard (Phase 8 acceptance: static searches/tests
// enforce architectural boundaries). Pure-domain + lifecycle layers must not
// import UI/runtime infrastructure DIRECTLY (arch rules 11-12): the timeline
// domain is framework-agnostic pure logic, and the project lifecycle layer
// constructs services through injected factories (store/editor.ts owns the one
// `new TauriFs()`), never by reaching for React/Zustand/Tauri itself. The lone
// documented exception is the timeline's render/export orchestrator
// (render.ts), which resolves a bundled resource path via the Tauri path API —
// see TAURI_INFRA_EXEMPT below.
//
// This scans the actual source of each layer and fails on any direct import of a
// forbidden package, so an accidental `import ... from "@tauri-apps/..."` (or
// react/zustand) inside src/timeline or src/project is caught here rather than
// silently coupling a pure layer to the platform.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(fileURLToPath(import.meta.url))); // .../src

/** All non-test .ts/.tsx source files under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Module specifiers imported by `source` — static `import`/`export ... from`
 *  (line-anchored so comments/jsdoc can't false-positive) plus dynamic
 *  `import("...")` anywhere. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /^\s*(?:import|export)\s+(?:[^'"\n]*?\sfrom\s+)?["']([^"']+)["']/gm;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (let m = staticRe.exec(source); m; m = staticRe.exec(source)) specs.push(m[1]);
  for (let m = dynamicRe.exec(source); m; m = dynamicRe.exec(source)) specs.push(m[1]);
  return specs;
}

const FORBIDDEN: ReadonlyArray<{ label: string; hit: (spec: string) => boolean }> = [
  {
    label: "React",
    hit: (s) =>
      s === "react" || s === "react-dom" || s.startsWith("react/") || s.startsWith("react-dom/"),
  },
  { label: "Zustand", hit: (s) => s === "zustand" || s.startsWith("zustand/") },
  { label: "Tauri", hit: (s) => s.startsWith("@tauri-apps/") },
];

// Layers that must stay free of the above (arch rules 11-12).
const PURE_LAYERS = ["timeline", "project"] as const;

// Documented INFRA exceptions to the Tauri rule ONLY (React/Zustand stay
// forbidden everywhere, no exceptions). render.ts is the timeline's ffmpeg
// render/export orchestrator — NOT a pure-domain module: it lazily resolves the
// bundled font dir via @tauri-apps/api/path (degrading to null off-Tauri, e.g.
// in tests) so drawtext can find the shipped fonts. Its decomposition is
// optional-later per the architecture doc, so it stays infra. A STALE entry
// here is caught by the "still load-bearing" test below.
const TAURI_INFRA_EXEMPT = new Set<string>(["timeline/render.ts"]);

describe("architectural boundaries: forbidden dependencies", () => {
  for (const layer of PURE_LAYERS) {
    it(`src/${layer} does not import React, Zustand, or Tauri directly`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(join(SRC, layer))) {
        const rel = relative(SRC, file).replace(/\\/g, "/");
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          const rule = FORBIDDEN.find((r) => r.hit(spec));
          if (!rule) continue;
          if (rule.label === "Tauri" && TAURI_INFRA_EXEMPT.has(rel)) continue;
          violations.push(`${rel} -> "${spec}" (${rule.label})`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it("every Tauri infra exemption is still load-bearing (no stale allowlist)", () => {
    for (const rel of TAURI_INFRA_EXEMPT) {
      const importsTauri = importSpecifiers(readFileSync(join(SRC, rel), "utf8")).some((s) =>
        s.startsWith("@tauri-apps/"),
      );
      expect(
        importsTauri,
        `${rel} is exempt but no longer imports Tauri — drop it from TAURI_INFRA_EXEMPT`,
      ).toBe(true);
    }
  });

  it("self-check: the import scanner detects both static and dynamic specifiers", () => {
    const sample = [
      `import { a } from "react";`,
      `import "@tauri-apps/api/core";`,
      `export type { T } from "./local";`,
      `const x = await import("zustand");`,
      `// import { fake } from "react-dom"; -- a comment must NOT count`,
    ].join("\n");
    const specs = importSpecifiers(sample);
    expect(specs).toContain("react");
    expect(specs).toContain("@tauri-apps/api/core");
    expect(specs).toContain("./local");
    expect(specs).toContain("zustand");
    // The commented line is line-anchored out of the static match.
    expect(specs).not.toContain("react-dom");
  });
});
