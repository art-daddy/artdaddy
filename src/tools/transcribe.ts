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
import { joinPath } from "./store";
import { beginSessionActivity } from "../observability/crashWatch";
import {
  clearModelDownload,
  megabytes,
  percent,
  reportModelDownload,
} from "../store/modelDownload";
import { loadTimeline } from "../timeline/engine";
import { findClip } from "../timeline/helpers";
import type { Clip } from "../timeline/model";

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

/** Reshape whisper.cpp `-ojf` JSON into the canonical transcript schema. Words
 *  are reconstructed by merging BPE tokens (a leading space starts a new word). */
export function parseWhisperCppJson(raw: string): ParsedTranscript {
  const data = JSON.parse(raw) as WhisperCppJson;
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

    let cur: { text: string; from: number; to: number; ps: number[] } | null = null;
    const flush = (): void => {
      if (!cur) return;
      const wt = cur.text.trim();
      if (wt) {
        const w: WordPayload = {
          word_id: words.length + 1,
          segment_id: segId,
          index_in_segment: segWords.length,
          word: wt,
          start_seconds: cur.from / 1000,
          end_seconds: cur.to / 1000,
          start_timestamp: fmtTimestampPrecise(cur.from / 1000),
          end_timestamp: fmtTimestampPrecise(cur.to / 1000),
          probability: cur.ps.length ? cur.ps.reduce((a, b) => a + b, 0) / cur.ps.length : 0,
        };
        segWords.push(w);
        words.push(w);
      }
      cur = null;
    };

    for (const tok of seg.tokens ?? []) {
      const tt = tok.text ?? "";
      if (isSpecialToken(tt)) continue;
      const from = tok.offsets?.from ?? segFrom;
      const to = tok.offsets?.to ?? from;
      if (/^\s/.test(tt) || cur === null) {
        flush();
        cur = { text: tt, from, to, ps: tok.p != null ? [tok.p] : [] };
      } else {
        cur.text += tt;
        cur.to = to;
        if (tok.p != null) cur.ps.push(tok.p);
      }
    }
    flush();

    // No usable tokens -> treat the whole segment as a single word.
    if (segWords.length === 0) {
      const w: WordPayload = {
        word_id: words.length + 1,
        segment_id: segId,
        index_in_segment: 0,
        word: segText,
        start_seconds: segStart,
        end_seconds: segEnd,
        start_timestamp: fmtTimestampPrecise(segStart),
        end_timestamp: fmtTimestampPrecise(segEnd),
        probability: 0,
      };
      segWords.push(w);
      words.push(w);
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

/** whisper's own `-ot`/`-d` bounds, plus the cache-key suffix that keeps a windowed
 *  transcript from ever being served as a full one.
 *
 *  Verified against whisper-cli: with `-ot 60000` the reported offsets START at 60000, i.e.
 *  they stay on the SOURCE timeline. Nothing downstream has to shift them back. */
function windowArgs(w?: TranscribeWindow | null): { key: string; args: string[] } {
  const start = Math.max(0, Number(w?.start) || 0);
  const rawEnd = Number(w?.end);
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
  if (!start && end === null) return { key: "", args: [] };
  const args = start > 0 ? ["-ot", String(Math.floor(start * 1000))] : [];
  if (end !== null) args.push("-d", String(Math.ceil((end - start) * 1000)));
  return {
    key: `|w${Math.floor(start * 1000)}-${end === null ? "" : Math.ceil(end * 1000)}`,
    args,
  };
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

/** The 16 kHz mono extract whisper reads, shared by every window of the same source. */
async function ensureWav(ctx: ClientToolContext, src: string): Promise<string> {
  const wav = await ctx.store.prepareArtifact(
    `transcribe/${shortHash(`${src}|16k|r${TRANSCODE_WAV_REV}`)}.wav`,
  );
  if (await ctx.store.exists(wav)) return wav;
  return once(`wav\u0000${wav}`, async () => {
    const conv = await ctx.runner.run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        src,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      ctx.signal,
    );
    if (conv.code !== 0 || !(await ctx.store.exists(wav))) {
      if (ctx.signal?.aborted) throw new Error("transcription cancelled");
      throw new Error(
        `audio extraction failed (code=${conv.code}): ${stderrExcerpt(conv.stderr, 200)}`,
      );
    }
    return wav;
  });
}

export async function runWhisper(
  ctx: ClientToolContext,
  src: string,
  size: string = DEFAULT_MODEL,
  language?: string,
  window?: TranscribeWindow | null,
): Promise<ParsedTranscript> {
  const lang = normLanguage(language);
  // The language is part of the KEY, not just the arguments: keyed on src|size alone, a
  // Spanish request would be served the English transcript already on disk, forever.
  const baseKey = `${src}|${size}${lang ? `|${lang}` : ""}`;
  const fullBase = await ctx.store.prepareArtifact(`transcribe/${shortHash(baseKey)}`);
  // A full transcript already answers every window, so a windowed ask must never re-run
  // over one we have — the indexer builds these in the background for exactly this reason.
  if (await ctx.store.exists(`${fullBase}.json`)) {
    return parseWhisperCppJson(await ctx.store.readText(`${fullBase}.json`));
  }

  const win = windowArgs(window);
  const outBase = win.key
    ? await ctx.store.prepareArtifact(`transcribe/${shortHash(baseKey + win.key)}`)
    : fullBase;
  const jsonPath = `${outBase}.json`;
  if (await ctx.store.exists(jsonPath)) {
    return parseWhisperCppJson(await ctx.store.readText(jsonPath));
  }

  return once(jsonPath, async () => {
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
    const wav = await ensureWav(ctx, src);
    const run = await ctx.runner.run(
      "whisper-cli",
      [
        "-m",
        model,
        "-f",
        wav,
        "-ojf",
        "-of",
        outBase,
        "-np",
        "-t",
        whisperThreads(),
        ...win.args,
        ...(lang ? ["-l", lang] : []),
      ],
      ctx.signal,
    );
    if (run.code !== 0 || !(await ctx.store.exists(jsonPath))) {
      // Stop kills the sidecar, so the exit code describes the KILL, not the transcription:
      // it surfaced as `whisper-cli failed (code=-1): cancelled`, which reads as a broken
      // install rather than as the thing the user just asked for.
      if (ctx.signal?.aborted) throw new Error("transcription cancelled");
      throw new Error(`whisper-cli failed (code=${run.code}): ${stderrExcerpt(run.stderr, 200)}`);
    }
    return parseWhisperCppJson(await ctx.store.readText(jsonPath));
  });
}

export interface EnsuredTranscript {
  path: string;
  parsed: ParsedTranscript;
  existed: boolean;
}

/** Normalize a media ref (absolute path / project-relative / the same file
 *  referenced differently) to ONE key, so the background indexer's pre-built
 *  transcript and a later get_transcript(media_path=…) share the same file. */
function canonicalRef(ref: string): string {
  const s = (ref ?? "").replace(/\\/g, "/").trim();
  const m = /(?:^|\/)(library\/.+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Canonical, deterministic transcript path for a media ref (project-portable:
 *  keyed by the canonical ref, not the absolute path). A language, when asked for, joins
 *  the key — omitting it would hand a Spanish request the cached English words. Absent
 *  language keeps the ORIGINAL key, so transcripts cached before this existed still hit. */
function canonicalTranscriptRel(ref: string, size: string, language?: string): string {
  const lang = normLanguage(language);
  return `transcripts/${shortHash(`${canonicalRef(ref)}|${size}${lang ? `|${lang}` : ""}`)}.json`;
}

/** Whisper takes a short code ('en', 'es'); 'auto' means "let it detect", which is the
 *  no-language path. */
export function normLanguage(language: unknown): string {
  const s = String(language ?? "")
    .trim()
    .toLowerCase();
  return !s || s === "auto" ? "" : s;
}

function transcriptPayload(
  src: string,
  size: string,
  parsed: ParsedTranscript,
): Record<string, unknown> {
  return {
    tool: "v4.get_transcript",
    created_at: new Date().toISOString().slice(0, 19),
    input: { original_path: src },
    transcription: {
      model_size: size,
      compute_type: "int8",
      language: parsed.language,
      language_probability: null,
      duration_seconds: parsed.duration_seconds,
      segments: parsed.segments,
      words: parsed.words,
    },
  };
}

function parsedFromPayload(raw: string): ParsedTranscript {
  const o = JSON.parse(raw) as { transcription?: Partial<ParsedTranscript> };
  const t = o.transcription ?? {};
  return {
    language: t.language ?? null,
    duration_seconds: t.duration_seconds ?? 0,
    segments: (t.segments as SegPayload[]) ?? [],
    words: (t.words as WordPayload[]) ?? [],
  };
}

/** Ensure a canonical transcript exists for `ref` and return it. Returns the
 *  EXISTING transcript when present (no re-transcription); otherwise runs whisper
 *  and writes `transcripts/<hash(ref|size)>.json`. This deterministic path is the
 *  link between a media file and its transcript — any tool can recompute it, and
 *  explicit callers share it. `outRel` overrides the canonical location. */
export async function ensureTranscript(
  ctx: ClientToolContext,
  ref: string,
  size: string = DEFAULT_MODEL,
  outRel?: string,
  language?: string,
): Promise<EnsuredTranscript> {
  const src = await ctx.store.resolveRef(ref);
  if (!src) throw new Error(`file not found: ${ref}`);
  const rel = outRel && outRel.trim() ? outRel.trim() : canonicalTranscriptRel(ref, size, language);
  const path = await ctx.store.prepareArtifact(rel);
  if (await ctx.store.exists(path)) {
    return { path, parsed: parsedFromPayload(await ctx.store.readText(path)), existed: true };
  }
  const parsed = await runWhisper(ctx, src, size, language);
  await ctx.store.writeText(path, JSON.stringify(transcriptPayload(src, size, parsed), null, 2));
  return { path, parsed, existed: false };
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
      failures.push({ clip_id: String(clip.id), error: String(e).slice(-200) });
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
