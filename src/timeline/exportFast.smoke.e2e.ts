// Fast against Quality, judged on the FILES the real export tool delivers (the Export dialog's Quality | Fast choice, real ffmpeg and ffprobe).
// The unit and journey suites play the app process with a fake and read the command it was handed; nothing there proves what the file looks like.
// This lane runs the command. Each case exports small real projects through the real `export` tool (`exportTool`, the one the Export menu runs) at
// Quality and at Fast, the dialog's pick riding in the tool context as `ctx.exportRoute` exactly as the host hands it over, then reads the delivered
// files back with ffprobe (and, for the encoder, the bytes of the file itself) and compares them with literals of the owner's table:
//   Fast = the picture one rung below the project's by its SHORT side (2160, 1080, 720, 480; none at 480 or less), at most 30 frames a second
//   (60 gives 30, 50 gives 25, 48 gives 24; never raised), Medium quality, and the encoder is the graphics chip if it passed the app's own test and
//   the person's switch is not Off, else the processor's lighter setting (x264 `-preset veryfast`). A lever the person set (`explicit`) is never
//   overridden. A call without a slot (the chat and MCP doors) is Quality in every byte.
// No expected number is computed with the code under test: every size, rate, frame count and x264 option below is written out. Each case says which
// two artifacts it compares. FAST_SMOKE_COMMANDS=1 also prints every command and the whole x264 text of every file.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportFast.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag, __setHeldOffByBuild } from "../api/exportFlags";
import type { GraphicsAdapter, ProbeOutcome } from "../platform/host";
import { shippedSidecar } from "../test/sidecars";
import { agentToolContext } from "../tools/agentStore";
import type { ClientToolContext } from "../tools/context";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { CHIP_PREF_KEY } from "./chipPref";
import { findChip, type ChipDeps } from "./chipTest";
import { ensureTimeline } from "./engine";
import { CHIP_MAKERS, type ChipMaker, type SizeClass } from "./exportEncoder";
import { exportTool } from "./exportItems";
import { whenExportEnds, whenExportsSettle } from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";

type Rec = Record<string, unknown>;

const FF = shippedSidecar("ffmpeg");
const FP = shippedSidecar("ffprobe");

const ROOT = joinPath(os.tmpdir(), `artdaddy-fast-${Date.now()}`);
const SECONDS = 2;
const VERBOSE = process.env.FAST_SMOKE_COMMANDS === "1";

// What the app process tells the page about this PC (its graphics chips) cannot be asked from here, so every maker's chip is "reported" and the app's own
// lookup and test (chipTest.ts: a real encode of the test clip, a real compare, a real processor reference) find out which one works on this PC, with the
// real ffmpeg under them. The person's Graphics chip switch lives in `pc.memory` (the storage the lookup reads it from).
const pc = vi.hoisted(() => ({
  deps: undefined as ChipDeps | undefined,
  memory: new Map<string, string>(),
}));
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn((sizeClass: SizeClass, options: { allowRun: boolean; signal?: AbortSignal }) =>
      real.findChip(sizeClass, options, pc.deps),
    ),
  };
});
// Nothing is reported to the server by a test.
vi.mock("../api/exportEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/exportEvents")>()),
  reportExport: async () => undefined,
}));

async function realProbe(
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ProbeOutcome> {
  const started = Date.now();
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), options.timeoutMs);
  try {
    const result = await nodeRunner.run("ffmpeg", [...args], timer.signal);
    if (timer.signal.aborted) return { kind: "timeout" };
    return {
      kind: "ran",
      code: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(handle);
  }
}

function chipDeps(): ChipDeps {
  const adapters: GraphicsAdapter[] = CHIP_MAKERS.map((maker) => ({
    maker,
    device: "0000",
    driver: "0.0",
  }));
  return {
    adapters: async () => adapters,
    probe: realProbe,
    files: {
      dir: async () => joinPath(ROOT, "chip-test"),
      mkdir: async (path) => void (await fsp.mkdir(path, { recursive: true })),
      remove: async (path) => fsp.rm(path, { force: true }),
    },
    storage: {
      getItem: (key) => pc.memory.get(key) ?? null,
      setItem: (key, value) => void pc.memory.set(key, value),
    },
    now: () => Date.now(),
    release: "artdaddy@smoke",
  };
}

