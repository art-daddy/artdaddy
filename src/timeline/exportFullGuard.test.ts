// The full-quality guard: proof that a change to Quick export moved not one byte of an export that does not name Quick.
//
// It makes a SHA-256 of the stable JSON text of what four doors of the exporter produce for a large, fixed table of projects and
// options, and compares every hash with the fixture the constant `FIXTURE` names (see THREE FIXTURES):
//   A  the command builder, `buildRenderCommand`: the WHOLE plan (arguments, graph, steps, files, facts), not only the arguments, for
//      ten project shapes on twelve canvases under every option, singly and in pairs and in a seeded sample of everything at once
//   B  the encoder choice as the export tool makes it, `encoderOptions`, for the requests auto, full and fast: its answer AND the
//      chip lookups made for it (a chip tested for a request that did not ask for one is a change in what the app runs)
//   C  the real `export` tool, from the call to the job handed to the app process: the submitted command and the reply, for the whole
//      product of call, door, chip, measurement, engine setting and canvas
//   D  `encoderOptions` for the request "quick", as 0.28.0 already answers it (the encoder only: the chip where one passed, else
//      the faster setting), hashed like B and kept apart so the sections can be compared separately
//
// THE FIXTURE IS NEVER REGENERATED TO MAKE THIS TEST PASS. After a change, run print mode to a DIFFERENT file and compare the two key by
// key; a key that moved is a change in what an export does, to be explained, not blessed. The combined hash is pinned in this file, so
// the data cannot be replaced without this file saying so in the same diff.
//
// THREE FIXTURES. `exportFullGuard.sha256.json` was made once, on 0.28.0 (the client at commit 32df78e3, before any Quick change), and is the
// record of what that export did: it is kept untouched and its combined hash is pinned below (OLD_COMBINED). The rule for an export nobody
// pinned then changed on purpose (the graphics chip is used whenever it passed its test for the picture's size and is not Off), and
// `exportFullGuard.always.sha256.json` was printed from the tree after that change (ALWAYS_COMBINED), also kept untouched. The chip test
// then got a third size class (`uhd60`: 3840 x 2160 and smaller pictures of 31 to 60 frames a second, which had no class and so always
// ran on the processor), so the chip lookup is now made for such a picture, and `exportFullGuard.uhd60.sha256.json` was printed from
// the tree after that change: it is the one the four sections below compare with. The last two describes read the files from disk and
// check that what differs between neighbours is what that change can reach and nothing else.
//
//   check mode (the default): every hash is recomputed and compared with the fixture: every key present and equal, no key extra.
//   print mode: EXPORT_GUARD_PRINT=<absolute path of a NEW file> writes the hashes there (UTF-8, LF, keys sorted) and compares
//               nothing. PowerShell:  $env:EXPORT_GUARD_PRINT = 'C:\somewhere\after.json'
//                                     & .\node_modules\.bin\vitest.cmd run src/timeline/exportFullGuard.test.ts
//   EXPORT_GUARD_NOTES=<absolute path> also writes what each key exercised (backend, steps, captions, encoder, reason, ...), which
//               is for reading and is not compared.
//
// The state is the one a shipped 0.28.0 is in: the export flags at their compiled defaults and the build's hold on `estimate_v2` and
// `pc_check` ON, except where an axis sets a flag. Nothing here reads the clock, random numbers (the sample is a seeded generator),
// the locale or the machine, runs ffmpeg or touches the network: the chip lookup is the one thing faked (the decision code stays real).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetExportFlags,
  __setExportFlag,
  __setHeldOffByBuild,
  exportFlag,
  type ExportFlagName,
} from "../api/exportFlags";
import type { MutationOrigin } from "../project/MutationGate";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import { setupExport } from "../test/chipExportKit";
import { resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import { _resetAppCaches } from "../tools/appCache";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor } from "../tools/jobSupervisor";
import { __resetWorkGate } from "../tools/workGate";
import type { Branding } from "./branding";
import type { ChipLookup, ChipTestEvent, ChipVerdict } from "./chipTest";
import type { ChoiceFacts } from "./exportChoice";
import {
  CHIP_PREFERENCE,
  type ChipMaker,
  type ExportEncoder,
  type ModeRequest,
  type SizeClass,
} from "./exportEncoder";
import { exportTool } from "./exportItems";
import {
  deliveredPicture,
  type ExportCalibration,
  type ExportEngine,
  type ExportMode,
  type ExportOptions,
  type ExportQuality,
  type ExportResolution,
} from "./exportOptions";
import type { Rung } from "./exportPlan";
import {
  __resetExportQueue,
  cancelExport,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "./exportQueue";
import type { LeanOptions, LeanProbed } from "./leanOptions";
import type { Clip, Timeline, Track } from "./model";
import { setCanvasTool } from "./ops";
import { buildRenderCommand, encoderOptions, type RenderPlan } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FIXTURE = "src/timeline/__fixtures__/exportFullGuard.uhd60.sha256.json";
const ALWAYS_FIXTURE = "src/timeline/__fixtures__/exportFullGuard.always.sha256.json";
const OLD_FIXTURE = "src/timeline/__fixtures__/exportFullGuard.sha256.json";
const PRINT_TO = process.env.EXPORT_GUARD_PRINT;
const NOTES_TO = process.env.EXPORT_GUARD_NOTES;
/** The combined hash of the fixture printed after the chip test got its third size class (set once, when the fixture was made; see the header). */
const PINNED_COMBINED = "bc08c42d43115dfe367f62b03cd2fbdd6f2777701cfbe369ed911b9ef6203715";
/** The combined hash of the fixture printed after the chip became the rule, before the third size class (kept as the record; see the header). */
const ALWAYS_COMBINED = "a4e4d59c61535a7fca8c8f5b22418195caffbba86499847ea0bbef56c90bd170";
/** The combined hash of the fixture made on 0.28.0, which is kept as the record (see the header). */
const OLD_COMBINED = "5050b04afc969defc30a2f767c351a22104aeb3717a708f4dd03d1392bacadf5";
const SEED = 20261118;

// ---------------------------------------------------------------------------------------------------------------------
// The mocks: the chip lookup is the test's to answer, and nothing leaves the process
// ---------------------------------------------------------------------------------------------------------------------

const chipFake = vi.hoisted(() => ({
  lookup: async (_sizeClass: string, _options: { allowRun: boolean }): Promise<unknown> => ({
    chip: null,
    events: [],
  }),
  take: (): unknown[] => [],
}));
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: async (sizeClass: string, options: { allowRun: boolean; signal?: AbortSignal }) =>
      (await chipFake.lookup(sizeClass, options)) as ChipLookup,
    takeChipTestEvents: () => chipFake.take() as ChipTestEvent[],
    markChipSuspect: () => undefined,
  };
});
// The reports of a settled export are fire-and-forget to the server: never sent from here.
vi.mock("../api/exportEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/exportEvents")>()),
  reportExport: async () => undefined,
}));
// No branding asset is fetched: the exports here are the unbranded ones an app without its bundle makes.
vi.mock("./brandRecovery", () => ({ recoverBrandAsset: async () => null }));

beforeEach(() => {
  __resetExportFlags();
  __setHeldOffByBuild(true);
  useAuth.setState({ profile: null });
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
});
afterEach(() => {
  __resetExportFlags();
  __setHeldOffByBuild(null);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
});

// ---------------------------------------------------------------------------------------------------------------------
// The stable text, the hash, and the file
// ---------------------------------------------------------------------------------------------------------------------

/** JSON with every object's keys sorted, arrays in order, `undefined` properties dropped, and a number JSON cannot write (NaN, the
 *  infinities) written as the STRING "NaN", "Infinity" or "-Infinity", never as null. What JSON would silently lose (a Map, a Set, a
 *  function, a class instance, a symbol) is an error here: a hash that cannot see a field is a guard with a hole in it. */
function stable(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
    case "object":
      break;
    default:
      throw new TypeError(`stable(): a ${typeof value} has no stable text`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(
      `stable(): ${String((value as object).constructor?.name)} has no stable text`,
    );
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`);
  return `{${parts.join(",")}}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const hashOf = (value: unknown): string => sha256(stable(value));

/** The lines `key=hash`, sorted as strings, joined with a line feed. */
function combinedOf(hashes: Record<string, string>): string {
  return sha256(
    Object.entries(hashes)
      .map(([key, hash]) => `${key}=${hash}`)
      .sort()
      .join("\n"),
  );
}

const SECTIONS = ["A", "B", "C", "D"] as const;
type SectionName = (typeof SECTIONS)[number];

interface Computed {
  hashes: Record<string, string>;
  /** What each key exercised, for the notes file only. */
  tags: Record<string, string[]>;
  /** The text of the first entries of the section, for the notes file only: what a hash is made of. */
  samples: Record<string, string>;
  /** What a key's entry says besides its hash, for the notes file only (section C: the reply's note, and the hash of everything else). */
  extras: Record<string, Record<string, unknown>>;
}
interface Digest {
  hash: string;
  text: string;
  tags: string[];
  extra?: Record<string, unknown>;
}
const computed: Partial<Record<SectionName, Computed>> = {};
const emptyComputed = (): Computed => ({ hashes: {}, tags: {}, samples: {}, extras: {} });
const digest = (value: unknown, tags: string[], extra?: Record<string, unknown>): Digest => {
  const text = stable(value);
  return { hash: sha256(text), text, tags, ...(extra ? { extra } : {}) };
};
function collect(result: Computed, key: string, one: Digest): void {
  result.hashes[key] = one.hash;
  result.tags[key] = one.tags;
  if (one.extra) result.extras[key] = one.extra;
  if (Object.keys(result.samples).length < 3) result.samples[key] = one.text.slice(0, 40_000);
}

interface Fixture {
  format: number;
  /** Only the fixture printed after the rule changed has these two: what it is and the fixture it comes from. */
  about?: string;
  derivedFrom?: { file: string; combined: string };
  sections: Record<string, { count: number }>;
  combined: string;
  hashes: Record<string, string>;
}

function readFixture(file: string = FIXTURE): Fixture {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `${file} is missing: the fixture is made once, in print mode, on the untouched tree`,
    );
  }
  return JSON.parse(text.replace(/\r\n/g, "\n")) as Fixture;
}

