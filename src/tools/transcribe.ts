// get_transcript (client tool): word-level transcription via a bundled
// whisper.cpp binary, so audio never leaves the machine (offline-capable). Ports
// mechanical.py::get_transcript_tool — ffmpeg extracts a 16 kHz mono WAV,
// whisper-cli emits token-level JSON, and we reshape it into the canonical
// transcript schema that the rest of the pipeline reads. Each media file has a
// deterministic transcript path, so get_transcript returns an existing
// transcript instead of re-transcribing, so explicit callers share one cache.
// The ggml model is downloaded into app-data only when transcription is requested.
import { stderrExcerpt, type CommandResult } from "./command";
import type { AppCache } from "./appCache";
import type { ClientToolContext } from "./context";
import { missingClipMessage } from "../contract/params";
import { jobResult, jobSupervisor, runAsJob, whenJobEnds, type JobView } from "./jobSupervisor";
import { shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";
import { MediaOfflineError } from "./refState";
import { cpuOnlyNow, holdCpuOnly, isGpuCrash, WINDOWS_LOAD_FAILURES } from "./speechBackend";
import {
  decodeArgs,
  DEFAULT_BEAM,
  lastSpeechLanguage,
  rememberSpeechLanguage,
  WeakDecodeError,
  type ModelVariant,
} from "./speechDecoding";
import {
  acceptableRun,
  assertLaunchArgv,
  launchPlan,
  ModelPairingError,
  planModel,
  type ModelPlan,
} from "./speechModel";
import {
  classifyTranscriptFailure,
  failureText,
  isSpeechCancelled,
  SpeechCancelledError,
  TranscriptionFailure,
  type TranscriptFailureReason,
} from "./speechFailure";
import {
  admitWholeFile,
  isSpeechDeferred,
  knownAudioLength,
  markRunCancelledByPerson,
  SpeechDeferredError,
  wasRunCancelledByPerson,
} from "./speechAdmission";
import { backendNow, backendOfRun, readPace, recordSpeechRun } from "./speechPace";
import { padded, playedSpan, spanWindows } from "./speechSpans";
import { CAP_S } from "./speechPlan";
import { showAdoptedRun, watchSpeechRun, type RunInfo, type StopReason } from "./speechRun";
import {
  segmentFollowsWords,
  settleWords,
  tokenOnSound,
  wordTimesArgs,
  wordTimesOn,
} from "./speechWordTimes";
import { exportFlag, speechModelSources } from "../api/exportFlags";
import { joinPath } from "./store";
import { prioritizeTranscript } from "./transcriptQueue";
import { whisperCode } from "./whisperLanguages";
import { whisperRunFacts } from "./whisperFacts";
import { adoptTurn, lookWhisper } from "./workGate";
import { reportAppError, reportTranscription } from "../api/appEvents";
import { beginSessionActivity } from "../observability/crashWatch";
import { recordFact, type ModelFact } from "../lib/localFacts";
import { settledWithin } from "../lib/settledWithin";
import { stoppedAnswer } from "../lib/stopped";
import { trackSpeechWait } from "../store/liveWait";
import type { SpeechPurpose } from "../store/speechJobs";
import {
  clearModelDownload,
  megabytes,
  percent,
  reportModelDownload,
  setModelDownloadAgain,
  setModelDownloadCancel,
  setModelDownloadFailure,
} from "../store/modelDownload";
import { clearModelDecline, declineModel } from "./modelDecline";
import { kindOfHttpStatus, type ModelFailureKind } from "./modelFailure";
import {
  DEFAULT_MODEL_KEY,
  MODEL_MANIFEST,
  modelOrigins,
  remotePlacesFor,
  secondPlaces,
} from "./modelManifest";
import {
  noteWordsFetched,
  registerCachedWords,
  registerPendingWords,
  wakeTargetOf,
  type Settled,
} from "../store/speechWakeHost";
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
const DEFAULT_MODEL = DEFAULT_MODEL_KEY;

export interface WhisperModelSpec {
  revision: string;
  bytes: number;
  sha256: string;
  /** The file's name, on disk and at the place it is fetched from. Absent only in a spec a test builds
   *  by hand: the manifest's entry for the model says it. */
  file?: string;
  /** Other places the same bytes can be fetched from, tried when the first fails or refuses. The
   *  checksum above is what makes a copy trustworthy, wherever it comes from. */
  mirrors?: readonly string[];
}

/** Every model the app can install, read from the one table that states its size, checksum and revision, with the
 *  places it is fetched from after the first (the table derives them: a new entry has its own). */
export const WHISPER_MODELS: Readonly<Record<string, WhisperModelSpec>> = Object.fromEntries(
  Object.entries(MODEL_MANIFEST).map(([key, e]) => [
    key,
    {
      file: e.file,
      revision: e.revision,
      bytes: e.bytes,
      sha256: e.sha256,
      mirrors: secondPlaces(e),
    },
  ]),
);

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
/** The model's file name: its entry in the manifest says it. Only a size the manifest does not know (a test
 *  builds one by hand) falls back to the name `ggml-<size>.bin`. */
export function modelFileName(size: string, file?: string): string {
  return file ?? MODEL_MANIFEST[size]?.file ?? `ggml-${size}.bin`;
}
export function whisperModelPath(projectDir: string, size: string, file?: string): string {
  return joinPath(dataRootOf(projectDir), "models", modelFileName(size, file));
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
  /** The engine's own time for this token's sound, in units of 10 ms, from a run with `-dtw`; -1 where none was
   *  made (a special token, or a run without it). */
  t_dtw?: number;
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
 *  A segment's text is kept whole; its annotations never become words.
 *  `options.wordTimes` is for tests: whether the engine's own word times are used (see
 *  {@link parseWhisperCpp}); absent, it is whether the behaviour is in use right now. */
export function parseWhisperCppJson(
  raw: string,
  options: { wordTimes?: boolean } = {},
): ParsedTranscript {
  return parseWhisperCpp(JSON.parse(raw) as WhisperCppJson, options.wordTimes ?? wordTimesOn());
}

/** {@link parseWhisperCppJson} for whisper's JSON already read: what the app cache holds, so a
 *  change to how words are cut applies to every transcript already made.
 *
 *  With `wordTimes` the words are on the engine's own times for their sounds (speechWordTimes.ts), when the
 *  JSON holds any: a token with a usable `t_dtw` is moved onto it, and the words are then put in order. Without it,
 *  or for a JSON with no usable time (a run made without `-dtw`), this is exactly what 0.27.0 made of the JSON,
 *  for any JSON: that is what makes turning the behaviour off a way back for transcripts already kept. */
function parseWhisperCpp(
  data: WhisperCppJson,
  wordTimes: boolean = wordTimesOn(),
): ParsedTranscript {
  const onSound = wordTimes ? onSoundClock(data) : null;
  return onSound ? settleTranscript(parseStoredTimes(onSound)) : parseStoredTimes(data);
}

/** `data` with every token that has a usable sound time moved onto it, or null when none has. A copy: the JSON is
 *  what the app cache holds and every later parse reads it again, so it is never changed here. The defaults for a
 *  token's stored times are those of {@link parseStoredTimes}. */
function onSoundClock(data: WhisperCppJson): WhisperCppJson | null {
  let moved = false;
  const transcription = (data.transcription ?? []).map((seg) => {
    const segFrom = seg.offsets?.from ?? 0;
    const tokens = seg.tokens?.map((tok) => {
      if (isSpecialToken(tok.text ?? "")) return tok;
      const from = tok.offsets?.from ?? segFrom;
      const at = tokenOnSound({ from, to: tok.offsets?.to ?? from }, tok.t_dtw);
      if (!at) return tok;
      moved = true;
      return { ...tok, offsets: at };
    });
    return tokens ? { ...seg, tokens } : seg;
  });
  return moved ? { ...data, transcription } : null;
}

/** The words of a transcript parsed from times that moved with the sound, put in order and given their segments'
 *  bounds (the rules are in speechWordTimes.ts). Changes `parsed`, which the caller has just made. */
function settleTranscript(parsed: ParsedTranscript): ParsedTranscript {
  const spans = settleWords(
    parsed.words.map((w) => ({ start: w.start_seconds, end: w.end_seconds })),
  );
  parsed.words.forEach((w, i) => {
    w.start_seconds = spans[i].start;
    w.end_seconds = spans[i].end;
    w.start_timestamp = fmtTimestampPrecise(w.start_seconds);
    w.end_timestamp = fmtTimestampPrecise(w.end_seconds);
  });
  let duration = parsed.duration_seconds;
  for (const seg of parsed.segments) {
    const at = segmentFollowsWords(
      { start: seg.start_seconds, end: seg.end_seconds },
      seg.words.map((w) => ({ start: w.start_seconds, end: w.end_seconds })),
    );
    seg.start_seconds = at.start;
    seg.end_seconds = at.end;
    seg.start_timestamp = fmtTimestamp(at.start);
    seg.end_timestamp = fmtTimestamp(at.end);
    duration = Math.max(duration, at.end);
  }
  parsed.duration_seconds = duration;
  return parsed;
}

/** The transcript of whisper's JSON read for the times it stores, as 0.27.0 read every JSON. */
function parseStoredTimes(data: WhisperCppJson): ParsedTranscript {
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
  /** The bytes the part file already held when the first attempt began; null before it. */
  startedWith: number | null = null;
  /** Another model file was already whole on this PC when this one began, so the download is a second one and says
   *  so (the words about "the first time you start the app" are untrue of it). Read off the disk beside the
   *  download, so false until it is known. */
  again = false;

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
  const path = whisperModelPath(ctx.store.projectDir, size, spec.file);
  if (await validModel(ctx, path, spec)) return { path, downloaded: false };
  if (!fetchImpl) throw new Error("no network available to download the whisper model");
  if (!ctx.store.canStreamDownload) {
    throw new Error("this platform cannot stream and atomically install the whisper model");
  }
  // Somebody needs the model and it is not here: a Cancel the person pressed earlier is over.
  clearModelDecline();
  const key = `${path}\u0000${spec.sha256}`;
  const existing = modelDownloads.get(key);
  if (existing) return joinDownload(existing, ctx.signal);

  const policy = downloadPolicy;
  // Two files never download at once: the one progress line, its Cancel and its failure card belong to the download
  // under way, so a request for another file waits for the installs already in flight (one Cancel ends them all).
  const ahead = [...modelDownloads.values()];
  const install = new ModelInstall(
    spec.bytes,
    (self) => {
      const start = (): Promise<InstalledModel> =>
        downloadModel(ctx, path, size, spec, fetchImpl, self, policy);
      return ahead.length === 0 ? start() : afterTheOthers(ahead, self).then(start);
    },
    () => modelDownloads.delete(key),
  );
  modelDownloads.set(key, install);
  return joinDownload(install, ctx.signal);
}

/** Wait until every install in `ahead` has ended, however it ended, or until `self` is cancelled first: then at once,
 *  in the download's own words for a Cancel. Nothing is shown and nobody is asked for anything meanwhile. */
function afterTheOthers(ahead: readonly ModelInstall[], self: ModelInstall): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const signal = self.ac.signal;
    const cancelled = (): void =>
      reject(new Error(modelCancelledMessage(self.received, self.total)));
    if (signal.aborted) return cancelled();
    signal.addEventListener("abort", cancelled, { once: true });
    void Promise.allSettled(ahead.map((other) => other.promise)).then(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    });
  });
}