const log = (line: string): void => console.log(`[fast smoke] ${line}`);

/** The encoder each maker's chip is run with (the names ffmpeg knows them by), written out. */
const CHIP_CODEC: Record<ChipMaker, string> = {
  amd: "h264_amf",
  nvidia: "h264_nvenc",
  intel: "h264_qsv",
};

const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
};

/** The graphics chip lookup the app makes for a Fast picture (every picture here is of the "hd" size class), run once before any export, so that the app's own
 *  test is over when an export asks (an export waits only 20 seconds for a first test, then uses the processor). What it says is this PC's answer. */
const pcChip = once(async () => {
  const started = Date.now();
  const found = await findChip("hd", { allowRun: true });
  log(
    `this PC's chip lookup (the app's own test, ${((Date.now() - started) / 1000).toFixed(1)} s): ` +
      `${found.chip ? `${found.chip.maker} passed (ssim ${found.chip.ssimMilli / 1000})` : "no chip passed"}; ` +
      `tests run: ${JSON.stringify(found.events.map((e) => `${e.maker}:${e.result}`))}`,
  );
  return found;
});

beforeAll(async () => {
  installE2EDocuments();
  await fsp.mkdir(ROOT, { recursive: true });
  pc.deps = chipDeps();
  // The switch as the unit suite runs it, set here so that no setting of the build can hide a Fast pick or invent one.
  __setHeldOffByBuild(false);
  __setExportFlag("quick_route", true);
});
afterAll(async () => {
  await whenExportsSettle();
  await resetE2EDocuments();
  __resetExportFlags();
  __setHeldOffByBuild(null);
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

// The project: one real clip of SECONDS seconds with sound, placed whole, on a canvas of the same size and rate.
interface Shape {
  w: number;
  h: number;
  fps: number;
}
interface Project {
  ctx: ClientToolContext;
  shape: Shape;
  /** The names exported from it so far: one file each, so a name is never used twice. */
  names: Set<string>;
}

let projects = 0;
async function project(shape: Shape): Promise<Project> {
  const dir = joinPath(ROOT, `p${++projects}-${shape.w}x${shape.h}-${shape.fps}`);
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  const set = (await setCanvasTool(
    { width: shape.w, height: shape.h, fps: shape.fps },
    ctx,
  )) as Rec;
  expect(set.ok, JSON.stringify(set)).toBe(true);
  const src = joinPath(dir, "src.mp4");
  await ff([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${shape.w}x${shape.h}:r=${shape.fps}:d=${SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    src,
  ]); // prettier-ignore
  const ref = await libRef(ctx, src, "video");
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: shape.fps * SECONDS }] },
    ctx,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  return { ctx, shape, names: new Set() };
}

// What a delivered file says of itself, read back with ffprobe (not what the plan or the command promised).
interface Facts {
  width: number;
  height: number;
  /** The container's frame rate. */
  rate: number;
  /** The pictures decoded from the file (`-count_frames`): the file's own count, not the header's. */
  frames: number;
  videoS: number;
  audioS: number | null;
  videoCodec: string;
  pixFmt: string;
  audioCodec: string | null;
  audioRate: number | null;
  streams: { video: number; audio: number };
}

const ratio = (text: unknown): number => {
  const [num, den] = String(text).split("/").map(Number);
  return den ? num / den : num;
};

