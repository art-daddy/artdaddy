import { describe, expect, it } from "vitest";

import { scrubAbsolutePaths } from "./scrubPaths";

describe("scrubAbsolutePaths", () => {
  it("replaces a Windows drive path (forward + back slash) with its basename", () => {
    expect(scrubAbsolutePaths({ path: "C:/Users/me/hero.mp4" }).path).toBe("hero.mp4");
    expect(scrubAbsolutePaths({ path: "D:\\footage\\clip.mov" }).path).toBe("clip.mov");
  });

  it("replaces a UNC path with its basename", () => {
    expect(scrubAbsolutePaths({ path: "\\\\server\\share\\f.mp4" }).path).toBe("f.mp4");
  });

  it("replaces a POSIX absolute path under a known root with its basename", () => {
    expect(scrubAbsolutePaths({ path: "/Users/me/Movies/a.mp4" }).path).toBe("a.mp4");
    expect(scrubAbsolutePaths({ path: "/home/me/x.png" }).path).toBe("x.png");
    expect(scrubAbsolutePaths({ e: "/etc/passwd" }).e).toBe("passwd");
  });

  it("scrubs a path EMBEDDED in an error string, keeping the surrounding text", () => {
    expect(
      scrubAbsolutePaths({ error: "no file or directory at 'D:/footage/hero.mp4'" }).error,
    ).toBe("no file or directory at 'hero.mp4'");
  });

  it("does NOT mangle an https URL (the s:/ in https:// is not a drive letter)", () => {
    const url = "https://youtube.com/watch?v=abc";
    expect(scrubAbsolutePaths({ url }).url).toBe(url);
  });

  it("leaves media_refs + project-relative paths untouched (the model's real refs)", () => {
    const r = { media_ref: "media_abc123", path: "library/media_abc123.mp4", filename: "hero.mp4" };
    expect(scrubAbsolutePaths(r)).toEqual(r);
  });

  it("does not scrub a non-known-root POSIX fragment in prose", () => {
    const r = { note: "use the /a/b flag" };
    expect(scrubAbsolutePaths(r)).toEqual(r);
  });

  it("recurses into arrays + nested objects", () => {
    const r = {
      clips: [
        { id: "media_x", path: "D:/a/b/c.mp4" },
        { id: "media_y", path: "library/media_y.mp4" },
      ],
    };
    expect(scrubAbsolutePaths(r).clips.map((c) => c.path)).toEqual([
      "c.mp4",
      "library/media_y.mp4",
    ]);
  });

  it("is a deep copy — it does not mutate the input", () => {
    const r = { path: "C:/x/y.mp4" };
    scrubAbsolutePaths(r);
    expect(r.path).toBe("C:/x/y.mp4");
  });

  it("survives a cyclic result without infinite looping", () => {
    const r: Record<string, unknown> = { path: "C:/x/y.mp4" };
    r.self = r;
    const out = scrubAbsolutePaths(r) as Record<string, unknown>;
    expect(out.path).toBe("y.mp4");
    expect(out.self).toBeDefined();
  });
});