/** Stop the speech model's download now, whoever is waiting for it: the person pressed Cancel.
 *  What has been downloaded stays, and the next request resumes from it. Whoever was waiting is
 *  told the download was cancelled, in the words {@link modelCancelledMessage} uses. */
export function cancelModelDownload(): void {
  // Remembered, so that the launch prefetch does not start it again behind his back (modelDecline.ts).
  declineModel();
  for (const install of modelDownloads.values()) install.ac.abort();
}

/** Tests only: no download is under way, whatever a test left running (a waiting one is cancelled with it). */
export function __resetModelDownloads(): void {
  for (const install of modelDownloads.values()) install.ac.abort();
  modelDownloads.clear();
}

/** What a download left on this PC for later, in closed words: never a path, a name or an address. */
function recordModelFact(fact: Omit<ModelFact, "at">): void {
  recordFact("model_download", { ...fact, at: Date.now() });
}

/** Which of the places asked for this download a fact names: the compiled-in one, or the Nth extra one. */
function sourceWord(origins: readonly string[], origin: string): NonNullable<ModelFact["source"]> {
  const i = origins.indexOf(origin);
  return i <= 0 ? "primary" : i === 1 ? "extra_1" : i === 2 ? "extra_2" : "extra_3";
}

async function downloadModel(
  ctx: ClientToolContext,
  path: string,
  size: string,
  spec: WhisperModelSpec,
  fetchImpl: typeof fetch,
  self: ModelInstall,
  policy: DownloadPolicy,
): Promise<InstalledModel> {
  // Keyed by the CONTENT, not just the model name: `ggml-small.bin` keeps its path across
  // revisions, so a part left by the previous pinned build would otherwise be resumed into the
  // new one and fail its checksum — a guaranteed wasted download for every user on a bump.
  const tmp = `${path}.${spec.sha256.slice(0, 12)}.part`;
  const marker = `${path}.verified.json`;
  const signal = self.ac.signal;
  const pinned = { file: modelFileName(size, spec.file), revision: spec.revision };
  const finishActivity = beginSessionActivity("whisper-model-download");
  // The pill's Cancel stops this install, whoever is waiting for it.
  setModelDownloadCancel(cancelModelDownload);
  // Whether this is a second model file is read off the disk beside the download and told to the screens when it is
  // known: the first request never waits for the words on them.
  let over = false;
  void installedModels(ctx).then(
    (here) => {
      self.again = here.some((other) => other !== size);
      if (!over) setModelDownloadAgain(self.again);
    },
    () => undefined,
  );
  const began = Date.now();
  const seconds = (): number => (Date.now() - began) / 1000;
  const fetched = (): number => Math.max(0, self.received - (self.startedWith ?? 0));
  recordModelFact({ event: "download_started" });
  // Why this download failed, if it does. Set where each failure is thrown, never read back from its words.
  let reason: ModelFailureKind = "unknown";
  let made = 0;
  let source: NonNullable<ModelFact["source"]> = "primary";
  let failure: ModelFailureKind | null = null;
  try {
    // Only bytes we can PROVE are wrong are thrown away (see transferModel). A cancellation or a
    // dropped connection leaves a perfectly good prefix, and discarding it is what made the user
    // restart from zero.
    const attempts = policy.backoffMs.length + 1;
    let last: AttemptFailure | null = null;
    /** Origins that sent something they should not have: asked again, they would only do it again. */
    const refused = new Set<string>();
    for (let attempt = 0; attempt < attempts; attempt++) {
      // A refusal moves on to the next origin at once; anything else waits its turn first.
      if (attempt > 0 && last?.fate !== "next-origin")
        await pause(policy.backoffMs[attempt - 1], signal, () =>
          modelCancelledMessage(self.received, spec.bytes),
        );
      // The places are worked out for EVERY attempt: an answer from the server that comes after the download
      // began (the launch prefetch starts before the first answer) is used by the next attempt.
      const origins = modelOrigins(pinned, [
        ...(spec.mirrors ?? []),
        ...remotePlacesFor(pinned, speechModelSources()),
      ]);
      const open = origins.filter((o) => !refused.has(o));
      if (open.length === 0) break; // every origin has refused
      const origin = open[attempt % open.length];
      source = sourceWord(origins, origin);
      made++;
      try {
        await transferModel(ctx, tmp, spec, origin, fetchImpl, self, policy);
        last = null;
        break;
      } catch (e) {
        reason = e instanceof AttemptFailure ? e.kind : "unknown";
        if (signal.aborted || !(e instanceof AttemptFailure) || e.fate === "fatal") throw e;
        last = e;
        if (e.fate === "next-origin") refused.add(origin);
      }
    }
    if (last) {
      reportModelDownloadFailure(last.message);
      throw made === 1 ? last : new Error(`${last.message} (after ${made} attempts)`);
    }
    if (signal.aborted) throw new Error(modelCancelledMessage(self.received, spec.bytes));
    // From here on only the disk can let it down.
    reason = "disk_write";
    if (await ctx.store.exists(path)) await ctx.store.remove(path);
    await ctx.store.remove(marker).catch(() => undefined);
    await ctx.store.rename(tmp, path);
    await ctx.store
      .writeText(marker, JSON.stringify({ bytes: spec.bytes, sha256: spec.sha256 }))
      .catch(() => undefined);
    recordModelFact({
      event: "download_finished",
      source,
      attempts: made,
      seconds: seconds(),
      bytes: fetched(),
    });
    return { path, downloaded: true };
  } catch (e) {
    if (signal.aborted) {
      recordModelFact({ event: "download_cancelled", attempts: made, seconds: seconds() });
    } else {
      recordModelFact({
        event: "download_failed",
        source,
        attempts: made,
        seconds: seconds(),
        bytes: fetched(),
        reason,
      });
      failure = reason;
    }
    throw e;
  } finally {
    over = true;
    clearModelDownload();
    finishActivity();
    // After the progress is cleared: the card replaces the pill, never sits beside it. It remembers which file it is
    // about, so that its Retry asks for that file.
    if (failure !== null) setModelDownloadFailure(failure, size);
  }
}

/** How patient a download is with an origin that fails or goes quiet. */
export interface DownloadPolicy {
  /** An attempt that receives nothing for this long (ms) is ended and counted as failed. */
  stallMs: number;
  /** The waits (ms) between attempts: there is one more attempt than there are waits. */
  backoffMs: readonly number[];
}

/** What the app does: quiet for 30 s is a stall, and a download that fails is tried again after 2,
 *  10 and 30 s, from where it stopped, on the next origin when there is one. */
export const PATIENT_DOWNLOAD: DownloadPolicy = {
  stallMs: 30_000,
  backoffMs: [2_000, 10_000, 30_000],
};

/** One attempt and no clock: a download as it was before it was patient. */
export const SINGLE_ATTEMPT: DownloadPolicy = { stallMs: Infinity, backoffMs: [] };

let downloadPolicy: DownloadPolicy = PATIENT_DOWNLOAD;

/** Tests only: how patient the next downloads are. */
export function __setDownloadPolicy(policy: DownloadPolicy): void {
  downloadPolicy = policy;
}

/** What to do about an attempt that did not finish. `retry`: the origin or the connection let us
 *  down, so wait and try again. `next-origin`: this origin sent something it should not have, so
 *  try another without waiting. `fatal`: nothing another attempt could do changes it. `kind` is
 *  what went wrong, in the closed words the card and the local record use; each throw site says it. */
class AttemptFailure extends Error {
  constructor(
    message: string,
    readonly fate: "retry" | "next-origin" | "fatal",
    readonly kind: ModelFailureKind,
  ) {
    super(message);
    this.name = "AttemptFailure";
  }
}

/** One app_error per kind of failure per session; only the reason leaves the machine. */
const reportedDownloadFailures = new Set<string>();
function reportModelDownloadFailure(reason: string): void {
  const kind = reason.replace(/\d+/g, "N").slice(0, 100);
  if (reportedDownloadFailures.has(kind)) return;
  reportedDownloadFailures.add(kind);
  reportAppError(`speech_model_download_failed: ${reason.slice(0, 160)}`);
}

/** Wait `ms`, or end at once with `message()` when the install is cancelled. */
async function pause(ms: number, signal: AbortSignal, message: () => string): Promise<void> {
  if (signal.aborted) throw new Error(message());
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
  if (signal.aborted) throw new Error(message());
}

/** One attempt to bring the part file up to the whole model from `url`, continuing from what is on
 *  disk. Returns when the part holds the pinned bytes, checksum verified. Proven-wrong bytes
 *  (a server that ignored Range, a wrong length, a bad checksum) are removed so the next attempt
 *  starts clean; everything else is a good prefix and is kept. */