async function factsOf(file: string): Promise<Facts> {
  const r = await nodeRunner.run("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-of", "json", file,
  ]); // prettier-ignore
  expect(r.code, r.stderr.slice(-400)).toBe(0);
  const streams = (JSON.parse(r.stdout || "{}") as { streams?: Rec[] }).streams ?? [];
  const videos = streams.filter((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  const v = videos[0] ?? {};
  const a = audios[0];
  return {
    width: Number(v.width),
    height: Number(v.height),
    rate: ratio(v.r_frame_rate),
    frames: Number(v.nb_read_frames),
    videoS: Number(v.duration),
    audioS: a ? Number(a.duration) : null,
    videoCodec: String(v.codec_name),
    pixFmt: String(v.pix_fmt),
    audioCodec: a ? String(a.codec_name) : null,
    audioRate: a ? Number(a.sample_rate) : null,
    streams: { video: videos.length, audio: audios.length },
  };
}

/** The text x264 writes into every stream it encodes ("x264 - core NNN ... options: ref=3 ... subme=7 ..."), found in the bytes of the file; null for a
 *  file x264 did not make (a graphics chip's). */
async function x264Text(file: string): Promise<string | null> {
  const bytes = await fsp.readFile(file);
  const at = bytes.indexOf("x264 - core");
  if (at < 0) return null;
  const end = bytes.indexOf(0, at);
  return bytes.toString("latin1", at, end < 0 ? undefined : end);
}
const optionOf = (text: string, key: string): string | null =>
  new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(text)?.[1] ?? null;

/** Which x264 speed setting a file's own text shows: `veryfast` keeps one reference frame and subme 2 (no trellis), `medium` (x264's default) three and 7. */
function speedOf(text: string): string {
  const [ref, subme, trellis] = ["ref", "subme", "trellis"].map((key) => optionOf(text, key));
  if (ref === "1" && subme === "2" && trellis === "0") return "veryfast";
  if (ref === "3" && subme === "7" && trellis === "1") return "medium";
  return `other (ref=${ref} subme=${subme} trellis=${trellis})`;
}

/** The average PSNR (dB) of `file` against `reference` brought to the picture of `file`: a file of the right shape that shows another picture (black, garbled,
 *  a frame late) scores far lower than the same video made twice. Only for two files of one frame rate: the frames then pair one to one. */
async function psnrAgainst(file: string, reference: string, facts: Facts): Promise<number> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v", "info", "-i", file, "-i", reference,
    "-lavfi", `[1:v]scale=${facts.width}:${facts.height}[ref];[0:v][ref]psnr`,
    "-f", "null", "-",
  ]); // prettier-ignore
  const m = /average:(\S+)/.exec(r.stderr);
  if (!m) throw new Error(`no PSNR in ffmpeg output: ${r.stderr.slice(-400)}`);
  return m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
}

// An export: the call, the command the tool handed the process, the file it delivered and what the file says.
interface Delivered {
  name: string;
  file: string;
  /** The ffmpeg command that wrote the delivered file, as the export tool handed it to the process. */
  command: string[];
  facts: Facts;
  x264: string | null;
}

/** How a call reaches the tool: the dialog's pick of Quality or Fast as the host puts it in the context (absent for the chat and MCP doors, and for a Quality
 *  pick of the dialog), the door, the dialog's own pick of the encoder (the 0.28.0 Mode row; absent is the app's own rule) and the person's Graphics chip switch. */
interface Door {
  slot?: unknown;
  surface?: "app" | "mcp";
  mode?: "quality" | "fast";
  chip?: "auto" | "off";
}

const flag = (command: string[], name: string): string | undefined => {
  const at = command.lastIndexOf(name);
  return at < 0 ? undefined : command[at + 1];
};
/** The command with what differs between two runs of one export (the staging file it writes, named after the export and a random word) taken out. */
const scrubbed = (command: string[]): string[] =>
  command.map((part) => (part.endsWith(".partial") ? "STAGING" : part));