function expectSectionMatches(name: SectionName, now: Record<string, string>): void {
  const fixture = readFixture().hashes;
  const then: Record<string, string> = {};
  for (const [key, hash] of Object.entries(fixture))
    if (key.startsWith(`${name}|`)) then[key] = hash;
  const keys = [...new Set([...Object.keys(then), ...Object.keys(now)])].sort();
  const differ = keys.filter((key) => then[key] !== now[key]);
  const missing = differ.filter((key) => now[key] === undefined).length;
  const extra = differ.filter((key) => then[key] === undefined).length;
  const shown = differ
    .slice(0, 10)
    .map(
      (key) =>
        `  ${key}\n    fixture ${then[key] ?? "(not in the fixture)"}\n    now     ${now[key] ?? "(not produced now)"}`,
    );
  expect(
    differ.length,
    `section ${name}: ${differ.length} of ${keys.length} keys differ from the fixture (${missing} no longer produced, ${extra} not in the fixture). The first ${shown.length}:\n${shown.join("\n")}`,
  ).toBe(0);
}

function writeNotes(): void {
  if (!NOTES_TO) return;
  const notes = Object.fromEntries(
    SECTIONS.flatMap((name) => (computed[name] ? [[name, notesOf(computed[name])]] : [])),
  );
  mkdirSync(dirname(NOTES_TO), { recursive: true });
  writeFileSync(NOTES_TO, `${JSON.stringify(notes, null, 1)}\n`, { encoding: "utf8" });
}

function finish(name: SectionName, result: Computed): void {
  computed[name] = result;
  // The notes are written as each section ends, so a section that fails does not take the others' notes with it.
  writeNotes();
  if (!PRINT_TO) expectSectionMatches(name, result.hashes);
}