async function transferModel(
  ctx: ClientToolContext,
  tmp: string,
  spec: WhisperModelSpec,
  url: string,
  fetchImpl: typeof fetch,
  self: ModelInstall,
  policy: DownloadPolicy,
): Promise<void> {
  const signal = self.ac.signal;
  // This attempt's own cancellation: the install's, and the stall clock's.
  const attemptAc = new AbortController();
  const stop = (): void => attemptAc.abort();
  signal.addEventListener("abort", stop, { once: true });
  const discard = async (): Promise<void> => {
    await ctx.store.remove(tmp).catch(() => undefined);
  };
  /** `p`, unless the install is cancelled (at once, whatever the origin does with its connection) or
   *  nothing happens for the policy's stall time: then this attempt is ended. */
  const unlessStalled = <T>(p: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(policy.stallMs)
        ? setTimeout(() => {
            attemptAc.abort();
            reject(
              new AttemptFailure(
                `whisper model download stalled: ${what} for ${policy.stallMs / 1000} s`,
                "retry",
                "stalled",
              ),
            );
          }, policy.stallMs)
        : undefined;
      const onCancel = (): void => {
        clearTimeout(timer);
        reject(new Error(modelCancelledMessage(self.received, spec.bytes)));
      };
      if (signal.aborted) return onCancel();
      signal.addEventListener("abort", onCancel, { once: true });
      const settled = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onCancel);
      };
      p.then(
        (v) => (settled(), resolve(v)),
        (e: unknown) => (settled(), reject(e)),
      );
    });
  try {
    let have = (await ctx.store.byteSize(tmp)) ?? 0;
    if (have < 0 || have >= spec.bytes) {
      await discard();
      have = 0;
    }
    // Shown from the moment the download is asked for, not from the first byte: an origin that
    // never answers is a download stuck at 0%, and nothing on screen said it had started.
    reportModelDownload(have, spec.bytes, self.again);
    self.received = have;
    self.startedWith ??= have;
    let resp: Response;
    try {
      resp = await unlessStalled(
        fetchImpl(url, {
          signal: attemptAc.signal,
          headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
        }),
        "no answer",
      );
    } catch (e) {
      if (signal.aborted) throw new Error(modelCancelledMessage(have, spec.bytes));
      if (e instanceof AttemptFailure) throw e;
      throw new AttemptFailure(`whisper model download failed: ${String(e)}`, "retry", "network");
    }
    if (resp.status === 416) {
      // Our part is at or past the end of the file the server holds, so it is not this model.
      await discard();
      throw new AttemptFailure(
        "whisper model download could not resume from the partial file",
        "retry",
        "cannot_resume",
      );
    }
    if (!resp.ok) {
      const kind = kindOfHttpStatus(resp.status);
      throw new AttemptFailure(
        `whisper model download failed: HTTP ${resp.status}`,
        kind === "server_busy" ? "retry" : "next-origin",
        kind,
      );
    }
    if (!resp.body) {
      throw new AttemptFailure(
        "whisper model download cannot be streamed",
        "fatal",
        "cannot_stream",
      );
    }
    // A server that ignores Range answers 200 with the WHOLE file. Appending that to what we
    // already had would concatenate two copies and leave the checksum as the only thing between
    // the user and a doubled file — start the part over rather than trust the length check.
    if (have > 0 && resp.status !== 206) {
      await discard();
      have = 0;
    }
    const declaredHeader = resp.headers.get("content-length");
    const declared = declaredHeader === null ? null : Number(declaredHeader);
    const remaining = spec.bytes - have;
    if (declared !== null && Number.isFinite(declared) && declared !== remaining) {
      await discard();
      throw new AttemptFailure(
        `whisper model size mismatch: expected ${remaining}, server sent ${declared}`,
        "next-origin",
        "size_mismatch",
      );
    }

    const reader = resp.body.getReader();
    let received = have;
    let published = -1;
    const publish = (): void => {
      if (received === published) return;
      published = received;
      self.received = received;
      reportModelDownload(received, spec.bytes, self.again);
    };
    publish();
    let completed = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await unlessStalled(reader.read(), "no data");
        } catch (e) {
          if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
          if (e instanceof AttemptFailure) throw e;
          throw new AttemptFailure(
            `whisper model download failed: ${String(e)}`,
            "retry",
            "network",
          );
        }
        const { done, value } = chunk;
        if (done) break;
        if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
        if (received + value.length > spec.bytes) {
          await discard();
          throw new AttemptFailure(
            `whisper model exceeded expected size ${spec.bytes}`,
            "next-origin",
            "size_mismatch",
          );
        }
        // `received` tracks what is ON DISK, so a failed append cannot inflate it: the next
        // attempt re-reads the file's real size anyway, which keeps resume self-correcting.
        let written: boolean;
        try {
          written = await ctx.store.appendBytes(tmp, value);
        } catch {
          // A disk that is full or refuses the write throws. What it says may name a folder of this PC, and
          // this text reaches the assistant: the kind says what happened.
          written = false;
        }
        if (!written) {
          if (signal.aborted) throw new Error(modelCancelledMessage(received, spec.bytes));
          throw new AttemptFailure(
            "whisper model download stopped before it could be written",
            "fatal",
            "disk_write",
          );
        }
        received += value.length;
        self.received = received;
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
      throw new AttemptFailure(
        `whisper model was incomplete: expected ${spec.bytes}, received ${received}`,
        "retry",
        "incomplete",
      );
    }
    const probe = await ctx.store.probeMedia(tmp, 0);
    if (!probe || probe.size !== spec.bytes || probe.sha256 !== spec.sha256) {
      await discard(); // proven wrong; resuming these bytes would never converge
      throw new AttemptFailure(
        "whisper model failed checksum validation",
        "next-origin",
        "damaged",
      );
    }
  } finally {
    signal.removeEventListener("abort", stop);
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

/** Let a request for `key` join `running`, a run this page did not start (adopted after a crash of
 *  the page, 4i), exactly as {@link once} lets it join one it did. */
function joinable<T>(key: string, running: Promise<T>): void {
  const tracked = running.finally(() => inflight.delete(key));
  tracked.catch(() => undefined);
  inflight.set(key, tracked);
}

// whisper.cpp wants 16 kHz mono PCM WAV. Bump the rev when the extract recipe changes.
const TRANSCODE_WAV_REV = 1;

/** Where the whole-file 16 kHz extract of the file `audioOf` names lives (whether or not it exists
 *  yet). `audioOf` is the file's identity where it has one, as for its transcript: a file changed
 *  in place gets new audio, never the extract of what it was. In the app's work folder, outside
 *  every project, so a run that outlives its project's close never writes into it (4i). */
function wavPathFor(ctx: ClientToolContext, audioOf: string, windowKey = ""): Promise<string> {
  return ctx.store.prepareWork(
    `transcribe/${shortHash(`${audioOf}|16k|r${TRANSCODE_WAV_REV}${windowKey}`)}.wav`,
  );
}

/** How many runs in this page hold each 16 kHz extract, and the removals still under way. */
const wavHolders = new Map<string, number>();
const wavRemovals = new Map<string, Promise<void>>();

/** Run `fn` holding the extracts `wavs`: each is deleted when the last run holding it ends, however
 *  it ends. Only a run that holds an extract reads it, so none is deleted from under a reader, and
 *  none outlives the runs that needed it (an 80-minute file's is 148 MB). */
async function holdingWavs<T>(
  io: { remove(path: string): Promise<void> },
  wavs: string[],
  fn: () => Promise<T>,
): Promise<T> {
  for (const w of wavs) wavHolders.set(w, (wavHolders.get(w) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const removals: Promise<void>[] = [];
    for (const w of wavs) {
      const left = (wavHolders.get(w) ?? 1) - 1;
      if (left > 0) {
        wavHolders.set(w, left);
        continue;
      }
      wavHolders.delete(w);
      const gone: Promise<void> = io
        .remove(w)
        .catch(() => undefined)
        .finally(() => {
          if (wavRemovals.get(w) === gone) wavRemovals.delete(w);
        });
      wavRemovals.set(w, gone);
      removals.push(gone);
    }
    await Promise.all(removals);
  }
}

/** Is the extract at `wav` on disk, once any removal of it already under way has finished? */
async function wavOnDisk(ctx: ClientToolContext, wav: string): Promise<boolean> {
  await wavRemovals.get(wav);
  return ctx.store.exists(wav);
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
  if (await wavOnDisk(ctx, wav)) return wav;
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
      throw new TranscriptionFailure(
        "audio_extraction_failed",
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
 *  SOURCE timeline, where `-ot` on the whole file would have put it. The engine's own word times
 *  (`t_dtw`, units of 10 ms, -1 where none was made) are on the window's clock too and move with them:
 *  left behind, every one of a window that starts 30 s in or later would be a whisper window away from its
 *  token, and an earlier one would be wrong by the window's start. */
function shiftWhisperJson(data: WhisperCppJson, shiftMs: number): void {
  const move = (o?: { from?: number; to?: number }): void => {
    if (!o) return;
    if (typeof o.from === "number") o.from += shiftMs;
    if (typeof o.to === "number") o.to += shiftMs;
  };
  for (const seg of data.transcription ?? []) {
    move(seg.offsets);
    for (const tok of seg.tokens ?? []) {
      move(tok.offsets);
      if (typeof tok.t_dtw === "number" && tok.t_dtw >= 0) tok.t_dtw += shiftMs / 10;
    }
  }
}

/** The speech engine cannot run on this machine AT ALL. Distinct from "this file failed":
 *  retrying it per asset just repeats the same load failure, so the caller must stop asking. */
export class SpeechEngineUnavailableError extends TranscriptionFailure {
  constructor(readonly exitCode: number) {
    super(
      "engine_unavailable",
      "The speech engine could not start on this machine, so audio cannot be transcribed.",
      { expected: true },
    );
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
  return failureText(e);
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
  identity: string | null;
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
  return { lang, identity, full, out, win };
}

/** Bump when what is stored under a transcript key changes meaning. v2: whisper runs with no
 *  carried context (-mc 0); a v1 transcript of a file with long silence can be blank after it. */
const TRANSCRIPT_FORMAT = "v2";
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
 *  this window's own, or the whole file's (which answers every window), or null. */
export async function peekTranscript(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
): Promise<ParsedTranscript | null> {
  const k = await transcriptKeys(ctx, src, size, language, window);
  for (const key of new Set([k.out, k.full])) {
    const data = await cachedWhisper(ctx, key);
    if (data) return parseWhisperCpp(data);
  }
  return null;
}

/** Is a run for exactly this request going right now, started by anything (a look, captions, the
 *  indexer)? A request for it joins that run instead of starting one, so it is never too long to be
 *  answered: only a run that has not started is. False for a file with no identity, where the join is
 *  keyed by a scratch path that cannot be known without making it. */
export async function transcriptRunning(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
): Promise<boolean> {
  const { out } = await transcriptKeys(ctx, src, size, language, window);
  return out !== null && inflight.has(out);
}

/** A transcription, kept for the file and language it was asked for. What it is made with follows speechModel.ts
 *  and speechDecoding.ts: a language the accuracy gate cleared is decoded with the faster setting (and on a PC
 *  that transcribes on its processor, with the smaller model file where the gate cleared that too), and a
 *  transcript made with a file or setting that its detected language does not allow is never kept (finishWhisper
 *  refuses it, and this runs once more with what that language needs). */
export async function runWhisper(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
  /** The caller already holds this transcript's place in the one-run-per-file join (a batch that falls
   *  back to running one of its files alone), so it must not wait on itself. */
  joined = false,
  /** The file and width a run over several files refused this file at, for not being what its language
   *  needs: it is run with what that language needs at once instead of being predicted again. */
  redoWith?: ModelPlan,
): Promise<ParsedTranscript> {
  let redo = redoWith;
  /** The engine failed on the smaller file and this request went on with the full-size one. */
  let wentOn = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const done = await runWhisperOnce(ctx, src, size, language, window, redo, joined);
      // The full-size file ran what the smaller one could not: the smaller file is the likely cause on this PC.
      if (wentOn) smallerFileFailed = true;
      return done;
    } catch (e) {
      if (e instanceof EngineFailedOnSmallerFile) {
        // The engine failed on the smaller file, which may be the cause: once more with the full-size file, which
        // every language accepts. If that fails too, or the runs are spent, the failure is the engine's own.
        if (attempt >= 2) throw e.failure;
        redo = universalPlan();
        wentOn = true;
        continue;
      }
      if (!(e instanceof WeakDecodeError) || attempt >= 2) throw e;
      // The language turned out to need another file or a wider beam than the prediction gave it. If a second
      // run finds yet another language, the full-size file with the engine's own default beam settles it: it is
      // acceptable for all (speechModel.ts, acceptableRun).
      redo = attempt === 0 ? await replanFor(ctx, e.detected) : universalPlan();
    }
  }
}

/** The model file the gate measured, for the one model there is: the manifest's entry says which. A model
 *  size that was not measured is never given a narrower beam. */
const MODEL_VARIANT: ModelVariant = MODEL_MANIFEST[DEFAULT_MODEL_KEY].variant;

/** What every language accepts on every path: the full-size file at the engine's own default beam. */
function universalPlan(): ModelPlan {
  return { key: DEFAULT_MODEL_KEY, variant: MODEL_VARIANT, beam: DEFAULT_BEAM };
}

/** The engine itself failed on a run made with the smaller model file: it did not start, crashed, or left no output.
 *  The file may be the cause (it was never run on a PC like this one), so {@link runWhisper} runs the request once
 *  more with the full-size file; `failure` is what the caller is told when that cannot be done. It never leaves
 *  runWhisper. */
class EngineFailedOnSmallerFile extends Error {
  constructor(readonly failure: unknown) {
    super("the speech engine failed on the smaller model file");
    this.name = "EngineFailedOnSmallerFile";
  }
}

/** Set when the engine failed on the smaller file and the full-size file then ran the same request: the smaller file
 *  is the likely cause on this PC, so the plan does not name it for the rest of this app session (a restart tries it
 *  again: one more fast failed launch is cheap, and an update may have fixed it). When the full-size file fails too the
 *  file is not to blame and nothing is remembered. */
let smallerFileFailed = false;

/** Tests only: a session in which the engine has not failed on the smaller file. */
export function __resetSmallerFileFailure(): void {
  smallerFileFailed = false;
}

/** Whether `e`, thrown for a run made with `plan`, is the ENGINE failing on a file other than the baseline. Not the
 *  person stopping it, not a run deferred for the cap, not an engine that cannot start at all (a missing library is
 *  not the model's fault), not a language it does not know and not a transcript the commit point refused. */
function engineFailedOnSmallerFile(e: unknown, plan: ModelPlan): boolean {
  if (plan.key === DEFAULT_MODEL_KEY) return false;
  if (e instanceof TranscriptionFailure) return e.reason === "engine_failed";
  // The engine exited cleanly and left an output that is not a transcript (cut short).
  return e instanceof SyntaxError;
}

/** The manifest keys whose file is whole on this PC right now (its size and checksum were verified when it landed). */
async function installedModels(ctx: ClientToolContext): Promise<string[]> {
  const here: string[] = [];
  for (const [key, spec] of Object.entries(WHISPER_MODELS)) {
    try {
      if (await validModel(ctx, whisperModelPath(ctx.store.projectDir, key, spec.file), spec))
        here.push(key);
    } catch {
      /* a file that cannot be read is not here */
    }
  }
  return here;
}

/** The plan for a language that is known (named, predicted or just detected), on the path a run started now takes.
 *  `predicted`: the language is only a guess from the last run, which never makes the PC fetch a file (speechModel.ts). */
async function planForLanguage(
  ctx: ClientToolContext,
  language: string | null,
  predicted = false,
): Promise<ModelPlan> {
  return planModel({
    backend: backendNow(readPace()),
    language,
    installed: await installedModels(ctx),
    ...(predicted ? { predicted } : {}),
    ...(smallerFileFailed ? { smallerFailed: true } : {}),
  });
}

/** The plan after a run was refused for its detected language: the language is known now. */
function replanFor(ctx: ClientToolContext, detected: string): Promise<ModelPlan> {
  return planForLanguage(ctx, detected || null);
}

/** What to run with, BEFORE the run. A named language is known; "auto" is predicted from the last language this
 *  machine detected and CHECKED once the engine has said (finishWhisper), and a prediction never makes the PC fetch a
 *  file. A model size the gate did not measure is never narrowed, and a re-run is given what it was sent for. */
async function planFor(
  ctx: ClientToolContext,
  size: string,
  lang: string,
  redo: ModelPlan | undefined,
): Promise<ModelPlan> {
  if (redo) return redo;
  // A size the gate did not measure is handed to the engine as it always was: the default beam. Its variant is the
  // manifest's word for its file, so that what is checked at the commit point is what was really run.
  if (size !== DEFAULT_MODEL)
    return {
      key: size,
      variant: MODEL_MANIFEST[size]?.variant ?? MODEL_VARIANT,
      beam: DEFAULT_BEAM,
    };
  const named = whisperCode(lang);
  return planForLanguage(ctx, named || lastSpeechLanguage(), named === "");
}

/** The file the launch prefetch fetches: the one the plan for this PC names while no language is asked for (the
 *  last language this PC detected, if any, as a guess). A PC that already holds a file the plan accepts fetches nothing.
 *  `retry` is the manifest key of the file a failure card was about, when the person pressed Retry on it: that file is
 *  asked for, not whatever the plan names now (it may be one that is already here, which would retry nothing). */
export async function ensureLaunchModel(
  ctx: ClientToolContext,
  retry?: string,
): Promise<{ path: string; downloaded: boolean }> {
  if (retry !== undefined && Object.hasOwn(WHISPER_MODELS, retry))
    return ensureWhisperModel(ctx, retry);
  const plan = await planForLanguage(ctx, lastSpeechLanguage(), true);
  return ensureWhisperModel(ctx, plan.key);
}

async function runWhisperOnce(
  ctx: ClientToolContext,
  src: string,
  size: string,
  language: string | undefined,
  window: TranscribeWindow | null | undefined,
  redo: ModelPlan | undefined,
  joined = false,
): Promise<ParsedTranscript> {
  const { lang, identity, full, out, win } = await transcriptKeys(ctx, src, size, language, window);
  // A full transcript already answers every window, so a windowed ask must never re-run
  // over one we have — the indexer builds these in the background for exactly this reason.
  // A window's OWN transcript answers first: whisper hears that stretch with less around it, and
  // on the 12-minute QA file it had words and times the whole file's lacked (4h2).
  const done = (await cachedWhisper(ctx, out)) ?? (await cachedWhisper(ctx, full));
  if (done) return parseWhisperCpp(done);
  // Not before this page has taken over what a crashed page left running: a transcription of this
  // file still at work there is joined below, never run a second time (4i).
  await adoptTranscriptions(ctx.store);

  // whisper's own output is scratch, written in the app's work folder like the audio it reads, so
  // a run still going when its project closes finishes without writing into the project (4i).
  const scratchBase = await scratchBaseFor(ctx, src, size, lang, win.key);
  const run = async (): Promise<ParsedTranscript> => {
    // The one place every whole-file start passes (S2-02): the background's own runs, and the ones a
    // batch runs alone after missing them, before any audio is read or any engine is started. A file this
    // PC would take longer than the cap for is not started by itself; a request (a look, captions,
    // get_transcript) is never planned away here: it asks for the stretch it needs, and what it asks for runs.
    // The length is what the indexer measured (`noteAudioLength`); a run never probes a file to plan it,
    // and a length nobody measured is a run here: it is read again, from the audio itself, just before the
    // engine is launched (below).
    if (ctx.background && win.key === "") {
      // The person stopped this file's run (a look, captions, the indexer's own): the background never
      // starts it by itself afterwards, however its queue names the file (F7). A request still runs it.
      // With the switch off nothing here decides anything: it is 0.27.0, where a whole file asked for by a
      // request on the background's queue (a long look) must run.
      if (exportFlag("speech_cpu_cap") && wasRunCancelledByPerson(out))
        throw new SpeechCancelledError();
      const admission = admitWholeFile({
        file: fileLabel(src),
        where: "boundary",
        audioS: knownAudioLength(src),
      });
      if (admission?.plan === "ondemand") throw new SpeechDeferredError(admission);
    }
    // What to run with is decided before the model is fetched, because it says WHICH file: the smaller one on a PC
    // that transcribes on its processor, for a language the gate cleared it for; the full-size one everywhere else.
    const plan = await planFor(ctx, size, lang, redo);
    const model = await modelFor(ctx, plan.key);
    // A window is transcribed from its OWN audio only. Extracting a 2-hour file to transcribe 30
    // seconds of it was most of the wait (UJ-012); and whisper loads the whole file it is handed, so
    // `-ot/-d` on an 80-minute extract took 11.9 s for a 60 s window where the window's own WAV took
    // 7.3 s (QA, 2026-10-03). The window is cut from the whole-file extract when that is on disk
    // (published by rename, so it is complete), else from the source.
    const audioOf = identity ?? src;
    const fullWav = await wavPathFor(ctx, audioOf);
    const winWav = win.key === "" ? null : await wavPathFor(ctx, audioOf, win.key);
    const start = Math.max(0, Number(window?.start) || 0);
    const rawEnd = Number(window?.end);
    const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
    const wavs = winWav ? [fullWav, winWav] : [fullWav];
    return holdingWavs(ctx.store, wavs, async () => {
      const wav =
        winWav === null
          ? await extractWav(ctx, src, fullWav)
          : await extractWav(ctx, (await wavOnDisk(ctx, fullWav)) ? fullWav : src, winWav, {
              start,
              end,
            });
      // The audio is read now, so its length is exact: the engine's chip entry shows it, and the plan is read
      // again by it before the engine is launched (below).
      const spanS = await wavSeconds(ctx, wav);
      const purpose: SpeechPurpose = ctx.background ? "index" : (ctx.speechPurpose ?? "look");
      // whisper writes under a scratch name; the transcript reaches the cache in ONE atomic write,
      // already on the file's timeline. Shifting it in place after whisper had written it would
      // leave a window cached on its own clock if anything stopped between the two writes.
      const meta: TranscriptJobMeta = {
        kind: "transcript",
        key: out,
        once: out ?? scratchBase,
        scratch: `${scratchBase}.${scratchToken()}.tmp`,
        // A window's own audio starts where the window does (only the whole file starts at 0).
        shiftMs: Math.floor(start * 1000),
        wavs,
        beam: plan.beam,
        variant: plan.variant,
        requested: lang,
        ...(redo !== undefined ? { rerun: true } : {}),
        label: fileLabel(src),
        purpose,
        spanS,
      };
      // -mc 0: no text carried from one 30 s window into the next. With it, six minutes of
      // silence left whisper repeating "[BLANK_AUDIO]" straight through the speech after it
      // (4h2): the file's whole transcript came back empty, and it answers every stretch of it.
      // No -np: it would hide the backend and timings whisperFacts.ts reads.
      const args = [
        "-m",
        model,
        "-f",
        wav,
        "-ojf",
        "-of",
        meta.scratch,
        "-t",
        whisperThreads(),
        "-l",
        lang,
        "-mc",
        "0",
        ...decodeArgs(plan.beam),
      ];
      // The audio is read: its length is exact, and what the first look did not know (a probe that
      // failed or lied) or what has changed since (a model that took an hour to install, a pace measured by
      // another run) is read again where the run can still be left undone (S2-02): no engine is launched,
      // and the audio is let go of as for any run that fails. Only the whole files the background starts.
      if (ctx.background && win.key === "") {
        const admission = admitWholeFile({
          file: fileLabel(src),
          where: "boundary",
          audioS: spanS ?? knownAudioLength(src),
          recheck: true,
        });
        if (admission?.plan === "ondemand") throw new SpeechDeferredError(admission);
      }
      const { engine, release } = await engineFor(
        ctx,
        args,
        meta,
        {
          purpose,
          label: fileLabel(src),
          work: [
            {
              source: src,
              language: normLanguage(language),
              window: win.key === "" ? null : { start, end },
            },
          ],
          spanS,
          threads: Number(whisperThreads()) || null,
          // Only a whole file that the background started by itself can be stopped for being too slow:
          // what a request asked for (a look, captions, get_transcript) runs until it is done or Cancelled.
          liveStop: ctx.background === true && win.key === "",
          several: false,
        },
        plan.key,
      );
      try {
        // A look's whisper runs at once, one look at a time; the indexer's took its turn already.
        const run = ctx.background ? await engine() : await lookWhisper(engine, ctx.signal);
        if (!run) throw new Error("transcription cancelled"); // stopped before its turn came
        // The engine ran and failed on the smaller file: runWhisper goes on with the full-size one. A launch the
        // manifest refused never gets here (it is thrown by engine() above), and neither does a cancel.
        return await finishWhisper(ctx.store, meta, run, ctx.signal).catch((e: unknown) => {
          throw engineFailedOnSmallerFile(e, plan) ? new EngineFailedOnSmallerFile(e) : e;
        });
      } catch (e) {
        // The person stopped a whole file's run: it is theirs to ask for again, and nothing starts it behind
        // their back (the check at the top of this run, for the background).
        if (isSpeechCancelled(e) && win.key === "") markRunCancelledByPerson(out);
        throw e;
      } finally {
        // Its words are kept, or it failed: nothing is left for another page to finish.
        await release();
      }
    });
  };
  if (joined) return run();
  try {
    return await once(out ?? scratchBase, run);
  } catch (e) {
    // The run this request joined was the background's, and it was left undone for the cap before it
    // began. A request is never planned away: it makes its own run.
    if (!ctx.background && isSpeechDeferred(e)) return once(out ?? scratchBase, run);
    throw e;
  }
}

/** What the person calls the file: its name, for the plan log and the chip. */
function fileLabel(src: string): string {
  return normSep(src).split("/").pop() || src;
}

/** How many seconds of audio the extract `wav` holds: whisper's input is 16 kHz mono 16-bit, so it is the
 *  file's size less the 44-byte header over 32,000 bytes a second. Null when the size cannot be read. The
 *  run's own length, exactly: no probe of the source is needed. */
async function wavSeconds(ctx: ClientToolContext, wav: string): Promise<number | null> {
  try {
    const bytes = await ctx.store.byteSize(wav);
    if (bytes === null) return null;
    const seconds = (bytes - 44) / 32_000;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** Where whisper's scratch output for one request lives: the same place for a run alone and for a run
 *  over several files, so the one-run-per-file join (keyed by this when the file has no identity) is the
 *  same key whichever of them asks. */
function scratchBaseFor(
  ctx: ClientToolContext,
  src: string,
  size: string,
  lang: string,
  windowKey: string,
): Promise<string> {
  return ctx.store.prepareWork(`transcribe/${shortHash(`${src}|${size}|${lang}${windowKey}`)}`);
}

/** The model file for `size`, installing it if need be. */
async function modelFor(ctx: ClientToolContext, size: string): Promise<string> {
  try {
    return (await ensureWhisperModel(ctx, size)).path;
  } catch (e) {
    // Do NOT flatten this into "transcription cancelled". Whatever went wrong happened while
    // INSTALLING the model, before a single second of audio was read, and the download's own
    // message is the only one that says so — replacing it is how a 465 MiB download in
    // progress came out the other side looking like a failed transcription.
    if (e instanceof TranscriptionFailure) throw e;
    throw new TranscriptionFailure(
      "model_unavailable",
      e instanceof Error ? e.message : `whisper model '${size}' unavailable: ${String(e)}`,
      { cause: e },
    );
  }
}

/** An engine run as its caller reads it: what the process reported, and how the run ended when the person
 *  (Cancel) or the live check stopped it, so a stopped run is never taken for a crash of the graphics
 *  chip, and what the monitor measured, so the pace this PC keeps learns the start-up too. */
type EngineRun = CommandResult & {
  stoppedBy?: StopReason;
  startupS?: number;
  liveProjectedS?: number;
};

/** A signal that aborts when either `a` or `b` does, and the way to let go of both. */
function eitherSignal(
  a: AbortSignal | undefined,
  b: AbortSignal,
): { signal: AbortSignal; off: () => void } {
  if (!a) return { signal: b, off: () => undefined };
  const both = new AbortController();
  const stop = (): void => both.abort();
  if (a.aborted || b.aborted) both.abort();
  a.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  return {
    signal: both.signal,
    off: () => {
      a.removeEventListener("abort", stop);
      b.removeEventListener("abort", stop);
    },
  };
}

/** What `engineFor` is given to make jobs of: one transcription's meta, or a run over several files' (each file's own
 *  meta, as the page that started the run wrote them). */
type JobMeta = TranscriptJobMeta | { kind: "transcripts"; items: TranscriptJobMeta[] };

/** A launch the manifest does not allow is a failure of the run, said plainly, never a crash of something else. */
function refusedLaunch(e: unknown): unknown {
  return e instanceof ModelPairingError
    ? new TranscriptionFailure("engine_failed", `the speech engine was not started: ${e.message}`, {
        cause: e,
      })
    : e;
}

/** Whether a launch of the model file `args` name is a processor launch (the launch with `-ng`): when the caller asked
 *  for one, and always for a file the manifest does not allow on the graphics chip. */
function enginePath(args: readonly string[], cpuOnly: boolean): boolean {
  try {
    return launchPlan(args, cpuOnly).cpuOnly;
  } catch (e) {
    throw refusedLaunch(e);
  }
}

/** The last check on the arguments about to be spawned. */
function checkLaunch(argv: readonly string[]): void {
  try {
    assertLaunchArgv(argv);
  } catch (e) {
    throw refusedLaunch(e);
  }
}

/** Say on each transcription's meta whether this launch carries the engine's word times, before the job is made from
 *  it: the page that ran it and a page that takes it over after a crash both read it when the words are kept. It is
 *  written only when true, so a launch without them leaves the meta exactly as 0.27.0 made it. */
function noteWordTimes(meta: JobMeta, on: boolean): void {
  for (const m of meta.kind === "transcripts" ? meta.items : [meta]) {
    if (on) m.wordTimes = true;
    else delete m.wordTimes;
  }
}

/** The engine for one run of whisper-cli with `args`, and the way to let go of it afterwards.
 *
 *  In the app, whisper is a job of the app process: a crash of the page neither stops it nor loses its
 *  words, and the next page finishes it ({@link adoptTranscriptions}) from `meta`, which the job carries.
 *  The jobs are let go of only by `release`, which the caller calls once the words are kept, or it failed.
 *
 *  `engine` runs it on the GPU, or off it where the GPU is known to crash. A GPU that crashes is retried
 *  ONCE with it off (-ng): when that works, this machine stays off it for a while, and when it crashes too
 *  the GPU was not the cause and nothing is remembered.
 *
 *  Each launch is its own job with its own abort, registered with the top-bar chip's store (S2-05): Cancel
 *  stops THAT run and no other, whoever else is running. The caller's own signal (Stop) ends it too. A run
 *  stopped either way exits non-zero, and that is not a crash of the chip: it is not retried, and it is
 *  answered as what it was. `info` says what the run is for, so the chip can title it. */
async function engineFor(
  ctx: ClientToolContext,
  args: string[],
  meta: JobMeta,
  info: RunInfo,
  /** The model the run is made with: the engine's word times are measured for one model only. */
  size: string,
): Promise<{ engine: () => Promise<EngineRun>; release: () => Promise<void> }> {
  const sup = await jobSupervisor();
  const jobs: string[] = [];
  /** How the run was stopped, if it was: shared by the launches of one run, so a stop never leads to a retry. */
  const stopped: { by: StopReason | null } = { by: null };
  const launch = async (cpuOnly: boolean, afterCrash: boolean): Promise<EngineRun> => {
    // THE place whisper-cli is started (the test "where the engine is started" in speechModelRun.test.ts walks the
    // sources for any other). The model file `args` name says which path it may take: a file the manifest restricts
    // to the processor is launched with `-ng` whatever was asked, so it can never run on the graphics chip, and the
    // final arguments are checked once more just before the spawn.
    const onProcessor = enginePath(args, cpuOnly);
    const id = `whisper-${scratchToken()}`;
    jobs.push(id);
    const wordTimes = wordTimesArgs({ size, cpuOnly: onProcessor });
    noteWordTimes(meta, wordTimes.length > 0);
    const run = onProcessor ? [...args, "-ng", ...wordTimes] : args;
    checkLaunch(run);
    const own = new AbortController();
    const both = eitherSignal(ctx.signal, own.signal);
    const watch = watchSpeechRun({
      ...info,
      id,
      cpuOnly: onProcessor,
      afterCrash,
      stop: (how) => {
        stopped.by ??= how;
        own.abort();
      },
      readLog: sup
        ? async () => (await sup.list()).find((v) => v.id === id)?.stderr_head ?? null
        : undefined,
    });
    try {
      const result = sup
        ? await runAsJob(
            sup,
            {
              id,
              lane: id,
              program: "whisper-cli",
              args: run,
              meta: { ...meta } as Record<string, unknown>,
            },
            both.signal,
            watch.onStdout,
          )
        : await ctx.runner.run("whisper-cli", run, both.signal, undefined, watch.onStdout);
      const end = watch.finish(result.code, stopped.by);
      return {
        ...result,
        ...(end.startupS === null ? {} : { startupS: end.startupS }),
        ...(stopped.by ? { stoppedBy: stopped.by } : {}),
        ...(end.liveProjectedS === null ? {} : { liveProjectedS: end.liveProjectedS }),
      };
    } catch (e) {
      watch.finish(null, stopped.by);
      throw e;
    } finally {
      both.off();
    }
  };
  const engine = async (): Promise<EngineRun> => {
    // A file that may only run on the processor makes this a processor run from its first launch: no chip is tried,
    // so a crash is never taken for the chip's and no hold is kept for it.
    const cpuOnly = cpuOnlyNow() || enginePath(args, false);
    const first = await launch(cpuOnly, false);
    if (stopped.by || cpuOnly || ctx.signal?.aborted || !isGpuCrash(first)) return first;
    const second = await launch(true, true);
    if (stopped.by) return second;
    const worked = second.code === 0;
    if (worked) holdCpuOnly(first.code);
    reportGpuCrash(first.code, worked);
    return second;
  };
  const release = async (): Promise<void> => {
    for (const id of jobs) await sup?.forget(id).catch(() => undefined);
  };
  return { engine, release };
}

/** Where a run of whisper is read and its transcript kept: a project's store, or for a run adopted
 *  after a crash of the page, the app's own filesystem (no project is needed). */
interface ScratchIO {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  appCache(): Promise<AppCache | null>;
}

/** One app_error per outcome per session: a GPU that crashes does so on every file, and the telling
 *  is the same each time. Only the exit status and whether the CPU run worked leave the machine. */
const reportedGpuCrashes = new Set<string>();
function reportGpuCrash(code: number | null, cpuWorked: boolean): void {
  const key = `${code}|${cpuWorked}`;
  if (reportedGpuCrashes.has(key)) return;
  reportedGpuCrashes.add(key);
  reportAppError(
    `speech_gpu_crash: exit ${code}, ` +
      (cpuWorked
        ? "the CPU run worked and the GPU is off until it is tried again"
        : "the CPU run failed too"),
  );
}

/** A run of whisper, as whoever finishes it needs it: the page that started it, or the next one. */
interface TranscriptJobMeta {
  kind: "transcript";
  /** The app-cache key its transcript is kept under; null when the file has no identity. */
  key: string | null;
  /** What another request for the same transcript joins while it runs. */
  once: string;
  /** whisper's output base (`-of`): it writes `<scratch>.json`. */
  scratch: string;
  /** Where its clock starts on the file's, for a window cut out on its own. */
  shiftMs: number;
  /** The 16 kHz extracts it reads. */
  wavs: string[];
  /** The beam the engine was run with, and the model file it ran on. Absent on a job a page of an
   *  earlier version started: that ran at the engine's default, which is acceptable for everything. */
  beam?: number;
  variant?: ModelVariant;
  /** The language the caller asked for ("auto" when it named none). */
  requested?: string;
  /** True for the run that replaced one refused for being narrower than its language needs. */
  rerun?: boolean;
  /** What the chip shows of this run if a page that did not start it takes it over after a crash (F4): the
   *  file's name, what asked for it, and how much audio it reads. LOCAL: the meta stays in the app process,
   *  and the app process outlives a page, never a version of the app, so a run adopted always carries them. */
  label?: string;
  purpose?: SpeechPurpose;
  spanS?: number | null;
  /** True when the engine was launched with the word-times arguments (speechWordTimes.ts), so its output is read
   *  the way it was made, by the page that ran it and by one that adopts it. LOCAL, like the three above: written
   *  only when true, so a launch without them leaves the meta as it was, and never sent anywhere. */
  wordTimes?: boolean;
}

/** A run of whisper made into its transcript and kept: the one finish, for the page that ran it
 *  and for a page that adopted it after a crash. Its JSON is read, moved onto the file's timeline
 *  and put in the app cache; the scratch output is removed, whatever happens. */
async function finishWhisper(
  io: ScratchIO,
  meta: TranscriptJobMeta,
  run: EngineRun,
  signal?: AbortSignal,
  /** One file of a run over several: its words are kept if ITS output is there and whole, whatever the
   *  run's exit status says about the files after it, and the run is reported once by whoever ran it. */
  batch = false,
): Promise<ParsedTranscript> {
  const json = `${meta.scratch}.json`;
  try {
    if (batch ? !(await io.exists(json)) : run.code !== 0 || !(await io.exists(json))) {
      // Stop kills the sidecar, so the exit code describes the KILL, not the transcription:
      // it surfaced as `whisper-cli failed (code=-1): cancelled`, which reads as a broken
      // install rather than as the thing the user just asked for.
      if (signal?.aborted) throw new Error("transcription cancelled");
      // The person pressed Cancel on this run, or the live check stopped it for being too slow: each is
      // answered as what it was, never as a failure of the engine (S2-05, S2-02).
      if (run.stoppedBy === "person") throw new SpeechCancelledError();
      if (run.stoppedBy === "too_slow")
        throw new SpeechDeferredError(
          { why: "cap", projectedS: run.liveProjectedS ?? null, capS: CAP_S },
          { stopped: true },
        );
      if (run.stderr === "cancelled") throw new Error("transcription cancelled");
      if (run.code !== null && WINDOWS_LOAD_FAILURES.has(run.code))
        throw new SpeechEngineUnavailableError(run.code);
      // whisper-cli prints its usage and exits 0 for a language it does not know, so the cause is
      // in the output, not in the exit status.
      const rejected = /error: unknown language '([^'\r\n]*)'/.exec(run.stderr);
      throw new TranscriptionFailure(
        rejected ? "language_rejected" : "engine_failed",
        rejected
          ? `the speech engine did not accept the language "${rejected[1].slice(0, 40)}"`
          : batch && run.code === 0
            ? `the speech engine made no transcript of this file: ${stderrExcerpt(run.stderr, 200)}`
            : `whisper-cli failed (code=${run.code}): ${stderrExcerpt(run.stderr, 200)}`,
      );
    }
    let data: WhisperCppJson;
    try {
      data = JSON.parse(await io.readText(json)) as WhisperCppJson;
    } catch (e) {
      // A run that died while writing this file's output leaves it cut short. Only a batch can have a file
      // whose turn had not come and one it was in the middle of, so only there is it said and retried alone.
      if (!batch) throw e;
      throw new TranscriptionFailure(
        "engine_failed",
        `the speech engine's output for this file was cut short (code=${run.code})`,
      );
    }
    // The commit point, before anything reaches the cache and once the language is known: a run made
    // with a file or a setting its language does not allow (speechModel.ts, speechDecoding.ts) is refused
    // here, whoever finishes it, the page that ran it or a page that adopted it. It is never kept.
    const detected = detectedLanguage(data, meta.requested);
    // What this machine hears next is predicted from what it was last told it heard, so the
    // language is remembered even when this transcript is refused: it is still what was heard.
    if (meta.requested === "auto" && detected) rememberSpeechLanguage(detected);
    if (
      meta.beam !== undefined &&
      !acceptableRun({ variant: meta.variant ?? MODEL_VARIANT, beam: meta.beam }, detected)
    )
      throw new WeakDecodeError(detected, meta.beam);
    shiftWhisperJson(data, meta.shiftMs);
    // Read the way the run was made, and as 0.27.0 read it when the behaviour has been switched off since.
    const parsed = parseWhisperCpp(data, meta.wordTimes === true && wordTimesOn());
    // Kept outside the project, so it is kept even when the project closed while whisper ran.
    if (meta.key) await (await io.appCache())?.put(TRANSCRIPTS, meta.key, data);
    if (!batch) {
      const facts = whisperRunFacts(run.stderr);
      reportTranscription(facts, undefined, { beam: meta.beam, rerun: meta.rerun });
      recordSpeechRun(
        facts.audioSeconds,
        facts.wallSeconds,
        backendOfRun(facts.backend),
        undefined,
        run.startupS,
      );
    }
    return parsed;
  } finally {
    await io.remove(json).catch(() => undefined);
  }
}

/** The language whisper says it transcribed: the one it detected, or the one it was told. */
function detectedLanguage(data: WhisperCppJson, requested: string | undefined): string {
  const said = whisperCode(data.result?.language);
  return said || (requested && requested !== "auto" ? whisperCode(requested) : "");
}

/** The transcription a job of the app process is running, or null for any other job. Its meta is
 *  what this app's page wrote when it started the job: the app process outlives a page, never a
 *  version of the app. */
function transcriptMeta(v: JobView): TranscriptJobMeta | null {
  return v.meta.kind === "transcript" ? (v.meta as unknown as TranscriptJobMeta) : null;
}

/** The transcriptions of a run over several files ({@link ensureTranscripts}): each file's own
 *  meta, as the page that started the run wrote them. */
function transcriptsMeta(v: JobView): TranscriptJobMeta[] | null {
  const items = v.meta.items;
  if (v.meta.kind !== "transcripts" || !Array.isArray(items)) return null;
  return items.filter(
    (i): i is TranscriptJobMeta => !!i && (i as { kind?: unknown }).kind === "transcript",
  );
}

async function desktopScratchIO(): Promise<ScratchIO | null> {
  try {
    const [{ TauriFs }, { appCacheFor }] = await Promise.all([
      import("./tauri"),
      import("./appCache"),
    ]);
    const fs = new TauriFs();
    return {
      exists: (p) => fs.exists(p),
      readText: (p) => fs.readTextFile(p),
      remove: (p) => fs.remove(p),
      appCache: () => appCacheFor(fs),
    };
  } catch {
    return null;
  }
}

/** This page's taking over of what a crashed page left running, once begun. */
let adoption: Promise<number> | null = null;

/** After a crash of the page (4i): the transcriptions the app process still runs, or ran while no
 *  page was there, are finished exactly as the page that started them would have: their words kept
 *  in the app cache, their scratch and audio removed, the job let go. One still running is whisper
 *  at work, so it holds the indexer's whisper turn, and a request for the same transcript waits for
 *  it instead of starting another.
 *
 *  Once per page, and before this page runs any whisper itself: every later call answers how many
 *  the first took over. Never fails; a page that cannot list the app's jobs transcribes as before. */
export function adoptTranscriptions(io?: ScratchIO): Promise<number> {
  adoption ??= adoptOrphans(io).catch(() => 0);
  return adoption;
}

async function adoptOrphans(io?: ScratchIO): Promise<number> {
  const sup = await jobSupervisor();
  if (!sup) return 0;
  const scratchIo = io ?? (await desktopScratchIO());
  if (!scratchIo) return 0;
  /** An adopted run is on the chip's list, going, with a Cancel that kills its process (F4): what its meta
   *  carries is what the page that started it knew. Nothing is listed for one that has already ended. */
  const showing = (v: JobView, m: TranscriptJobMeta | undefined) =>
    v.state === "exited"
      ? null
      : showAdoptedRun({
          id: v.id,
          purpose: m?.purpose ?? "index",
          label: m?.label ?? "a file",
          spanS: typeof m?.spanS === "number" ? m.spanS : null,
          enqueuedAt: v.queued_at,
          startedAt: v.started_at,
          stop: () => void sup.kill(v.id).catch(() => undefined),
        });
  let adopted = 0;
  for (const v of await sup.list()) {
    const together = transcriptsMeta(v);
    if (together) {
      adopted++;
      // One run over several files: held until every file's words are kept, finished one by one from the
      // output each was given, and let go of once.
      const turn = adoptTurn("whisper");
      const ended = whenJobEnds(sup, v.id);
      const shown = showing(v, together[0]);
      const finishing = together.map((m) => {
        const finished = holdingWavs(scratchIo, m.wavs, async () => {
          const job = await ended;
          if (!job) throw new Error("the app process no longer has this transcription");
          const result = jobResult(job);
          return finishWhisper(
            scratchIo,
            m,
            shown?.stoppedByPerson() ? { ...result, stoppedBy: "person" } : result,
            undefined,
            true,
          );
        });
        // A failure reaches whoever joins it; nobody else is waiting on it. A file the person stopped is
        // theirs to ask for again, and nothing starts it behind their back (F7).
        finished.catch((e: unknown) => {
          if (isSpeechCancelled(e)) markRunCancelledByPerson(m.key);
        });
        joinable(m.once, finished);
        return finished;
      });
      void Promise.allSettled(finishing)
        .then(async (outcomes) => {
          // The run is reported once, by the page that finished it, for the files it kept.
          const kept = outcomes.filter((o) => o.status === "fulfilled").length;
          const job = await ended;
          if (shown)
            shown.end(kept > 0 ? "done" : shown.stoppedByPerson() ? "cancelled" : "failed");
          if (kept > 0 && job)
            reportTranscription(
              whisperRunFacts(jobResult(job).stderr, { batch: true }),
              undefined,
              { beam: together[0]?.beam, files: kept },
            );
        })
        .catch(() => undefined)
        .finally(async () => {
          shown?.end("failed");
          turn();
          await sup.forget(v.id).catch(() => undefined);
        });
      continue;
    }
    const m = transcriptMeta(v);
    if (!m) continue;
    adopted++;
    // Held until its words are kept: while it runs, it is the whisper at work.
    const turn = adoptTurn("whisper");
    const shown = showing(v, m);
    const finished = holdingWavs(scratchIo, m.wavs, async () => {
      try {
        const ended = await whenJobEnds(sup, v.id);
        if (!ended) throw new Error("the app process no longer has this transcription");
        // A run the person stopped on the chip is answered as that, never as a failure of the engine.
        const result = jobResult(ended);
        const parsed = await finishWhisper(
          scratchIo,
          m,
          shown?.stoppedByPerson() ? { ...result, stoppedBy: "person" } : result,
        );
        shown?.end("done");
        return parsed;
      } catch (e) {
        if (isSpeechCancelled(e)) markRunCancelledByPerson(m.key);
        shown?.end(isSpeechCancelled(e) ? "cancelled" : "failed");
        throw e;
      }
    }).finally(async () => {
      turn();
      await sup.forget(v.id).catch(() => undefined);
    });
    // A failure reaches whoever joins it; nobody else is waiting on it.
    finished.catch(() => undefined);
    joinable(m.once, finished);
  }
  return adopted;
}

export interface EnsuredTranscript {
  parsed: ParsedTranscript;
  /** True when it was already made, and nothing ran. */
  existed: boolean;
}

/** The language as the caller means it, as the engine takes it: its own short code ("es"), or ""
 *  to detect it. A regional tag names the same language to whisper ("en-US", "pt_BR" -> "en",
 *  "pt"), and so do the other names a caller uses ("jpn", "fil", "mandarin": whisperLanguages.ts).
 *  A language the engine does not know is detected too: whisper-cli answers an unknown code with
 *  its usage text and no transcript, so it is never handed one. 'auto' is the no-language path. */
export function normLanguage(language: unknown): string {
  return whisperCode(language);
}

/** What whisper is told AND what keys its cache: a language code, or "auto". whisper-cli's own
 *  default is ENGLISH, not detection, so leaving `-l` out transcribed every language as English
 *  (UJ-004). One value for the argument and the key, so the two can never disagree. */
function whisperLanguage(language: unknown): string {
  return normLanguage(language) || "auto";
}

/** The file `ref` names, or why there is none: offline (a linked file that moved, UJ-014), or
 *  missing. */
async function sourcePath(ctx: ClientToolContext, ref: string): Promise<string> {
  const src = await ctx.store.resolveRef(ref);
  if (src) return src;
  const offline = await ctx.store.offlineMedia(ref).catch(() => null);
  if (offline) throw new MediaOfflineError(offline);
  throw new Error(`file not found: ${ref}`);
}

/** The whole-file transcript of `ref`: the one already made for this file, model and language
 *  (in any project), else a new one. A WHOLE file is the background indexer's to make, one at a time
 *  and only where this PC can do it in the cap (S2-02), so a foreground caller never gets here: it
 *  asks for the stretch it needs ({@link transcribeSpan}), and that cannot be bypassed by forgetting
 *  to. With the switch `speech_cpu_cap` off it is 0.27.0 again: any caller may ask for a whole file. */
export async function ensureTranscript(
  ctx: ClientToolContext,
  ref: string,
  size: string = DEFAULT_MODEL,
  language?: string,
): Promise<EnsuredTranscript> {
  if (!ctx.background && exportFlag("speech_cpu_cap"))
    throw new Error(
      "ensureTranscript makes a WHOLE file's transcript and belongs to the background indexer: ask for the stretch you need (transcribeSpan)",
    );
  const src = await sourcePath(ctx, ref);
  const made = await peekTranscript(ctx, src, size, language);
  if (made) return { parsed: made, existed: true };
  return { parsed: await runWhisper(ctx, src, size, language), existed: false };
}

/** The transcript of one stretch of `ref` (source seconds): this stretch's own, or the file's whole one
 *  where it is kept, else a run over the stretch alone. What a foreground caller that needs a file's
 *  words asks for. */
export async function transcribeSpan(
  ctx: ClientToolContext,
  ref: string,
  window: { start: number; end: number },
  language?: string,
  size: string = DEFAULT_MODEL,
): Promise<EnsuredTranscript> {
  const src = await sourcePath(ctx, ref);
  const made = await peekTranscript(ctx, src, size, language, window);
  if (made) return { parsed: made, existed: true };
  return { parsed: await runWhisper(ctx, src, size, language, window), existed: false };
}

/** What one file of {@link ensureTranscripts} came to. */
export type BatchOutcome = { ok: true; existed: boolean } | { ok: false; error: unknown };

/** A file waiting for the engine: its place in the caller's list and where it is. */
interface Wanted {
  at: number;
  src: string;
}

/** A {@link Wanted} with what a run needs to know about it. */
interface Keyed extends Wanted {
  keys: Awaited<ReturnType<typeof transcriptKeys>>;
  scratchBase: string;
  /** What anybody else who wants this transcript joins while it runs. */
  onceKey: string;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The whole-file transcripts of `refs`, each as {@link ensureTranscript} would make it, but with ONE run
 *  of the engine for everything that needs one (T-34 step 3): a run costs a start-up no clip shortens, and
 *  six short clips took 13.6 s as six runs and 4.1 s as one, with the same words.
 *
 *  Every file comes to its own outcome. One that already has its transcript costs nothing, one that someone
 *  else is transcribing is joined, and what remains runs together when there are two or more of them. A
 *  file the run made no transcript of is then run alone, exactly as it always was, so a bad clip costs its
 *  neighbours nothing and an engine that died half way loses only the files it had not reached. Only a
 *  failure of the whole run (no model, an engine that cannot start) is thrown, and for every file at once. */
export async function ensureTranscripts(
  ctx: ClientToolContext,
  refs: readonly string[],
  size: string = DEFAULT_MODEL,
  language?: string,
): Promise<BatchOutcome[]> {
  const outcomes: Array<BatchOutcome | undefined> = refs.map(() => undefined);
  const wanted: Wanted[] = [];
  for (const [at, ref] of refs.entries()) {
    try {
      const src = await sourcePath(ctx, ref);
      if (await peekTranscript(ctx, src, size, language))
        outcomes[at] = { ok: true, existed: true };
      else wanted.push({ at, src });
    } catch (error) {
      outcomes[at] = { ok: false, error };
    }
  }
  await transcribeTogether(ctx, wanted, size, language, outcomes);
  return outcomes.map((o) => o ?? { ok: false, error: new Error("transcription did not run") });
}

async function transcribeTogether(
  ctx: ClientToolContext,
  wanted: Wanted[],
  size: string,
  language: string | undefined,
  outcomes: Array<BatchOutcome | undefined>,
): Promise<void> {
  const keyed: Keyed[] = await Promise.all(
    wanted.map(async (w) => {
      const keys = await transcriptKeys(ctx, w.src, size, language, null);
      const scratchBase = await scratchBaseFor(ctx, w.src, size, keys.lang, keys.win.key);
      return { ...w, keys, scratchBase, onceKey: keys.out ?? scratchBase };
    }),
  );
  // A whole file this PC would take longer than the cap for is not started by itself (S2-02): it is left
  // out, answered as a deferral, and the others run. One already being transcribed is joined below,
  // never planned away. Done before the synchronous pass below, so that pass stays one pass.
  const left = new Set<Keyed>();
  if (ctx.background) {
    for (const k of keyed) {
      if (inflight.has(k.onceKey)) continue;
      const admission = admitWholeFile({
        file: fileLabel(k.src),
        where: "boundary",
        audioS: knownAudioLength(k.src),
      });
      if (admission?.plan !== "ondemand") continue;
      left.add(k);
      outcomes[k.at] = { ok: false, error: new SpeechDeferredError(admission) };
    }
  }
  const admitted = keyed.filter((k) => !left.has(k));
  // One synchronous pass: who is already being transcribed (joined, not started again), and who is ours.
  const joining = admitted.filter((k) => inflight.has(k.onceKey));
  const ours = admitted.filter((k) => !inflight.has(k.onceKey));
  const waiting = joining.map(async (k) => {
    const running = inflight.get(k.onceKey);
    try {
      await running;
      outcomes[k.at] = { ok: true, existed: false };
    } catch (error) {
      outcomes[k.at] = { ok: false, error };
    }
  });
  if (ours.length < 2) {
    for (const k of ours) {
      try {
        await runWhisper(ctx, k.src, size, language);
        outcomes[k.at] = { ok: true, existed: false };
      } catch (error) {
        outcomes[k.at] = { ok: false, error };
      }
    }
  } else {
    await runTogether(ctx, ours, size, language, outcomes);
  }
  await Promise.all(waiting);
}

/** One run of the engine over `ours` (two or more files that nobody else is transcribing). */
async function runTogether(
  ctx: ClientToolContext,
  ours: Keyed[],
  size: string,
  language: string | undefined,
  outcomes: Array<BatchOutcome | undefined>,
): Promise<void> {
  const lang = ours[0].keys.lang;
  const held = ours.map(() => deferred<ParsedTranscript>());
  // Whoever asks for one of these from now on waits for this run instead of starting another.
  ours.forEach((k, n) => joinable(k.onceKey, held[n].promise));
  const settled = ours.map(() => false);
  const settle = (n: number, result: { parsed: ParsedTranscript } | { error: unknown }): void => {
    if (settled[n]) return;
    settled[n] = true;
    if ("error" in result) {
      outcomes[ours[n].at] = { ok: false, error: result.error };
      held[n].reject(result.error);
    } else {
      outcomes[ours[n].at] = { ok: true, existed: false };
      held[n].resolve(result.parsed);
    }
  };
  /** What each file the run refused (for not being what its language needs) is run with alone, by place in `ours`. */
  const widenTo = new Map<number, ModelPlan>();
  /** A file the run did not make a transcript of, run alone as it always was. */
  const alone = async (n: number): Promise<void> => {
    try {
      settle(n, {
        parsed: await runWhisper(ctx, ours[n].src, size, language, null, true, widenTo.get(n)),
      });
    } catch (error) {
      settle(n, { error });
    }
  };
  try {
    await adoptTranscriptions(ctx.store);
    // One file and one beam for the whole run, decided before the model is fetched because it says WHICH file.
    const plan = await planFor(ctx, size, lang, undefined);
    const model = await modelFor(ctx, plan.key);
    const wavs = await Promise.all(ours.map((k) => wavPathFor(ctx, k.keys.identity ?? k.src)));
    await holdingWavs(ctx.store, wavs, async () => {
      // The audio of each file, held until its words are kept. One that cannot be read fails alone.
      const ready: number[] = [];
      for (const [n, k] of ours.entries()) {
        try {
          await extractWav(ctx, k.src, wavs[n]);
          ready.push(n);
        } catch (error) {
          settle(n, { error });
        }
      }
      if (ready.length < 2) {
        for (const n of ready) await alone(n);
        return;
      }
      const metas: TranscriptJobMeta[] = ready.map((n) => ({
        kind: "transcript",
        key: ours[n].keys.out,
        once: ours[n].onceKey,
        scratch: `${ours[n].scratchBase}.${scratchToken()}.tmp`,
        shiftMs: 0,
        wavs: [wavs[n]],
        beam: plan.beam,
        variant: plan.variant,
        requested: lang,
        label: fileLabel(ours[n].src),
        purpose: ctx.background ? "index" : (ctx.speechPurpose ?? "look"),
      }));
      // One process, every file in it, each output under its own name: the nth `-of` is the nth `-f`'s.
      const args = [
        "-m",
        model,
        ...ready.flatMap((n) => ["-f", wavs[n]]),
        "-ojf",
        ...metas.flatMap((m) => ["-of", m.scratch]),
        "-t",
        whisperThreads(),
        "-l",
        lang,
        "-mc",
        "0",
        ...decodeArgs(plan.beam),
      ];
      const { engine, release } = await engineFor(
        ctx,
        args,
        { kind: "transcripts", items: metas },
        {
          purpose: ctx.background ? "index" : (ctx.speechPurpose ?? "look"),
          label: fileLabel(ours[ready[0]].src),
          work: ready.map((n) => ({
            source: ours[n].src,
            language: normLanguage(language),
            window: null,
          })),
          spanS: null,
          threads: Number(whisperThreads()) || null,
          liveStop: false,
          // Each file's segments restart at 0: the run has no one position to read a speed from.
          several: true,
        },
        plan.key,
      );
      const missed: number[] = [];
      try {
        const run = ctx.background ? await engine() : await lookWhisper(engine, ctx.signal);
        if (!run) throw new Error("transcription cancelled"); // stopped before its turn came
        let kept = 0;
        let unavailable: unknown;
        for (const [i, n] of ready.entries()) {
          try {
            settle(n, { parsed: await finishWhisper(ctx.store, metas[i], run, ctx.signal, true) });
            kept++;
          } catch (error) {
            if (error instanceof SpeechEngineUnavailableError) unavailable = error;
            if (error instanceof WeakDecodeError)
              widenTo.set(n, await replanFor(ctx, error.detected));
            // The person stopped the run: what it did not reach is not started again behind their back.
            if (isSpeechCancelled(error)) settle(n, { error });
            else missed.push(n);
          }
        }
        // The run is reported once, for all the files it read.
        if (kept > 0)
          reportTranscription(whisperRunFacts(run.stderr, { batch: true }), undefined, {
            beam: plan.beam,
            files: kept,
          });
        if (unavailable) throw unavailable;
      } finally {
        // Their words are kept, or they failed: nothing is left for another page to finish.
        await release();
      }
      for (const n of missed) await alone(n);
    });
  } catch (error) {
    ours.forEach((_, n) => settle(n, { error }));
  } finally {
    // Whoever joined one of these must never be left waiting on a run that is over.
    ours.forEach((_, n) => settle(n, { error: new Error("transcription did not finish") }));
  }
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

/** How long get_transcript waits for transcription before answering with what is ready (owner
 *  decision 2026-10-04): about a minute. What is not ready goes on in the background. */
export const TRANSCRIPT_WAIT_MS = 60_000;

/** One clip as get_transcript reads it: its file, and the source seconds it plays. */
interface ClipUse {
  track: string;
  clip: Clip;
  src: string;
  span: [number, number];
}

/** A stretch of one file to transcribe, covering the clips that play it. */
interface SpanJob {
  src: string;
  window: { start: number; end: number };
  words?: WordPayload[];
  error?: string;
  /** Why it failed, when it did: a stop by the person is answered as that, not as a failure. */
  reason?: TranscriptFailureReason;
}

/** The windows to transcribe: each clip's padded span, merged where two of one file overlap, so
 *  a split clip is one window and not two (speechSpans.ts, the rule add_captions shares). */
function spanJobs(uses: ClipUse[]): Map<ClipUse, SpanJob> {
  const windows = spanWindows(uses, (u) => u.src);
  const jobOfWindow = new Map<object, SpanJob>();
  const jobOf = new Map<ClipUse, SpanJob>();
  for (const u of uses) {
    const w = windows.get(u);
    if (!w) continue;
    let job = jobOfWindow.get(w);
    if (!job) {
      job = { src: u.src, window: { start: w.start, end: w.end } };
      jobOfWindow.set(w, job);
    }
    jobOf.set(u, job);
  }
  return jobOf;
}

/** get_transcript: the CURRENT TIMELINE's spoken transcript in PROJECT FRAMES
 *  (other NLEs model). Walks the audio-track clips (a video clip's audio is split to a
 *  linked audio clip at placement), maps each clip's source words through its
 *  trim/speed/position, and concatenates in timeline order — so it always reflects
 *  what's audible after cuts. For a RAW source file's transcript, use inspect_media.
 *  Optional start_frame/end_frame window it to a time range; optional clip_id scopes
 *  it to one clip (its audio, or the audio split from that video clip).
 *
 *  Only what the clips play is transcribed, plus a second either side (owner decision
 *  2026-10-04): an 80-minute file a clip uses 2 minutes of is not transcribed whole. A file's
 *  whole transcript, when the indexer has made it, answers every clip of it. The call waits at
 *  most {@link TRANSCRIPT_WAIT_MS}; clips not ready by then are listed in `in_progress` and the
 *  rest of the work goes to the project's background transcriber. */
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
    if (!found) return { ok: false, error: missingClipMessage("get_transcript", wantId) };
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

  const failures: Array<{ clip_id: string; error: string }> = [];
  /** How many of those the person stopped in the app (Cancel on the chip), not failed. */
  let stoppedByPerson = 0;
  const uses: ClipUse[] = [];
  for (const [track, clip] of audio) {
    const span = playedSpan(clip, fps, startFrame, endFrame);
    if (!span) continue; // plays nothing inside the asked-for frames
    try {
      uses.push({ track, clip, src: await sourcePath(ctx, String(clip.media_ref)), span });
    } catch (e) {
      // Swallowing this made a BROKEN transcriber indistinguishable from silence:
      // the tool reported success with no words and the model concluded the footage
      // had no speech. Keep going (one bad source shouldn't sink the rest) but
      // report what failed, and fail outright when nothing could be transcribed.
      failures.push({ clip_id: String(clip.id), error: transcriptionFailureText(e) });
    }
  }
  // Kept already, the file's whole transcript (the indexer's) or a clip's own stretch from an
  // earlier call: answered at once. Only the clips still without words are merged and transcribed,
  // so a clip keeps its words when a new clip overlapping it joins the timeline.
  const jobOf = new Map<ClipUse, SpanJob>();
  const rest: ClipUse[] = [];
  for (const use of uses) {
    const window = padded(use.span);
    const kept = await peekTranscript(ctx, use.src, DEFAULT_MODEL, undefined, window).catch(
      () => null,
    );
    if (kept) jobOf.set(use, { src: use.src, window, words: kept.words });
    else rest.push(use);
  }
  for (const [use, job] of spanJobs(rest)) jobOf.set(use, job);
  const jobs = [...new Set(uses.map((u) => jobOf.get(u)!))]; // in the order the timeline plays them
  // The rest, one at a time, for at most TRANSCRIPT_WAIT_MS in all (a merge an earlier call kept
  // comes straight back from runWhisper). A run still going when the time is up keeps going and
  // keeps its result; one not started yet goes to the background queue.
  const until = Date.now() + TRANSCRIPT_WAIT_MS;
  let overdue: SpanJob | null = null;
  /** The answer the person's Cancel left, once a run was stopped: the windows after it are not started (F6a)
   *  and are answered the same way. */
  let stopped: { error: string } | null = null;
  /** How the run of the job still going when the time ran out ends: what the wake for its words waits on. */
  let overdueEnds: Promise<Settled> | null = null;
  const queued: SpanJob[] = [];
  for (const job of jobs) {
    if (job.words) continue;
    if (stopped) {
      job.error = stopped.error;
      job.reason = "cancelled";
      continue;
    }
    if (overdue) {
      queued.push(job);
      continue;
    }
    const made = runWhisper(
      { ...ctx, speechPurpose: "transcript" },
      job.src,
      DEFAULT_MODEL,
      undefined,
      job.window,
    );
    const run = made.then(
      (t) => ({ words: t.words }),
      (e: unknown) => ({
        error: transcriptionFailureText(e),
        reason: classifyTranscriptFailure(e).reason,
      }),
    );
    const got = await trackSpeechWait(
      "get_transcript",
      settledWithin(run, Math.max(0, until - Date.now()), ctx.signal),
    );
    if (got) {
      Object.assign(job, got);
      if (job.reason === "cancelled" && job.error !== undefined) stopped = { error: job.error };
    } else {
      overdue = job;
      overdueEnds = made.then(
        (): Settled => ({ ok: true }),
        (error: unknown): Settled => ({ ok: false, error }),
      );
    }
  }
  if (ctx.signal?.aborted) return stoppedAnswer();
  const handedJobs = new Set(
    queued.filter((job) => prioritizeTranscript(ctx.store.projectDir, job.src, "", job.window)),
  );
  const handed = handedJobs.size === queued.length;
  // Words still to come are waited for on the chat's behalf: the assistant is brought back when they are there.
  // The run that was going when the time ran out says so when it ends. A file the project's own transcriber was
  // handed has no run to wait for here (its words appear in the cache), so the cache is looked at. A file nobody
  // is transcribing is not waited for: no words will come.
  for (const job of jobs) {
    if (job.words || job.error !== undefined) continue;
    const first = uses.find((u) => jobOf.get(u) === job);
    if (!first) continue;
    const target = wakeTargetOf(
      ctx,
      String(first.clip.media_ref),
      String(first.clip.id),
      job.window,
      job.src,
    );
    if (!target) continue;
    const key = `${job.src}\u0000transcript\u0000${job.window.start}-${job.window.end}`;
    const seconds = job.window.end - job.window.start;
    if (job === overdue && overdueEnds) registerPendingWords(target, key, seconds, overdueEnds);
    else if (handedJobs.has(job))
      registerCachedWords(
        target,
        key,
        seconds,
        async () =>
          (await peekTranscript(ctx, job.src, DEFAULT_MODEL, undefined, job.window).catch(
            () => null,
          )) !== null,
      );
  }

  const clipsOut: Array<Record<string, unknown>> = [];
  const pending: Array<{ clip_id: string; track_id: string }> = [];
  let idx = 0;
  let truncated = false;
  for (const use of uses) {
    const { clip, track } = use;
    const job = jobOf.get(use)!;
    if (job.error !== undefined) {
      failures.push({ clip_id: String(clip.id), error: job.error });
      if (job.reason === "cancelled") stoppedByPerson++;
      continue;
    }
    if (!job.words) {
      pending.push({ clip_id: String(clip.id), track_id: track });
      continue;
    }
    if (truncated) continue;
    const rows: Array<[number, string, number, number]> = [];
    for (const [text, tf, te] of clipWordFrames(job.words, clip, fps)) {
      if (tf < startFrame || tf >= endFrame) continue;
      if (idx >= TRANSCRIPT_WORD_CAP) {
        truncated = true;
        break;
      }
      rows.push([idx++, text, tf, te]);
    }
    if (rows.length) clipsOut.push({ clip_id: clip.id, track_id: track, words: rows });
    // The assistant has this clip's words now (all of them, unless the cap cut them): a wake has nothing to add.
    if (!truncated) noteWordsFetched(ctx, String(clip.media_ref), job.window);
  }
  const preview = clipsOut
    .flatMap((c) => (c.words as Array<[number, string, number, number]>).map((r) => r[1]))
    .join(" ");
  // Every audio source failed -> an empty transcript would be a lie, not a result.
  if (failures.length && !clipsOut.length && !pending.length) {
    // The person stopped it in the app: nothing failed, and the assistant is told not to start it again.
    if (stoppedByPerson === failures.length)
      return { ok: false, reason: "cancelled", error: failures[0].error, failed: failures };
    return {
      ok: false,
      error:
        `transcription failed for all ${failures.length} audio clip(s) — this is a tool ` +
        `failure, NOT an absence of speech: ${failures[0].error}`,
      failed: failures,
    };
  }
  const waiting = handed
    ? "they are being transcribed in the background, only the parts the clips play"
    : "transcribing them takes longer than one call waits";
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
    ...(pending.length
      ? {
          in_progress: pending,
          note: `No words yet for ${pending.length} clip(s) in in_progress: ${waiting}. Call get_transcript again for them; their absence here is not silence.`,
        }
      : {}),
  };
}

export function registerTranscriptTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("get_transcript", (a) => getTranscriptTool(a, getCtx()));
}
