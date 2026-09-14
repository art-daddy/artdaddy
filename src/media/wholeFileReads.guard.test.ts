// Nothing may pull a media file into the webview heap unbounded.
//
// This rule has now been broken FOUR times by four different modules, and every time the
// symptom was the same: the app died with 0xE0000008 (Chromium's out-of-memory code) in
// app.exe, because on desktop the asset protocol serves a range-less request by reading the
// whole file into the RUST process first. A 1.84 GB screen recording killed the editor from
// the video demuxer, then the audio engine, then — after both were fixed — from a decorative
// timeline WAVEFORM. Fixing them one at a time is what let the next one ship.
//
// So the list is pinned here. A module that materialises bytes must say which bound keeps it
// finite; a new one fails this test until it does. The bounds that count are: a Range request,
// an ffmpeg conform of the clip's window, or a hard size ceiling checked from a stat.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

/** file -> why its whole-buffer read cannot grow with the source file. */
const BOUNDED = new Map<string, string>([
  [
    "preview/videoSource.ts",
    "Range requests only: reads the sample table, then one GOP's bytes at a time",
  ],
  [
    "preview/audioEngine.ts",
    "fetches the ffmpeg-conformed extract of the CLIP'S WINDOW, not the source",
  ],
  [
    "components/ClipWaveform.tsx",
    "same conformed window as the audio engine; refuses oversized where no ffmpeg exists",
  ],
  [
    "preview/loader.ts",
    "an image must be whole to decode; import bounds dimensions (imageDims) and TIFF/HEIC " +
      "go through a generated PNG stand-in",
  ],
  ["preview/renderer.ts", "reads back a canvas blob the renderer itself just produced"],
  ["lib/upload.ts", "staged by path in chunks; the whole-file read is the small-file branch"],
  ["tools/import.ts", "downloads have their own byte cap before the buffer is taken"],
  ["tools/transcribe.ts", "reads a model/JSON artefact, never the media"],
  [
    "components/RecordDialog.tsx",
    "the take is capped at MAX_RECORDING_BYTES as chunks arrive; the recorder stops itself",
  ],
  ["preview/__probe_video.ts", "dev-only probe page, not in the production bundle"],
]);

const READS_BYTES = /\.arrayBuffer\(\)|createImageBitmap\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.e2e\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("whole-file reads into the webview", () => {
  it("every module that materialises bytes states what bounds it", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (!READS_BYTES.test(readFileSync(file, "utf8"))) continue;
      if (!BOUNDED.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      `These read a whole buffer into the webview. On desktop the asset protocol answers a ` +
        `range-less request by reading the ENTIRE file in the Rust process, so an oversized ` +
        `source is an app crash, not a slow load. Bound it with a Range request, an ffmpeg ` +
        `conform of the clip's window, or a size ceiling from a stat — then record which, here.`,
    ).toEqual([]);
  });

  it("...and the list has no stale entries hiding a module that stopped reading bytes", () => {
    const stale = [...BOUNDED.keys()].filter(
      (rel) => !READS_BYTES.test(readFileSync(join(SRC, rel), "utf8")),
    );
    expect(stale, "these no longer read whole buffers; drop them so the list stays honest").toEqual(
      [],
    );
  });
});
