// What users actually import, through the real export door (3g). The rest of the export suite
// feeds synthetic H.264 mp4, PNG and WAV; real users bring iPhone HEVC with a rotation flag,
// VP9/AV1 web downloads, ProRes, 23.976 fps film, 4:4:4 screen captures, odd sizes, 5.1, alpha
// PNGs, AVIF, GIF and every audio container. A table drives it, so walk the table: each row is
// imported, placed alone, exported through exportTimelineTool and judged on the DELIVERED file.
//
// Every picture source shows the same thing when displayed correctly: red top half, blue bottom
// half. That makes "upright" checkable (a rotated phone clip exported sideways splits left/right)
// and makes a wrong colour conversion visible. Sound sources carry a 440 Hz tone.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportInputs.smoke.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaKind } from "../media/formats";
import {
  ff,
  installE2EDocuments,
  libRef,
  meanVolumeDb,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { whenExportEnds } from "./exportQueue";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-inputs-${Date.now()}`);
const FPS = 30;
const SECONDS = 2;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** Red over blue, displayed `w` x `h`. */
const split = (w: number, h: number, rate = "30") =>
  `color=c=red:s=${w}x${h}:r=${rate}:d=${SECONDS},drawbox=x=0:y=ih/2:w=iw:h=ih/2:color=blue:t=fill`;
const tone = (rate = 48000, layout = "mono") =>
  `sine=frequency=440:sample_rate=${rate}:duration=${SECONDS},aformat=channel_layouts=${layout}`;

interface Row {
  name: string;
  file: string;
  kind: MediaKind;
  /** The canvas the source fills (a portrait source on a portrait canvas). */
  canvas?: { width: number; height: number };
  picture: boolean;
  sound: boolean;
  /** Bottom half of the canvas shows the black canvas, not blue (a transparent PNG half). */
  bottomIsCanvas?: boolean;
  make: (out: string) => string[][];
}

const v = (lavfi: string) => ["-f", "lavfi", "-i", lavfi];
const ROWS: Row[] = [
  {
    name: "H.264 + AAC in mp4 (the baseline)",
    file: "baseline.mp4",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone()),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "iPhone portrait: HEVC 10-bit + AAC in mov, stored sideways with a rotation flag",
    file: "iphone.mov",
    kind: "video",
    canvas: { width: 360, height: 640 },
    picture: true,
    sound: true,
    make: (o) => {
      const coded = o.replace(/\.mov$/, ".coded.mov");
      return [
        // Stored as 640x360 turned a quarter counter-clockwise, as a phone held upright records.
        [
          ...v(`${split(360, 640)},transpose=2`),
          ...v(tone(44100)),
          "-c:v",
          "libx265",
          "-pix_fmt",
          "yuv420p10le",
          "-tag:v",
          "hvc1",
          "-x265-params",
          "log-level=error",
          "-c:a",
          "aac",
          "-shortest",
          coded,
        ],
        ["-display_rotation:v:0", "-90", "-i", coded, "-c", "copy", o],
      ];
    },
  },
  {
    name: "VP9 + Opus in webm (screen recorders, web downloads)",
    file: "screen.webm",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone()),
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libopus",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "AV1 + Opus in mkv (modern downloads)",
    file: "download.mkv",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone()),
        "-c:v",
        "libsvtav1",
        "-preset",
        "12",
        "-c:a",
        "libopus",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "ProRes 422 + 24-bit PCM in mov (cameras, other editors)",
    file: "camera.mov",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone(48000, "stereo")),
        "-c:v",
        "prores_ks",
        "-profile:v",
        "2",
        "-c:a",
        "pcm_s24le",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "Motion JPEG + PCM in avi (older cameras)",
    file: "oldcam.avi",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone(32000)),
        "-c:v",
        "mjpeg",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "3",
        "-c:a",
        "pcm_s16le",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "H.264 4:4:4 in mkv, no sound (lossless screen capture)",
    file: "capture444.mkv",
    kind: "video",
    picture: true,
    sound: false,
    make: (o) => [
      [...v(split(640, 360)), "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "0", o],
    ],
  },
  {
    name: "23.976 fps film, H.264 + AAC",
    file: "film23976.mp4",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360, "24000/1001")),
        ...v(tone()),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "odd size 721x405 with non-square pixels (anamorphic)",
    file: "anamorphic.mkv",
    kind: "video",
    picture: true,
    sound: false,
    make: (o) => [
      [...v(`${split(721, 405)},setsar=4/3`), "-c:v", "libx264", "-pix_fmt", "yuv444p", o],
    ],
  },
  {
    name: "5.1 surround AC-3 in mkv",
    file: "surround.mkv",
    kind: "video",
    picture: true,
    sound: true,
    make: (o) => [
      [
        ...v(split(640, 360)),
        ...v(tone(48000, "5.1")),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "ac3",
        "-shortest",
        o,
      ],
    ],
  },
  {
    name: "PNG with alpha (transparent bottom half)",
    file: "overlay.png",
    kind: "image",
    picture: true,
    sound: false,
    bottomIsCanvas: true,
    make: (o) => [
      [
        ...v(
          "color=c=red@1:s=640x360,format=rgba,drawbox=x=0:y=ih/2:w=iw:h=ih/2:color=black@0:t=fill:replace=1",
        ),
        "-frames:v",
        "1",
        o,
      ],
    ],
  },
  {
    name: "16-bit PNG",
    file: "deep.png",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", "-pix_fmt", "rgb48be", o]],
  },
  {
    name: "JPEG",
    file: "photo.jpg",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", o]],
  },
  {
    name: "WebP",
    file: "web.webp",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", "-c:v", "libwebp", o]],
  },
  {
    name: "AVIF",
    file: "modern.avif",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [
      [
        ...v(split(640, 360)),
        "-frames:v",
        "1",
        "-c:v",
        "libaom-av1",
        "-still-picture",
        "1",
        "-cpu-used",
        "8",
        o,
      ],
    ],
  },
  {
    name: "GIF",
    file: "meme.gif",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", o]],
  },
  {
    name: "BMP",
    file: "paint.bmp",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", o]],
  },
  {
    name: "TIFF",
    file: "scan.tiff",
    kind: "image",
    picture: true,
    sound: false,
    make: (o) => [[...v(split(640, 360)), "-frames:v", "1", o]],
  },
  ...(
    [
      ["MP3", "song.mp3", ["-c:a", "libmp3lame"]],
      ["FLAC", "master.flac", ["-c:a", "flac"]],
      ["Ogg Vorbis", "game.ogg", ["-c:a", "libvorbis"]],
      ["Opus", "voice.opus", ["-c:a", "libopus"]],
      ["M4A (AAC)", "memo.m4a", ["-c:a", "aac"]],
      ["WAV 24-bit 96 kHz", "studio.wav", ["-c:a", "pcm_s24le", "-ar", "96000"]],
      ["AIFF", "mac.aiff", ["-c:a", "pcm_s16be"]],
    ] as const
  ).map(([name, file, codec]): Row => ({
    name: `${name} (audio only)`,
    file,
    kind: "audio",
    picture: false,
    sound: true,
    make: (o) => [[...v(tone(48000, "stereo")), ...codec, o]],
  })),
];

/** Mean chroma of a horizontal band of the delivered file at 1 s: [top, bottom] as fractions. */
async function band(
  file: string,
  top: number,
  bottom: number,
): Promise<{ u: number; v: number; y: number }> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "1",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=iw:ih*${(bottom - top).toFixed(3)}:0:ih*${top.toFixed(3)},signalstats,metadata=print:file=-`,
    "-f",
    "null",
    "-",
  ]);
  const num = (k: string) => Number(new RegExp(`${k}=([\\d.]+)`).exec(r.stdout)?.[1] ?? NaN);
  return { y: num("YAVG"), u: num("UAVG"), v: num("VAVG") };
}

