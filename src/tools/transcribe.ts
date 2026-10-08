// get_transcript (client tool): word-level transcription via a bundled
// whisper.cpp binary, so audio never leaves the machine (offline-capable). Ports
// mechanical.py::get_transcript_tool — ffmpeg extracts a 16 kHz mono WAV,
// whisper-cli emits token-level JSON, and we reshape it into the canonical
// transcript schema that the rest of the pipeline reads. Each media file has a
// deterministic transcript path, so get_transcript returns an existing
// transcript instead of re-transcribing, so explicit callers share one cache.
// The ggml model is downloaded into app-data only when transcription is requested.
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";
import { MediaOfflineError } from "./refState";
import { joinPath } from "./store";
import { beginSessionActivity } from "../observability/crashWatch";
import { ArtDaddyError } from "../lib/errors";
import {
  clearModelDownload,
  megabytes,
  percent,
  reportModelDownload,
} from "../store/modelDownload";
import { loadTimeline } from "../timeline/engine";
import { findClip } from "../timeline/helpers";
import type { Clip } from "../timeline/model";
import { UNSPACED_CHAR } from "../timeline/wordJoin";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
// Fixed transcription model. `get_transcript` does NOT expose model selection —
// everything (the tool, inspect_media, and captions) uses this one
// model so the model can never downgrade to base/tiny or pick an inconsistent one.
const DEFAULT_MODEL = "small";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve";

export interface WhisperModelSpec {
  revision: string;
  bytes: number;
  sha256: string;
}

export const WHISPER_MODELS: Readonly<Record<string, WhisperModelSpec>> = {
  small: {
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    bytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
};

function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}
function parentOf(p: string): string {
  const n = normSep(p).replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM:SS" (ports segmentor_tool.format_timestamp). */
export function fmtTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const whole = Math.trunc(safe);
  return `${pad2(Math.trunc(whole / 3600))}:${pad2(Math.trunc((whole % 3600) / 60))}:${pad2(whole % 60)}`;
}
/** "HH:MM:SS.mmm" (ports segmentor_tool.format_timestamp_precise). */
export function fmtTimestampPrecise(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  let whole = Math.trunc(safe);
  let ms = Math.round((safe - whole) * 1000);
  if (ms === 1000) {
    whole += 1;
    ms = 0;
  }
  return `${pad2(Math.trunc(whole / 3600))}:${pad2(Math.trunc((whole % 3600) / 60))}:${pad2(whole % 60)}.${String(ms).padStart(3, "0")}`;
}

/** app-data root inferred from the active project dir (<data_root>/projects/<id>). */
function dataRootOf(projectDir: string): string {
  return parentOf(parentOf(projectDir));
}
export function whisperModelPath(projectDir: string, size: string): string {
  return joinPath(dataRootOf(projectDir), "models", `ggml-${size}.bin`);
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
}
interface WhisperSeg {
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: WhisperToken[];
}
interface WhisperCppJson {
  result?: { language?: string };
  transcription?: WhisperSeg[];
}

interface WordPayload {
  word_id: number;
  segment_id: number;
  index_in_segment: number;
  word: string;
  start_seconds: number;
  end_seconds: number;
  start_timestamp: string;
  end_timestamp: string;
  probability: number;
}
interface SegPayload {
  segment_id: number;
  start_seconds: number;
  end_seconds: number;
  start_timestamp: string;
  end_timestamp: string;
  text: string;
  words: WordPayload[];
}
export interface ParsedTranscript {
  language: string | null;
  duration_seconds: number;
  segments: SegPayload[];
  words: WordPayload[];
}

// whisper.cpp special tokens look like [_BEG_], [_TT_123]; drop them + blanks.
function isSpecialToken(t: string): boolean {
  return /^\s*\[_/.test(t) || t.trim() === "";
}

/** whisper writes the sounds it hears, but does not transcribe, as subtitle-style annotations:
 *  "(eerie music)", "[Music]", "[BLANK_AUDIO]", "[NON-ENGLISH SPEECH]". 176 whisper outputs cached
 *  on the dev machine held over 30 kinds, parentheses the most common. They are not speech: as
 *  WORDS they reach every caption and read as talk to anything that times speech (UJ-004). Only a
 *  span that closes inside its segment counts, so a stray "(" in real speech keeps its words. */
const ANNOTATION = /\[[^[\]]*\]|\([^()]*\)/g;
/** Something was said: a letter or a digit in any script. */
const SAID = /[\p{L}\p{N}]/u;

/** Which characters of `text` lie inside an annotation. */
function annotationMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(ANNOTATION)) mask.fill(true, m.index, m.index + m[0].length);
  return mask;
}

/** Chinese and Japanese are written without spaces between words. whisper's tokens carry none there
 *  either, so the space rule makes a whole sentence one "word": a caption per sentence, and nothing a
 *  word edit could cut inside (UJ-004: a real 60 s Japanese clip came back as 5 words). Which scripts
 *  those are is decided in ONE place, with how such words are joined again for display. */
let wordSegmenter: Intl.Segmenter | null | undefined;
/** A dictionary word-breaker. It goes by the characters' script, so no locale is needed. */
function segmenter(): Intl.Segmenter | null {
  if (wordSegmenter === undefined)
    wordSegmenter =
      typeof Intl === "object" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "word" })
        : null;
  return wordSegmenter;
}