function notesOf(result: Computed) {
  const tagCounts: Record<string, number> = {};
  for (const tags of Object.values(result.tags))
    for (const tag of tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  const sorted = Object.fromEntries(Object.entries(tagCounts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    entries: Object.keys(result.hashes).length,
    distinct: new Set(Object.values(result.hashes)).size,
    tags: sorted,
    samples: result.samples,
    keys: result.tags,
    hashes: result.hashes,
    ...(Object.keys(result.extras).length ? { extras: result.extras } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tables: canvases, project shapes, option sets (all fresh objects each time, built by functions)
// ---------------------------------------------------------------------------------------------------------------------

interface Canvas {
  w: number;
  h: number;
  fps: number;
}
const CANVASES: readonly Canvas[] = [
  { w: 1920, h: 1080, fps: 30 },
  { w: 1080, h: 1920, fps: 30 },
  { w: 3840, h: 2160, fps: 30 },
  { w: 3840, h: 2160, fps: 60 },
  { w: 1366, h: 768, fps: 30 },
  { w: 1280, h: 720, fps: 60 },
  { w: 854, h: 480, fps: 24 },
  { w: 2560, h: 1440, fps: 50 },
  { w: 640, h: 360, fps: 25 },
  { w: 1001, h: 563, fps: 30 },
  { w: 1081, h: 1921, fps: 30 },
  { w: 7680, h: 4320, fps: 30 },
];
const canvasId = (c: Canvas): string => `${c.w}x${c.h}@${c.fps}`;
const canvasOf = (c: Canvas) => ({ width: c.w, height: c.h, fps: c.fps });
const [HD30, VERTICAL30, UHD30, UHD60] = CANVASES;

type Shape =
  | "av"
  | "dense"
  | "overlay"
  | "text"
  | "kenburns"
  | "stills"
  | "many"
  | "big2"
  | "longargs"
  | "minutes";
const SHAPES: readonly Shape[] = [
  "av",
  "dense",
  "overlay",
  "text",
  "kenburns",
  "stills",
  "many",
  "big2",
  "longargs",
  "minutes",
];
/** The 8K canvas is built only with the shapes that stay cheap. */
const CHEAP_FOR_8K: readonly Shape[] = ["av", "dense", "overlay", "kenburns", "big2"];

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

/** The golden's dense timeline (golden.export.test.ts): rotation, opacity, crop, fades and both forms of volume, in frames. */
function denseTimeline(c: Canvas): Timeline {
  return {
    units: "frames",
    canvas: canvasOf(c),
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c1",
            kind: "video",
            media_ref: "/a.mp4",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            opacity: 0.8,
            rotate: 12,
            fade: { in: 6, out: 9 },
            transform: { position: { x: 0.4, y: 0.6 }, scale_x: 0.5, scale_y: 0.5 },
          },
          {
            id: "c2",
            kind: "video",
            media_ref: "/b.png",
            timeline_in: 60,
            timeline_out: 120,
            crop: { left: 0.1, right: 0.05, top: 0, bottom: 0 },
            opacity: [
              { t: 0, v: 0 },
              { t: 30, v: 1 },
            ],
            rotate: [
              { t: 0, v: 0 },
              { t: 30, v: 45 },
            ],
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "a-const",
            kind: "audio",
            media_ref: "/m.mp3",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            volume: 0.5,
            fade: { in: 3, out: 4 },
          },
          {
            id: "a-kf",
            kind: "audio",
            media_ref: "/n.mp3",
            timeline_in: 60,
            timeline_out: 150,
            source_in: 0,
            source_out: 90,
            volume: [
              { t: 0, v: 1 },
              { t: 45, v: 0.2 },
              { t: 90, v: 0.9 },
            ],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

/** A project of one of the ten shapes on a canvas, in seconds. A new object every call: the builder is not promised to leave its input alone. */
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
    case "dense":
      return denseTimeline(c);
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
    case "many":
      return {
        canvas,
        tracks: [
          vtrack(
            "v0",
            0,
            Array.from({ length: 33 }, (_v, i) =>
              vclip(`m${i}`, `/s${i}.mp4`, i * 0.5, (i + 1) * 0.5),
            ),
          ),
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
    case "longargs":
      // Twenty-eight sources (under the 32 that send an export to the streamed engine) whose paths are so long that the command, with
      // its graph already moved to a file, is over the command budget: the third way the planner leaves the single pass.
      return {
        canvas,
        tracks: [
          vtrack(
            "v0",
            0,
            Array.from({ length: 28 }, (_v, i) =>
              vclip(
                `l${i}`,
                `/media/${"deep-folder-name/".repeat(62)}clip-${i}.mp4`,
                i * 0.5,
                (i + 1) * 0.5,
              ),
            ),
          ),
        ],
      } as Timeline;
    case "minutes":
      // Over two minutes with sound: the streamed engine cuts it into parts of at most a minute and carries the sound as one mix.
      return {
        canvas,
        tracks: [
          vtrack("v1", 0, [vclip("c1", "/a.mp4", 0, 130)]),
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
                source_out: 130,
                timeline_in: 0,
                timeline_out: 130,
              },
            ],
          },
        ],
      } as Timeline;
  }
}

/** A small real project for the encoder choice: `layers` full-length clips of `secs` seconds on the canvas. */
function projectOf(c: Canvas, secs: number, layers: number): Timeline {
  return {
    canvas: canvasOf(c),
    tracks: Array.from({ length: layers }, (_v, z) =>
      vtrack(`v${z}`, z, [vclip(`p${z}`, `/p${z}.mp4`, 0, secs)]),
    ),
  } as Timeline;
}

/** A seeded generator (mulberry32): the same numbers on every machine. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)];
const fpsLabel = (fps: number | undefined): string => (fps === undefined ? "-" : String(fps));
const bit = (on: boolean): string => (on ? "1" : "0");

// ---- Section A: the command builder ----------------------------------------------------------------------------------

type LeanId = "-" | "plain" | "on" | "probed" | "mixed";
type BrandId = "-" | "wm" | "card" | "wmcard";
type ChoiceId = "-" | "amd" | "x264";

interface AOpt {
  res?: ExportResolution;
  q?: ExportQuality;
  fps?: number;
  eng?: ExportEngine;
  mode?: ExportMode;
  chip?: ChipMaker;
  faster?: true;
  rung?: Rung;
  lean: LeanId;
  brand: BrandId;
  choice: ChoiceId;
  preset?: string;
  max?: number;
  range?: readonly [number, number];
  qa?: 180;
}
interface ARow {
  key: string;
  canvas: Canvas;
  shape: Shape;
  opt: AOpt;
}

const RES_ALL: readonly (ExportResolution | undefined)[] = [
  undefined,
  "source",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
];
const Q_ALL: readonly (ExportQuality | undefined)[] = [undefined, "high", "medium", "low"];
const FPS_ALL: readonly (number | undefined)[] = [
  undefined,
  24,
  25,
  30,
  50,
  60,
  120,
  0,
  -5,
  29.97,
  NaN,
];
const ENG_ALL: readonly (ExportEngine | undefined)[] = [
  undefined,
  "file-sequence-v1",
  "partition-pipes-v1",
  "auto",
];
const MODE_ALL: readonly (ExportMode | undefined)[] = [undefined, "quality", "fast"];
const CHIP_ALL: readonly (ChipMaker | undefined)[] = [undefined, "amd", "nvidia", "intel"];
const FASTER_ALL: readonly (true | undefined)[] = [undefined, true];
const RUNG_ALL: readonly (Rung | undefined)[] = [undefined, 0, 1, 2];
const LEAN_ALL: readonly LeanId[] = ["-", "plain", "on", "probed", "mixed"];
const BRAND_ALL: readonly BrandId[] = ["-", "wm", "card", "wmcard"];

const ALL_LEAN = { zoom: true, fades: true, dip: true, stills: true, grade: true, decoders: true };
function leanOf(id: LeanId): LeanOptions | undefined {
  switch (id) {
    case "-":
      return undefined;
    case "plain":
      return { plain: true };
    case "on":
      return { ...ALL_LEAN };
    case "mixed":
      return { zoom: false, fades: true, dip: false, stills: true, grade: false, decoders: true };
    case "probed":
      return { ...ALL_LEAN, requests: [] };
  }
}
const BRANDS: Record<Exclude<BrandId, "-">, () => Branding> = {
  wm: () => ({ watermark: "/brand/watermark-16x9.png", endcard: null, endcardDuration: 0 }),
  card: () => ({ watermark: null, endcard: "/brand/endcard-16x9.mp4", endcardDuration: 2.5 }),
  wmcard: () => ({
    watermark: "/brand/watermark-16x9.png",
    endcard: "/brand/endcard-16x9.mp4",
    endcardDuration: 2.5,
  }),
};
// Cast, not annotated: the inputs of this guard are frozen, so a field a later change adds to one of these types must not force a change here.
const CHOICES: Record<Exclude<ChoiceId, "-">, () => ChoiceFacts> = {
  amd: () =>
    ({
      encoder: "amd",
      chip: "amd",
      reason: "person",
      shown: "fast",
      fullSeconds: 600,
      fastSeconds: 200,
      tests: [{ maker: "amd", sizeClass: "hd", result: "passed", ms: 1800, ssimMilli: 870 }],
      adapter: { maker: "amd", device: "15bf", driver: "32.0.1" },
    }) as ChoiceFacts,
  x264: () => ({ encoder: "x264", reason: "none", tests: [] }) as ChoiceFacts,
};

function aKey(canvas: Canvas, shape: Shape, o: AOpt): string {
  const axes = [
    `res=${o.res ?? "-"}`,
    `q=${o.q ?? "-"}`,
    `fps=${fpsLabel(o.fps)}`,
    `eng=${o.eng ?? "-"}`,
    `mode=${o.mode ?? "-"}`,
    `chip=${o.chip ?? "-"}`,
    `faster=${o.faster ? "1" : "-"}`,
    `rung=${o.rung ?? "-"}`,
    `lean=${o.lean}`,
    `brand=${o.brand}`,
  ];
  if (o.choice !== "-") axes.push(`choice=${o.choice}`);
  if (o.preset) axes.push(`preset=${o.preset}`);
  if (o.max !== undefined) axes.push(`max=${o.max}`);
  if (o.range) axes.push(`range=${o.range[0]}-${o.range[1]}`);
  if (o.qa) axes.push(`qa=${o.qa}`);
  return `A|${canvasId(canvas)}|${shape}|${axes.join(",")}`;
}

/** The options of a row, except `lean` (which is a fresh object per build, see `buildA`). */
function optionsOf(o: AOpt): ExportOptions {
  return {
    ...(o.eng !== undefined ? { engine: o.eng } : {}),
    ...(o.mode !== undefined ? { mode: o.mode } : {}),
    ...(o.chip !== undefined ? { chip: o.chip } : {}),
    ...(o.faster ? { faster: true } : {}),
    ...(o.choice !== "-" ? { choice: CHOICES[o.choice]() } : {}),
    ...(o.rung !== undefined ? { rung: o.rung } : {}),
    ...(o.res !== undefined ? { resolution: o.res } : {}),
    ...(o.q !== undefined ? { quality: o.q } : {}),
    ...(o.fps !== undefined ? { fps: o.fps } : {}),
    ...(o.brand !== "-" ? { branding: BRANDS[o.brand]() } : {}),
    ...(o.preset ? { preset: o.preset } : {}),
    ...(o.max !== undefined ? { maxDurationSec: o.max } : {}),
    ...(o.range ? { range: { from: o.range[0], to: o.range[1] } } : {}),
    ...(o.qa ? { __qaPieceSpanSeconds: o.qa } : {}),
  };
}

/** What ffmpeg would have answered about a zooming picture: invented, fixed numbers that make the lean paths that need an answer run. */
function pretendProbe(c: Canvas): LeanProbed {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  const cover = Math.max((c.w * 1.3) / 4000, (c.h * 1.3) / 3000);
  return { fmt: "yuv420p", source: [4000, 3000], scaled: [even(4000 * cover), even(3000 * cover)] };
}

function buildA(row: ARow): RenderPlan {
  const make = (lean: LeanOptions | undefined): RenderPlan =>
    buildRenderCommand(timelineOf(row.shape, row.canvas), "/out.mp4", {
      ...optionsOf(row.opt),
      ...(lean ? { lean } : {}),
    });
  const asked = leanOf(row.opt.lean);
  const first = make(asked);
  // What the async boundary of an export does: answer what the first build asked of ffmpeg, then build again.
  const requests = asked?.requests ?? [];
  if (row.opt.lean !== "probed" || requests.length === 0) return first;
  const probed = new Map<string, LeanProbed>(
    requests.map((r) => [r.key, pretendProbe(row.canvas)]),
  );
  return make({ ...ALL_LEAN, probed });
}

function tagsOfPlan(plan: RenderPlan): string[] {
  const tags = [`backend:${plan.selection?.backend}`, `reason:${plan.selection?.reason}`];
  tags.push(`encoder:${plan.encoder}`);
  if (plan.steps?.length) tags.push("steps");
  if (plan.assFiles.length) tags.push("ass-files");
  if (plan.fonts.length) tags.push("fonts");
  if (plan.stillImages.length) tags.push("still-images");
  if (plan.lean?.ran.length) tags.push(`lean-ran:${plan.lean.ran.join("+")}`);
  if (plan.lean?.kept.length) tags.push(`lean-kept:${plan.lean.kept.join("+")}`);
  if (plan.audioMustSpanVideo) tags.push("end-card");
  if (plan.warnings.length) tags.push("warnings");
  if (plan.rung) tags.push(`rung:${plan.rung}`);
  if (plan.choice) tags.push("choice");
  return tags;
}

function runA(row: ARow): Digest {
  try {
    const plan = buildA(row);
    return digest(plan, tagsOfPlan(plan));
  } catch (error) {
    // A refusal is behaviour too: its message is what is pinned.
    return digest({ threw: error instanceof Error ? error.message : String(error) }, ["threw"]);
  }
}

const baseA = (): AOpt => ({ lean: "-", brand: "-", choice: "-" });
const withBase = (part: Partial<AOpt>): AOpt => ({ ...baseA(), ...part });

/** One change at a time from the baseline (nothing set). */
const A_VARIANTS: readonly AOpt[] = [
  ...RES_ALL.filter((v) => v !== undefined).map((res) => withBase({ res })),
  ...Q_ALL.filter((v) => v !== undefined).map((q) => withBase({ q })),
  ...FPS_ALL.filter((v) => v !== undefined).map((fps) => withBase({ fps })),
  ...ENG_ALL.filter((v) => v !== undefined).map((eng) => withBase({ eng })),
  ...MODE_ALL.filter((v) => v !== undefined).map((mode) => withBase({ mode })),
  ...CHIP_ALL.filter((v) => v !== undefined).map((chip) => withBase({ chip })),
  withBase({ faster: true }),
  ...RUNG_ALL.filter((v) => v !== undefined).map((rung) => withBase({ rung })),
  ...LEAN_ALL.filter((v) => v !== "-").map((lean) => withBase({ lean })),
  ...BRAND_ALL.filter((v) => v !== "-").map((brand) => withBase({ brand })),
  withBase({ choice: "amd" }),
  withBase({ choice: "x264" }),
  withBase({ preset: "ultrafast" }),
  withBase({ preset: "slow" }),
  withBase({ max: 1.5 }),
  withBase({ max: 0.5 }),
  withBase({ range: [15, 45] }),
  withBase({ range: [0, 30] }),
  withBase({ qa: 180 }),
];

function aRows(): ARow[] {
  const rows = new Map<string, ARow>();
  const add = (canvas: Canvas, shape: Shape, opt: AOpt): void => {
    const key = aKey(canvas, shape, opt);
    if (!rows.has(key)) rows.set(key, { key, canvas, shape, opt });
  };
  const combos: { canvas: Canvas; shape: Shape }[] = [];
  for (const canvas of CANVASES)
    for (const shape of SHAPES)
      if (canvas.w < 7680 || CHEAP_FOR_8K.includes(shape)) combos.push({ canvas, shape });

  // A1: every canvas and shape with the baseline and a window of the one-change variants (the windows rotate, so every variant is on many).
  combos.forEach(({ canvas, shape }, index) => {
    add(canvas, shape, baseA());
    const start = (index * 17) % A_VARIANTS.length;
    for (let step = 0; step < 14; step++)
      add(canvas, shape, A_VARIANTS[(start + step) % A_VARIANTS.length]);
  });

  // A2: resolution x quality x frame rate in full, on three projects (so every pair of the three axes is there).
  for (const [canvas, shape] of [
    [HD30, "dense"],
    [UHD60, "big2"],
    [VERTICAL30, "av"],
  ] as const)
    for (const res of RES_ALL)
      for (const q of Q_ALL)
        for (const fps of FPS_ALL) add(canvas, shape, withBase({ res, q, fps }));

  // A3: engine x mode x chip x faster in full, on three projects (every legal and illegal-looking pairing).
  for (const [canvas, shape] of [
    [HD30, "dense"],
    [UHD30, "big2"],
    [VERTICAL30, "text"],
  ] as const)
    for (const eng of ENG_ALL)
      for (const mode of MODE_ALL)
        for (const chip of CHIP_ALL)
          for (const faster of FASTER_ALL)
            add(canvas, shape, withBase({ eng, mode, chip, faster }));

  // A5: the QA piece-span knob, which only a streamed export of a project over a minute can show (the 130 second project cuts into
  // parts of a minute by default and of three minutes with the knob), crossed with the engine that streams.
  for (const canvas of CANVASES)
    if (canvas.w < 7680)
      for (const shape of ["minutes", "many"] as const)
        for (const eng of ["partition-pipes-v1", "auto"] as const)
          for (const qa of [undefined, 180] as const) add(canvas, shape, withBase({ eng, qa }));

  // A4: a seeded sample of everything crossed with everything.
  const rand = prng(SEED);
  for (let n = 0; n < 500; n++) {
    const { canvas, shape } = pick(rand, combos);
    add(canvas, shape, {
      res: pick(rand, RES_ALL),
      q: pick(rand, Q_ALL),
      fps: pick(rand, FPS_ALL),
      eng: pick(rand, ENG_ALL),
      mode: pick(rand, MODE_ALL),
      chip: pick(rand, CHIP_ALL),
      faster: pick(rand, FASTER_ALL),
      rung: pick(rand, RUNG_ALL),
      lean: pick(rand, LEAN_ALL),
      brand: pick(rand, BRAND_ALL),
      choice: rand() < 0.15 ? pick(rand, ["amd", "x264"] as const) : "-",
      preset: rand() < 0.1 ? pick(rand, ["ultrafast", "slow"]) : undefined,
      max: rand() < 0.1 ? pick(rand, [0.5, 1.5]) : undefined,
      range:
        rand() < 0.1
          ? pick(rand, [
              [15, 45],
              [0, 30],
            ] as const)
          : undefined,
      qa: rand() < 0.05 ? 180 : undefined,
    });
  }
  return [...rows.values()];
}

// ---- Sections B and D: the encoder choice ----------------------------------------------------------------------------

type Who = "menu" | "chat" | "mcp";
type ChipsId =
  "none" | "amd" | "nvidia" | "intel" | "all" | "amd-found" | "amd-real" | "amd-failed";
type HistoryId = "none" | "fastpc" | "slowpc" | "veryslow" | "slowchip" | "chipworse";
interface Flags {
  cd: boolean;
  fx: boolean;
  amd: boolean;
  nv: boolean;
  intel: boolean;
}
interface BOpt {
  canvas: Canvas;
  secs: number;
  layers: number;
  request: ModeRequest;
  kind: "deliverable" | "working";
  res?: ExportResolution;
  q?: ExportQuality;
  fps?: number;
  range?: readonly [number, number];
  max?: number;
  flags: Flags;
  chips: ChipsId;
  history: HistoryId;
  who: Who;
  row: boolean | null;
}
interface BRow {
  key: string;
  opt: BOpt;
}

const FLAG_NAMES: Record<keyof Flags, ExportFlagName> = {
  cd: "chip_default",
  fx: "faster_x264",
  amd: "chip_amd",
  nv: "chip_nvidia",
  intel: "chip_intel",
};
const ALL_ON: Flags = { cd: true, fx: true, amd: true, nv: true, intel: true };
const ALL_OFF: Flags = { cd: false, fx: false, amd: false, nv: false, intel: false };
const FLAG_SETS: readonly Flags[] = Array.from({ length: 32 }, (_v, n) => ({
  cd: (n & 1) === 0,
  fx: (n & 2) === 0,
  amd: (n & 4) === 0,
  nv: (n & 8) === 0,
  intel: (n & 16) === 0,
}));
const CHIPS_ALL: readonly ChipsId[] = [
  "none",
  "amd",
  "nvidia",
  "intel",
  "all",
  "amd-found",
  "amd-real",
  "amd-failed",
];
const HISTORY_ALL: readonly HistoryId[] = [
  "none",
  "fastpc",
  "slowpc",
  "veryslow",
  "slowchip",
  "chipworse",
];
const WHO_ALL: readonly Who[] = ["menu", "chat", "mcp"];
const ROW_ALL: readonly (boolean | null)[] = [null, true, false];
const SECS_ALL: readonly number[] = [20, 90, 900, 7200];
const REQUEST_ALL: readonly ModeRequest[] = ["auto", "full", "fast"];
/** The grid of the person's choices: every resolution, and fewer qualities and rates than section A (the rest are in the one-change rows). */
const B_RES = RES_ALL;
const B_QUALITY: readonly (ExportQuality | undefined)[] = [undefined, "high", "low"];
const B_FPS: readonly (number | undefined)[] = [undefined, 24, 60, 120, 0];

function bKey(prefix: "B" | "D", o: BOpt): string {
  const f = o.flags;
  const settings = [`res=${o.res ?? "-"}`, `q=${o.q ?? "-"}`, `fps=${fpsLabel(o.fps)}`];
  if (o.range) settings.push(`range=${o.range[0]}-${o.range[1]}`);
  if (o.max !== undefined) settings.push(`max=${o.max}`);
  return [
    prefix,
    canvasId(o.canvas),
    `${o.secs}s`,
    `L${o.layers}`,
    `req=${o.request},kind=${o.kind}`,
    settings.join(","),
    `cd=${bit(f.cd)},fx=${bit(f.fx)},amd=${bit(f.amd)},nv=${bit(f.nv)},in=${bit(f.intel)}`,
    `chips=${o.chips}`,
    `hist=${o.history}`,
    `who=${o.who},row=${o.row === null ? "-" : bit(o.row)}`,
  ].join("|");
}

const BASE_B: BOpt = {
  canvas: HD30,
  secs: 90,
  layers: 1,
  request: "auto",
  kind: "deliverable",
  flags: ALL_ON,
  chips: "amd",
  history: "none",
  who: "menu",
  row: null,
};
/** A project this PC has measured to take three times its length on the processor, and its length on a chip. */
const RICH_B: BOpt = { ...BASE_B, secs: 900, history: "slowchip" };
/** The same measurement with no chip: the faster setting's case. */
const NOCHIP_B: BOpt = { ...BASE_B, secs: 900, history: "slowpc", chips: "none" };

function bVariants(base: BOpt): BOpt[] {
  const out: BOpt[] = [];
  for (const canvas of CANVASES) out.push({ ...base, canvas });
  for (const secs of SECS_ALL) out.push({ ...base, secs });
  out.push({ ...base, layers: 6 });
  for (const request of REQUEST_ALL) out.push({ ...base, request });
  out.push({ ...base, kind: "working" });
  for (const res of RES_ALL) out.push({ ...base, res });
  for (const q of Q_ALL) out.push({ ...base, q });
  for (const fps of FPS_ALL) out.push({ ...base, fps });
  out.push({ ...base, range: [0, 1800] }, { ...base, max: 30 });
  for (const key of Object.keys(FLAG_NAMES) as (keyof Flags)[])
    out.push({ ...base, flags: { ...ALL_ON, [key]: false } });
  out.push({ ...base, flags: ALL_OFF });
  for (const chips of CHIPS_ALL) out.push({ ...base, chips });
  for (const history of HISTORY_ALL) out.push({ ...base, history });
  for (const who of WHO_ALL) out.push({ ...base, who });
  for (const row of ROW_ALL) out.push({ ...base, row });
  return out;
}

/** Every canvas at each length with one layer, and a stack of six layers on every canvas: the promise lines and the over-a-minute rule. */
function workloads(): { canvas: Canvas; secs: number; layers: number }[] {
  const out: { canvas: Canvas; secs: number; layers: number }[] = [];
  for (const canvas of CANVASES) for (const secs of SECS_ALL) out.push({ canvas, secs, layers: 1 });
  for (const canvas of CANVASES) out.push({ canvas, secs: 900, layers: 6 });
  return out;
}

/** The rows of section B (requests auto, full and fast) or of section D (the request "quick"). */
function bRows(section: "B" | "D"): BRow[] {
  const rows = new Map<string, BRow>();
  const quick = section === "D";
  const add = (opt: BOpt): void => {
    const o = quick ? { ...opt, request: "quick" as const } : opt;
    const key = bKey(section, o);
    if (!rows.has(key)) rows.set(key, { key, opt: o });
  };
  const requests: readonly ModeRequest[] = quick ? ["quick"] : REQUEST_ALL;
  const settingsGrid = (base: BOpt, asked: readonly ModeRequest[] = requests): void => {
    for (const res of B_RES)
      for (const q of B_QUALITY)
        for (const fps of B_FPS)
          for (const request of asked) add({ ...base, request, res, q, fps });
  };
  /** The settings grid on a 1080p and a 4K project in full, and on three more (a 4K project at 60 frames, a 1440p one, an 8K one)
   *  for one request: a setting that shrinks the picture can bring it inside a chip's limits, and one that does not shrink it changes nothing. */
  const settings = (): void => {
    settingsGrid(RICH_B);
    settingsGrid({ ...RICH_B, canvas: UHD30 });
    for (const canvas of [UHD60, CANVASES[7], CANVASES[11]])
      settingsGrid({ ...RICH_B, canvas }, [quick ? "quick" : "auto"]);
  };

  if (!quick) {
    // B1: one change at a time from three bases.
    for (const base of [BASE_B, RICH_B, NOCHIP_B]) for (const opt of bVariants(base)) add(opt);
    // B2: every state of the five switches with every chip situation and every request, where the choice is richest.
    for (const flags of FLAG_SETS)
      for (const chips of CHIPS_ALL)
        for (const request of REQUEST_ALL) add({ ...RICH_B, flags, chips, request });
    for (const flags of FLAG_SETS)
      for (const request of REQUEST_ALL) add({ ...NOCHIP_B, flags, request });
    // B3: every project at every length with every kind of measurement and every request.
    for (const { canvas, secs, layers } of workloads())
      for (const history of HISTORY_ALL)
        for (const request of REQUEST_ALL)
          add({ ...BASE_B, canvas, secs, layers, history, request });
    // B4: the person's settings.
    settings();
    // B5: who asked, what the dialog showed, which request, what kind of render.
    for (const who of WHO_ALL)
      for (const row of ROW_ALL)
        for (const request of REQUEST_ALL)
          for (const kind of ["deliverable", "working"] as const)
            add({ ...RICH_B, who, row, request, kind });
  } else {
    // D1: one change at a time from three bases (the request is quick in every one).
    for (const base of [BASE_B, RICH_B, NOCHIP_B]) for (const opt of bVariants(base)) add(opt);
    // D2 and D3: every state of the switches with every chip situation.
    for (const flags of FLAG_SETS) for (const chips of CHIPS_ALL) add({ ...RICH_B, flags, chips });
    for (const flags of FLAG_SETS)
      for (const chips of ["none", "amd"] as const) add({ ...BASE_B, flags, chips });
    // D4: every project and length, with no chip, an AMD chip and all three.
    for (const { canvas, secs, layers } of workloads())
      for (const chips of ["none", "amd", "all"] as const)
        add({ ...BASE_B, canvas, secs, layers, chips });
    // D5: who asked and what the dialog showed.
    for (const who of WHO_ALL)
      for (const row of ROW_ALL)
        for (const kind of ["deliverable", "working"] as const)
          for (const chips of ["none", "amd"] as const) add({ ...RICH_B, who, row, kind, chips });
    // D6: the person's settings.
    settings();
    // D7: every kind of measurement, with and without a chip.
    for (const history of HISTORY_ALL)
      for (const chips of ["none", "amd"] as const) add({ ...NOCHIP_B, history, chips });
  }

  // The seeded sample of everything crossed with everything.
  const rand = prng(quick ? SEED + 1 : SEED + 2);
  const sample = workloads();
  for (let n = 0; n < (quick ? 100 : 300); n++) {
    const { canvas, secs, layers } = pick(rand, sample);
    add({
      canvas,
      secs,
      layers,
      request: pick(rand, requests),
      kind: rand() < 0.85 ? "deliverable" : "working",
      res: pick(rand, RES_ALL),
      q: pick(rand, Q_ALL),
      fps: pick(rand, FPS_ALL),
      flags: pick(rand, FLAG_SETS),
      chips: pick(rand, CHIPS_ALL),
      history: pick(rand, HISTORY_ALL),
      who: pick(rand, WHO_ALL),
      row: pick(rand, ROW_ALL),
    });
  }
  return [...rows.values()];
}

// What this PC has measured, built from plain numbers (not from the code under test): each sample is a 60 second export of the
// project's size, so a longer project scales it.
function sampleOf(
  c: Canvas,
  layers: number,
  engine: ExportEngine,
  encoder: ExportEncoder,
  ratio: number,
): ExportCalibration {
  return {
    workload: {
      width: c.w,
      height: c.h,
      fps: c.fps,
      durationSeconds: 60,
      visualClips: layers,
      captionClips: 0,
      audioClips: 0,
      peakVisualLayers: layers,
      peakMediaLayers: layers,
    },
    output: { width: c.w, height: c.h, fps: c.fps },
    quality: "medium",
    engine,
    encoder,
    // The speed revision of 0.28.0: a measurement of another revision speaks for nothing.
    revision: 2,
    elapsedSeconds: 60 * ratio,
    finalBytes: 50_000_000,
    memoryBytes: 1_000_000_000,
    temporaryBytes: 0,
  } as ExportCalibration;
}
const RATIOS: Record<HistoryId, { cpu?: number; chip?: number }> = {
  none: {},
  fastpc: { cpu: 0.3 },
  slowpc: { cpu: 3 },
  veryslow: { cpu: 8 },
  slowchip: { cpu: 3, chip: 1 },
  chipworse: { cpu: 1, chip: 1 },
};
function calibrationsOf(history: HistoryId, c: Canvas, layers: number): ExportCalibration[] {
  const { cpu, chip } = RATIOS[history];
  const out: ExportCalibration[] = [];
  for (const engine of ["file-sequence-v1", "partition-pipes-v1"] as const) {
    if (cpu !== undefined)
      for (const encoder of ["x264-crf", "x264-crf-threads2"] as const)
        out.push(sampleOf(c, layers, engine, encoder, cpu));
    if (chip !== undefined)
      for (const encoder of ["chip-amd", "chip-nvidia", "chip-intel"] as const)
        out.push(sampleOf(c, layers, engine, encoder, chip));
  }
  return out;
}

// The chip lookup the decision makes, answered by the test: which makers this PC has, and what the lookup would tell the export.
const MAKER_FLAG: Record<ChipMaker, ExportFlagName> = {
  amd: "chip_amd",
  nvidia: "chip_nvidia",
  intel: "chip_intel",
};
const PRESENT: Record<ChipsId, readonly ChipMaker[]> = {
  none: [],
  amd: ["amd"],
  nvidia: ["nvidia"],
  intel: ["intel"],
  all: ["amd", "nvidia", "intel"],
  "amd-found": ["amd"],
  "amd-real": ["amd"],
  "amd-failed": [],
};
let chipsNow: ChipsId = "none";
let lookupLog: [string, boolean][] = [];

const verdictOf = (maker: ChipMaker, sizeClass: SizeClass) =>
  ({
    maker,
    adapter: { maker, device: `device-${maker}`, driver: "1.0" },
    sizeClass,
    ok: true,
    result: "passed",
    ssimMilli: 870,
    ms: 1800,
  }) as ChipVerdict;
const eventOf = (
  maker: ChipMaker,
  sizeClass: SizeClass,
  result: ChipTestEvent["result"] = "passed",
  ms = 1800,
) => ({ maker, sizeClass, result, ms, ssimMilli: result === "passed" ? 870 : 0 }) as ChipTestEvent;

chipFake.lookup = async (sizeClass, options): Promise<ChipLookup> => {
  const size = sizeClass as SizeClass;
  lookupLog.push([size, options.allowRun]);
  if (chipsNow === "amd-failed")
    return { chip: null, events: [eventOf("amd", size, "encode_failed", 900)] };
  // The real lookup skips a maker whose switch is off, and takes the first of the rest in order of preference.
  const maker = CHIP_PREFERENCE.find(
    (candidate) => PRESENT[chipsNow].includes(candidate) && exportFlag(MAKER_FLAG[candidate]),
  );
  if (!maker) return { chip: null, events: [] };
  return {
    chip: verdictOf(maker, size),
    events: chipsNow === "amd-found" ? [eventOf(maker, size)] : [],
  };
};
chipFake.take = () => (chipsNow === "amd-real" ? [eventOf("amd", "hd", "passed", 2100)] : []);

const CONTEXTS: Record<Who, () => ClientToolContext> = {
  menu: () => ({ surface: "app" }) as unknown as ClientToolContext,
  chat: () =>
    ({
      surface: "app",
      origin: { chatSessionId: "c", branchId: 0, executionId: 1 },
    }) as unknown as ClientToolContext,
  mcp: () => ({ surface: "mcp" }) as unknown as ClientToolContext,
};

function applyFlags(flags: Flags): void {
  for (const key of Object.keys(FLAG_NAMES) as (keyof Flags)[])
    __setExportFlag(FLAG_NAMES[key], flags[key]);
}

async function runB(row: BRow): Promise<Digest> {
  const o = row.opt;
  applyFlags(o.flags);
  chipsNow = o.chips;
  lookupLog = [];
  useExportJob.setState({
    calibrations: calibrationsOf(o.history, o.canvas, o.layers),
    modeRowOnScreen: o.row,
  });
  const options: ExportOptions = {
    ...(o.res !== undefined ? { resolution: o.res } : {}),
    ...(o.q !== undefined ? { quality: o.q } : {}),
    ...(o.fps !== undefined ? { fps: o.fps } : {}),
    ...(o.range ? { range: { from: o.range[0], to: o.range[1] } } : {}),
    ...(o.max !== undefined ? { maxDurationSec: o.max } : {}),
  };
  let out: unknown;
  try {
    out = await encoderOptions(
      CONTEXTS[o.who](),
      { seconds: projectOf(o.canvas, o.secs, o.layers), request: o.request },
      options,
      o.kind,
    );
  } catch (error) {
    out = { threw: error instanceof Error ? error.message : String(error) };
  }
  const answer = out as Any;
  const tags = [`who:${o.who}`, `lookups:${lookupLog.length}`];
  if (answer?.threw !== undefined) tags.push("threw");
  if (answer?.choice) {
    tags.push(`encoder:${answer.choice.encoder}`, `reason:${answer.choice.reason}`);
    if (answer.choice.shown) tags.push(`shown:${answer.choice.shown}`);
    if (answer.choice.tests?.length) tags.push("tests");
  } else tags.push("no-choice");
  if (answer?.mode) tags.push(`mode:${answer.mode}`);
  if (answer?.chip) tags.push(`chip:${answer.chip}`);
  if (answer?.faster) tags.push("faster");
  // The answer and the chip lookups made for it: a chip tested for a request that did not ask for one is a change too.
  return digest({ out, lookups: lookupLog }, tags);
}

async function computeB(section: "B" | "D", rows: BRow[]): Promise<Computed> {
  const result = emptyComputed();
  for (const row of rows) collect(result, row.key, await runB(row));
  expect(Object.keys(result.hashes)).toHaveLength(rows.length);
  expect(section === "D" || rows.every((row) => row.opt.request !== "quick")).toBe(true);
  return result;
}

// ---- Section C: the real export tool ---------------------------------------------------------------------------------

type Caller = "menu" | "menu-quality" | "menu-fast" | "chat" | "mcp";
const CALLERS: readonly Caller[] = ["menu", "menu-quality", "menu-fast", "chat", "mcp"];
const C_ARGS = {
  none: {},
  r720: { resolution: "720p" },
  "r1080-f30-qlow": { resolution: "1080p", fps: 30, quality: "low" },
  f24: { fps: 24 },
  qhigh: { quality: "high" },
  r2160: { resolution: "2160p" },
  rsource: { resolution: "source" },
};
type CArgs = keyof typeof C_ARGS;
const C_ARGS_ALL = Object.keys(C_ARGS) as CArgs[];
const C_CANVASES: readonly Canvas[] = [HD30, VERTICAL30, UHD60, CANVASES[4], CANVASES[11]];
const C_ENGINES: readonly ExportEngine[] = ["file-sequence-v1", "partition-pipes-v1", "auto"];
interface COpt {
  canvas: Canvas;
  args: CArgs;
  caller: Caller;
  chip: "none" | "amd";
  engine: ExportEngine;
  history: "none" | "slow";
}
interface CRow {
  key: string;
  opt: COpt;
}
const cKey = (o: COpt): string =>
  `C|${canvasId(o.canvas)}|args=${o.args}|who=${o.caller}|chip=${o.chip}|eng=${o.engine}|hist=${o.history}`;

/** The whole product of the tool's axes: every call's arguments, from every door, with and without a chip and a long measurement, under
 *  every engine setting, on five canvases (the 8K one is where asking for 2160p changes the picture). */
function cRows(): CRow[] {
  const rows: CRow[] = [];
  for (const canvas of C_CANVASES)
    for (const args of C_ARGS_ALL)
      for (const caller of CALLERS)
        for (const chip of ["none", "amd"] as const)
          for (const engine of C_ENGINES)
            for (const history of ["none", "slow"] as const) {
              const opt: COpt = { canvas, args, caller, chip, engine, history };
              rows.push({ key: cKey(opt), opt });
            }
  return rows;
}

const ORIGIN: MutationOrigin = { chatSessionId: "c", branchId: 0, executionId: 1 };
function callerContext(
  base: ClientToolContext,
  signal: AbortSignal,
  caller: Caller,
): ClientToolContext {
  if (caller === "chat") return agentToolContext({ ...base, surface: "app" }, signal, ORIGIN);
  if (caller === "mcp") return agentToolContext({ ...base, surface: "mcp" }, signal);
  const exportMode: ExportMode | undefined =
    caller === "menu-quality" ? "quality" : caller === "menu-fast" ? "fast" : undefined;
  return {
    ...agentToolContext({ ...base, surface: "app" }, signal),
    ...(exportMode ? { exportMode } : {}),
  };
}

/** Every string in a value, changed by `change`; numbers, booleans and the shape stay as they are. */
function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        mapStrings(item, change),
      ]),
    );
  return value;
}

