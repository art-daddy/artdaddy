import { describe, expect, it } from "vitest";

import { patchFileTool, readFileTool, writeFileTool } from "./artifacts";
import type { ClientToolContext } from "./context";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

class MockFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
function ctxWith(fs: MockFs = new MockFs()): ClientToolContext {
  return {
    store: new ProjectStoreAccess(DIR, fs),
    runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("read_file", () => {
  it("reads a project file and reports totals", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "notes.md"), "hello");
    const r = (await readFileTool({ path_or_key: "notes.md" }, ctxWith(fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.content).toBe("hello");
    expect(r.total_chars).toBe(5);
    expect(r.truncated).toBe(false);
  });
  it("truncates at the read cap", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "big.txt"), "x".repeat(200_005));
    const r = (await readFileTool({ path_or_key: "big.txt" }, ctxWith(fs))) as Any;
    expect(r.truncated).toBe(true);
    expect(String(r.content).length).toBe(200_000);
    expect(r.total_chars).toBe(200_005);
  });
  it("rejects escapes, missing files, and bad input", async () => {
    expect(((await readFileTool({ path_or_key: "../../etc/passwd" }, ctxWith())) as Any).ok).toBe(
      false,
    );
    expect(((await readFileTool({ path_or_key: "nope.txt" }, ctxWith())) as Any).ok).toBe(false);
    expect(((await readFileTool({}, ctxWith())) as Any).ok).toBe(false);
    expect(((await readFileTool({ path_or_key: "x" }, null)) as Any).ok).toBe(false);
  });

  // What a tool wrote for the model to read: run_ffmpeg returns the output_ref of any output that is
  // not media, under the cache folder. 8 of the 27 calls in a month read exactly this, and worked.
  it("reads what a tool wrote: the output_ref run_ffmpeg gave back", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "internals/cache/ffmpeg/silence.txt"), "silence_start=0.5");
    const r = (await readFileTool(
      { path_or_key: "internals/cache/ffmpeg/silence.txt" },
      ctxWith(fs),
    )) as Any;
    expect(r).toMatchObject({
      ok: true,
      content: "silence_start=0.5",
      path: "internals/cache/ffmpeg/silence.txt",
    });
  });

  // The other 19 calls guessed a file name (a timeline, a transcript, a script, a brief). The model
  // read the answer as "wrong name", and tried the next. Say what the file would have been for.
  describe("a miss says where to go instead", () => {
    const GUESSES = [
      "timeline.json",
      "timeline_json",
      "transcript.json",
      "transcript.txt",
      "script.txt",
      "edit_plan.json",
      "docs/identity.txt",
    ];
    it.each(GUESSES)(
      "%s: names the tool for each thing the model may have wanted",
      async (name) => {
        const r = (await readFileTool({ path_or_key: name }, ctxWith())) as Any;
        expect(r.ok).toBe(false);
        const msg = String(r.error);
        expect(msg).toContain(`file not found: ${name}`);
        expect(msg).toMatch(/get_timeline/);
        expect(msg).toMatch(/get_transcript/);
        expect(msg).toMatch(/inspect_media/);
        expect(msg).toMatch(/get_project_state/);
        expect(msg).toMatch(/ask the user to paste/i);
        expect(msg).toMatch(/output_ref/);
      },
    );

    it("a path outside the project says the same, and that it is outside", async () => {
      for (const ref of ["C:/Users/someone/brief.md", "/etc/hosts", "../up.txt"]) {
        const r = (await readFileTool({ path_or_key: ref }, ctxWith())) as Any;
        expect(r.ok, ref).toBe(false);
        expect(String(r.error), ref).toMatch(/not inside this project/);
        expect(String(r.error), ref).toMatch(/ask the user to paste/i);
      }
    });

    it("an empty request says what to pass", async () => {
      const r = (await readFileTool({}, ctxWith())) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/path_or_key is required/);
      expect(String(r.error)).toMatch(/output_ref/);
    });
  });

  // The editor's own records are not for reading by path: the document in memory can be ahead of
  // the file, the library holds the paths of the user's own files, and each has a tool that answers
  // from the live project. `internals/` apart from its cache, whatever the file is called.
  describe("the editor's own records are not readable, even when the file is there", () => {
    const RECORDS = [
      "internals/timeline.json",
      "internals/library.json",
      "internals/project.json",
      "internals/transcript.json",
      "internals/chat/checkpoints/c1.json",
      "internals/styles/house.md",
      "Internals\\Timeline.JSON",
      "./internals/library.json",
      "internals//project.json",
    ];
    it.each(RECORDS)("%s", async (name) => {
      const fs = new MockFs();
      for (const p of [
        "internals/timeline.json",
        "internals/library.json",
        "internals/project.json",
        "internals/transcript.json",
        "internals/chat/checkpoints/c1.json",
        "internals/styles/house.md",
      ])
        fs.files.set(joinPath(DIR, p), '{"secret":"D:/Users/someone/private.mp4"}');
      const r = (await readFileTool({ path_or_key: name }, ctxWith(fs))) as Any;
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("content");
      expect(JSON.stringify(r)).not.toContain("private.mp4");
      expect(String(r.error)).toMatch(/editor's own records/);
      expect(String(r.error)).toMatch(/get_timeline/);
    });

    // The floor that keeps the rule from refusing everything under internals/: its cache is where
    // the tools write, and a project file outside it that merely has a manifest's name is the user's.
    it("but its cache, and a file elsewhere that shares a record's name, stay readable", async () => {
      const fs = new MockFs();
      fs.files.set(joinPath(DIR, "internals/cache/ffmpeg/a.txt"), "cache");
      fs.files.set(joinPath(DIR, "internals/cache/research/page.html"), "<p>");
      fs.files.set(joinPath(DIR, "docs/timeline.json"), "{}");
      for (const name of [
        "internals/cache/ffmpeg/a.txt",
        "internals/cache/research/page.html",
        "docs/timeline.json",
      ]) {
        const r = (await readFileTool({ path_or_key: name }, ctxWith(fs))) as Any;
        expect(r.ok, name).toBe(true);
      }
    });
  });
});