const colour = (b: { u: number; v: number; y: number }) =>
  b.v > b.u + 40
    ? "red"
    : b.u > b.v + 40
      ? "blue"
      : b.y < 24
        ? "black"
        : `other(y${b.y.toFixed(0)} u${b.u.toFixed(0)} v${b.v.toFixed(0)})`;

async function streams(file: string): Promise<Rec[]> {
  const r = await nodeRunner.run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]);
  return ((JSON.parse(r.stdout || "{}") as { streams?: Rec[] }).streams ?? []) as Rec[];
}

describe("every input format a user imports exports correctly", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s",
    async (_name, row) => {
      const dir = joinPath(ROOT, row.file.replace(/\W+/g, "_"));
      await nodeFs.mkdir(dir);
      await openE2EDoc(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      const canvas = row.canvas ?? { width: 640, height: 360 };
      expect(((await setCanvasTool({ ...canvas, fps: FPS }, ctx)) as Rec).ok).toBe(true);

      const src = joinPath(dir, row.file);
      for (const args of row.make(src)) await ff(["-y", "-v", "error", ...args]);
      const ref = await libRef(ctx, src, row.kind);
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: FPS * SECONDS }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);

      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await whenExportEnds(String(res.job_id));
      expect(ended?.state, JSON.stringify(ended)).toBe("done");

      const out = await ctx.store.exportPath("out.mp4");
      const s = await streams(out);
      const video = s.find((x) => x.codec_type === "video");
      expect(video?.codec_name).toBe("h264");
      expect(video?.pix_fmt).toBe("yuv420p");
      expect([video?.width, video?.height]).toEqual([canvas.width, canvas.height]);
      const audio = s.find((x) => x.codec_type === "audio");
      if (row.sound) {
        expect(audio?.codec_name, "the sound is missing from the file").toBe("aac");
        expect(Number(audio?.sample_rate)).toBe(48000);
        expect(await meanVolumeDb(out, { ss: 0.5, dur: 1 }), "the sound is silent").toBeGreaterThan(
          -40,
        );
      }
      if (row.picture) {
        // Standard (TV) range whatever the source: pure red decodes to luma ~81 there and ~76 in
        // full range. A JPEG once turned the whole export full range (tagged pc).
        expect(video?.color_range, "the export must not be full range").not.toBe("pc");
        expect(Math.abs((await band(out, 0.1, 0.4)).y - 81), "red's luma, TV range").toBeLessThan(
          4,
        );
        expect(colour(await band(out, 0.1, 0.4)), "top of the picture").toBe("red");
        expect(colour(await band(out, 0.6, 0.9)), "bottom of the picture").toBe(
          row.bottomIsCanvas ? "black" : "blue",
        );
      }
    },
    180_000,
  );
});
