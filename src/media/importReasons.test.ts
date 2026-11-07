// Why a file did not come in, and how it came in, as words: the questions are whether anything a caller, a model or the
// operating system said can ever travel as text, and whether every word the app can say is one the server knows.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { IMPORT_DOORS, IMPORT_REASONS } from "../api/editorEvents";
import { ImportRefusal, importDoor, importReasonOf } from "./importReasons";

describe("importReasonOf", () => {
  it("takes the word from what refused the file, whatever the message says", () => {
    for (const reason of IMPORT_REASONS)
      expect(importReasonOf(new ImportRefusal(reason, "'Holiday final.mp4' can't be used: Access is denied (os error 5)"))).toBe(reason);
  });

  it.each([
    ["The system cannot find the file specified. (os error 2)", "file_missing"],
    ["The system cannot find the path specified. (os error 3)", "file_missing"],
    ["No such file or directory (os error 2)", "file_missing"],
    ["ENOENT: no such file or directory", "file_missing"],
    ["Access is denied. (os error 5)", "permission"],
    ["Permission denied (os error 13)", "permission"],
    ["EACCES: permission denied", "permission"],
    ["There is not enough space on the disk. (os error 112)", "disk_full"],
    ["No space left on device (os error 28)", "disk_full"],
    ["ENOSPC", "disk_full"],
    ["(os error 2)", "file_missing"],
    ["(os error 3)", "file_missing"],
    ["(os error 5)", "permission"],
    ["(os error 13)", "permission"],
    ["(os error 28)", "disk_full"],
    ["(os error 112)", "disk_full"],
    ["(os error 32)", "file_in_use"],
    ["(os error 33)", "file_in_use"],
    ["The process cannot access the file because it is being used by another process. (os error 32)", "file_in_use"],
    ["EBUSY: resource busy or locked", "file_in_use"],
    ["something nobody has seen before", "other"],
    ["", "other"],
  ])("the operating system's words (%s) are the word %s", (message, word) => {
    expect(importReasonOf(new Error(message))).toBe(word);
  });

  it("an error number is matched whole: 22 is not 2, 1120 is not 112", () => {
    expect(importReasonOf(new Error("(os error 22)"))).toBe("other");
    expect(importReasonOf(new Error("(os error 1120)"))).toBe("other");
    expect(importReasonOf(new Error("(os error 50)"))).toBe("other");
  });

  it("is always a word of the list, for anything at all, and never throws", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(IMPORT_REASONS).toContain(importReasonOf(value));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        expect(IMPORT_REASONS).toContain(importReasonOf(new Error(text)));
      }),
      { numRuns: 300 },
    );
    expect(importReasonOf(null)).toBe("other");
    expect(importReasonOf(undefined)).toBe("other");
  });

  it("nothing of the message survives: the answer is the same word whatever name is in the text", () => {
    const named = importReasonOf(new Error("'My Private Holiday.mp4': Access is denied. (os error 5)"));
    const other = importReasonOf(new Error("'x.mov': Access is denied. (os error 5)"));
    expect(named).toBe(other);
    expect(IMPORT_REASONS).toContain(named);
  });
});

describe("importDoor", () => {
  it("a file linked in place is `reference`, and that outranks any provenance", () => {
    expect(importDoor("D:/footage/hero.mp4", undefined)).toBe("reference");
    expect(importDoor("D:/footage/hero.mp4", { kind: "recording" })).toBe("reference");
  });

  it("a producer that says what it is is named, and no provenance at all is a copy", () => {
    expect(importDoor(undefined, { kind: "recording" })).toBe("recording");
    expect(importDoor(undefined, { kind: "export" })).toBe("export");
    expect(importDoor(undefined, { kind: "generation" })).toBe("generation");
    expect(importDoor(undefined, undefined)).toBe("copy");
    expect(importDoor("   ", undefined)).toBe("copy");
    expect(importDoor(undefined, {})).toBe("copy");
  });

  it("a label nobody declared is `other`, never itself", () => {
    expect(importDoor(undefined, { kind: "youtube" })).toBe("other");
    expect(importDoor(undefined, { kind: "C:/Users/me/Videos/holiday.mp4" })).toBe("other");
    expect(importDoor(undefined, { kind: 42 })).toBe("copy");
  });

  it("is always a word of the list, whatever provenance arrives", () => {
    fc.assert(
      fc.property(fc.option(fc.string()), fc.option(fc.dictionary(fc.string(), fc.anything())), (path, source) => {
        expect(IMPORT_DOORS).toContain(importDoor(path ?? undefined, source ?? undefined));
      }),
      { numRuns: 300 },
    );
  });
});