describe("write_file", () => {
  it("writes text and reports the byte length", async () => {
    const fs = new MockFs();
    const r = (await writeFileTool(
      { relative_path: "history/notes.md", content: "hi" },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe(2);
    expect(fs.files.get(joinPath(DIR, "history/notes.md"))).toBe("hi");
  });
  it("parse-validates JSON content and does NOT write on failure", async () => {
    const fs = new MockFs();
    const bad = (await writeFileTool(
      { relative_path: "x.json", content: "{ not json" },
      ctxWith(fs),
    )) as Any;
    expect(bad.ok).toBe(false);
    expect(String(bad.validation_errors[0])).toContain("invalid JSON");
    expect(fs.files.has(joinPath(DIR, "x.json"))).toBe(false);
  });
  it("refuses to write project manifests (owned by the editor tools)", async () => {
    const fs = new MockFs();
    for (const p of ["timeline.json", "internals/timeline.json", "library.json", "project.json"]) {
      const r = (await writeFileTool({ relative_path: p, content: '{"x":1}' }, ctxWith(fs))) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("manifest");
      expect(fs.files.has(joinPath(DIR, p))).toBe(false);
    }
  });
  it("rejects escaping / missing relative_path", async () => {
    expect(
      ((await writeFileTool({ relative_path: "../evil", content: "x" }, ctxWith())) as Any).ok,
    ).toBe(false);
    expect(((await writeFileTool({ content: "x" }, ctxWith())) as Any).ok).toBe(false);
  });
});

describe("patch_file", () => {
  it("replaces exactly the expected count and reports byte deltas", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "a.txt"), "foo bar foo");
    const r = (await patchFileTool(
      { path_or_key: "a.txt", old_string: "foo", new_string: "baz", expected_replacements: 2 },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(2);
    expect(fs.files.get(joinPath(DIR, "a.txt"))).toBe("baz bar baz");
    expect(r.bytes_delta).toBe(0);
  });
  it("rejects a count mismatch and leaves the file unchanged", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "a.txt"), "foo bar");
    const r = (await patchFileTool(
      { path_or_key: "a.txt", old_string: "foo", new_string: "baz", expected_replacements: 2 },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(r.matches_found).toBe(1);
    expect(fs.files.get(joinPath(DIR, "a.txt"))).toBe("foo bar");
  });
  it("validates the JSON result of a patch (no write on break)", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "c.json"), '{"a": 1}');
    const r = (await patchFileTool(
      { path_or_key: "c.json", old_string: "1", new_string: "" },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(fs.files.get(joinPath(DIR, "c.json"))).toBe('{"a": 1}');
  });
  it("refuses to patch project manifests", async () => {
    const fs = new MockFs();
    fs.files.set(joinPath(DIR, "internals/timeline.json"), '{"units":"frames"}');
    const r = (await patchFileTool(
      { path_or_key: "internals/timeline.json", old_string: "frames", new_string: "x" },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("manifest");
    expect(fs.files.get(joinPath(DIR, "internals/timeline.json"))).toBe('{"units":"frames"}'); // unchanged
  });
});
