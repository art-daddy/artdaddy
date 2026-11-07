// What one look at footage did, for the telemetry: how many frames it made, how each came to exist, where the time went
// and what kind of source it read. Pure: marks in, a report out.
//
// A look is inspect_media or inspect_timeline reading frames out of a person's file. The slow ones (a minute, ten) kept
// coming back in new shapes because nothing recorded where a look spent its time: the call's total was all there was.
// This keeps the facts that tell them apart, all of them numbers or one short label (a codec such as "hevc"), never a
// file name, a path or what a picture shows.
import type { LookOutcome } from "../api/agentEvents";

export type LookTool = "inspect_media" | "inspect_timeline";

/** How one frame came to exist: `cached` (an earlier look's file was reused), `software` (decoded without the graphics
 *  chip), `gpu` (decoded by it), `retried` (the chip failed and software redid it) or `failed` (it could not be made). */
export type FrameMode = "cached" | "software" | "gpu" | "retried" | "failed";
const MODES: ReadonlySet<string> = new Set<FrameMode>([
  "cached",
  "software",
  "gpu",
  "retried",
  "failed",
]);

/** Rounded facts about a source video, from the probe the look already ran. Each is absent when unknown. */
export interface SourceFacts {
  codec?: string;
  width?: number;
  height?: number;
  dur_s?: number;
  kbps?: number;
}

export interface FrameStat {
  mode: FrameMode;
  ms: number;
  /** Sources this frame opened (a timeline frame composites several). One when not said. */
  layers?: number;
  source?: SourceFacts;
}

export interface LookReport {
  tool: LookTool;
  outcome: LookOutcome;
  /** The whole look, from its start to its report. */
  ms: number;
  /** From the first frame starting to the last one ending: the lanes run side by side, so this is not their sum. */
  frames_ms: number;
  /** The slowest single frame that had to be made (a reused file costs nothing and is not counted). */
  slowest_ms: number;
  /** Frames the look wanted. The next four partition it with the frames made in software: every frame is exactly one. */
  frames: number;
  cached: number;
  gpu: number;
  retried: number;
  failed: number;
  /** The most sources any one frame opened. */
  layers: number;
  /** The source of the slowest frame that has facts (else any frame's, else the look's own). */
  source?: SourceFacts;
}

const wholeMs = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
const positive = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;

/** A codec name as ffprobe spells it ("hevc", "h264", "prores", "pcm_s16le"). Anything that is not a short name of that
 *  alphabet (a path, a sentence) is dropped, never trimmed into something that merely looks like one. */
const CODEC = /^[a-z0-9][a-z0-9_.-]{0,19}$/;
export function codecLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return CODEC.test(name) ? name : undefined;
}

/** The rounded facts of a source from a probe result (media.ts `probePath`): its video stream's codec and size, its
 *  length and its average data rate. Undefined when it says none of them. */
export function sourceFacts(probe: unknown): SourceFacts | undefined {
  if (probe === null || typeof probe !== "object") return undefined;
  const p = probe as Record<string, unknown>;
  const video =
    p.video !== null && typeof p.video === "object" ? (p.video as Record<string, unknown>) : null;
  const rawDur = typeof p.duration_s === "number" && p.duration_s > 0 ? p.duration_s : 0;
  const dur = positive(rawDur);
  const bytes = typeof p.size_bytes === "number" && p.size_bytes > 0 ? p.size_bytes : 0;
  const out: SourceFacts = {};
  const codec = codecLabel(video?.codec ?? video?.codec_name);
  if (codec) out.codec = codec;
  const width = positive(video?.width);
  const height = positive(video?.height);
  if (width) out.width = width;
  if (height) out.height = height;
  if (dur) out.dur_s = dur;
  const kbps = rawDur && bytes ? positive((bytes * 8) / 1000 / rawDur) : undefined;
  if (kbps) out.kbps = kbps;
  return Object.keys(out).length ? out : undefined;
}

/** The heavier of two sources to decode: the one with more pixels (an unknown size counts as none; a tie keeps the first). */
export function heavierSource(
  a: SourceFacts | undefined,
  b: SourceFacts | undefined,
): SourceFacts | undefined {
  if (!b) return a;
  if (!a) return b;
  const pixels = (s: SourceFacts): number => (s.width ?? 0) * (s.height ?? 0);
  return pixels(b) > pixels(a) ? b : a;
}