async function exportOf(p: Project, name: string, args: Rec, door: Door = {}): Promise<Delivered> {
  // One file per name: a second export under a name would be numbered by the tool, and the file read back would be the first one's.
  expect(p.names.has(name), `${name} was exported from this project already`).toBe(false);
  p.names.add(name);
  // The app's own chip test is over before the person's switch is touched or any export asks.
  await pcChip();
  const commands: string[][] = [];
  const base: ClientToolContext = {
    ...p.ctx,
    // The real ffmpeg under a runner that remembers every command it is handed.
    runner: {
      run: async (program, argv, signal, cwd, onStdout) => {
        if (program === "ffmpeg") commands.push([...argv]);
        return nodeRunner.run(program, argv, signal, cwd, onStdout);
      },
    },
    surface: door.surface ?? "app",
    ...(door.mode ? { exportMode: door.mode } : {}),
    ...(door.slot === undefined
      ? {}
      : { exportRoute: door.slot as ClientToolContext["exportRoute"] }),
  };
  if (door.chip === "off") pc.memory.set(CHIP_PREF_KEY, "off");
  try {
    const res = (await exportTool(
      { name, ...args },
      agentToolContext(base, new AbortController().signal),
    )) as Rec;
    expect(res.ok, `${name}: ${JSON.stringify(res)}`).toBe(true);
    expect(res.saved_to, `${name}: the file the tool says it wrote`).toBe(`${name}.mp4`);
    const ended = await whenExportEnds(String(res.job_id));
    expect(ended?.state, `${name}: ${JSON.stringify(ended)}`).toBe("done");
  } finally {
    pc.memory.delete(CHIP_PREF_KEY);
  }
  const file = await p.ctx.store.exportPath(`${name}.mp4`);
  const command = commands.filter((c) => c.some((part) => part.endsWith(".partial"))).at(-1);
  expect(command, `${name}: no command wrote the file: ${JSON.stringify(commands)}`).toBeDefined();
  const made: Delivered = {
    name,
    file,
    command: command!,
    facts: await factsOf(file),
    x264: await x264Text(file),
  };
  // Whatever the call, the file says what the command said: x264's own text is in the file exactly when the command names x264, at the speed and the quality
  // the command asked for (no `-preset` is x264's own default, medium; no `-crf` is x264's own default, 23); a chip's file has none.
  const codec = flag(command!, "-c:v");
  if (codec === "libx264") {
    expect(made.x264, `${name}: the file carries x264's own text`).not.toBeNull();
    expect(speedOf(made.x264!), `${name}: the speed in the file, the command's`).toBe(
      flag(command!, "-preset") ?? "medium",
    );
    expect(optionOf(made.x264!, "crf"), `${name}: the quality in the file, the command's`).toBe(
      Number(flag(command!, "-crf") ?? 23).toFixed(1),
    );
  } else {
    expect(Object.values(CHIP_CODEC), `${name}: an encoder the app knows`).toContain(codec);
    expect(made.x264, `${name}: a chip's file carries no x264 text`).toBeNull();
  }
  const f = made.facts;
  log(
    `${name}: ${f.width}x${f.height} at ${f.rate} fps, ${f.frames} frames, video ${f.videoS.toFixed(3)} s, ` +
      `audio ${f.audioS?.toFixed(3)} s, ${f.streams.video} video + ${f.streams.audio} audio stream, ` +
      `${f.videoCodec}/${f.pixFmt}; encoder in the command: ${codec}` +
      `${flag(command!, "-preset") ? ` -preset ${flag(command!, "-preset")}` : ""}; ` +
      `x264 text in the file: ${
        made.x264
          ? `yes (${["ref", "subme", "trellis", "rc_lookahead", "crf"]
              .map((key) => `${key}=${optionOf(made.x264!, key)}`)
              .join(" ")})`
          : "none"
      }`,
  );
  if (VERBOSE) {
    log(`${name}: command ${command!.join(" ")}`);
    if (made.x264) log(`${name}: x264 text ${made.x264}`);
  }
  return made;
}

// The dialog's calls. At Quality it sends the size "same as the project" and Medium, and no frame rate (one that is not changed is not sent); at Fast it sends
// the SHOWN values (Fast's own size, and the rate where Fast lowers it) and the slot says which of the three the person touched (`explicit`).
const QUALITY = { resolution: "source", quality: "medium" };
// The slots are frozen: a tool that wrote into the dialog's slot would throw.
const slotOf = (explicit: Rec) =>
  Object.freeze({ route: "quick", explicit: Object.freeze(explicit) });
const FAST = slotOf({ size: false, fps: false, quality: false });

/** Fast twice, as one PC can have it: with the person's Graphics chip switch at Auto (the chip if this PC's chip passed the app's test) and Off (the processor's
 *  lighter setting), so that every rule is read on a file of each encoder. */
async function fastBoth(p: Project, name: string, args: Rec, slot: unknown = FAST) {
  return {
    auto: await exportOf(p, name, args, { slot }),
    off: await exportOf(p, `${name}-chip-off`, args, { slot, chip: "off" }),
  };
}

/** The encoder a file's command must name, and what the file itself shows, for a Fast export (the chip if this PC's chip passed the app's own test and the switch
 *  is not Off, else x264 `veryfast`) or any other (x264 at its default speed, whatever the chip). The oracle for this PC is the app's chip lookup, run once. */
