// get_transcript (client tool): word-level transcription via a bundled
// whisper.cpp binary, so audio never leaves the machine (offline-capable). Ports
// mechanical.py::get_transcript_tool — ffmpeg extracts a 16 kHz mono WAV,
// whisper-cli emits token-level JSON, and we reshape it into the canonical
// transcript schema that the rest of the pipeline reads. Each media file has a
// deterministic transcript path, so get_transcript returns an existing
// transcript instead of re-transcribing, and library indexing pre-builds it.
// The ggml model is lazy-downloaded into app-data and warmed on every project
// load (open or create) via warmWhisperModel.
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";
import { joinPath } from "./store";
import { loadTimeline } from "../timeline/engine";
import { findClip } from "../timeline/helpers";
import type { Clip } from "../timeline/model";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
// Fixed transcription model. `get_transcript` does NOT expose model selection —
// everything (the tool, inspect_media, and the background indexer) uses this one
// model so the model can never downgrade to base/tiny or pick an inconsistent one.
const DEFAULT_MODEL = "small";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

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

/** Ensure the ggml model is present in app-data, downloading it on first use.
 *  Returns the local model path. Injectable fetch for tests. */
export async function ensureWhisperModel(
  ctx: ClientToolContext,
  size: string = DEFAULT_MODEL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ path: string; downloaded: boolean }> {
  const path = whisperModelPath(ctx.store.projectDir, size);
  if (await ctx.store.exists(path)) return { path, downloaded: false };
  if (!fetchImpl) throw new Error("no network available to download the whisper model");
  const url = `${HF_BASE}/ggml-${size}.bin`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`whisper model download failed: HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0) throw new Error("whisper model download was empty");
  await ctx.store.writeBytes(path, bytes);
  return { path, downloaded: true };
}

/** Best-effort model preload for a fresh project (fire-and-forget). No-op when
 *  the fs can't write bytes (web / unit tests) so it never hits the network. */
export async function warmWhisperModel(
  ctx: ClientToolContext,
  size: string = DEFAULT_MODEL,
): Promise<void> {
  if (!ctx.store.canWriteBytes) return;
  try {
    await ensureWhisperModel(ctx, size);
  } catch {
    /* best-effort warm; the first transcribe will retry the download */
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
      throw new Error(`whisper model '${size}' unavailable: ${String(e)}`);
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
 *  library indexing pre-builds it. `outRel` overrides the canonical location. */
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
