// AI audio generation tools (client): validation + prompt composition + audio
// post-processing (PCM->WAV, ffmpeg re-mux) live here; the thin /ai/voiceover|music
// proxies make only the authed provider call. Both tools SUBMIT and return a
// placeholder media_ref -- word timings come from the library's own transcription
// pass, read back through get_transcript. Ported from the server's audio.py.
import { callAiProxy } from "../api/ai";
import type { ClientToolContext } from "./context";
import {
  DEFAULT_VOICE,
  MUSIC_IDS,
  resolveMusicModel,
  resolveTtsBackend,
  TTS_IDS,
  TTS_VOICES,
  voiceoverContents,
} from "./genModels";
import { submitGeneration } from "./genJobs";
import { decodeMusic, decodeVoiceover, musicScratchKeys } from "./generationResults";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

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
  const backend = resolveTtsBackend(args.model);
  if (!backend)
    return {
      ok: false,
      error: `unknown tts model '${args.model}'; options: ${TTS_IDS.join(", ")}`,
    };
  const contents = voiceoverContents(text, style);

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
    run: async (order) => {
      const dto = await callAiProxy<{
        ok?: boolean;
        error?: string;
        pcm_b64?: string;
        mime?: string;
      }>(
        "voiceover",
        { args: { model: backend, text: contents, voice, language }, order_id: order.orderId },
        undefined,
        { onOrder: order.orderAccepted },
      );
      return decodeVoiceover(dto);
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

  const am = resolveMusicModel(args.model);
  if (!am)
    return {
      ok: false,
      error: `unknown music model '${args.model}'; options: ${MUSIC_IDS.join(", ")}`,
    };
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
    run: async (order) => {
      const dto = await callAiProxy<{
        ok?: boolean;
        error?: string;
        audio_b64?: string;
        format?: string;
        lyrics?: string;
      }>(
        "music",
        {
          args: {
            backend_id: backend,
            prompt: composed,
            interactions: Boolean(am.interactions),
            negative_prompt: negative,
            seed: seedVal,
          },
          order_id: order.orderId,
        },
        undefined,
        { onOrder: order.orderAccepted },
      );
      return decodeMusic(dto, {
        store: ctx.store,
        runner: ctx.runner,
        ...musicScratchKeys(composed, backend),
      });
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