/** One token's visible text inside a word being built: where it sits in the word's text, its time. */
interface Piece {
  at: number;
  end: number;
  from: number;
  to: number;
  p: number | undefined;
}
interface Cut {
  text: string;
  from: number;
  to: number;
  ps: number[];
}

/** Cut a run of unspaced text into words where the word-breaker says they end. Punctuation joins the
 *  word before it, as "Hello," does in a spaced language (or the word after, at the start); each
 *  word's time runs from its first character's token to its last one's. Null when the runtime has
 *  no word-breaker, and the run stays one word. */
function cutWords(text: string, pieces: Piece[]): Cut[] | null {
  const seg = segmenter();
  if (!seg) return null;
  const spans: Array<{ start: number; end: number }> = [];
  let lead: number | null = null;
  for (const s of seg.segment(text)) {
    const start = s.index;
    const end = start + s.segment.length;
    if (!s.segment.trim()) continue;
    if (s.isWordLike) {
      spans.push({ start: lead ?? start, end });
      lead = null;
    } else if (spans.length) spans[spans.length - 1].end = end;
    else lead ??= start;
  }
  if (lead !== null) spans.push({ start: lead, end: text.length }); // punctuation and nothing else
  const pieceAt = (i: number): Piece => pieces.find((p) => i < p.end) ?? pieces[pieces.length - 1];
  return spans.map(({ start, end }) => ({
    text: text.slice(start, end).trim(),
    from: pieceAt(start).from,
    to: pieceAt(end - 1).to,
    ps: pieces
      .filter((p) => p.at < end && p.end > start && p.p !== undefined)
      .map((p) => p.p as number),
  }));
}

/** Reshape whisper.cpp `-ojf` JSON into the canonical transcript schema. Words
 *  are reconstructed by merging BPE tokens (a leading space starts a new word).
 *  A segment's text is kept whole; its annotations never become words. */
export function parseWhisperCppJson(raw: string): ParsedTranscript {
  return parseWhisperCpp(JSON.parse(raw) as WhisperCppJson);
}

/** {@link parseWhisperCppJson} for whisper's JSON already read: what the app cache holds, so a
 *  change to how words are cut applies to every transcript already made. */
function parseWhisperCpp(data: WhisperCppJson): ParsedTranscript {
  const trans = data.transcription ?? [];
  const language = data.result?.language ?? null;
  const segments: SegPayload[] = [];
  const words: WordPayload[] = [];
  let segId = 0;
  let maxEndMs = 0;

  for (const seg of trans) {
    const segText = (seg.text ?? "").trim();
    if (!segText) continue;
    segId += 1;
    const segFrom = seg.offsets?.from ?? 0;
    const segTo = seg.offsets?.to ?? 0;
    maxEndMs = Math.max(maxEndMs, segTo);
    const segStart = segFrom / 1000;
    const segEnd = segTo / 1000;
    const segWords: WordPayload[] = [];
    const pushWord = (text: string, fromMs: number, toMs: number, ps: number[]): void => {
      const w: WordPayload = {
        word_id: words.length + 1,
        segment_id: segId,
        index_in_segment: segWords.length,
        word: text,
        start_seconds: fromMs / 1000,
        end_seconds: toMs / 1000,
        start_timestamp: fmtTimestampPrecise(fromMs / 1000),
        end_timestamp: fmtTimestampPrecise(toMs / 1000),
        probability: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0,
      };
      segWords.push(w);
      words.push(w);
    };

    // An annotation is split over several BPE tokens ("(", "e", "erie", " music", ")"), so it is
    // found in the segment's joined token text and each token keeps only its characters outside.
    const toks = (seg.tokens ?? []).filter((t) => !isSpecialToken(t.text ?? ""));
    const mask = annotationMask(toks.map((t) => t.text ?? "").join(""));
    let at = 0;
    // `residue`: the word began where an annotation ended, inside one token, so it counts only if
    // it says something ("[Music]." leaves a bare ".").
    let cur: { text: string; pieces: Piece[]; residue: boolean } | null = null;
    const flush = (): void => {
      if (!cur) return;
      const wt = cur.text.trim();
      if (wt && (!cur.residue || SAID.test(wt))) {
        const cut = UNSPACED_CHAR.test(wt) ? cutWords(cur.text, cur.pieces) : null;
        if (cut) for (const w of cut) pushWord(w.text, w.from, w.to, w.ps);
        else {
          const { pieces } = cur;
          const ps = pieces.filter((p) => p.p !== undefined).map((p) => p.p as number);
          pushWord(wt, pieces[0].from, pieces[pieces.length - 1].to, ps);
        }
      }
      cur = null;
    };

    for (const tok of toks) {
      const raw = tok.text ?? "";
      let tt = "";
      for (let i = 0; i < raw.length; i++) if (!mask[at + i]) tt += raw[i];
      const opensMasked = mask[at] === true; // blank tokens were filtered: `raw` is never empty
      at += raw.length;
      // Nothing said in this piece: an annotation, or the space before one. Either ends a word,
      // and lends its time to none.
      if (tt.trim() === "") {
        flush();
        continue;
      }
      const from = tok.offsets?.from ?? segFrom;
      const to = tok.offsets?.to ?? from;
      const p = tok.p ?? undefined;
      if (opensMasked || /^\s/.test(tt) || cur === null) {
        flush();
        cur = { text: tt, pieces: [{ at: 0, end: tt.length, from, to, p }], residue: opensMasked };
      } else {
        cur.pieces.push({ at: cur.text.length, end: cur.text.length + tt.length, from, to, p });
        cur.text += tt;
      }
    }
    flush();

    // No token data at all -> the segment's speech is a single word. A segment whose tokens were
    // all annotation has none.
    if (toks.length === 0) {
      const said = segText.replace(ANNOTATION, " ").replace(/\s+/g, " ").trim();
      if (SAID.test(said)) pushWord(said, segFrom, segTo, []);
    }

    segments.push({
      segment_id: segId,
      start_seconds: segStart,
      end_seconds: segEnd,
      start_timestamp: fmtTimestamp(segStart),
      end_timestamp: fmtTimestamp(segEnd),
      text: segText,
      words: segWords,
    });
  }
  return { language, duration_seconds: maxEndMs / 1000, segments, words };
}