/** Collects the marks of ONE look and turns them into a report. The clock is injected and read through a monotone
 *  filter, so a clock that jumps back can make a time look short but never negative. Once `finish` has reported, the look
 *  is final: a late frame (a lane that ignored Stop) changes nothing. */
export class LookStats {
  private last: number;
  private readonly began: number;
  private asked = 0;
  private framesFrom: number | null = null;
  private framesTo: number | null = null;
  private readonly stats: FrameStat[] = [];
  private halted = false;
  private fallback: SourceFacts | undefined;
  private report: LookReport | null = null;

  constructor(
    readonly tool: LookTool,
    private readonly clock: () => number = Date.now,
  ) {
    this.last = Math.round(clock());
    this.began = this.last;
  }

  private now(): number {
    const t = Math.round(this.clock());
    if (Number.isFinite(t) && t > this.last) this.last = t;
    return this.last;
  }

  /** Did the look do anything worth a report: ask for a frame, or make one? */
  get touched(): boolean {
    return this.asked > 0 || this.stats.length > 0;
  }

  /** The look means to make `n` frames. */
  plan(n: number): void {
    if (this.report) return;
    this.asked = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  }

  /** The source of any frame that does not say its own (a media look reads one file). */
  source(facts: SourceFacts | undefined): void {
    if (!this.report) this.fallback = facts;
  }

  /** Frame making begins (the first call counts; lanes start together). */
  framesBegin(): void {
    if (this.report) return;
    if (this.framesFrom === null) this.framesFrom = this.now();
  }

  /** Frame making ends (the last call counts). */
  framesEnd(): void {
    if (!this.report) this.framesTo = this.now();
  }

  /** One frame is done, one way or another. Frames finish in any order. */
  frame(stat: FrameStat): void {
    if (this.report) return;
    const mode: FrameMode = MODES.has(stat.mode) ? stat.mode : "failed";
    this.stats.push({
      mode,
      ms: wholeMs(stat.ms),
      layers: positive(stat.layers) ?? 1,
      ...(stat.source ? { source: stat.source } : {}),
    });
  }

  /** The person pressed Stop (or the turn ended) before the look finished. */
  stopped(): void {
    if (!this.report) this.halted = true;
  }

  /** The report. Said once: later calls return the same one. */
  finish(): LookReport {
    if (this.report) return this.report;
    const at = this.now();
    const frames = Math.max(this.asked, this.stats.length);
    let cached = 0;
    let gpu = 0;
    let retried = 0;
    let failed = frames - this.stats.length; // a frame never reported did not come to exist
    for (const s of this.stats) {
      if (s.mode === "cached") cached += 1;
      else if (s.mode === "gpu") gpu += 1;
      else if (s.mode === "retried") retried += 1;
      else if (s.mode === "failed") failed += 1;
    }
    const made = frames - failed;
    const outcome: LookOutcome = this.halted
      ? "stopped"
      : frames === 0 || made === 0
        ? "failed"
        : failed === 0
          ? "done"
          : "partial";
    const slowFirst = this.stats.filter((s) => s.mode !== "cached").sort((a, b) => b.ms - a.ms);
    const withFacts = [...slowFirst, ...this.stats.filter((s) => s.mode === "cached")].find(
      (s) => s.source,
    );
    const source = withFacts?.source ?? this.fallback;
    this.report = {
      tool: this.tool,
      outcome,
      ms: Math.max(0, at - this.began),
      frames_ms:
        this.framesFrom === null ? 0 : Math.max(0, (this.framesTo ?? at) - this.framesFrom),
      slowest_ms: slowFirst.length ? slowFirst[0].ms : 0,
      frames,
      cached,
      gpu,
      retried,
      failed,
      layers: this.stats.reduce((most, s) => Math.max(most, s.layers ?? 1), 0),
      ...(source ? { source } : {}),
    };
    return this.report;
  }
}

/** Where a look's report goes: the tool context's `look` (set by the host, which knows the call and who made it). */
export interface LookSink {
  look?: (report: LookReport) => void;
}

/** Say what the look did, once, if it did anything. A failure to report is never the look's failure. */
export function reportLook(sink: LookSink, stats: LookStats, signal?: AbortSignal): void {
  try {
    if (signal?.aborted) stats.stopped();
    if (sink.look && stats.touched) sink.look(stats.finish());
  } catch {
    /* telemetry must never cost a look its answer */
  }
}
