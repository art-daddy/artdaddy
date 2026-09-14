// The drag rebuild rests on facts no behavioural test can see: a Tauri CONFIG flag, and the
// absence of the HTML5 handlers it replaced. Both are one edit away from silently reverting —
// flip the flag back and OS drops stop carrying paths; re-add a `draggable` and that element's
// drag dies on Windows the moment Tauri owns the handler. Neither shows up as a failing unit
// test, so these assert the facts directly.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// vitest runs from the package root. Deriving this from __dirname pointed somewhere else
// entirely, and the guard then named a file that does not contain what it claimed.
const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** Source with comments stripped: a rule about what the app DOES must not be tripped by prose
 *  describing it — osDrop.ts's doc comment mentions a `data-artdaddy-drop="<id>"` zone that
 *  does not exist, and the first draft of this guard reported it as real. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = () => walk(SRC).filter((f) => !/\.(test|spec|e2e)\.tsx?$/.test(f));
const rel = (f: string) => f.slice(ROOT.length).replace(/\\/g, "/");
const DRAGGABLE = /\bdraggable\b\s*(=|\})/;

describe("tauri.conf.json", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
    app: { windows: Array<{ dragDropEnabled?: boolean }> };
  };

  it("lets Tauri handle file drops, or a drop cannot carry a path", () => {
    // With this false the webview receives HTML5 File objects, which expose no path — a drop
    // would silently go back to COPYING media while File > Import links it.
    expect(conf.app.windows[0].dragDropEnabled).toBe(true);
  });
});

describe("no HTML5 drag source survives", () => {
  // Tauri's docs: "Disabling [dragDropEnabled] is required to use HTML5 drag and drop on the
  // frontend on Windows since we replace the drag drop handler of WebView2." So with the flag
  // on, any `draggable` element is a gesture that silently does nothing on Windows.
  it("has no `draggable` attribute in any component", () => {
    expect(
      sources()
        .filter((f) => DRAGGABLE.test(code(f)))
        .map(rel),
    ).toEqual([]);
  });

  it("has no in-app dataTransfer payload left behind", () => {
    // The old library -> timeline channel. A reader with no writer is worse than neither:
    // the lane would look like it still accepts drags.
    expect(
      sources()
        .filter((f) => /application\/x-artdaddy-source/.test(code(f)))
        .map(rel),
    ).toEqual([]);
  });

  it("still recognises a `draggable` when one exists (the guard is not vacuous)", () => {
    // A regex that matched nothing would pass the two checks above forever.
    expect(DRAGGABLE.test('<div draggable="true" />')).toBe(true);
    expect(DRAGGABLE.test("<div draggable={media} />")).toBe(true);
  });
});

describe("drop zones and their subscribers agree", () => {
  // osDrop routes by a string attribute, so a rename on either side fails SILENTLY: the drop
  // is delivered to nobody and the file just does not arrive.
  const all = sources().map(code).join("\n");
  const found = (re: RegExp) => new Set([...all.matchAll(re)].map((m) => m[1]));
  const subscribed = found(/onOsDrop\(\s*["']([^"']+)["']/g);
  const zones = found(/data-artdaddy-drop=["']([^"']+)["']/g);

  it("every subscribed target exists as a zone in the DOM", () => {
    expect([...subscribed].filter((t) => !zones.has(t))).toEqual([]);
  });

  it("every zone has a subscriber", () => {
    expect([...zones].filter((z) => !subscribed.has(z))).toEqual([]);
  });

  it("finds the zones this app actually declares (the guard is not vacuous)", () => {
    // Without this, regexes that matched nothing would pass both checks above.
    expect([...zones].sort()).toEqual(["chat", "library", "track"]);
    expect([...subscribed].sort()).toEqual(["chat", "library", "track"]);
  });
});