interface InstalledModel {
  path: string;
  downloaded: boolean;
}

/** One in-flight install of one pinned model, shared by everything waiting for it.
 *
 *  It owns its OWN cancellation. A caller's signal must never reach the download: the background
 *  indexer and a user's caption request wait on the SAME promise, so a project switch cancelling
 *  the indexer used to cancel the user's request with it — and tell them THEY cancelled. The tap
 *  is turned off only when the last waiter has left. */
class ModelInstall {
  readonly ac = new AbortController();
  readonly promise: Promise<InstalledModel>;
  waiters = 0;
  settled = false;
  received = 0;

  constructor(
    readonly total: number,
    run: (self: ModelInstall) => Promise<InstalledModel>,
    onSettled: () => void,
  ) {
    this.promise = run(this).finally(() => {
      this.settled = true;
      onSettled();
    });
  }
}

const modelDownloads = new Map<string, ModelInstall>();

/** Wait for a shared install under THIS caller's cancellation, without imposing it on the others. */
function joinDownload(dl: ModelInstall, signal: AbortSignal | undefined): Promise<InstalledModel> {
  dl.waiters += 1;
  let left = false;
  const depart = (): void => {
    if (left) return;
    left = true;
    dl.waiters -= 1;
    if (dl.waiters === 0 && !dl.settled) dl.ac.abort();
  };
  return new Promise<InstalledModel>((resolve, reject) => {
    const onAbort = (): void => {
      const got = dl.received;
      depart();
      reject(new Error(modelCancelledMessage(got, dl.total)));
    };
    // Observed unconditionally, even by a caller that has already gone: an unwatched shared
    // rejection surfaces as an unhandled promise rejection and kills the app in dev.
    dl.promise.then(
      (v) => {
        signal?.removeEventListener("abort", onAbort);
        depart();
        resolve(v);
      },
      (e: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        depart();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/** What a stopped download says. It names the thing, its size, how far it got, and that the
 *  bytes survive — "transcription cancelled" said none of that, and no transcription had begun. */
export function modelCancelledMessage(received: number, total: number): string {
  return (
    `speech model download cancelled at ${percent(received, total)}% of ${megabytes(total)} MB — ` +
    `the part already downloaded is kept and resumes next time`
  );
}

/** Bytes between progress reports: ~116 updates across the model, cheap enough to publish from
 *  the read loop and often enough that the percentage visibly moves. */
const PROGRESS_STEP = 4 * 1024 * 1024;

async function validModel(
  ctx: ClientToolContext,
  path: string,
  spec: WhisperModelSpec,
): Promise<boolean> {
  if (!(await ctx.store.exists(path))) return false;
  const size = await ctx.store.byteSize(path);
  if (size !== spec.bytes) return false;
  const marker = `${path}.verified.json`;
  if (await ctx.store.exists(marker)) {
    try {
      const verified = JSON.parse(await ctx.store.readText(marker)) as {
        bytes?: number;
        sha256?: string;
      };
      if (verified.bytes === spec.bytes && verified.sha256 === spec.sha256) {
        return true;
      }
    } catch {
      /* stale/corrupt marker: verify the real file below */
    }
  }
  const probe = await ctx.store.probeMedia(path, 0);
  if (!probe || probe.size !== spec.bytes || probe.sha256 !== spec.sha256) return false;
  await ctx.store.writeText(marker, JSON.stringify({ bytes: spec.bytes, sha256: spec.sha256 }));
  return true;
}

/** Ensure the pinned ggml model is present in app-data. The response is streamed into a
 * temporary sibling, verified natively, and atomically promoted, so the webview never holds
 * the 465 MiB model and an interrupted download is never mistaken for a complete cache hit.
 * An interrupted download RESUMES: the partial file survives, and only bytes proven wrong
 * (bad checksum, wrong length, a server that ignored our Range) are thrown away. */
export async function ensureWhisperModel(
  ctx: ClientToolContext,
  size: string = DEFAULT_MODEL,
  fetchImpl: typeof fetch = globalThis.fetch,
  injectedSpec?: WhisperModelSpec,
): Promise<{ path: string; downloaded: boolean }> {
  const spec = injectedSpec ?? WHISPER_MODELS[size];
  if (!spec) throw new Error(`unsupported whisper model '${size}'`);
  const path = whisperModelPath(ctx.store.projectDir, size);
  if (await validModel(ctx, path, spec)) return { path, downloaded: false };
  if (!fetchImpl) throw new Error("no network available to download the whisper model");
  if (!ctx.store.canStreamDownload) {
    throw new Error("this platform cannot stream and atomically install the whisper model");
  }
  const key = `${path}\u0000${spec.sha256}`;
  const existing = modelDownloads.get(key);
  if (existing) return joinDownload(existing, ctx.signal);

  const install = new ModelInstall(
    spec.bytes,
    (self) => downloadModel(ctx, path, size, spec, fetchImpl, self),
    () => modelDownloads.delete(key),
  );
  modelDownloads.set(key, install);
  return joinDownload(install, ctx.signal);
}

async function downloadModel(
  ctx: ClientToolContext,
  path: string,
  size: string,
  spec: WhisperModelSpec,
  fetchImpl: typeof fetch,
  self: ModelInstall,
): Promise<InstalledModel> {
  // Keyed by the CONTENT, not just the model name: `ggml-small.bin` keeps its path across
  // revisions, so a part left by the previous pinned build would otherwise be resumed into the
  // new one and fail its checksum — a guaranteed wasted download for every user on a bump.
  const tmp = `${path}.${spec.sha256.slice(0, 12)}.part`;
  const marker = `${path}.verified.json`;
  const signal = self.ac.signal;
  // Only bytes we can PROVE are wrong. A cancellation or a dropped connection leaves a
  // perfectly good prefix, and discarding it is what made the user restart from zero.
  let discardPart = false;
  const finishActivity = beginSessionActivity("whisper-model-download");
  try {
    const url = `${HF_BASE}/${spec.revision}/ggml-${size}.bin`;
    let have = (await ctx.store.byteSize(tmp)) ?? 0;
    if (have < 0 || have >= spec.bytes) {
      await ctx.store.remove(tmp).catch(() => undefined);
      have = 0;
    }
    const resp = await fetchImpl(url, {
      signal,
      headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
    });
    if (resp.status === 416) {
      // Our part is at or past the end of the file the server holds, so it is not this model.
      discardPart = true;
      throw new Error("whisper model download could not resume from the partial file");
    }
    if (!resp.ok) throw new Error(`whisper model download failed: HTTP ${resp.status}`);
    if (!resp.body) throw new Error("whisper model download cannot be streamed");
    // A server that ignores Range answers 200 with the WHOLE file. Appending that to what we
    // already had would concatenate two copies and leave the checksum as the only thing between
    // the user and a doubled file — start the part over rather than trust the length check.
    if (have > 0 && resp.status !== 206) {
      await ctx.store.remove(tmp).catch(() => undefined);
      have = 0;
    }
    const declaredHeader = resp.headers.get("content-length");
    const declared = declaredHeader === null ? null : Number(declaredHeader);
    const remaining = spec.bytes - have;
    if (declared !== null && Number.isFinite(declared) && declared !== remaining) {
      discardPart = true;
      throw new Error(
        `whisper model size mismatch: expected ${remaining}, server sent ${declared}`,
      );
    }

    const reader = resp.body.getReader();
    let received = have;
    let published = -1;
    const publish = (): void => {
      if (received === published) return;
      published = received;
      self.received = received;
      reportModelDownload(received, spec.bytes);
    };
    publish();
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
        if (received + value.length > spec.bytes) {
          discardPart = true;
          throw new Error(`whisper model exceeded expected size ${spec.bytes}`);
        }
        // `received` tracks what is ON DISK, so a failed append cannot inflate it: the next
        // attempt re-reads the file's real size anyway, which keeps resume self-correcting.
        if (!(await ctx.store.appendBytes(tmp, value))) {
          if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
          throw new Error("whisper model download stopped before it could be written");
        }
        received += value.length;
        if (received - published >= PROGRESS_STEP || received === spec.bytes) publish();
      }
      completed = true;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
    if (received !== spec.bytes) {
      // Truncated, not wrong: keep the prefix so the next attempt picks up where this stopped.
      throw new Error(`whisper model was incomplete: expected ${spec.bytes}, received ${received}`);
    }
    const probe = await ctx.store.probeMedia(tmp, 0);
    if (!probe || probe.size !== spec.bytes || probe.sha256 !== spec.sha256) {
      discardPart = true; // proven wrong; resuming these bytes would never converge
      throw new Error("whisper model failed checksum validation");
    }
    if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
    if (await ctx.store.exists(path)) await ctx.store.remove(path);
    await ctx.store.remove(marker).catch(() => undefined);
    await ctx.store.rename(tmp, path);
    await ctx.store
      .writeText(marker, JSON.stringify({ bytes: spec.bytes, sha256: spec.sha256 }))
      .catch(() => undefined);
    return { path, downloaded: true };
  } finally {
    if (discardPart) await ctx.store.remove(tmp).catch(() => undefined);
    clearModelDownload();
    finishActivity();
  }
}

/** Run the whisper pipeline (ensure model -> ffmpeg 16 kHz mono WAV -> whisper-cli
 *  JSON -> parse) and return the parsed transcript. Cached on disk by (src, size),
 *  so a repeat call (e.g. inspect_media after transcribe, or two inspects of the
 *  same clip) reuses the WAV + JSON. Throws a descriptive Error on any step
 *  failure. Shared by the transcribe tool and inspect_media. */
/** A window of SOURCE SECONDS to bound the work. Absent = the whole file. */
export interface TranscribeWindow {
  start?: number | null;
  end?: number | null;
}

/** whisper defaults to 4 threads whatever the machine has. Leave a couple of cores for the
 *  UI and ffmpeg, and stop at 8 — the decoder scales poorly past that. */
function whisperThreads(): string {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  return String(Math.max(1, Math.min(8, cores - 2)));
}

/** The cache-key suffix that keeps a windowed transcript from ever being served as a full one
 *  ("" for the whole file). A window is transcribed from its own extracted audio (see runWhisper),
 *  so whisper itself is never given `-ot`/`-d`. */
function windowArgs(w?: TranscribeWindow | null): { key: string } {
  const start = Math.max(0, Number(w?.start) || 0);
  const rawEnd = Number(w?.end);
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
  if (!start && end === null) return { key: "" };
  return { key: `|w${Math.floor(start * 1000)}-${end === null ? "" : Math.ceil(end * 1000)}` };
}

/** One run per output path. Whisper is minutes long and BOTH the background indexer and
 *  inspect_media ask for the same file: without this the second caller sees "no transcript
 *  yet", starts its own, and the machine grinds two identical 20-minute jobs at once. */
const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = run().finally(() => inflight.delete(key));
  inflight.set(key, started);
  return started;
}

// whisper.cpp wants 16 kHz mono PCM WAV. Bump the rev when the extract recipe changes.
const TRANSCODE_WAV_REV = 1;

/** Where the whole-file 16 kHz extract of `src` lives (whether or not it exists yet). */
function wavPathFor(ctx: ClientToolContext, src: string): Promise<string> {
  return ctx.store.prepareArtifact(
    `transcribe/${shortHash(`${src}|16k|r${TRANSCODE_WAV_REV}`)}.wav`,
  );
}

/** Extract [start, end) seconds of `src`'s audio, or the whole of it, as whisper's 16 kHz WAV.
 *
 *  Written under a temporary name and renamed into place, so `exists(wav)` means COMPLETE. It was
 *  written straight to `wav`, and a window asked for while the whole file was still being extracted
 *  read the half-written file; a failed extraction also left one behind for the next call to reuse.
 *  Without rename (web) it writes in place, as before. */
async function extractWav(
  ctx: ClientToolContext,
  src: string,
  wav: string,
  span?: { start: number; end: number | null },
): Promise<string> {
  if (await ctx.store.exists(wav)) return wav;
  return once(`wav\u0000${wav}`, async () => {
    const out = ctx.store.canRename ? wav.replace(/\.wav$/, `.${scratchToken()}.tmp.wav`) : wav;
    const seek: string[] = [];
    if (span && span.start > 0) seek.push("-ss", span.start.toFixed(3));
    if (span && span.end !== null) seek.push("-to", span.end.toFixed(3));
    const conv = await ctx.runner.run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        ...seek,
        "-i",
        src,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        out,
      ],
      ctx.signal,
    );
    if (conv.code !== 0 || !(await ctx.store.exists(out))) {
      await ctx.store.remove(out).catch(() => undefined);
      if (ctx.signal?.aborted) throw new Error("transcription cancelled");
      throw new Error(
        `audio extraction failed (code=${conv.code}): ${stderrExcerpt(conv.stderr, 200)}`,
      );
    }
    if (out !== wav) await ctx.store.rename(out, wav);
    return wav;
  });
}

/** A name part unique to one extraction, so two never share a scratch file. */
let scratchSeq = 0;
function scratchToken(): string {
  scratchSeq = (scratchSeq + 1) % 1e6;
  return `${Date.now().toString(36)}${scratchSeq.toString(36)}`;
}

/** whisper's JSON for a window extracted on its own starts at 0; move every offset onto the
 *  SOURCE timeline, where `-ot` on the whole file would have put it. */
function shiftWhisperJson(data: WhisperCppJson, shiftMs: number): void {
  const move = (o?: { from?: number; to?: number }): void => {
    if (!o) return;
    if (typeof o.from === "number") o.from += shiftMs;
    if (typeof o.to === "number") o.to += shiftMs;
  };
  for (const seg of data.transcription ?? []) {
    move(seg.offsets);
    for (const tok of seg.tokens ?? []) move(tok.offsets);
  }
}

/** Windows kills a process that cannot resolve its imports BEFORE a line of its code runs, so
 *  there is no stderr to read and no exit status from whisper itself — only an NTSTATUS. One
 *  user's machine lacked the Visual C++ runtime whisper-cli imports and produced 56 of these in
 *  a single session: identical, empty, and indistinguishable from a broken media file. */
const WINDOWS_LOAD_FAILURES: ReadonlySet<number> = new Set([
  -1073741515, // 0xC0000135 STATUS_DLL_NOT_FOUND
  -1073741511, // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
  -1073741701, // 0xC000007B STATUS_INVALID_IMAGE_FORMAT
]);

/** The speech engine cannot run on this machine AT ALL. Distinct from "this file failed":
 *  retrying it per asset just repeats the same load failure, so the caller must stop asking. */
export class SpeechEngineUnavailableError extends ArtDaddyError {
  readonly code = "speech_engine_unavailable";
  readonly expected = true;
  constructor(readonly exitCode: number) {
    super("The speech engine could not start on this machine, so audio cannot be transcribed.");
    this.name = "SpeechEngineUnavailableError";
  }
}

/** Duck-typed on purpose: the background indexer resolves this through its dynamic module
 *  record, so an `instanceof` would drag desktop-only transcription into the main bundle. */
export function isSpeechEngineUnavailable(e: unknown): boolean {
  return e instanceof SpeechEngineUnavailableError;
}

/** A failed transcription as the model reads it: our own errors whole, since they lead with what
 *  happened, and the TAIL of anything else, where a subprocess puts its reason. */
export function transcriptionFailureText(e: unknown): string {
  return e instanceof ArtDaddyError ? e.message : String(e).slice(-200);
}

/** The cache keys a transcription request reads: the full transcript's (which answers every
 *  window) and, for a windowed request, the window's own; both null when the file has no
 *  identity. One place, so a peek and a run can never disagree about what is cached. */
async function transcriptKeys(
  ctx: ClientToolContext,
  src: string,
  size: string,
  language: string | undefined,
  window: TranscribeWindow | null | undefined,
): Promise<{
  lang: string;
  full: string | null;
  out: string | null;
  win: ReturnType<typeof windowArgs>;
}> {
  const lang = whisperLanguage(language);
  const win = windowArgs(window);
  // Kept under the FILE, by identity, not under the path a project knows it by (4f): the same
  // bytes in another project, or moved and relinked, are not transcribed again, and a file
  // changed in place is. The language is part of the key, not just the arguments: keyed without
  // it, a Spanish request would be served the English transcript already made, forever. "auto"
  // is in the key too, so nothing made under whisper's English default is served as detected.
  const identity = await ctx.store.fileIdentity(src);
  const full = identity ? `whisper:${TRANSCRIPT_FORMAT}:${identity}:${size}:${lang}` : null;
  const out = full && win.key ? `${full}${win.key}` : full;
  return { lang, full, out, win };
}

/** Bump when what is stored under a transcript key changes meaning. */
const TRANSCRIPT_FORMAT = "v1";
const TRANSCRIPTS = "transcripts";

/** Where the app cache keeps the whole-file transcript of `src` (namespace and key, the key null
 *  when the file has no identity), exactly as {@link runWhisper} and every peek compute it.
 *  Exported so a test can stand in for whisper by putting its output there. */
export async function transcriptCacheSlot(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
): Promise<{ namespace: string; key: string | null }> {
  return {
    namespace: TRANSCRIPTS,
    key: (await transcriptKeys(ctx, src, size, language, null)).full,
  };
}

/** whisper's JSON for `key` from the app cache, or null. */
async function cachedWhisper(
  ctx: ClientToolContext,
  key: string | null,
): Promise<WhisperCppJson | null> {
  if (!key) return null;
  const cache = await ctx.store.appCache();
  const data = cache ? await cache.get<WhisperCppJson>(TRANSCRIPTS, key) : null;
  return data && typeof data === "object" ? data : null;
}

/** The transcript {@link runWhisper} would return for this request, WITHOUT running anything:
 *  the whole file's (which answers every window), or this window's own, or null. */
export async function peekTranscript(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
): Promise<ParsedTranscript | null> {
  const k = await transcriptKeys(ctx, src, size, language, window);
  for (const key of new Set([k.full, k.out])) {
    const data = await cachedWhisper(ctx, key);
    if (data) return parseWhisperCpp(data);
  }
  return null;
}

export async function runWhisper(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
): Promise<ParsedTranscript> {
  const { lang, full, out, win } = await transcriptKeys(ctx, src, size, language, window);
  // A full transcript already answers every window, so a windowed ask must never re-run
  // over one we have — the indexer builds these in the background for exactly this reason.
  const done = (await cachedWhisper(ctx, full)) ?? (await cachedWhisper(ctx, out));
  if (done) return parseWhisperCpp(done);

  // whisper's own output is scratch, written in the project like the audio it reads.
  const scratchBase = await ctx.store.prepareArtifact(
    `transcribe/${shortHash(`${src}|${size}|${lang}${win.key}`)}`,
  );
  return once(out ?? scratchBase, async () => {
    let model: string;
    try {
      model = (await ensureWhisperModel(ctx, size)).path;
    } catch (e) {
      // Do NOT flatten this into "transcription cancelled". Whatever went wrong happened while
      // INSTALLING the model, before a single second of audio was read, and the download's own
      // message is the only one that says so — replacing it is how a 465 MiB download in
      // progress came out the other side looking like a failed transcription.
      throw e instanceof Error ? e : new Error(`whisper model '${size}' unavailable: ${String(e)}`);
    }
    // A window is transcribed from its OWN audio only. Extracting a 2-hour file to transcribe 30
    // seconds of it was most of the wait (UJ-012); and whisper loads the whole file it is handed, so
    // `-ot/-d` on an 80-minute extract took 11.9 s for a 60 s window where the window's own WAV took
    // 7.3 s (QA, 2026-10-03). The window is cut from the whole-file extract when that is on disk
    // (published by rename, so it is complete), else from the source.
    const fullWav = await wavPathFor(ctx, src);
    const start = Math.max(0, Number(window?.start) || 0);
    const rawEnd = Number(window?.end);
    const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
    const wav =
      win.key === ""
        ? await extractWav(ctx, src, fullWav)
        : await extractWav(
            ctx,
            (await ctx.store.exists(fullWav)) ? fullWav : src,
            await ctx.store.prepareArtifact(
              `transcribe/${shortHash(`${src}|16k|r${TRANSCODE_WAV_REV}${win.key}`)}.wav`,
            ),
            { start, end },
          );
    // whisper writes under a scratch name; the transcript reaches the cache in ONE atomic write,
    // already on the file's timeline. Shifting it in place after whisper had written it would
    // leave a window cached on its own clock if anything stopped between the two writes.
    const scratch = `${scratchBase}.${scratchToken()}.tmp`;
    const run = await ctx.runner.run(
      "whisper-cli",
      ["-m", model, "-f", wav, "-ojf", "-of", scratch, "-np", "-t", whisperThreads(), "-l", lang],
      ctx.signal,
    );
    if (run.code !== 0 || !(await ctx.store.exists(`${scratch}.json`))) {
      await ctx.store.remove(`${scratch}.json`).catch(() => undefined);
      // Stop kills the sidecar, so the exit code describes the KILL, not the transcription:
      // it surfaced as `whisper-cli failed (code=-1): cancelled`, which reads as a broken
      // install rather than as the thing the user just asked for.
      if (ctx.signal?.aborted) throw new Error("transcription cancelled");
      if (run.code !== null && WINDOWS_LOAD_FAILURES.has(run.code))
        throw new SpeechEngineUnavailableError(run.code);
      throw new Error(`whisper-cli failed (code=${run.code}): ${stderrExcerpt(run.stderr, 200)}`);
    }
    const data = JSON.parse(await ctx.store.readText(`${scratch}.json`)) as WhisperCppJson;
    if (win.key !== "" && start > 0) shiftWhisperJson(data, Math.floor(start * 1000));
    const parsed = parseWhisperCpp(data);
    // Kept outside the project, so it is kept even when the project closed while whisper ran.
    if (out) await (await ctx.store.appCache())?.put(TRANSCRIPTS, out, data);
    await ctx.store.remove(`${scratch}.json`).catch(() => undefined);
    return parsed;
  });
}

export interface EnsuredTranscript {
  parsed: ParsedTranscript;
  /** True when it was already made, and nothing ran. */
  existed: boolean;
}

/** The language as the caller means it: a short code ("es"), or "" to detect it. A regional tag
 *  names the same language to whisper ("en-US", "pt_BR" -> "en", "pt"); whisper refuses the tag
 *  itself. 'auto' is the no-language path. */
export function normLanguage(language: unknown): string {
  const s = String(language ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return !s || s === "auto" ? "" : s;
}

/** What whisper is told AND what keys its cache: a language code, or "auto". whisper-cli's own
 *  default is ENGLISH, not detection, so leaving `-l` out transcribed every language as English
 *  (UJ-004). One value for the argument and the key, so the two can never disagree. */
function whisperLanguage(language: unknown): string {
  return normLanguage(language) || "auto";
}

/** The whole-file transcript of `ref`: the one already made for this file, model and language
 *  (in any project), else a new one. Every caller that needs a file's words comes through here
 *  or {@link runWhisper}, so all of them share one transcript per file. */
export async function ensureTranscript(
  ctx: ClientToolContext,
  ref: string,
  size: string = DEFAULT_MODEL,
  language?: string,
): Promise<EnsuredTranscript> {
  const src = await ctx.store.resolveRef(ref);
  if (!src) {
    const offline = await ctx.store.offlineMedia(ref).catch(() => null);
    if (offline) throw new MediaOfflineError(offline);
    throw new Error(`file not found: ${ref}`);
  }
  const made = await peekTranscript(ctx, src, size, language);
  if (made) return { parsed: made, existed: true };
  return { parsed: await runWhisper(ctx, src, size, language), existed: false };
}

const TRANSCRIPT_WORD_CAP = 10_000;

/** Map one audio clip's source-word times (seconds) to PROJECT FRAMES through its
 *  source trim + speed, keeping only words within the clip's visible source span:
 *  timeline_frame = timeline_in + (word_src_frame - source_in) / speed. Pure.
 *
 *  Both edges, because the gap BETWEEN words is silence, and a start-only reading cannot see
 *  it — the caller would have to guess where each word ended. */
export function clipWordFrames(
  words: Array<{ word: string; start_seconds: number; end_seconds?: number }>,
  clip: Pick<Clip, "source_in" | "source_out" | "timeline_in" | "speed">,
  fps: number,
): Array<[string, number, number]> {
  const sIn = Number(clip.source_in) || 0;
  const sOut = Number.isFinite(Number(clip.source_out)) ? Number(clip.source_out) : Infinity;
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const tIn = Number(clip.timeline_in) || 0;
  const toTimeline = (srcF: number) => Math.round(tIn + (srcF - sIn) / speed);
  const out: Array<[string, number, number]> = [];
  for (const w of words) {
    const srcF = w.start_seconds * fps;
    if (srcF < sIn || srcF >= sOut) continue;
    // A word can run past the cut that ends this clip. Report what is AUDIBLE, not what the
    // source file holds, or the gap after it reads longer than the viewer actually hears.
    const rawEnd = Number(w.end_seconds);
    const endSrc = Number.isFinite(rawEnd) ? rawEnd * fps : srcF;
    out.push([w.word, toTimeline(srcF), toTimeline(Math.min(Math.max(endSrc, srcF), sOut))]);
  }
  return out;
}

/** get_transcript: the CURRENT TIMELINE's spoken transcript in PROJECT FRAMES
 *  (other NLEs model). Walks the audio-track clips (a video clip's audio is split to a
 *  linked audio clip at placement), maps each clip's source words through its
 *  trim/speed/position, and concatenates in timeline order — so it always reflects
 *  what's audible after cuts. For a RAW source file's transcript, use inspect_media.
 *  Optional start_frame/end_frame window it to a time range; optional clip_id scopes
 *  it to one clip (its audio, or the audio split from that video clip). */
export async function getTranscriptTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const timeline = await loadTimeline(ctx.store).catch(() => null);
  if (!timeline) return { ok: false, error: "no timeline to transcribe" };
  const fps = Number(timeline.canvas?.fps) || 30;
  const startFrame = typeof args.start_frame === "number" ? args.start_frame : -Infinity;
  const endFrame = typeof args.end_frame === "number" ? args.end_frame : Infinity;

  // Optional: scope to a single clip. Accepts the audio clip itself or the video
  // clip whose audio was split off (matched via its link_group), so either id works.
  const wantId = String(args.clip_id ?? "").trim();
  let wantLinkGroup: string | null = null;
  if (wantId) {
    const found = findClip(timeline, wantId);
    if (!found) return { ok: false, error: `clip not found on the timeline: ${wantId}` };
    const lg = found[1].link_group;
    wantLinkGroup = typeof lg === "string" && lg ? lg : null;
  }
  const inScope = (c: Clip): boolean =>
    !wantId || c.id === wantId || (wantLinkGroup !== null && c.link_group === wantLinkGroup);

  const audio: Array<[string, Clip]> = [];
  for (const t of timeline.tracks ?? []) {
    if (t.kind !== "audio") continue;
    for (const c of t.clips ?? []) {
      if (typeof c.media_ref === "string" && c.media_ref && inScope(c)) audio.push([t.id, c]);
    }
  }
  audio.sort((a, b) => (Number(a[1].timeline_in) || 0) - (Number(b[1].timeline_in) || 0));

  const clipsOut: Array<Record<string, unknown>> = [];
  const failures: Array<{ clip_id: string; error: string }> = [];
  let idx = 0;
  let truncated = false;
  for (const [track, clip] of audio) {
    let words: WordPayload[];
    try {
      words = (await ensureTranscript(ctx, String(clip.media_ref), DEFAULT_MODEL)).parsed.words;
    } catch (e) {
      // Swallowing this made a BROKEN transcriber indistinguishable from silence:
      // the tool reported success with no words and the model concluded the footage
      // had no speech. Keep going (one bad source shouldn't sink the rest) but
      // report what failed, and fail outright when nothing could be transcribed.
      failures.push({ clip_id: String(clip.id), error: transcriptionFailureText(e) });
      continue;
    }
    const rows: Array<[number, string, number, number]> = [];
    for (const [text, tf, te] of clipWordFrames(words, clip, fps)) {
      if (tf < startFrame || tf >= endFrame) continue;
      if (idx >= TRANSCRIPT_WORD_CAP) {
        truncated = true;
        break;
      }
      rows.push([idx++, text, tf, te]);
    }
    if (rows.length) clipsOut.push({ clip_id: clip.id, track_id: track, words: rows });
    if (truncated) break;
  }
  const preview = clipsOut
    .flatMap((c) => (c.words as Array<[number, string, number, number]>).map((r) => r[1]))
    .join(" ");
  // Every audio source failed -> an empty transcript would be a lie, not a result.
  if (failures.length && !clipsOut.length) {
    return {
      ok: false,
      error:
        `transcription failed for all ${failures.length} audio clip(s) — this is a tool ` +
        `failure, NOT an absence of speech: ${failures[0].error}`,
      failed: failures,
    };
  }
  return {
    ok: true,
    fps,
    timing: "project_frames",
    word_format: ["index", "text", "start_frame", "end_frame"],
    clips: clipsOut,
    word_count: idx,
    truncated,
    script_preview: preview.slice(0, 600),
    script_chars: preview.length,
    ...(failures.length ? { failed: failures } : {}),
  };
}

export function registerTranscriptTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("get_transcript", (a) => getTranscriptTool(a, getCtx()));
}
