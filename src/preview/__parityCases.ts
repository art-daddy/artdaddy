// The whole-frame preview <-> export parity cases (art-daddy/backlog#83), described once for the
// three places that use them: the generator that writes the media and the references
// (scripts/genParityFixtures.ts), the smoke lane that holds the EXPORT to the references
// (src/preview/parity.smoke.e2e.ts) and the browser lane that holds the PREVIEW to the same
// references (e2e/ui/parity.spec.ts, through preview-probe-parity.html). Dev only.
//
// One frozen answer, held from both sides, as the rotation fixtures are: a reference is a frame of
// the REAL export (ffmpeg's decode of the exported file), pooled into block means
// (src/test/frameParity.ts) so it stays small and drops the sub-pixel detail neither painter
// promises. Never drawn by hand and never regenerated to make a test pass.
import type { Clip, Timeline, Track } from "../timeline/model";

/** Where the media and the references live (served by the browser lane's dev server too). */
export const PARITY_DIR = "e2e/ui/fixtures/parity";

/** The project every case is drawn in: 16:9 like most projects, small enough to keep the lanes fast
 *  while a default-size caption (6% of the height, 22 px) is still a readable line. */
export const PARITY_CANVAS = { width: 640, height: 360, fps: 30 } as const;

/** A reference holds the mean of every BLOCK x BLOCK square of the frame: 160 x 90 for the canvas. */
export const PARITY_BLOCK = 4;

/** The media every case is built from, made by the shipped ffmpeg (scripts/genParityFixtures.ts). */
export const PARITY_MEDIA = {
  /** 320x180 H.264 (High, tagged BT.709), 60 frames at 30 fps: four flat quadrants (one a grey ramp)
   *  and a white bar that moves 4 px a frame, so a frame shown at the wrong time is a different
   *  picture. */
  clipA: "clip_a.mp4",
  /** 320x180 H.264, 60 frames: six coloured stripes and a dark bar moving down 2 px a frame. */
  clipB: "clip_b.mp4",
  /** 400x300 (4:3) PNG: a diagonal split, an orange disc and a light border. */
  still: "still.png",
  /** 160x160 PNG with transparency: a white ring around a half-transparent yellow disc. */
  logo: "logo.png",
} as const;
export type ParityMedia = keyof typeof PARITY_MEDIA;

/** How a case names its media: a library id in the export, the file's own name in the preview. */
export type MediaRef = (media: ParityMedia) => string;

export interface ParityCase {
  name: string;
  /** What a person does that this case stands for. */
  what: string;
  /** The project frames compared (a reference each). */
  frames: readonly number[];
  timeline(ref: MediaRef): Timeline;
  /** A KNOWN mismatch from the preview hub's table: the preview is expected NOT to match the
   *  export here, and its test is an expected failure that goes red the day the preview matches. */
  known?: string;
  /** The picture depends on the platform (a system font): the reference was made here, and both
   *  halves hold it on this platform only. */
  platform?: NodeJS.Platform;
}

/** The reference file of one compared frame, relative to PARITY_DIR. */
export const referenceName = (name: string, frame: number): string => `ref/${name}@${frame}.png`;

type Extra = Partial<Clip> & Record<string, unknown>;

function video(
  id: string,
  media: ParityMedia,
  ref: MediaRef,
  at: [number, number],
  extra: Extra = {},
) {
  const [tin, tout] = at;
  const sourceIn = typeof extra.source_in === "number" ? extra.source_in : 0;
  return {
    id,
    kind: "video" as const,
    media_ref: ref(media),
    source_in: sourceIn,
    source_out: sourceIn + (tout - tin),
    timeline_in: tin,
    timeline_out: tout,
    ...extra,
  };
}

function image(
  id: string,
  media: ParityMedia,
  ref: MediaRef,
  at: [number, number],
  extra: Extra = {},
) {
  return {
    id,
    kind: "image" as const,
    media_ref: ref(media),
    timeline_in: at[0],
    timeline_out: at[1],
    ...extra,
  };
}

function text(id: string, at: [number, number], extra: Extra): Clip {
  return { id, kind: "text", timeline_in: at[0], timeline_out: at[1], ...extra } as Clip;
}

