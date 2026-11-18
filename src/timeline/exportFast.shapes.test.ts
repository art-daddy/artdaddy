// A Fast pick changes the picture size, the rate, the quality and the encoder, and nothing else of the command, whatever the project holds: sound, a second layer, a crossfade and a speed
// change, captions in two fonts, a zooming picture, held pictures, a watermark, an end card. Every project is built twice by the real command builder: once from the options the Fast
// route composes (`encoderOptions` with the Fast pick, as the export tool calls it) and once from the same settings typed by hand, with the encoder that goes with the chip or without it.
// The two whole plans (arguments, graph, steps, caption files, fonts, sources, the delivered picture, ...) must be equal; only the facts about how the encoder was chosen may differ.
// Every expected size and rate is a literal of the owner's table (never computed with the code under test), so a wrong rule cannot agree with itself. The journey file does the same
// through the whole `export` tool for a simple project; this file does it for the shapes of project that file does not build. Nothing runs ffmpeg or reaches a vendor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setHeldOffByBuild } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import type { ClientToolContext } from "../tools/context";
import type { Branding } from "./branding";
import type { ChipLookup, ChipVerdict } from "./chipTest";
import type { ExportEngine, ExportOptions, ExportQuality } from "./exportOptions";
import type { Clip, Timeline, Track } from "./model";
import { buildRenderCommand, encoderOptions, type RenderPlan } from "./render";

// The graphics chip's lookup is the test's to answer.
const chipFake = vi.hoisted(() => ({ chip: null as unknown }));
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: async (): Promise<ChipLookup> => ({
      chip: chipFake.chip as ChipVerdict | null,
      events: [],
    }),
    takeChipTestEvents: () => [],
    markChipSuspect: () => undefined,
  };
});

const AMD: ChipVerdict = {
  maker: "amd",
  adapter: { maker: "amd", device: "15bf", driver: "32.0.1" },
  sizeClass: "hd",
  ok: true,
  result: "passed",
  ssimMilli: 870,
  ms: 1800,
};

beforeEach(() => {
  __resetExportFlags();
  __setHeldOffByBuild(false);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
});
afterEach(() => {
  chipFake.chip = null;
  __resetExportFlags();
  __setHeldOffByBuild(null);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
});

interface Canvas {
  w: number;
  h: number;
  fps: number;
}
const canvasOf = (c: Canvas) => ({ width: c.w, height: c.h, fps: c.fps });
const vtrack = (id: string, z: number, clips: Clip[]): Track => ({ id, kind: "video", z, clips });
const vclip = (
  id: string,
  ref: string,
  from: number,
  to: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  kind: "video",
  media_ref: ref,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
  ...extra,
});

type Shape = "av" | "overlay" | "text" | "kenburns" | "stills" | "big2";
const SHAPES: readonly Shape[] = ["av", "overlay", "text", "kenburns", "stills", "big2"];