async function expectEncoder(made: Delivered, how: { fast: boolean; chipOff?: boolean }) {
  const found = await pcChip();
  const chip = how.fast && !how.chipOff ? found.chip?.maker : undefined;
  const [codec, preset] = [flag(made.command, "-c:v"), flag(made.command, "-preset")];
  if (chip) {
    expect(codec, `${made.name}: the chip that passed the app's test`).toBe(CHIP_CODEC[chip]);
    expect(preset, `${made.name}: a chip is not given the processor's setting`).not.toBe(
      "veryfast",
    );
    expect(made.x264, `${made.name}: a chip's file carries no x264 text`).toBeNull();
    return;
  }
  expect(codec, `${made.name}: the processor`).toBe("libx264");
  expect(preset, `${made.name}: the lighter setting for Fast only`).toBe(
    how.fast ? "veryfast" : undefined,
  );
  expect(made.x264, `${made.name}: the file carries x264's own text`).not.toBeNull();
  expect(speedOf(made.x264!), `${made.name}: the speed x264 says it ran at`).toBe(
    how.fast ? "veryfast" : "medium",
  );
}

const picture = (made: Delivered) => ({
  width: made.facts.width,
  height: made.facts.height,
  rate: made.facts.rate,
});
/** An actual count within `tolerance` of the literal `want`. */
const near = (actual: number, want: number, tolerance: number, what: string): void => {
  expect(
    Math.abs(actual - want),
    `${what}: ${actual}, wanted ${want} (within ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
};

/** What the two files must share whichever way each was made: the sound, the containers and codecs a player needs, and the length. `oneFrame` is a frame of the
 *  slower of the two rates, in seconds. */
function expectSameVideo(quality: Delivered, other: Delivered, oneFrame: number): void {
  const [q, f] = [quality.facts, other.facts];
  expect(f.streams, `${other.name}: stream counts`).toEqual(q.streams);
  expect(q.streams).toEqual({ video: 1, audio: 1 });
  expect([f.videoCodec, f.pixFmt], other.name).toEqual(["h264", "yuv420p"]);
  expect([f.audioCodec, f.audioRate], other.name).toEqual(["aac", 48000]);
  expect([q.videoCodec, q.pixFmt, q.audioCodec, q.audioRate]).toEqual([
    "h264",
    "yuv420p",
    "aac",
    48000,
  ]);
  expect(Math.abs(f.videoS - q.videoS), `${other.name}: video length`).toBeLessThanOrEqual(
    oneFrame + 1e-3,
  );
  expect(Math.abs(f.audioS! - q.audioS!), `${other.name}: sound length`).toBeLessThan(0.05);
  near(q.videoS, SECONDS, 0.1, "Quality's video length in seconds");
}

/** The same video, made smaller: `fast` against `quality` brought to Fast's picture (both at one frame rate). The same moving test pattern made twice, once smaller
 *  and by another encoder, scores in the forties; a black, green or garbled picture in the teens, and one frame late (a moving pattern at 30 fps) in the twenties. */
const SAME_PICTURE_DB = 33;
async function expectSamePicture(quality: Delivered, fast: Delivered): Promise<void> {
  expect(fast.facts.rate, "the frames pair one to one").toBe(quality.facts.rate);
  const db = await psnrAgainst(fast.file, quality.file, fast.facts);
  log(`${fast.name}: picture against ${quality.name}, average PSNR ${db.toFixed(1)} dB`);
  expect(db, `${fast.name}: the picture is not Quality's picture`).toBeGreaterThan(SAME_PICTURE_DB);
}

// The projects and the exports several cases read, made when a case first needs them. Quality as the dialog sends it (its Mode row never drawn: the app's request
// "full" the encoder rule gets from the dialog); Fast with nothing touched, as the dialog sends it (Fast's own size in the call) and as a call that carries only the
// slot (so that the tool composes Fast's size and rate itself), each with the Graphics chip at Auto and Off.
const p720 = once(() => project({ w: 1280, h: 720, fps: 30 }));
const p720at60 = once(() => project({ w: 1280, h: 720, fps: 60 }));
const pVertical = once(() => project({ w: 720, h: 1280, fps: 30 }));
const quality720 = once(async () =>
  exportOf(await p720(), "quality", QUALITY, { mode: "quality" }),
);
const dialog720 = once(async () =>
  exportOf(await p720(), "fast-dialog", { resolution: "480p", quality: "medium" }, { slot: FAST }),
);
const slotOnly720 = once(async () =>
  exportOf(await p720(), "fast-slot-only", QUALITY, { slot: FAST, chip: "off" }),
);
const quality60 = once(async () =>
  exportOf(await p720at60(), "quality", QUALITY, { mode: "quality" }),
);
const slotOnly60 = once(async () => fastBoth(await p720at60(), "fast-slot-only", QUALITY));

describe.skipIf(!FF || !FP)("Fast and Quality, on the files the real export tool delivers", () => {
  it("A. 1280x720 at 30 fps with sound: Fast is 854x480 at 30, as long as Quality's, with the same streams and picture", async () => {
    // The two artifacts: Quality's delivered file and Fast's, each read back with ffprobe, against the owner's table; and Fast's picture against Quality's.
    const quality = await quality720();
    const dialog = await dialog720();
    // The tool composes Fast itself from the slot alone (the call carries nothing of Fast's): on the processor here, on both encoders in B.
    const slotOnly = await slotOnly720();

    expect(picture(quality)).toEqual({ width: 1280, height: 720, rate: 30 });
    near(quality.facts.frames, 60, 1, "Quality's frames");
    for (const fast of [dialog, slotOnly]) {
      expect(picture(fast), fast.name).toEqual({ width: 854, height: 480, rate: 30 });
      near(fast.facts.frames, 60, 1, `${fast.name}: frames`);
      expectSameVideo(quality, fast, 1 / 30);
      await expectSamePicture(quality, fast);
    }
  });

  it("B. a 60 fps project: Fast delivers 30 fps and about half the frames, Quality keeps 60", async () => {
    // The two artifacts: Quality's delivered file and Fast's (the call carries only the slot, so the tool itself caps the rate), the frames decoded from each.
    // The pictures are not compared pixel by pixel: ffmpeg's own frame-rate conversion (the `-r 30` of any export typed by hand at 30 as well) starts with four
    // undecimated frames and then runs three source frames behind, so the two files do not pair frame for frame (a finding of the lane's report).
    const quality = await quality60();
    const slotOnly = await slotOnly60();
    const dialog = await exportOf(
      await p720at60(),
      "fast-dialog",
      { resolution: "480p", quality: "medium", fps: 30 },
      { slot: FAST },
    );

    expect(picture(quality)).toEqual({ width: 1280, height: 720, rate: 60 });
    near(quality.facts.frames, 120, 2, "Quality's frames at 60 fps");
    for (const fast of [slotOnly.auto, slotOnly.off, dialog]) {
      expect(picture(fast), fast.name).toEqual({ width: 854, height: 480, rate: 30 });
      near(fast.facts.frames, 60, 2, `${fast.name}: frames at 30 fps`);
      near(fast.facts.frames, quality.facts.frames / 2, 2, `${fast.name}: half of Quality's`);
      expectSameVideo(quality, fast, 1 / 30);
    }
  });

  it("C. a vertical project: the short side goes one rung down (720x1280 gives 480x854)", async () => {
    // The two artifacts: Quality's delivered file and Fast's, for a project taller than wide, and Fast's picture against Quality's.
    const p = await pVertical();
    const quality = await exportOf(p, "quality", QUALITY, { mode: "quality" });
    const fast = await exportOf(p, "fast", QUALITY, { slot: FAST });

    expect(picture(quality)).toEqual({ width: 720, height: 1280, rate: 30 });
    expect(picture(fast)).toEqual({ width: 480, height: 854, rate: 30 });
    near(fast.facts.frames, 60, 1, "Fast's frames");
    expectSameVideo(quality, fast, 1 / 30);
    await expectSamePicture(quality, fast);
  });

  it("D. what the person set stays: a size and a rate are never overridden, and a slot nobody can read is not believed", async () => {
    const p = await p720at60();
    // The two artifacts for each row: the delivered Fast file and the owner's table (what stays, and what Fast composes around it).
    // The size set ("same as the project" picked): the size stays, the rate still caps at 30.
    const size = await exportOf(p, "fast-size-set", QUALITY, {
      slot: slotOf({ size: true, fps: false, quality: false }),
    });
    expect(picture(size)).toEqual({ width: 1280, height: 720, rate: 30 });
    near(size.facts.frames, 60, 2, "the size set: frames at 30 fps");

    // The rate set ("same as the project" picked, so there is no rate in the call): the rate stays 60, the size still goes one rung down.
    const rate = await exportOf(
      p,
      "fast-rate-set",
      { resolution: "480p", quality: "medium" },
      { slot: slotOf({ size: false, fps: true, quality: false }) },
    );
    expect(picture(rate)).toEqual({ width: 854, height: 480, rate: 60 });
    near(rate.facts.frames, 120, 2, "the rate set: frames at 60 fps");

    // Both set: Fast changes only the encoder, so the file has the project's own size and rate.
    const both = await exportOf(p, "fast-both-set", QUALITY, {
      slot: slotOf({ size: true, fps: true, quality: false }),
    });
    expect(picture(both)).toEqual({ width: 1280, height: 720, rate: 60 });
    near(both.facts.frames, 120, 2, "size and rate set: frames at 60 fps");

    // A slot whose flags are not flags is not believed: what the call itself says was set stays (the rate named in the call), the rest is Fast's.
    const garbage = await exportOf(
      p,
      "fast-garbage",
      { ...QUALITY, fps: 60 },
      { slot: slotOf({ size: "yes", fps: "yes" }) },
    );
    expect(picture(garbage)).toEqual({ width: 854, height: 480, rate: 60 });
    near(garbage.facts.frames, 120, 2, "a slot nobody can read: frames at 60 fps");
    for (const made of [size, rate, both, garbage]) await expectEncoder(made, { fast: true });
  });

  it("D2. the quality the person set stays (High is not lowered), and Fast starts on Medium where none was set", async () => {
    // The two artifacts: the quality x264 wrote into the delivered file (crf 18 for High, 23 for Medium, 28 for Low) and the owner's table. The processor is asked for
    // (the Graphics chip Off), because only x264 says its quality in the file.
    const p = await p720();
    const high = await exportOf(
      p,
      "fast-high",
      { resolution: "480p", quality: "high" },
      { slot: slotOf({ size: false, fps: false, quality: true }), chip: "off" },
    );
    expect(optionOf(high.x264!, "crf")).toBe("18.0");
    expect(picture(high)).toEqual({ width: 854, height: 480, rate: 30 });
    // Nothing in the call names a quality, and the dialog says none was set: Fast's own, Medium.
    const untouched = await exportOf(p, "fast-untouched", {}, { slot: FAST, chip: "off" });
    expect(optionOf(untouched.x264!, "crf")).toBe("23.0");
    expect(picture(untouched)).toEqual({ width: 854, height: 480, rate: 30 });
    for (const made of [high, untouched]) await expectEncoder(made, { fast: true, chipOff: true });
  });

  it("E. the chat and MCP doors never take Fast: no slot is Quality in every byte, with the switch on, and a Fast slot with the switch off is too", async () => {
    // The two artifacts: Quality's delivered file and the file the same call gets with no slot (the MCP door) and with a Fast slot while the server's switch is off:
    // the sizes, the rates and the frames decoded from each, and the commands the tool handed the process (the same, but for the staging file's name).
    const p = await p720at60();
    const quality = await quality60();
    const mcp = await exportOf(p, "mcp", QUALITY, { surface: "mcp" });
    __setExportFlag("quick_route", false);
    let off: Delivered;
    try {
      off = await exportOf(p, "switch-off", QUALITY, { slot: FAST });
    } finally {
      __setExportFlag("quick_route", true);
    }

    near(quality.facts.frames, 120, 2, "Quality's frames at 60 fps");
    for (const made of [mcp, off]) {
      expect(picture(made), made.name).toEqual({ width: 1280, height: 720, rate: 60 });
      expect(made.facts.frames, `${made.name}: frames`).toBe(quality.facts.frames);
      expectSameVideo(quality, made, 1 / 60);
      expect(scrubbed(made.command), `${made.name}: the command, Quality's`).toEqual(
        scrubbed(quality.command),
      );
      await expectEncoder(made, { fast: false });
    }
    // Equal is no proof if both are empty: the same call with a Fast slot and the switch on is another file.
    const fast = (await slotOnly60()).auto;
    expect(picture(fast)).toEqual({ width: 854, height: 480, rate: 30 });
    expect(scrubbed(fast.command)).not.toEqual(scrubbed(quality.command));
  });

  it("F. the encoder, from the file itself: the chip if this PC's chip passed the app's test, else x264 veryfast; Quality is x264 at its default speed", async () => {
    // The two artifacts for each export: the command the tool handed the process and the bytes of the delivered file (x264 writes its own settings into every
    // stream it makes; a graphics chip's file has none). The oracle for this PC is the app's own chip lookup, run once before the export.
    const found = await pcChip();
    const quality = await quality720();
    const fast = await dialog720();
    const wantCodec = found.chip ? CHIP_CODEC[found.chip.maker] : "libx264";

    expect(flag(fast.command, "-c:v"), "the encoder in Fast's command").toBe(wantCodec);
    if (found.chip) {
      expect(flag(fast.command, "-preset")).not.toBe("veryfast");
      expect(fast.x264, "a chip's file carries no x264 text").toBeNull();
    } else {
      expect(flag(fast.command, "-preset"), "the processor's lighter setting").toBe("veryfast");
      expect(fast.x264, "the file carries x264's own text").not.toBeNull();
      expect(speedOf(fast.x264!), "the speed x264 says it ran at").toBe("veryfast");
      expect(optionOf(fast.x264!, "crf"), "Medium").toBe("23.0");
    }
    await expectEncoder(fast, { fast: true });

    // Quality: x264 at its own default speed, whatever this PC's chip.
    expect(flag(quality.command, "-c:v")).toBe("libx264");
    expect(flag(quality.command, "-preset")).toBeUndefined();
    expect(quality.x264, "Quality's file carries x264's own text").not.toBeNull();
    expect(speedOf(quality.x264!)).toBe("medium");
    expect(optionOf(quality.x264!, "crf")).toBe("23.0");
    await expectEncoder(quality, { fast: false });
  });

  it("F2. with the person's Graphics chip switch Off, Fast is x264 veryfast whatever the chip, and the file says so", async () => {
    // The two artifacts: the command the tool handed the process and the delivered file's own x264 text, for Fast with the switch Off. The chip may have passed its
    // test (the PC's own answer is in F): Off beats it.
    const found = await pcChip();
    const off = await slotOnly720();
    log(
      `chip switch Off: this PC's chip would have been ${found.chip ? found.chip.maker : "none"}`,
    );
    expect(flag(off.command, "-c:v")).toBe("libx264");
    expect(flag(off.command, "-preset")).toBe("veryfast");
    expect(off.x264, "the file carries x264's own text").not.toBeNull();
    expect(speedOf(off.x264!)).toBe("veryfast");
    expect(optionOf(off.x264!, "crf")).toBe("23.0");
    expect(picture(off)).toEqual({ width: 854, height: 480, rate: 30 });
    await expectEncoder(off, { fast: true, chipOff: true });
  });

  // The owner's table on real files: the project, then the picture and the rate of the file Fast delivers for it with nothing set (the size one rung below by the
  // short side where there is one; the rate halved down to 30 at most and never raised). The two artifacts: the delivered file and the owner's table, with its frame count.
  const LADDER: [string, Shape, { width: number; height: number; rate: number }][] = [
    ["1920x1080 at 30 gives 720p", { w: 1920, h: 1080, fps: 30 }, { width: 1280, height: 720, rate: 30 }],
    ["1280x720 at 50 gives 480p at 25 (halved)", { w: 1280, h: 720, fps: 50 }, { width: 854, height: 480, rate: 25 }],
    ["1280x720 at 24 gives 480p at 24 (never raised)", { w: 1280, h: 720, fps: 24 }, { width: 854, height: 480, rate: 24 }],
    ["854x480 at 60: the size stays, the rate caps at 30", { w: 854, h: 480, fps: 60 }, { width: 854, height: 480, rate: 30 }],
  ]; // prettier-ignore
  it.each(LADDER)("G. the ladder: %s", async (_name, shape, want) => {
    const fast = await exportOf(await project(shape), "fast", QUALITY, { slot: FAST });
    expect(picture(fast)).toEqual(want);
    near(fast.facts.frames, want.rate * SECONDS, 2, "frames");
    near(fast.facts.videoS, SECONDS, 0.1, "video length in seconds");
    expect(fast.facts.streams).toEqual({ video: 1, audio: 1 });
    await expectEncoder(fast, { fast: true });
  });
});
