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