/** A project of one of the shapes on a canvas, in seconds. A new object every call: the builder is not promised to leave its input alone. */
function timelineOf(shape: Shape, c: Canvas): Timeline {
  const canvas = canvasOf(c);
  switch (shape) {
    case "av":
      return {
        canvas,
        tracks: [
          vtrack("v1", 0, [vclip("c1", "/a.mp4", 0, 4)]),
          {
            id: "a1",
            kind: "audio",
            z: 0,
            clips: [
              {
                id: "a1c",
                kind: "audio",
                media_ref: "/m.mp3",
                source_in: 0,
                source_out: 4,
                timeline_in: 0,
                timeline_out: 4,
              },
            ],
          },
        ],
      } as Timeline;
    case "overlay":
      return {
        canvas,
        tracks: [
          vtrack("v0", 0, [
            vclip("o1", "/a.mp4", 0, 2),
            vclip("o2", "/b.mp4", 2, 4, {
              source_out: 4,
              speed: 2,
              transition_in: { kind: "crossfade", duration: 0.5 },
            }),
          ]),
          vtrack("v1", 1, [
            vclip("o3", "/c.mp4", 0.5, 2.5, {
              opacity: 0.9,
              transform: { position: { x: 0.7, y: 0.7 }, scale: 0.3 },
            }),
          ]),
        ],
      } as Timeline;
    case "text":
      return {
        canvas,
        tracks: [
          vtrack("v0", 0, [vclip("t1", "/a.mp4", 0, 3)]),
          {
            id: "cap",
            kind: "text",
            z: 1,
            clips: [
              {
                id: "x1",
                kind: "text",
                text: "Lower third",
                timeline_in: 0,
                timeline_out: 1.5,
                style: { size: 64, color: "#ffffff", font: "Anton" },
                transform: { position: { x: 0.5, y: 0.85 } },
              },
              {
                id: "x2",
                kind: "text",
                text: "Second line",
                timeline_in: 1.5,
                timeline_out: 3,
                style: { size: 48, color: "#ffd400", font: "Poppins", bold: true },
                transform: { position: { x: 0.5, y: 0.15 } },
              },
            ],
          },
        ],
      } as Timeline;
    case "kenburns":
      return {
        canvas,
        tracks: [
          vtrack("v0", 0, [
            vclip("k1", "/p.jpg", 0, 3, {
              kind: "image",
              fit: "cover",
              transform: {
                position: {
                  x: [
                    { t: 0, v: 0.5 },
                    { t: 3, v: 0.55 },
                  ],
                  y: 0.5,
                },
                scale: [
                  { t: 0, v: 1 },
                  { t: 3, v: 1.3 },
                ],
              },
            }),
          ]),
        ],
      } as Timeline;
    case "stills":
      // A held picture, a picture that fades, and an animated one (a GIF is replayed, not held).
      return {
        canvas,
        tracks: [
          vtrack("v0", 0, [
            vclip("s1", "/p1.jpg", 0, 2, { kind: "image" }),
            vclip("s2", "/p2.png", 2, 4, {
              kind: "image",
              fit: "contain",
              opacity: 0.9,
              fade: { in: 9, out: 9 },
            }),
            vclip("s3", "/g.gif", 4, 6, { kind: "image" }),
          ]),
        ],
      } as Timeline;
    case "big2":
      return {
        canvas,
        tracks: [
          vtrack("bg", 0, [vclip("b1", "/bg.mp4", 0, 3)]),
          vtrack("fg", 1, [
            vclip("b2", "/fg.mp4", 0, 3, {
              transform: { position: { x: 0.5, y: 0.5 }, scale: 0.5 },
            }),
          ]),
        ],
      } as Timeline;
  }
}

const BRANDS: Record<"wm" | "card" | "wmcard", Branding> = {
  wm: { watermark: "/brand/watermark-16x9.png", endcard: null, endcardDuration: 0 },
  card: { watermark: null, endcard: "/brand/endcard-16x9.mp4", endcardDuration: 2.5 },
  wmcard: {
    watermark: "/brand/watermark-16x9.png",
    endcard: "/brand/endcard-16x9.mp4",
    endcardDuration: 2.5,
  },
};

const ENGINES: readonly ExportEngine[] = ["file-sequence-v1", "partition-pipes-v1"];
const CONTEXT = { surface: "app" } as unknown as ClientToolContext;

// The owner's table for the canvases here: Fast's own size (the preset one rung below by the short side), the short side that gives, its rate; then a size a person may set (and the
// short side that gives), a rate and a quality they may set.
type Row = [Canvas, { preset: string; short: number; rate: number; size: string; sizeShort: number }];
const ROWS: Row[] = [
  [
    { w: 1920, h: 1080, fps: 30 },
    { preset: "720p", short: 720, rate: 30, size: "1080p", sizeShort: 1080 },
  ],
  [
    { w: 3840, h: 2160, fps: 60 },
    { preset: "1080p", short: 1080, rate: 30, size: "1440p", sizeShort: 1440 },
  ],
  [
    { w: 1080, h: 1920, fps: 30 },
    { preset: "720p", short: 720, rate: 30, size: "1080p", sizeShort: 1080 },
  ],
  [
    { w: 1366, h: 768, fps: 30 },
    { preset: "720p", short: 720, rate: 30, size: "source", sizeShort: 768 },
  ],
];
const SET_RATE = 24;
const SET_QUALITY: ExportQuality = "high";

interface Variant {
  name: string;
  size: boolean;
  fps: boolean;
  quality: boolean;
}
const VARIANTS: Variant[] = [
  { name: "nothing set", size: false, fps: false, quality: false },
  { name: "a size set", size: true, fps: false, quality: false },
  { name: "a rate set", size: false, fps: true, quality: false },
  { name: "a quality set", size: false, fps: false, quality: true },
  { name: "all three set", size: true, fps: true, quality: true },
];

/** The plan without the facts about how the encoder was chosen (the typed twin has none: nobody chose for it). */
function withoutChoice(plan: RenderPlan): Omit<RenderPlan, "choice"> {
  const { choice: _choice, ...rest } = plan;
  return rest;
}