async function until(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 1000 && !done(); tick++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (!done()) throw new Error("the export was never handed to the app process");
}

async function runC(row: CRow): Promise<Digest> {
  const o = row.opt;
  const t = await setupExport();
  try {
    const set = await setCanvasTool(
      { width: o.canvas.w, height: o.canvas.h, fps: o.canvas.fps },
      { store: t.store, runner: t.nextPage().runner },
    );
    if (set.ok === false) throw new Error(`the canvas was not set: ${JSON.stringify(set)}`);
    chipsNow = o.chip === "amd" ? "amd-found" : "none";
    lookupLog = [];
    useExportJob.setState({
      calibrations: calibrationsOf(o.history === "slow" ? "slowchip" : "none", o.canvas, 1),
    });
    useExportJob.getState().setEngine(o.engine);
    const base: ClientToolContext = { store: t.store, runner: t.nextPage().runner };
    const ctx = callerContext(base, new AbortController().signal, o.caller);
    const reply = (await exportTool({ ...C_ARGS[o.args] }, ctx)) as Any;
    if (reply.ok !== false) await until(() => t.jobs.submitted.length > 0);
    const spec = t.jobs.submitted[0];
    const jobId = String(spec?.id ?? reply.job_id ?? "");
    const scrub = (value: unknown): unknown =>
      mapStrings(value, (text) => {
        const named = jobId ? text.split(jobId).join("JOB") : text;
        // The staging file's name carries a random part.
        return named.replace(/\.[a-z0-9]{1,6}\.partial/g, ".X.partial");
      });
    const plan = (spec?.meta.plan ?? {}) as Any;
    const telemetry = (spec?.meta.telemetry ?? {}) as Any;
    const record = {
      reply: scrub({ ...reply }),
      submitted: spec
        ? scrub({
            program: spec.program,
            lane: spec.lane,
            args: spec.args,
            steps: spec.steps,
            plan: {
              contractVersion: plan.contractVersion,
              selection: plan.selection,
              transport: plan.transport,
              duration: plan.duration,
              output: plan.output,
              frame: plan.frame,
              stepDurations: plan.stepDurations,
              audioMustSpanVideo: plan.audioMustSpanVideo,
              audioExpected: plan.audioExpected,
              warnings: plan.warnings,
              sources: (plan.sources ?? []).map((source: Any) => source.path),
            },
            telemetry: {
              duration_s: telemetry.duration_s,
              width: telemetry.width,
              height: telemetry.height,
              fps: telemetry.fps,
              quality: telemetry.quality,
              visual_layers: telemetry.visual_layers,
              project_width: telemetry.project_width,
              project_height: telemetry.project_height,
              calibration: telemetry.calibration,
              choice: telemetry.choice,
              rung: telemetry.plan?.rung,
              max_rung: telemetry.plan?.max_rung,
              ladder: telemetry.plan?.ladder,
              basis: telemetry.plan?.basis,
              lean: telemetry.plan?.lean,
            },
            startedBy: spec.meta.startedBy,
          })
        : null,
      lookups: lookupLog,
    };
    const tags = [reply.ok === false ? "refused" : "ok", spec ? "submitted" : "not-submitted"];
    if (telemetry.choice)
      tags.push(`encoder:${telemetry.choice.encoder}`, `reason:${telemetry.choice.reason}`);
    if (plan.selection) tags.push(`backend:${plan.selection.backend}`);
    if (spec?.steps?.length) tags.push("steps");
    // For the notes file only: the reply's own note, and the hash of the whole record but for that note, so a diff can say that the note's words are all that moved.
    const { note, ...replyBesidesNote } = reply;
    const besides = hashOf({ ...record, reply: scrub({ ...replyBesidesNote }) });
    return digest(record, tags, { note: typeof note === "string" ? note : null, besides });
  } finally {
    // End every job the case started, and leave nothing behind for the next one.
    for (const spec of t.jobs.submitted) cancelExport(spec.id);
    await Promise.all(t.jobs.submitted.map((spec) => whenExportEnds(spec.id)));
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    await resetTestDocuments();
    __resetExportQueue();
    __resetProjectJobs();
    __resetJobSupervisor();
    _resetAppCaches();
    __resetWorkGate();
    useExportJob.setState({ calibrations: [] });
    useExportJob.getState().setEngine("auto");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The tests (the sections take their own, long timeout: a section is thousands of builds, not one)
// ---------------------------------------------------------------------------------------------------------------------

describe("the stable text a hash is made of", () => {
  it("does not care about the order of keys, and cares about everything else", () => {
    expect(stable({ b: 1, a: { d: [1, 2], c: undefined, e: "x" } })).toBe(
      '{"a":{"d":[1,2],"e":"x"},"b":1}',
    );
    expect(hashOf({ x: 1, y: [1, 2, 3], z: { q: "a", p: "b" } })).toBe(
      hashOf({ z: { p: "b", q: "a" }, y: [1, 2, 3], x: 1 }),
    );
    expect(hashOf({ y: [1, 2, 3] })).not.toBe(hashOf({ y: [1, 2, 4] }));
    expect(hashOf([1, 2])).not.toBe(hashOf([2, 1]));
    expect(hashOf({ a: 1 })).toBe(createHash("sha256").update('{"a":1}', "utf8").digest("hex"));
    expect(hashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops what is undefined, and says NaN and the infinities as words, never as null", () => {
    expect(stable({ a: 1, b: undefined })).toBe(stable({ a: 1 }));
    expect(stable([NaN, Infinity, -Infinity])).toBe('["NaN","Infinity","-Infinity"]');
    expect(stable({ n: NaN })).not.toBe(stable({ n: null }));
    expect(stable({ n: 29.97, m: -5, z: 0 })).toBe('{"m":-5,"n":29.97,"z":0}');
  });

  it("refuses what JSON would lose without a word", () => {
    expect(() => stable({ m: new Map([[1, 2]]) })).toThrow(TypeError);
    expect(() => stable({ s: new Set([1]) })).toThrow(TypeError);
    expect(() => stable({ f: () => 1 })).toThrow(TypeError);
    expect(() => stable({ d: new Date(0) })).toThrow(TypeError);
  });

  it("makes the combined hash of the sorted lines, whatever order they were made in", () => {
    expect(combinedOf({ b: "2", a: "1" })).toBe(combinedOf({ a: "1", b: "2" }));
    expect(combinedOf({ a: "1", b: "2" })).toBe(sha256("a=1\nb=2"));
    expect(combinedOf({ a: "1", b: "2" })).not.toBe(combinedOf({ a: "1", b: "3" }));
  });
});

describe("the tables are as wide as the guard says", () => {
  it("section A has at least 2,000 entries, every canvas and shape, every axis value and every pair that matters", () => {
    const rows = aRows();
    expect(rows.length).toBeGreaterThanOrEqual(2000);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => canvasId(row.canvas)))).toEqual(
      new Set(CANVASES.map(canvasId)),
    );
    expect(new Set(rows.map((row) => row.shape))).toEqual(new Set(SHAPES));
    for (const row of rows) if (row.canvas.w === 7680) expect(CHEAP_FOR_8K).toContain(row.shape);
    const seen = (read: (o: AOpt) => unknown): Set<string> =>
      new Set(rows.map((row) => stable([read(row.opt)])));
    expect(seen((o) => o.res).size).toBe(RES_ALL.length);
    expect(seen((o) => o.q).size).toBe(Q_ALL.length);
    expect(seen((o) => o.fps).size).toBe(FPS_ALL.length);
    expect(seen((o) => o.eng).size).toBe(ENG_ALL.length);
    expect(seen((o) => o.mode).size).toBe(MODE_ALL.length);
    expect(seen((o) => o.chip).size).toBe(CHIP_ALL.length);
    expect(seen((o) => o.faster).size).toBe(FASTER_ALL.length);
    expect(seen((o) => o.rung).size).toBe(RUNG_ALL.length);
    expect(seen((o) => o.lean).size).toBe(LEAN_ALL.length);
    expect(seen((o) => o.brand).size).toBe(BRAND_ALL.length);
    expect(seen((o) => [o.res, o.q]).size).toBe(RES_ALL.length * Q_ALL.length);
    expect(seen((o) => [o.res, o.fps]).size).toBe(RES_ALL.length * FPS_ALL.length);
    expect(seen((o) => [o.eng, o.mode]).size).toBe(ENG_ALL.length * MODE_ALL.length);
    expect(seen((o) => [o.mode, o.chip, o.faster]).size).toBe(
      MODE_ALL.length * CHIP_ALL.length * FASTER_ALL.length,
    );
    for (const variant of A_VARIANTS) {
      const key = (o: AOpt) => stable({ ...o });
      expect(rows.filter((row) => key(row.opt) === key(variant)).length).toBeGreaterThanOrEqual(10);
    }
  });

  it("section B has at least 1,500 entries and never asks for quick; section D has at least 100 and only does", () => {
    const b = bRows("B");
    const d = bRows("D");
    expect(b.length).toBeGreaterThanOrEqual(1500);
    expect(d.length).toBeGreaterThanOrEqual(100);
    expect(new Set([...b, ...d].map((row) => row.key)).size).toBe(b.length + d.length);
    expect(new Set(b.map((row) => row.opt.request))).toEqual(new Set(["auto", "full", "fast"]));
    expect(new Set(d.map((row) => row.opt.request))).toEqual(new Set(["quick"]));
    for (const rows of [b, d]) {
      expect(new Set(rows.map((row) => canvasId(row.opt.canvas)))).toEqual(
        new Set(CANVASES.map(canvasId)),
      );
      expect(new Set(rows.map((row) => row.opt.secs))).toEqual(new Set(SECS_ALL));
      expect(new Set(rows.map((row) => row.opt.chips))).toEqual(new Set(CHIPS_ALL));
      expect(new Set(rows.map((row) => row.opt.history))).toEqual(new Set(HISTORY_ALL));
      expect(new Set(rows.map((row) => row.opt.who))).toEqual(new Set(WHO_ALL));
      expect(new Set(rows.map((row) => row.opt.row))).toEqual(new Set(ROW_ALL));
      expect(new Set(rows.map((row) => row.opt.kind))).toEqual(new Set(["deliverable", "working"]));
      expect(
        new Set(
          rows.map(
            (row) =>
              bit(row.opt.flags.cd) +
              bit(row.opt.flags.fx) +
              bit(row.opt.flags.amd) +
              bit(row.opt.flags.nv) +
              bit(row.opt.flags.intel),
          ),
        ).size,
      ).toBe(32);
    }
  });

  it("section C is the whole product of its axes: every canvas, call, door, chip, engine setting and measurement (at least 80 entries)", () => {
    const rows = cRows();
    expect(rows.length).toBeGreaterThanOrEqual(80);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.length).toBe(
      C_CANVASES.length * C_ARGS_ALL.length * CALLERS.length * 2 * C_ENGINES.length * 2,
    );
    expect(new Set(rows.map((row) => row.opt.caller))).toEqual(new Set(CALLERS));
    expect(new Set(rows.map((row) => row.opt.args))).toEqual(new Set(C_ARGS_ALL));
    expect(new Set(rows.map((row) => row.opt.engine))).toEqual(new Set(C_ENGINES));
    expect(new Set(rows.map((row) => row.opt.chip))).toEqual(new Set(["none", "amd"]));
    expect(new Set(rows.map((row) => canvasId(row.opt.canvas)))).toEqual(
      new Set(C_CANVASES.map(canvasId)),
    );
  });
});

