// What a project's own scratch is called, and that the one rule is anchored to the code that makes
// the scratch rather than to a list of names that can fall behind it.
//
// A duplicate of a project failed because `internals/transcript.tmp-f3bi3l.json` was listed and then
// renamed away by the write that owned it (2026-10-25, while the project was being transcribed). That
// file is not part of the project, and the sweep that clears what a dead writer left behind
// (projectTemps.ts) already knew it: a copy has to agree with it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { atomicWriteBytes, atomicWriteText, type FsLike } from "./store";
import { isProjectScratch } from "./tempNames";

/** The name a real atomic write stages its file under, caught as it is renamed into place. */
async function stagedBy(
  write: (fs: FsLike, path: string) => Promise<unknown>,
  path: string,
): Promise<string> {
  let staged = "";
  const fs = {
    writeTextFile: async () => undefined,
    writeBytes: async () => undefined,
    rename: async (from: string) => {
      staged = from;
    },
    remove: async () => undefined,
  } as unknown as FsLike;
  await write(fs, path);
  return staged.slice(staged.lastIndexOf("/") + 1);
}

const writers: Array<[string, (fs: FsLike, path: string) => Promise<unknown>]> = [
  ["atomicWriteText", (fs, p) => atomicWriteText(fs, p, "{}")],
  ["atomicWriteBytes", (fs, p) => atomicWriteBytes(fs, p, new Uint8Array([1]))],
];

const stem = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
const ext = fc.constantFrom("json", "mp4", "png", "wav", "txt");

describe("isProjectScratch", () => {
  it.each(writers)(
    "%s: whatever it stages inside internals/ or library/ is scratch, and what it finishes never is",
    async (_name, write) => {
      await fc.assert(
        fc.asyncProperty(stem, ext, async (name, extension) => {
          for (const folder of ["internals", "library"] as const) {
            const final = `${folder === "library" ? "media_" : ""}${name}.${extension}`;
            const staged = await stagedBy(write, `C:/p/${folder}/${final}`);
            expect(staged, "the writer staged nothing").not.toBe("");
            expect(isProjectScratch(folder, staged, false), `${folder}/${staged}`).toBe(true);
            expect(isProjectScratch(folder, final, false), `${folder}/${final}`).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it("calls a scratch file of any name scratch in internals/, which holds only the app's own files", () => {
    for (const name of [
      "transcript.tmp-f3bi3l.json",
      "timeline.tmp-abc123.json",
      "jobs.tmp-1.json",
      "look.4f2d9a.tmp",
      "frame.4f2d9a.tmp.png",
    ])
      expect(isProjectScratch("internals", name, false), name).toBe(true);
  });

  it("judges only the app's own names in library/, which also holds what the user put there", () => {
    expect(isProjectScratch("library", "media_abc123.mp4.tmp-77aa01", false)).toBe(true);
    expect(isProjectScratch("library", "media_abc123.tmp-77aa01.mp4", false)).toBe(true);
    // Theirs, whatever it is called: dropping it from a copy would lose their footage.
    for (const theirs of ["holiday.tmp.mp4", "interview.tmp-2.wav", "clip.tmp"])
      expect(isProjectScratch("library", theirs, false), theirs).toBe(false);
  });

  it("never calls a folder scratch, and never calls a finished file scratch", () => {
    expect(isProjectScratch("internals", "transcript.tmp-f3bi3l.json", true)).toBe(false);
    for (const name of ["project.json", "timeline.json", "transcript.json", "jobs.json", ".lock"])
      expect(isProjectScratch("internals", name, false), name).toBe(false);
    for (const name of ["media_abc.mp4", "media_gen_1.png", "tmp.mp4", "temp_notes.txt"])
      expect(isProjectScratch("library", name, false), name).toBe(false);
  });
});
