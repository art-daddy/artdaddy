// Every door a person can drop files on goes through one of two functions, so a file the app does not open is never dropped
// without a word. The questions: is a drop split exactly into what is imported and what is reported (nothing lost, nothing
// counted twice), does the report carry no name or path, and can a new door filter by itself and so turn files away unseen
// (a scan of the source fails on one).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const marker = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<typeof import("../api/appEvents")>()),
  reportMediaImport: (...args: unknown[]) => {
    marker.calls.push(args);
  },
}));

import { __heldEditorItems, __resetEditorEvents } from "../api/editorEvents";
import { useAuth } from "../store/auth";
import { acceptDroppedFiles, acceptDroppedPaths, MEDIA_RE } from "./upload";

const held = () => __heldEditorItems().map((h) => ({ project: h.projectId, ...h.item }));
const file = (name: string): File => new File(["x"], name);

beforeEach(() => {
  __resetEditorEvents();
  marker.calls = [];
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
});
afterEach(() => __resetEditorEvents());

describe("a drop of paths (desktop)", () => {
  it("returns the media in the order dropped, and reports each other file once, as unsupported", () => {
    const media = acceptDroppedPaths(
      ["C:\\v\\a.mp4", "C:\\v\\notes.txt", "/home/me/b.JPG", "/home/me/archive.zip", "C:\\v\\c.wav"],
      "p1",
    );
    expect(media).toEqual(["C:\\v\\a.mp4", "/home/me/b.JPG", "C:\\v\\c.wav"]);
    expect(held()).toMatchObject([
      { kind: "import", ok: false, reason: "unsupported_type", media: "unknown", via: "reference", project: "p1" },
      { kind: "import", ok: false, reason: "unsupported_type", media: "unknown", via: "reference", project: "p1" },
    ]);
  });

  it("says nothing at all when everything dropped was media", () => {
    expect(acceptDroppedPaths(["a.mp4", "b.mov", "c.png"], "p1")).toHaveLength(3);
    expect(held()).toEqual([]);
    expect(marker.calls).toEqual([]);
  });

  it("an empty drop is not a refusal", () => {
    expect(acceptDroppedPaths([], "p1")).toEqual([]);
    expect(held()).toEqual([]);
  });

  it("puts one marker on the whole drop, not one per file, so a folder of junk costs one beacon", () => {
    acceptDroppedPaths(Array.from({ length: 40 }, (_, i) => `/x/file${i}.xyz`), "p1");
    expect(held()).toHaveLength(40);
    expect(marker.calls).toEqual([[false, "p1", "unsupported_type", "reference"]]);
  });

  it("carries no file name and no folder, only the word", () => {
    acceptDroppedPaths(["C:\\Users\\me\\Documents\\Tax return 2026.pdf", "/home/me/secret project/notes.txt"], "p1");
    const text = JSON.stringify([held(), marker.calls]);
    expect(text).not.toMatch(/Users|Documents|Tax|secret|notes|pdf|txt|home/);
  });

  it("on the start screen, where no project is open yet, still says so", () => {
    acceptDroppedPaths(["/x/readme.md"], "");
    expect(held()).toMatchObject([{ project: "", reason: "unsupported_type" }]);
    expect(marker.calls).toEqual([[false, "", "unsupported_type", "reference"]]);
  });

  it("splits any list exactly: every path is imported or reported, none both, none lost", () => {
    const names = fc.stringMatching(/^[a-z]{1,6}\.(mp4|mov|png|wav|srt|txt|zip|pdf|exe|MP4|JPG)$/);
    fc.assert(
      fc.property(fc.array(names, { maxLength: 30 }), (paths) => {
        __resetEditorEvents();
        useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
        const media = acceptDroppedPaths(paths, "p1");
        const isMedia = (p: string) => MEDIA_RE.test(p);
        expect(media).toEqual(paths.filter(isMedia));
        expect(held().length).toBe(paths.filter((p) => !isMedia(p)).length);
        expect(media.length + held().length).toBe(paths.length);
      }),
      { numRuns: 150 },
    );
  });
});

describe("a drop of files (the browser)", () => {
  it("returns the media files and reports the others, as ones that would have been copied", () => {
    const keep = [file("clip.mp4"), file("song.mp3")];
    const media = acceptDroppedFiles([keep[0], file("notes.txt"), keep[1]], "p1");
    expect(media).toEqual(keep);
    expect(held()).toMatchObject([{ reason: "unsupported_type", via: "copy", project: "p1" }]);
    expect(marker.calls).toEqual([[false, "p1", "unsupported_type", "copy"]]);
  });

  it("carries no file name", () => {
    acceptDroppedFiles([file("My Holiday Film.docx")], "p1");
    expect(JSON.stringify([held(), marker.calls])).not.toMatch(/Holiday|Film|docx/);
  });
});

describe("no door turns files away by itself", () => {
  const SRC = join(__dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.(test|e2e|smoke)\./.test(name) && !name.startsWith("__") ? [full] : [];
    });
  const rel = (full: string): string => relative(SRC, full).split(sep).join("/");
  const ALL = sources(SRC).map((full) => ({ file: rel(full), text: readFileSync(full, "utf8") }));

  it("only lib/upload.ts filters by the media pattern; a door that did would drop files unseen", () => {
    const offenders = ALL.filter(
      (s) => s.file !== "lib/upload.ts" && /\.filter\([^)]*\b(MEDIA_RE|isMediaFile)\b/.test(s.text),
    ).map((s) => s.file);
    expect(offenders, "these files filter dropped files by MEDIA_RE/isMediaFile themselves: use acceptDroppedPaths/acceptDroppedFiles (lib/upload.ts)").toEqual([]);
  });

  it("every file that receives a drop uses the helper for it", () => {
    const receivers = ALL.filter(
      (s) =>
        s.file !== "lib/osDrop.ts" &&
        s.file !== "lib/upload.ts" &&
        (/\bonOsDrop\(/.test(s.text) || /dataTransfer\??\.files/.test(s.text)),
    );
    expect(receivers.map((s) => s.file).sort()).toEqual([
      "components/ChatView.tsx",
      "components/FileTree.tsx",
      "components/ProjectPicker.tsx",
      "components/StageEmpty.tsx",
      "components/TimelineEditor.tsx",
    ]);
    for (const s of receivers) {
      const wantsPaths = /\bonOsDrop\(/.test(s.text);
      const wantsFiles = /dataTransfer\??\.files/.test(s.text);
      // TimelineEditor passes a lane drop's files to its own importFiles, which is where the helper is.
      if (wantsPaths) expect(s.text, `${s.file} receives dropped paths`).toMatch(/acceptDroppedPaths\(/);
      if (wantsFiles) expect(s.text, `${s.file} receives dropped files`).toMatch(/acceptDroppedFiles\(/);
    }
  });
});