describe("the full-quality guard", () => {
  it("A: the command builder gives the same plan for every project and option set", () => {
    const result = emptyComputed();
    for (const row of aRows()) collect(result, row.key, runA(row));
    finish("A", result);
  }, 1_500_000);

  it("B: the encoder choice gives the same answer for every project, request, setting, switch, chip and measurement", async () => {
    finish("B", await computeB("B", bRows("B")));
  }, 1_500_000);

  it("C: the export tool hands the app process the same command and gives the same reply", async () => {
    const result = emptyComputed();
    for (const row of cRows()) collect(result, row.key, await runC(row));
    finish("C", result);
  }, 1_500_000);

  it("D: the request quick gives the encoder it gives today (the chip where one passed, else the faster setting)", async () => {
    finish("D", await computeB("D", bRows("D")));
  }, 1_500_000);

  it("is the whole fixture: no key more, none less, and the combined hash is the pinned one", () => {
    const parts = SECTIONS.map((name) => computed[name]);
    const all: Record<string, string> = {};
    for (const part of parts) Object.assign(all, part?.hashes ?? {});
    const complete = parts.every((part) => part !== undefined);

    if (PRINT_TO) {
      expect(complete, "print mode needs all four sections: do not filter the tests").toBe(true);
      const sorted: Record<string, string> = {};
      for (const key of Object.keys(all).sort()) sorted[key] = all[key];
      const counts = Object.fromEntries(
        SECTIONS.map((name) => [name, { count: Object.keys(computed[name]!.hashes).length }]),
      );
      const text = `${JSON.stringify({ format: 1, sections: counts, combined: combinedOf(all), hashes: sorted }, null, 1)}\n`;
      mkdirSync(dirname(PRINT_TO), { recursive: true });
      writeFileSync(PRINT_TO, text, { encoding: "utf8" });
      writeNotes();
      return;
    }

    const fixture = readFixture();
    expect(fixture.format).toBe(1);
    for (const [key, hash] of Object.entries(fixture.hashes)) {
      expect(key, "a key of the fixture belongs to no section").toMatch(/^[ABCD]\|/);
      expect(hash, `the hash of ${key}`).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const name of SECTIONS) {
      const count = Object.keys(fixture.hashes).filter((key) => key.startsWith(`${name}|`)).length;
      expect(fixture.sections[name]?.count, `the fixture's own count of section ${name}`).toBe(
        count,
      );
    }
    expect(Object.keys(fixture.sections).sort()).toEqual([...SECTIONS]);
    expect(fixture.combined, "the fixture's combined hash is the hash of its own lines").toBe(
      combinedOf(fixture.hashes),
    );
    expect(fixture.combined, "the fixture is not the one pinned in this file").toBe(
      PINNED_COMBINED,
    );
    if (complete) expect(combinedOf(all)).toBe(PINNED_COMBINED);
  });

  it("does not depend on the hold on the estimate and the speed check: 300 entries of A and B are the same with it lifted", async () => {
    const aSample = aRows().filter((_row, index) => index % 20 === 0);
    const bSample = bRows("B").filter((_row, index) => index % 18 === 0);
    expect(aSample.length + bSample.length).toBeGreaterThanOrEqual(300);
    const read = async (held: boolean): Promise<Record<string, string>> => {
      __setHeldOffByBuild(held);
      const out: Record<string, string> = {};
      for (const row of aSample) out[row.key] = runA(row).hash;
      for (const row of bSample) out[row.key] = (await runB(row)).hash;
      return out;
    };
    const held = await read(true);
    const lifted = await read(false);
    const moved = Object.keys(held).filter((key) => held[key] !== lifted[key]);
    expect(
      moved,
      `lifting the hold on estimate_v2 and pc_check moved ${moved.length} of ${Object.keys(held).length} entries; the first: ${moved.slice(0, 10).join(" ; ")}`,
    ).toEqual([]);
  }, 1_500_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// What the change of rule moved: the 0.28.0 fixture against the one printed after it (both read from disk, nothing recomputed)
// ---------------------------------------------------------------------------------------------------------------------

const movedIn = (moved: string[], name: SectionName): string[] =>
  moved.filter((key) => key.startsWith(`${name}|`));
/** A field of a key's text: `req=auto`, `chips=amd`, `who=menu`, ... */
const field = (key: string, name: string): string | undefined =>
  key.match(new RegExp(`[|,]${name}=([^|,]*)`))?.[1];
/** A key's PC has a chip of a maker whose switch is on (`chips=` names what is installed, `amd=`, `nv=` and `in=` the switches). */
const chipUsable = (key: string): boolean => {
  const on: Record<ChipMaker, boolean> = {
    amd: field(key, "amd") === "1",
    nvidia: field(key, "nv") === "1",
    intel: field(key, "in") === "1",
  };
  return PRESENT[field(key, "chips") as ChipsId].some((maker) => on[maker]);
};

/** How many keys of each section differ between the two fixtures. Every one is explained by the rule: a request that is not Full quality, on a PC with a usable
 *  chip (and, in section C, a Fast pick through the dialog whose Mode row now starts on Fast). A later change of the rule shows up as a change of these numbers. */
const MOVED_BY_THE_RULE: Record<SectionName, number> = { A: 0, B: 772, C: 621, D: 28 };

describe("what the change of rule moved: the 0.28.0 fixture against the one printed after it", () => {
  const both = (): { old: Fixture; now: Fixture; moved: string[] } => {
    const old = readFixture(OLD_FIXTURE);
    const now = readFixture(ALWAYS_FIXTURE);
    const moved = Object.keys(now.hashes)
      .filter((key) => now.hashes[key] !== old.hashes[key])
      .sort();
    return { old, now, moved };
  };

  it("keeps the 0.28.0 fixture as the record, and the new one names it as its origin", () => {
    const { old, now } = both();
    expect(combinedOf(old.hashes), "the old fixture's own lines").toBe(OLD_COMBINED);
    expect(old.combined).toBe(OLD_COMBINED);
    expect(now.derivedFrom).toEqual({
      file: "exportFullGuard.sha256.json",
      combined: OLD_COMBINED,
    });
    expect(now.about, "the new fixture says why it exists").toMatch(/changed on purpose/);
  });

  it("has the same keys in both, and the command builder (section A) did not move in any of them", () => {
    const { old, now, moved } = both();
    expect(Object.keys(now.hashes).sort()).toEqual(Object.keys(old.hashes).sort());
    expect(movedIn(moved, "A")).toEqual([]);
  });

  it("moved as many keys in each section as the rule reaches", () => {
    const { moved } = both();
    expect(Object.fromEntries(SECTIONS.map((name) => [name, movedIn(moved, name).length]))).toEqual(
      MOVED_BY_THE_RULE,
    );
  });

  it("moved only keys the rule can reach: no PC without a usable chip, no working render, never the person's Full quality", () => {
    const { moved } = both();
    for (const key of [...movedIn(moved, "B"), ...movedIn(moved, "D")]) {
      expect(chipUsable(key), `${key} moved though no chip of its PC could be used`).toBe(true);
      expect(field(key, "req"), `${key}: Full quality is the processor, byte for byte`).not.toBe(
        "full",
      );
      expect(field(key, "kind"), `${key}: a working render never uses a chip`).toBe("deliverable");
    }
    for (const key of movedIn(moved, "C")) {
      expect(field(key, "chip"), `${key} moved though its PC has no chip`).toBe("amd");
      expect(field(key, "who"), `${key}: the person's Full quality is the processor`).not.toBe(
        "menu-quality",
      );
    }
  });

  it("moved a caller with no dialog only where the encoder itself can change, and Quick only through the dialog's Mode row", () => {
    const { moved } = both();
    for (const key of movedIn(moved, "B").filter((one) => field(one, "who") !== "menu")) {
      const encoderCanChange =
        (field(key, "req") === "auto" && field(key, "cd") === "1") || field(key, "req") === "fast";
      expect(
        encoderCanChange,
        `${key}: an unpinned request with the switch off keeps the processor`,
      ).toBe(true);
    }
    for (const key of movedIn(moved, "D"))
      expect(field(key, "who"), `${key}: the request quick keeps its encoder`).toBe("menu");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// What the third size class moved: the fixture before it against the one printed after it (both read from disk, nothing recomputed)
// ---------------------------------------------------------------------------------------------------------------------

/** How many keys of each section differ between the fixture before the third size class and the one printed after it. Every one is a key whose
 *  delivered picture is in the new class: the chip lookup is made for it now (on any PC), and where a chip is usable its encoder and the Mode row
 *  change with it. A later change of the class shows up as a change of these numbers. */
const MOVED_BY_THE_CLASS: Record<SectionName, number> = { A: 0, B: 232, C: 192, D: 131 };

interface Picture {
  width: number;
  height: number;
  fps: number;
}
/** The picture a key delivers, from the key's own text (its canvas and the settings it names), through the app's one definition of the delivered picture. */
function pictureOf(key: string): Picture {
  const canvas = key.split("|")[1].match(/^(\d+)x(\d+)@(\d+)$/);
  if (!canvas) throw new Error(`${key} names no canvas`);
  const workload = { width: Number(canvas[1]), height: Number(canvas[2]), fps: Number(canvas[3]) };
  if (key.startsWith("C|"))
    return deliveredPicture(
      workload,
      C_ARGS[field(key, "args") as CArgs] as { resolution?: ExportResolution; fps?: number },
    );
  const res = field(key, "res");
  const fps = field(key, "fps");
  return deliveredPicture(workload, {
    resolution: res === "-" ? undefined : (res as ExportResolution),
    fps: fps === "-" ? undefined : Number(fps),
  });
}
/** A picture the third class holds and neither of the first two does, written out from the table of classes (1080p up to 60 frames a second is the first, 4K up to 30 the
 *  second, 4K up to 60 the third), not read from the code under test. */
const gainsAClass = (p: Picture): boolean => {
  const longSide = Math.max(p.width, p.height);
  const pixels = p.width * p.height;
  const inHd = longSide <= 1920 && pixels <= 1920 * 1080 && p.fps <= 60;
  const inUhd = longSide <= 3840 && pixels <= 3840 * 2160 && p.fps <= 30;
  const inUhd60 = longSide <= 3840 && pixels <= 3840 * 2160 && p.fps <= 60;
  return inUhd60 && !inHd && !inUhd;
};

describe("what the third size class moved: the fixture before it against the one printed after it", () => {
  const both = (): { before: Fixture; now: Fixture; moved: string[] } => {
    const before = readFixture(ALWAYS_FIXTURE);
    const now = readFixture();
    const moved = Object.keys(now.hashes)
      .filter((key) => now.hashes[key] !== before.hashes[key])
      .sort();
    return { before, now, moved };
  };

  it("keeps the fixture before the class as the record, and the new one names it as its origin", () => {
    const { before, now } = both();
    expect(combinedOf(before.hashes), "the earlier fixture's own lines").toBe(ALWAYS_COMBINED);
    expect(before.combined).toBe(ALWAYS_COMBINED);
    expect(now.derivedFrom).toEqual({
      file: "exportFullGuard.always.sha256.json",
      combined: ALWAYS_COMBINED,
    });
    expect(now.about, "the new fixture says why it exists").toMatch(/third test class/);
  });

  it("has the same keys in both, and the command builder (section A) did not move in any of them", () => {
    const { before, now, moved } = both();
    expect(Object.keys(now.hashes).sort()).toEqual(Object.keys(before.hashes).sort());
    expect(movedIn(moved, "A")).toEqual([]);
  });

  it("moved as many keys in each section as the class reaches", () => {
    const { moved } = both();
    expect(Object.fromEntries(SECTIONS.map((name) => [name, movedIn(moved, name).length]))).toEqual(
      MOVED_BY_THE_CLASS,
    );
  });

  it("moved only keys whose delivered picture gained a class: nothing of a picture that already had one or has none, never the person's Full quality, no working render", () => {
    const { moved } = both();
    for (const key of moved)
      expect(gainsAClass(pictureOf(key)), `${key} moved though its picture gained no class`).toBe(
        true,
      );
    for (const key of [...movedIn(moved, "B"), ...movedIn(moved, "D")]) {
      expect(field(key, "req"), `${key}: Full quality is the processor`).not.toBe("full");
      expect(field(key, "kind"), `${key}: a working render never uses a chip`).toBe("deliverable");
    }
    for (const key of movedIn(moved, "C"))
      expect(field(key, "who"), `${key}: the person's Full quality is the processor`).not.toBe(
        "menu-quality",
      );
  });

  it("moved every key a lookup is made for: a deliverable export of a picture that gained a class, other than Full quality", () => {
    const { now, moved } = both();
    const movedSet = new Set(moved);
    const lookedUp = Object.keys(now.hashes).filter((key) => {
      if (key.startsWith("A|") || !gainsAClass(pictureOf(key))) return false;
      if (key.startsWith("C|")) return field(key, "who") !== "menu-quality";
      return field(key, "req") !== "full" && field(key, "kind") === "deliverable";
    });
    expect(lookedUp.length).toBeGreaterThan(0);
    expect(lookedUp.filter((key) => !movedSet.has(key))).toEqual([]);
  });
});