/** One Fast export and its twin typed by hand, on one project. Returns both whole plans and what the table says Fast's picture is. */
async function pair(
  shape: Shape,
  [canvas, table]: Row,
  variant: Variant,
  engine: ExportEngine,
  chip: boolean,
  branding?: Branding,
) {
  chipFake.chip = chip ? AMD : null;
  // What the call carries (what the dialog sends: only what the person set).
  const options: ExportOptions = {
    ...(variant.size ? { resolution: table.size as ExportOptions["resolution"] } : {}),
    ...(variant.fps ? { fps: SET_RATE } : {}),
    ...(variant.quality ? { quality: SET_QUALITY } : {}),
  };
  const picked = await encoderOptions(
    CONTEXT,
    { seconds: timelineOf(shape, canvas), request: "quick" },
    options,
    "deliverable",
    { explicit: { size: variant.size, fps: variant.fps, quality: variant.quality } },
  );
  const fast = buildRenderCommand(timelineOf(shape, canvas), "/out.mp4", {
    ...options,
    engine,
    ...picked,
    ...(branding ? { branding } : {}),
  });
  // The same settings typed: Fast's own size, rate and Medium where the person set nothing, and what the person set where they did; and the encoder that goes with the chip or without it.
  const typed = buildRenderCommand(timelineOf(shape, canvas), "/out.mp4", {
    engine,
    resolution: (variant.size ? table.size : table.preset) as ExportOptions["resolution"],
    fps: variant.fps ? SET_RATE : table.rate,
    quality: variant.quality ? SET_QUALITY : "medium",
    ...(chip ? { mode: "fast" as const, chip: "amd" as const } : { faster: true as const }),
    ...(branding ? { branding } : {}),
  });
  return {
    fast,
    typed,
    short: variant.size ? table.sizeShort : table.short,
    rate: variant.fps ? SET_RATE : table.rate,
  };
}

const idOf = (canvas: Canvas) => `${canvas.w}x${canvas.h}@${canvas.fps}`;

describe("a Fast pick is the typed settings and the encoder, and nothing else of the command, on every shape of project", () => {
  it.each(ROWS.map((row) => [idOf(row[0]), row] as const))(
    "%s: every shape, every thing a person may set, the chip and the processor, both engines",
    async (_id, row) => {
      let compared = 0;
      for (const shape of SHAPES)
        for (const variant of VARIANTS)
          for (const engine of ENGINES)
            for (const chip of [false, true]) {
              const where = `${shape}, ${variant.name}, ${engine}, ${chip ? "chip" : "processor"}`;
              const { fast, typed, short, rate } = await pair(shape, row, variant, engine, chip);
              expect(withoutChoice(fast), where).toEqual(withoutChoice(typed));
              // The picture is the owner's table, not whatever both sides agree on.
              expect([Math.min(fast.output.width, fast.output.height), fast.output.fps], where).toEqual(
                [short, rate],
              );
              // Equal is no proof if both are empty: the command names the encoder that goes with the chip or without it.
              const command = JSON.stringify([fast.args, fast.steps ?? []]);
              expect(command, where).toContain(chip ? "h264_amf" : "veryfast");
              expect(fast.args.length, where).toBeGreaterThan(10);
              compared++;
            }
      expect(compared).toBe(SHAPES.length * VARIANTS.length * ENGINES.length * 2);
    },
    60_000,
  );

  it("a watermark and an end card change nothing about it either: the same plans, branded", async () => {
    let compared = 0;
    for (const row of [ROWS[0], ROWS[1]])
      for (const shape of ["av", "text"] as const)
        for (const [brand, branding] of Object.entries(BRANDS))
          for (const variant of [VARIANTS[0], VARIANTS[4]])
            for (const engine of ENGINES)
              for (const chip of [false, true]) {
                const where = `${idOf(row[0])}, ${shape}, ${brand}, ${variant.name}, ${engine}, ${chip ? "chip" : "processor"}`;
                const { fast, typed, short, rate } = await pair(
                  shape,
                  row,
                  variant,
                  engine,
                  chip,
                  branding,
                );
                expect(withoutChoice(fast), where).toEqual(withoutChoice(typed));
                expect([Math.min(fast.output.width, fast.output.height), fast.output.fps], where).toEqual(
                  [short, rate],
                );
                // The branding is really in the command (equal plans of two unbranded builds would prove nothing).
                const command = JSON.stringify([fast.args, fast.steps ?? []]);
                if (brand !== "card") expect(command, where).toContain("watermark-16x9.png");
                if (brand !== "wm") expect(command, where).toContain("endcard-16x9.mp4");
                compared++;
              }
    expect(compared).toBe(2 * 2 * 3 * 2 * ENGINES.length * 2);
  }, 60_000);
});
