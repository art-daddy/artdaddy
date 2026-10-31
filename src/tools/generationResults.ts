// What a finished generation looks like once it has come back, turned into the media to keep.
//
// The paid call returns the provider's answer (`{result, media?}`); each tool used to turn that answer into bytes inside the
// closure that made the call. A generation that finished while the app was closed has no such closure when the app comes back,
// so the part that only needs the ANSWER lives here, where both the tool (live) and the reconciliation after a restart use it.
// Only the success shape is handled: a failed answer never becomes a stored result.
import { fromB64, type AiProxyResult } from "../api/ai";
import type { CommandRunner } from "./command";
import { probePath, shortHash } from "./media";
import type { ProjectStoreAccess } from "./store";

export interface GeneratedOutput {
  bytes: Uint8Array;
  ext?: string;
  /** Result facts that exist only in the provider's response; merged into the library row. */
  meta?: Record<string, unknown>;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const forModel = (model?: string): string => (model ? ` (model=${model})` : "");

/** (sample_rate, channels) from a PCM mime like 'audio/l16; rate=24000; channels=1'. */
export function parsePcmMime(mime: string): [number, number] {
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
export function pcmToWav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
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

/** The finished result holds no usable file, or says the generation failed: a fact about what the provider returned, which asking
 *  again cannot change. (As opposed to the app's own trouble while collecting or saving it, which can.) */
export class GeneratedResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedResultError";
  }
}

export function decodeImages(dto: AiProxyResult<unknown>, model?: string): GeneratedOutput[] {
  const media = dto.media ?? [];
  if (!media.length)
    throw new GeneratedResultError(`image generation returned no images${forModel(model)}`);
  return media.map((gm) => ({ bytes: fromB64(gm.b64), ext: gm.ext }));
}

export function decodeVideo(dto: AiProxyResult<unknown>, model?: string): GeneratedOutput[] {
  const media = dto.media ?? [];
  if (!media.length)
    throw new GeneratedResultError(
      `video generation returned no downloadable file${forModel(model)}`,
    );
  return [{ bytes: fromB64(media[0].b64), ext: media[0].ext }];
}

export function decodeVoiceover(
  dto: AiProxyResult<{ ok?: boolean; error?: string; pcm_b64?: string; mime?: string }>,
): GeneratedOutput[] {
  const r = dto.result ?? {};
  if (r.ok === false || !r.pcm_b64)
    throw new GeneratedResultError(String(r.error ?? "voiceover synthesis failed"));
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
}

export interface MusicDecodeEnv {
  store: ProjectStoreAccess;
  /** ffmpeg, where there is one. Without it the source audio is kept as it came and its measurements fall back to defaults. */
  runner: CommandRunner | null;
  /** What names the scratch files of this generation (the same prompt and model give the same names). */
  sourceKey: string;
  outputKey: string;
}

export async function decodeMusic(
  dto: AiProxyResult<{
    ok?: boolean;
    error?: string;
    audio_b64?: string;
    format?: string;
    lyrics?: string;
  }>,
  env: MusicDecodeEnv,
): Promise<GeneratedOutput[]> {
  const r = dto.result ?? {};
  if (r.ok === false || !r.audio_b64)
    throw new GeneratedResultError(String(r.error ?? "music generation failed"));
  const { store, runner } = env;
  const audioBytes = fromB64(r.audio_b64);
  const format = String(r.format ?? "wav");

  const srcPath = await store.prepareArtifact(
    `generated/music_src_${env.sourceKey}.${format === "mp3" ? "mp3" : "wav"}`,
  );
  await store.writeBytes(srcPath, audioBytes);
  const outPath = await store.prepareArtifact(`generated/music_${env.outputKey}.wav`);
  let wavPath = outPath;
  if (runner) {
    const rr = await runner.run("ffmpeg", [
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
    if (rr.code !== 0 || !(await store.exists(outPath))) wavPath = srcPath;
  } else {
    wavPath = srcPath;
  }
  let durationS = 0;
  let sampleRate = 48000;
  let channels = 2;
  if (runner) {
    try {
      const p = await probePath(runner, wavPath);
      if (typeof p.duration_s === "number") durationS = round3(p.duration_s);
      const a = (p.audio ?? null) as { sample_rate?: string; channels?: number } | null;
      const sr = a?.sample_rate ? parseInt(String(a.sample_rate), 10) : NaN;
      if (!Number.isNaN(sr)) sampleRate = sr;
      if (typeof a?.channels === "number") channels = a.channels;
    } catch {
      /* metadata probe failed; use defaults */
    }
  }
  return [
    {
      bytes: await store.readBytes(wavPath),
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
}

/** The scratch-file names the music tool has always used, from the composed prompt and the model. */
export function musicScratchKeys(
  composed: string,
  backend: string,
): { sourceKey: string; outputKey: string } {
  return { sourceKey: shortHash(composed), outputKey: shortHash(`${composed}|${backend}`) };
}

/** Which tools make something to collect, and how their answer becomes media. A tool that is not here cannot be reconciled. */
export const RESULT_TOOLS = [
  "generate_image",
  "generate_video",
  "generate_voiceover",
  "generate_music",
] as const;
export type ResultTool = (typeof RESULT_TOOLS)[number];

export function isResultTool(tool: string): tool is ResultTool {
  return (RESULT_TOOLS as readonly string[]).includes(tool);
}

export interface DecodeContext {
  store: ProjectStoreAccess;
  runner: CommandRunner | null;
  /** The order number: it names the scratch files of a music result that is being brought back after a restart. */
  orderId: string;
}

/** The media in a finished generation's answer, by the tool that asked for it. */
export async function decodeGenerated(
  tool: ResultTool,
  dto: AiProxyResult<unknown>,
  ctx: DecodeContext,
): Promise<GeneratedOutput[]> {
  switch (tool) {
    case "generate_image":
      return decodeImages(dto);
    case "generate_video":
      return decodeVideo(dto);
    case "generate_voiceover":
      return decodeVoiceover(dto as Parameters<typeof decodeVoiceover>[0]);
    case "generate_music":
      return decodeMusic(dto as Parameters<typeof decodeMusic>[0], {
        store: ctx.store,
        runner: ctx.runner,
        sourceKey: shortHash(`${ctx.orderId}|source`),
        outputKey: shortHash(`${ctx.orderId}|output`),
      });
  }
}
