// One list of supported formats, and proof there is only one.
//
// There were nine, and they disagreed: `avi` was a video to the chat composer but rejected by
// import; `tiff` was inspectable but unimportable; `opus` was known to a single module. None
// of those is visible in use — the file is just quietly ignored — so the drift is pinned here
// rather than left to be discovered by a user.
//
// mediaKind.guard.test.ts already forbids a module CLASSIFYING by extension regex, but it
// matched only regex literals, so `new Set([".mp4", ...])` walked straight past it. This
// catches the list itself, in whatever shape it is written.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, extOf, kindOf, needsPreviewProxy } from "./formats";

const SRC = join(__dirname, "..");
/** Only the registry may enumerate extensions; everything else asks it. */
const OWNER = "media/formats.ts";
/** Lists of something ELSE that happen to read like extensions. */
const NOT_EXTENSIONS = new Map<string, RegExp>([
  [
    "preview/mediaProxy.ts",
    // ffprobe's CONTAINER names for the ISOBMFF family, compared against a probe result.
    /WEB_CONTAINER_OK/,
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("supported media formats", () => {
  // The baseline a desktop NLE is expected to clear: every container/codec a user can drag in
  // from Finder or Explorer. Extras (webm/mkv/avi, ogg/opus, gif/bmp/avif) are ours on top.
  it("accepts every format a desktop NLE is expected to open", () => {
    const baseline: Record<string, string> = {
      mov: "video",
      mp4: "video",
      m4v: "video",
      mp3: "audio",
      wav: "audio",
      aac: "audio",
      m4a: "audio",
      aiff: "audio",
      aif: "audio",
      aifc: "audio",
      caf: "audio",
      flac: "audio",
      png: "image",
      jpg: "image",
      jpeg: "image",
      tiff: "image",
      heic: "image",
      webp: "image",
    };
    const missing = Object.entries(baseline).filter(([ext, kind]) => kindOf(`x.${ext}`) !== kind);
    expect(
      missing,
      `these are part of the expected baseline but not supported: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("classifies by the file's own extension, case and path irrelevant", () => {
    expect(kindOf("C:/Users/me/My Clip.MP4")).toBe("video");
    expect(kindOf("/tmp/a.b.c/track.FLAC")).toBe("audio");
    expect(kindOf("shot.HEIC")).toBe("image");
    // The failure direction: not-media stays not-media, and a bare library id has no
    // extension to read — classifying one here is the bug mediaKind.guard.test.ts exists for.
    expect(kindOf("notes.txt")).toBeNull();
    expect(kindOf("media_9a07ca3d8344")).toBeNull();
    expect(extOf("media_9a07ca3d8344")).toBe("");
  });

  it("knows which media the preview can decode ITSELF and which needs a proxy", () => {
    // mp4box reads ISOBMFF only; everything else has to be transcoded to be previewable.
    expect(needsPreviewProxy("a.mp4")).toBe(false);
    expect(needsPreviewProxy("a.mov")).toBe(false);
    expect(needsPreviewProxy("a.webm")).toBe(true);
    expect(needsPreviewProxy("a.mkv")).toBe(true);
    expect(needsPreviewProxy("a.avi")).toBe(true);
    // createImageBitmap has no TIFF/HEIC decoder.
    expect(needsPreviewProxy("a.png")).toBe(false);
    expect(needsPreviewProxy("a.heic")).toBe(true);
    expect(needsPreviewProxy("a.tiff")).toBe(true);
    // Audio is conformed per clip window by ffmpeg, so no container needs a stand-in.
    expect(AUDIO_EXTS.every((e) => !needsPreviewProxy(`a.${e}`))).toBe(true);
  });

  it("no other module keeps its own list of media extensions", () => {
    // A LIST, in whatever syntax: three or more extensions each introduced by a quote or a
    // dot and joined by `|` or `,` — which catches `/\.(mp4|mov|webm)$/`, `[".mp4", ".mov"]`
    // and `["mp4","mov"]` alike, while leaving alone the prose, ffmpeg/yt-dlp argument
    // strings and filename templates that merely happen to name a format.
    const ext = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS].join("|");
    const item = `["'.]\\.?(?:${ext})\\b["']?`;
    const quotedList = `(?:${item}\\s*[|,]\\s*){2,}${item}`;
    // ...and the bare regex form `(png|jpeg|gif)`, which has no quotes or dots to key on.
    // ClipThumbnail carried one of these and the quoted-only pattern walked straight past it.
    const bareAlternation = `(?:\\b(?:${ext})\\b\\|){2,}\\b(?:${ext})\\b`;
    const listOfThree = new RegExp(`(?:${quotedList})|(?:${bareAlternation})`, "i");
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (rel === OWNER) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (NOT_EXTENSIONS.get(rel)?.test(line)) continue;
        if (listOfThree.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      `These enumerate media extensions themselves and will drift from ${OWNER}. ` +
        `Import VIDEO_EXTS/IMAGE_EXTS/AUDIO_EXTS or call kindOf() instead.`,
    ).toEqual([]);
  });
});
