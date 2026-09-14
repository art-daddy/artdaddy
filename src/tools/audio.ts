// AI audio generation tools (client): validation + prompt composition + audio
// post-processing (PCM->WAV, ffmpeg re-mux) live here; the thin /ai/voiceover|music
// proxies make only the authed provider call. Both tools SUBMIT and return a
// placeholder media_ref -- word timings come from the library's own transcription
// pass, read back through get_transcript. Ported from the server's audio.py.
import { callAiProxy, fromB64 } from "../api/ai";
import type { ClientToolContext } from "./context";
import { AUDIO_BY_ID, DEFAULT_VOICE, DEFAULTS, MUSIC_IDS, TTS_IDS, TTS_VOICES } from "./genModels";
import { submitGeneration } from "./genJobs";
import { probePath, shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const DEFAULT_TTS_BACKEND = AUDIO_BY_ID[DEFAULTS.tts]?.backend_id ?? "gemini-3.1-flash-tts-preview";

/** (sample_rate, channels) from a PCM mime like 'audio/l16; rate=24000; channels=1'. */
function parsePcmMime(mime: string): [number, number] {
  let rate = 24000;
  let channels = 1;
  for (const part of (mime || "").split(";")) {
    const p = part.trim().toLowerCase();
    if (p.startsWith("rate=")) {
      const v = parseInt(p.slice(5), 10);
      if (!Number.isNaN(v)) rate = v;
    } else if (p.startsWith("channels=")) {
      const v = parseInt(p.slice(9), 10);
      if (!Number.isNaN(v)) channels = v;
    }
  }
  return [rate, channels];
}

/** Wrap signed-16-bit PCM in a minimal RIFF/WAVE container (ports _pcm_to_wav). */
function pcmToWav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
  const ch = Math.max(1, channels);
  const bitsPerSample = 16;
  const byteRate = (rate * ch * bitsPerSample) / 8;
  const blockAlign = (ch * bitsPerSample) / 8;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  str(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Generate a voiceover (ports generate_voiceover_tool). */
async function generateVoiceover(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const text = String(args.text ?? "").trim();
  if (!text) return { ok: false, error: "text must be a non-empty string" };
  const voice = String(args.voice ?? "").trim() || DEFAULT_VOICE;
  if (!(voice in TTS_VOICES)) {
    return {
      ok: false,
      error: `unknown voice '${voice}'; choose one of ${JSON.stringify(Object.keys(TTS_VOICES).sort())}`,
    };
  }
  const style = String(args.style ?? "").trim();
  const language = String(args.language ?? "").trim();
  let backend = DEFAULT_TTS_BACKEND;
  if (args.model) {
    const am = AUDIO_BY_ID[String(args.model).trim()];
    if (!am || am.category !== "tts")
      return {
        ok: false,
        error: `unknown tts model '${args.model}'; options: ${TTS_IDS.join(", ")}`,
      };
    backend = am.backend_id;
  }
  const contents = style ? `${style.replace(/:+$/, "")}: ${text}` : text;

  const sub = await submitGeneration({
    store: ctx.store,
    tool: "generate_voiceover",
    label: "a voiceover",
    mediaKind: "audio",
    count: 1,
    filename: () => "voiceover.wav",
    source: { origin: "generated", model: backend, prompt: text },
    origin: ctx.origin,
    model: backend,
    // No ctx.signal on purpose: Stop and project-close must not cancel a call already paid for.
    run: async () => {
      const dto = await callAiProxy<{
        ok?: boolean;
        error?: string;
        pcm_b64?: string;
        mime?: string;
      }>("voiceover", { args: { model: backend, text: contents, voice, language } });
      const r = dto.result ?? {};
      if (r.ok === false || !r.pcm_b64)
        throw new Error(String(r.error ?? "voiceover synthesis failed"));

      const pcm = fromB64(r.pcm_b64);
      const [rate, channels] = parsePcmMime(String(r.mime ?? ""));
      return [
        {
          bytes: pcmToWav(pcm, rate, channels),
          ext: ".wav",
          // Only knowable here — the mime carries the real rate, and the length is the byte
          // count. Word timings deliberately are NOT here: the library indexes every audio
          // asset, so `get_transcript` serves them in project frames, already mapped through
          // the clip's trim and speed. Transcribing inline did it a second time, in seconds.
          meta: {
            duration_s: round3(pcm.length / 2 / Math.max(1, channels) / rate),
            sample_rate: rate,
            channels,
          },
        },
      ];
    },
  });

  return {
    ok: true,
    status: "generating",
    voice,
    model: backend,
    style: style || null,
    language: language || null,
    media_ref: sub.media_refs[0],
    note: "Voiceover is being generated; you can place it now. Word timings become available from get_transcript once it lands.",
  };
}

export function registerAudioTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("generate_voiceover", (args) => generateVoiceover(getCtx(), args));
  registry.register("generate_music", (args) => generateMusic(getCtx(), args));
}

/** Compose a single music prompt from the structured controls (ports _compose_music_prompt). */
function composeMusicPrompt(
  prompt: string,
  mood: string,
  genre: string,
  bpm: number | null,
  instrumental: boolean,
  styleInstructions: string,
  lyrics: string,
): string {
  const parts: string[] = [];
  if (genre) parts.push(genre);
  if (mood) parts.push(mood);
  if (bpm) parts.push(`${Math.trunc(bpm)} BPM`);
  if (styleInstructions) parts.push(styleInstructions);
  if (instrumental) parts.push("instrumental");
  if (prompt) parts.push(prompt);
  let base = parts.filter(Boolean).join(", ");
  if (lyrics) base = base ? `${base}\nLyrics:\n${lyrics}` : `Lyrics:\n${lyrics}`;
  return base;
}

/** Generate a music bed (ports generate_music_tool). */
async function generateMusic(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "").trim();
  const mood = String(args.mood ?? "").trim();
  const genre = String(args.genre ?? "").trim();
  let lyrics = String(args.lyrics ?? "").trim();
  let styleInstructions = String(args.style_instructions ?? "").trim();
  let instrumental = args.instrumental !== false;
  if (!(prompt || mood || genre))
    return { ok: false, error: "provide at least one of prompt, mood, or genre" };
  const bpmVal = args.bpm != null ? Number(args.bpm) : null;
  if (bpmVal !== null && Number.isNaN(bpmVal)) return { ok: false, error: "bpm must be a number" };
  const seedVal = args.seed != null ? Math.trunc(Number(args.seed)) : null;
  if (seedVal !== null && Number.isNaN(seedVal))
    return { ok: false, error: "seed must be an integer" };

  let am = AUDIO_BY_ID[DEFAULTS.music];
  if (args.model) {
    const m = AUDIO_BY_ID[String(args.model).trim()];
    if (!m || m.category !== "music")
      return {
        ok: false,
        error: `unknown music model '${args.model}'; options: ${MUSIC_IDS.join(", ")}`,
      };
    am = m;
  }
  const backend = am.backend_id;

  if (lyrics && !am.supports_lyrics) lyrics = "";
  if (styleInstructions && !am.supports_style_instructions) styleInstructions = "";
  if (lyrics) instrumental = false;

  const composed = composeMusicPrompt(
    prompt,
    mood,
    genre,
    bpmVal,
    instrumental,
    styleInstructions,
    lyrics,
  );
  const negative = instrumental ? "vocals, singing, lyrics, spoken word" : "";

  const sub = await submitGeneration({
    store: ctx.store,
    tool: "generate_music",
    label: "a music bed",
    mediaKind: "audio",
    count: 1,
    filename: () => "music.wav",
    source: { origin: "generated", model: backend, prompt: composed },
    origin: ctx.origin,
    model: backend,
    // No ctx.signal on purpose: Stop and project-close must not cancel a call already paid for.
    run: async () => {
      const dto = await callAiProxy<{
        ok?: boolean;
        error?: string;
        audio_b64?: string;
        format?: string;
        lyrics?: string;
      }>("music", {
        args: {
          backend_id: backend,
          prompt: composed,
          interactions: Boolean(am.interactions),
          negative_prompt: negative,
          seed: seedVal,
        },
      });
      const r = dto.result ?? {};
      if (r.ok === false || !r.audio_b64)
        throw new Error(String(r.error ?? "music generation failed"));
      const audioBytes = fromB64(r.audio_b64);
      const format = String(r.format ?? "wav");

      const srcPath = await ctx.store.prepareArtifact(
        `generated/music_src_${shortHash(composed)}.${format === "mp3" ? "mp3" : "wav"}`,
      );
      await ctx.store.writeBytes(srcPath, audioBytes);
      const outPath = await ctx.store.prepareArtifact(
        `generated/music_${shortHash(`${composed}|${backend}`)}.wav`,
      );
      let wavPath = outPath;
      const rr = await ctx.runner.run("ffmpeg", [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        srcPath,
        "-c:a",
        "pcm_s16le",
        outPath,
      ]);
      if (rr.code !== 0 || !(await ctx.store.exists(outPath))) wavPath = srcPath;
      let durationS = 0;
      let sampleRate = 48000;
      let channels = 2;
      try {
        const p = await probePath(ctx.runner, wavPath);
        if (typeof p.duration_s === "number") durationS = round3(p.duration_s);
        const a = (p.audio ?? null) as { sample_rate?: string; channels?: number } | null;
        const sr = a?.sample_rate ? parseInt(String(a.sample_rate), 10) : NaN;
        if (!Number.isNaN(sr)) sampleRate = sr;
        if (typeof a?.channels === "number") channels = a.channels;
      } catch {
        /* metadata probe failed; use defaults */
      }
      return [
        {
          bytes: await ctx.store.readBytes(wavPath),
          ext: ".wav",
          // Only knowable here: the sung lyrics come back from the model, and the measured
          // length/format come from the probe. Both would be lost by returning early.
          meta: {
            lyrics: String(r.lyrics ?? "") || null,
            duration_s: durationS,
            sample_rate: sampleRate,
            channels,
          },
        },
      ];
    },
  });

  return {
    ok: true,
    model: backend,
    prompt: composed,
    instrumental,
    seed: seedVal,
    status: "generating",
    media_ref: sub.media_refs[0],
  };
}