const track = (id: string, kind: Track["kind"], z: number, clips: unknown[]): Track =>
  ({ id, kind, z, clips }) as Track;

const timeline = (...tracks: Track[]): Timeline => ({
  units: "frames",
  canvas: { ...PARITY_CANVAS },
  tracks,
});

/** A box on the canvas: centre and size as fractions of it (the model's transform). */
const box = (x: number, y: number, w: number, h = w) => ({
  transform: { position: { x, y }, scale_x: w, scale_y: h },
});

/** A clip of clip_a over the whole canvas, carrying `extra`: the base of most look cases. */
const lookCase = (
  name: string,
  what: string,
  extra: Extra,
  known?: string,
  frames: readonly number[] = [15],
): ParityCase => ({
  name,
  what,
  frames,
  known,
  timeline: (ref) => timeline(track("v1", "video", 0, [video("a", "clipA", ref, [0, 30], extra)])),
});

/** The caption add_captions writes for one spoken line: a run per word, timed in seconds from the
 *  card's start, centred 90% down the frame, in the default look. */
function caption(id: string, words: string[], at: [number, number], extra: Extra = {}): Clip {
  return text(id, at, {
    content: words.map((w, i) => ({ text: w, t_in: i * 0.1, t_out: (i + 1) * 0.1 })),
    caption_group: "cap_parity",
    transform: { position: { x: 0.5, y: 0.9 } },
    ...extra,
  });
}

/** What people use most, drawn as both painters should draw it. */
export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "plain",
    what: "a video clip over the whole canvas, at two moments (the bar moves between them)",
    frames: [10, 40],
    timeline: (ref) => timeline(track("v1", "video", 0, [video("a", "clipA", ref, [0, 60])])),
  },
  {
    name: "still",
    what: "a 4:3 photo on a 16:9 canvas: fitted inside, with bars at the sides",
    frames: [15],
    timeline: (ref) => timeline(track("v1", "video", 0, [image("s", "still", ref, [0, 30])])),
  },
  {
    name: "fit-crop",
    what: "a cropped, mirrored clip filling a box (cover), and a photo fitted inside a tall box",
    frames: [12],
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("b", "clipB", ref, [0, 30])]),
        track("v2", "video", 1, [
          video("a", "clipA", ref, [0, 30], {
            fit: "cover",
            crop: { left: 0.1, right: 0.25, top: 0.05, bottom: 0.15 },
            flip: { h: true },
            ...box(0.3, 0.33, 0.45, 0.5),
          }),
        ]),
        track("v3", "video", 2, [
          image("s", "still", ref, [0, 30], { fit: "contain", ...box(0.84, 0.5, 0.25, 0.8) }),
        ]),
      ),
  },
  {
    name: "text-caption",
    what: "a title and a spoken-word caption over a clip",
    frames: [20],
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("t1", "text", 1, [
          text("title", [0, 30], {
            text: "Parity check",
            style: { font: "Poppins", size: 44, color: "#FFFFFF" },
            transform: { position: { x: 0.5, y: 0.2 } },
          }),
        ]),
        track("captions", "text", 2, [
          caption("cap", ["what", "you", "see", "is", "what", "you", "get"], [0, 30]),
        ]),
      ),
  },
  {
    name: "opacity",
    what: "a half-transparent clip in a box over another clip",
    frames: [15],
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("v2", "video", 1, [
          video("b", "clipB", ref, [0, 30], { opacity: 0.5, ...box(0.4, 0.45, 0.55) }),
        ]),
      ),
  },
  {
    name: "crossfade",
    what: "a crossfade between two clips, a quarter, half and three quarters of the way",
    frames: [40, 45, 50],
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [
          video("a", "clipA", ref, [0, 45]),
          video("b", "clipB", ref, [45, 90], {
            transition_in: { kind: "crossfade", duration: 20 },
          }),
        ]),
      ),
  },
  lookCase("grade-exposure", "an exposure grade (a grade the preview draws)", {
    color: { exposure: 0.6 },
  }),
  // The hub lists these as approximations (rows 3 and 5); measured on 26 Nov they sit inside the
  // tolerance on these pictures, so they are held like any other look.
  lookCase("grade-levels", "levels: lifted blacks and dimmed whites (approximated, row 3)", {
    color: { blacks: 0.4, whites: -0.4 },
  }),
  lookCase("blur", "blur (a shader blur against gblur, row 5)", {
    effects: [{ type: "blur", params: { radius: 6 } }],
  }),
  lookCase("sharpen", "sharpen (a shader unsharp against unsharp 5x5, row 5)", {
    effects: [{ type: "sharpen", params: { sharpness: 1.5 } }],
  }),
];

