// UJ-087: the canvas rule (timeline/canvasAuto.ts `prepareCanvas`) is enforced at the doors that put media on an empty timeline, so a door that forgets it is the bug: the person
// drops pictures and is never asked, or the agent places them and is never told. The doors are two tools and two editor commands; this walks the source and fails when one of them
// stops calling it, or when a person's door stops handing it the question (`confirmCanvasChange`). The behaviour of the rule itself is tested in canvasAuto.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), "utf8");

/** The text of one declaration: from its marker to the start of the next marker (or the end of the file). */
function section(text: string, from: string, to?: string): string {
  const start = text.indexOf(from);
  expect(start, `${from} not found: the walk needs updating`).toBeGreaterThanOrEqual(0);
  const end = to ? text.indexOf(to, start + from.length) : -1;
  return text.slice(start, end > start ? end : undefined);
}

describe("every door that puts media on an empty timeline settles the canvas first (UJ-087)", () => {
  const placement = read("src/timeline/placement.ts");
  const commands = read("src/store/editorCommands.ts");

  it.each([
    [
      "the agent's add_clips",
      section(
        placement,
        "export async function addClipsTool(",
        "export async function resolveAddSpecs",
      ),
    ],
    [
      "the agent's insert_clips",
      section(
        placement,
        "export async function insertClipsTool(",
        "export function addTextClipsTool",
      ),
    ],
  ])("%s calls prepareCanvas before it resolves or places anything", (_name, body) => {
    const at = body.indexOf("prepareCanvas(");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(body.search(/resolveAddSpecs|resolveInsertEntry|ctxApplyOp/));
  });

  it.each([
    [
      "the person's library drag (addClip)",
      section(commands, "addClip: async (", "addClips: async ("),
    ],
    [
      "the person's drop or multi-import (addClips)",
      section(commands, "addClips: async (", "processImport: async ("),
    ],
  ])("%s asks the person: prepareCanvas gets confirmCanvasChange", (_name, body) => {
    expect(body).toMatch(/prepareCanvas\([^;]*confirmCanvasChange\)/);
  });
});
