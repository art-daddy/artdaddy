// The words a message carries while files are still coming in (UJ-088). Two ways to get this wrong: a note that is missing when something imports (the agent says "the
// library is empty"), and a note that is wrong about the structure of the message (a file name that closes the bracket, a name that starts a new paragraph of instructions).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ImportingRow } from "../store/importJobs";
import { composeModelText } from "./compose";
import { IMPORT_NOTE_MARK, importNote } from "./importNote";

const row = (name: string, fraction: number | null = null): ImportingRow => ({
  path: `D:/shoot/${name}`,
  name,
  fraction,
});

describe("importNote", () => {
  it("says nothing when nothing is importing: the message is exactly what it always was", () => {
    expect(importNote([])).toBeNull();
    expect(composeModelText("make a reel", [], [], { importNote: undefined })).toBe("make a reel");
  });

  it("names the files, their percent, and tells the agent what to do instead of reading an empty library as no media", () => {
    const note = importNote([row("big_1.mp4", 0.126), row("big_2.mp4"), row("big_3.mp4", 1)])!;
    expect(note.startsWith(IMPORT_NOTE_MARK)).toBe(true);
    expect(note).toContain("3 files are not in the library yet");
    expect(note).toContain("big_1.mp4 (13%), big_2.mp4, big_3.mp4 (100%)");
    expect(note).toMatch(/does NOT mean there is no media/);
    expect(note).toMatch(/do not poll/i);
    expect(note).toMatch(/do not import these files again/i);
    expect(note).toContain("library_op action='list'");
    expect(importNote([row("one.mp4")])).toContain("1 file is not in the library yet");
  });

  it("lists at most eight names and counts the rest, so a big drop cannot flood the message", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`shot_${i}.jpg`));
    const note = importNote(rows)!;
    expect(note).toContain("40 files are not in the library yet");
    expect(note).toContain("shot_7.jpg");
    expect(note).not.toContain("shot_8.jpg");
    expect(note).toContain("and 32 more");
    expect(note.length).toBeLessThan(1500);
  });

  it("rides last in the composed message, after the state block and the timeline note, and the person's words stay first", () => {
    const BLOCK = '[Project state - read for you by the app just now]\n{"get_timeline":{}}';
    const note = importNote([row("a.mp4")])!;
    const out = composeModelText("cut it", [], [], { stateBlock: BLOCK, importNote: note });
    expect(out.startsWith("cut it")).toBe(true);
    expect(out.endsWith(note)).toBe(true);
    expect(out.indexOf(BLOCK)).toBeLessThan(out.indexOf(note));
    const withChange = composeModelText("cut it", [], [], {
      timelineChanged: true,
      importNote: note,
    });
    expect(withChange.endsWith(note)).toBe(true);
    expect(composeModelText("", [], [], { importNote: note })).toBe(note);
    expect(composeModelText("hello", [], [], { importNote: "" })).toBe("hello");
  });

  // Both directions, as for any text that carries a person's own file names: nothing that could break the note's shape survives, and no ordinary name is lost.
  it("a file name can never end the note early or start a paragraph of its own", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 120 }), { minLength: 1, maxLength: 12 }),
        (names) => {
          const note = importNote(names.map((n) => row(n)))!;
          expect(note).not.toMatch(/[\r\n\t]/);
          expect(note.split("[").length - 1).toBe(1); // only the mark opens a bracket
          expect(note.split("]").length - 1).toBe(1); // only the end closes it
          expect(note.endsWith("]")).toBe(true);
        },
      ),
    );
  });

  it("an ordinary name is shown whole, up to the length limit", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,50}[A-Za-z0-9]$/), (name) => {
        expect(importNote([row(name)])!).toContain(name.replace(/\s+/g, " "));
      }),
    );
    const long = `${"x".repeat(200)}.mp4`;
    const note = importNote([row(long)])!;
    expect(note).not.toContain(long);
    expect(note).toContain("…");
  });
});