/** Found by this suite on 26 Nov 2026 and not in the hub's table: reported to the scrum master with
 *  the two frames, and held here as expected failures like the table's rows. */
const FOUND = "found 26 Nov, not in the hub table";

/** The preview hub's "Known mismatches", each as the case that shows it. Their preview test is an
 *  expected failure; the export half is held to its reference like any other case. */
export const KNOWN_MISMATCH_CASES: readonly ParityCase[] = [
  lookCase(
    "custom-filter",
    "a raw ffmpeg filter (custom effect)",
    { effects: [{ type: "custom", params: { expr: "negate" } }] },
    "row 1: a filter string has no WebGL path; the preview draws the clip as if it had none",
  ),
  lookCase(
    "wheels",
    "colour wheels: a cool push in the shadows, a warm push in the highlights",
    { color: { shadowsHue: 210, shadowsAmount: 0.8, highsHue: 30, highsAmount: 0.8 } },
    "row 2: the colour wheels are not in the preview's shader",
  ),
  lookCase(
    "vibrance",
    "vibrance",
    { color: { vibrance: 1.5 } },
    "row 2: vibrance is not in the preview's shader",
  ),
  lookCase(
    "grade-primaries",
    "brightness, contrast and saturation",
    { color: { brightness: 0.06, contrast: 1.2, saturation: 1.35 } },
    `${FOUND}: the preview grades in RGB, ffmpeg's eq in YUV; saturated colours come out stronger in the preview`,
  ),
  {
    name: "alpha-png",
    what: "a logo whose PNG has half-transparent pixels",
    frames: [15],
    known: `${FOUND}: the preview darkens a half-transparent pixel twice (its bitmap is premultiplied, the shader reads it as straight alpha)`,
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("v2", "video", 1, [image("l", "logo", ref, [0, 30], box(0.5, 0.5, 0.3, 0.55))]),
      ),
  },
  {
    name: "blend",
    what: "a photo blended with screen and a clip blended with multiply over a clip",
    frames: [15],
    known: `row 6 and ${FOUND}: the export blends screen and multiply per YUV plane (magenta and green casts); the preview follows the formulas`,
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("v2", "video", 1, [
          image("s", "still", ref, [0, 30], { blend: "screen", ...box(0.28, 0.5, 0.45) }),
        ]),
        track("v3", "video", 2, [
          video("b", "clipB", ref, [0, 30], { blend: "multiply", ...box(0.72, 0.5, 0.45) }),
        ]),
      ),
  },
  lookCase(
    "temperature",
    "white balance temperature",
    { color: { temperature: 3200 } },
    "row 3: temperature is a fixed RGB gain in the preview, colortemperature in the export",
  ),
  lookCase(
    "tint",
    "white balance tint",
    { color: { tint: 0.6 } },
    "row 3: tint is a green gain in the preview, colorbalance in the export",
  ),
  lookCase(
    "highlights-shadows",
    "highlights pulled down, shadows lifted",
    { color: { highlights: -0.8, shadows: 0.8 } },
    "row 3: highlights and shadows are a smoothstep lift in the preview, a curve in the export",
  ),
  lookCase(
    "curves",
    "a tone curve",
    {
      color: {
        masterCurve: [
          [0, 0.15],
          [0.5, 0.7],
          [1, 0.85],
        ],
      },
    },
    "row 3: the preview bakes the curve into a 256-step ramp; the export runs ffmpeg's curves",
  ),
  lookCase(
    "motion-blur",
    "motion blur on a moving bar",
    { effects: [{ type: "motion", params: { frames: 8 } }] },
    "row 4: the export averages earlier frames (tmix); a stateless draw smears sideways",
    [20],
  ),
  lookCase(
    "denoise",
    "strong denoise",
    { effects: [{ type: "denoise", params: { strength: 20 } }] },
    "row 4: hqdn3d in the export leaves clean edges; the preview's stand-in blurs them",
  ),
  lookCase(
    "glow",
    "glow",
    { glow: 60 },
    "row 5: an additive ring bloom in the preview, a bloom sub-graph in the export",
  ),
  lookCase(
    "clarity",
    "clarity and dehaze",
    { effects: [{ type: "clarity", params: { clarity: 0.8, dehaze: 0.8 } }] },
    "row 5: wide shader unsharp and contrast in the preview, unsharp 7x7 and eq in the export",
  ),
  lookCase(
    "grain",
    "film grain",
    { effects: [{ type: "grain", params: { grain: 40 } }] },
    "row 5: hash noise in the preview, ffmpeg's noise filter in the export",
  ),
  lookCase(
    "vignette",
    "vignette",
    { effects: [{ type: "vignette", params: { vignette: 0.8 } }] },
    "row 5: a smoothstep falloff over the clip in the preview, ffmpeg's vignette in the export",
  ),
  {
    name: "blend-overlay",
    what: "a photo blended with overlay over a clip",
    frames: [15],
    known:
      "row 6: fixed-function blending cannot express overlay, so the preview draws it as normal",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("v2", "video", 1, [image("s", "still", ref, [0, 30], { blend: "overlay" })]),
      ),
  },
  {
    name: "past-end-transition",
    what: "a clip placed past the end of its file, crossfading into the next clip",
    frames: [66],
    known:
      "row 9: at an outgoing transition the export holds the file's last frame (tpad), the preview shows nothing",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [
          // clip_a has 60 frames; this clip asks for 70.
          video("a", "clipA", ref, [0, 70]),
          video("b", "clipB", ref, [70, 100], {
            transition_in: { kind: "crossfade", duration: 20 },
          }),
        ]),
      ),
  },
  {
    name: "two-line-caption",
    what: "a caption of two lines",
    frames: [15],
    known:
      "row 10: the preview spaces lines 1.25 em apart, libass one cell (about 1.76 em in Poppins)",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("t1", "text", 1, [
          text("lines", [0, 30], {
            text: "the first line\nand the second",
            style: { font: "Poppins", size: 36, color: "#FFFFFF" },
            transform: { position: { x: 0.5, y: 0.5 } },
          }),
        ]),
      ),
  },
  {
    name: "run-style",
    what: "a caption with one word in another colour",
    frames: [15],
    known: "row 11: the preview draws a caption's runs as one line in the base style",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("captions", "text", 1, [
          caption("cap", ["only", "this", "word", "is", "red"], [0, 30], {
            content: [
              { text: "only" },
              { text: "THIS", style: { color: "#FF2020" } },
              { text: "word" },
              { text: "is" },
              { text: "red" },
            ],
            style: { size: 40 },
          }),
        ]),
      ),
  },
  {
    name: "raw-ass",
    what: "a title restyled with a raw ASS override",
    frames: [15],
    known: "row 11: the preview ignores raw_ass and draws the clip's own text in its style",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("t1", "text", 1, [
          text("title", [0, 30], {
            text: "Parity check",
            raw_ass: "{\\c&H2020FF&\\fs60}Parity check",
            style: { font: "Poppins", size: 44, color: "#FFFFFF" },
            transform: { position: { x: 0.5, y: 0.5 } },
          }),
        ]),
      ),
  },
  {
    name: "fallback-face",
    what: "Chinese, which none of the bundled faces covers",
    frames: [15],
    known:
      "row 12: a glyph no bundled face has falls back to the webview's face in the preview and to libass's system face in the export",
    // Both fallbacks are the platform's: the reference is the Windows export, held on Windows only.
    platform: "win32",
    timeline: (ref) =>
      timeline(
        track("v1", "video", 0, [video("a", "clipA", ref, [0, 30])]),
        track("t1", "text", 1, [
          text("title", [0, 30], {
            text: "你好世界，欢迎回来",
            style: { size: 44, color: "#FFFFFF" },
            transform: { position: { x: 0.5, y: 0.5 } },
          }),
        ]),
      ),
  },
];

export const ALL_PARITY_CASES: readonly ParityCase[] = [...PARITY_CASES, ...KNOWN_MISMATCH_CASES];
