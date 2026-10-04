// The app's rules for an ffmpeg command, applied where the command is SPAWNED: inside
// TauriCommandRunner.run, the one door every production ffmpeg passes (the e2e runner applies the
// same function). No producer has to remember them, and the agent's run_ffmpeg gets them too.
//
// AAC at 48 kHz. The shipped ffmpeg's AAC encoder stalls forever on 16 kHz audio that follows a
// few seconds of digital silence (N-126655: 5 s, 7 s and 120 s of silence hang; 48 kHz never
// does), so an export of a 16 kHz clip placed 5 s into the timeline ran until cancelled. An
// output that encodes AAC — named (`-c:a aac`) or by its container's default (.mp4/.m4a/.mov with
// no audio codec named) — is encoded at 48 kHz, and any `-ar` the command gave that output is
// replaced. A source already at 48 kHz is not resampled at all.
//
// Scope, deliberately: the options after the LAST input belong to the first output, which is the
// only output of every command the app builds. A second output of a multi-output command, and
// options trailing the output (ffmpeg ignores those), are left exactly as given.

export const AAC_SAMPLE_RATE = 48000;

/** `-c`, `-codec` (every stream), `-c:a`, `-codec:a`, `-c:a:N`, `-codec:a:N`, `-acodec`. */
const AUDIO_CODEC_OPT = /^-(?:c|codec)(?::a(?::\d+)?)?$|^-acodec$/;
/** `-ar`, `-ar:a`, `-ar:a:N`, `-ar:N`. */
const SAMPLE_RATE_OPT = /^-ar(?::[a-z0-9:]+)?$/i;
/** Muxers whose default audio codec is AAC (3gp/3g2 default to AMR, so they are not here).
 *  aac48k.smoke.e2e.ts checks every entry against the shipped ffmpeg's own answer. */
export const AAC_MUXERS: ReadonlySet<string> = new Set([
  "mp4",
  "mov",
  "ipod",
  "ismv",
  "f4v",
  "adts",
  "psp",
]);
/** Output extensions ffmpeg encodes AAC for by default — measured with the shipped build, and
 *  re-measured in both directions over 30 extensions by aac48k.smoke.e2e.ts. */
export const AAC_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "m4a",
  "m4b",
  "m4v",
  "mov",
  "ismv",
  "isma",
  "f4v",
  "aac",
  "adts",
]);

/** Does this output encode AAC? `codec` is the last audio codec named for it (null: none). */
function encodesAac(codec: string | null, format: string | null, output: string): boolean {
  if (codec !== null) return /aac/i.test(codec);
  if (format !== null) return AAC_MUXERS.has(format.toLowerCase());
  const ext = /\.([a-z0-9]+)$/i.exec(output)?.[1]?.toLowerCase();
  return ext !== undefined && AAC_EXTENSIONS.has(ext);
}

/** `args` with the AAC rule applied, or `args` itself (the same array) when it does not apply. */
export function aacAt48k(args: string[]): string[] {
  let lastInput = -1;
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-i") lastInput = i;
  if (lastInput < 0) return args;
  const first = lastInput + 2; // the first option after the last input's path

  let codec: string | null = null;
  let format: string | null = null;
  let noAudio = false;
  for (let i = first; i < args.length; i++) {
    const t = args[i];
    if (AUDIO_CODEC_OPT.test(t) && i + 1 < args.length) codec = args[++i];
    else if (t === "-f" && i + 1 < args.length) format = args[++i];
    else if (t === "-an") noAudio = true;
  }
  if (noAudio || !encodesAac(codec, format, args[args.length - 1])) return args;

  const out = args.slice(0, first);
  out.push("-ar", String(AAC_SAMPLE_RATE));
  for (let i = first; i < args.length; i++) {
    if (SAMPLE_RATE_OPT.test(args[i]) && i + 1 < args.length) {
      i++; // drop the output's own rate; ours is the one that applies
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Every rule this module owns, for the runner to apply to an ffmpeg command before spawning. */
export function ffmpegPolicy(program: string, args: string[]): string[] {
  return program === "ffmpeg" ? aacAt48k(args) : args;
}
