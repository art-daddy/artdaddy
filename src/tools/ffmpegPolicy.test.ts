import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AAC_EXTENSIONS,
  AAC_MUXERS,
  AAC_SAMPLE_RATE,
  aacAt48k,
  ffmpegPolicy,
} from "./ffmpegPolicy";

const RATE = String(AAC_SAMPLE_RATE);

/** The output-side options: everything after the last `-i <path>`. */
function outputSide(args: string[]): string[] {
  const last = args.lastIndexOf("-i");
  return args.slice(last + 2);
}
/** Every rate the output side asks for, in order (ffmpeg uses the last). */
function outputRates(args: string[]): string[] {
  const side = outputSide(args);
  const rates: string[] = [];
  for (let i = 0; i < side.length - 1; i++) if (/^-ar(:|$)/.test(side[i])) rates.push(side[i + 1]);
  return rates;
}

describe("aacAt48k: every AAC encode runs at 48 kHz", () => {
  it("pins a named AAC encode (the export's shape: many inputs, a graph, maps)", () => {
    const args = [
      "-y",
      "-ss",
      "0",
      "-t",
      "3",
      "-i",
      "a.wav",
      "-loop",
      "1",
      "-i",
      "still.png",
      "-filter_complex",
      "[0:a]adelay=5000|5000[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      "8",
      "out.mp4",
    ];
    const got = aacAt48k(args);
    expect(outputRates(got)).toEqual([RATE]);
    expect(got[got.length - 1]).toBe("out.mp4");
    // Nothing else moved: removing the inserted pair gives back the command.
    const i = got.indexOf("-ar");
    expect([...got.slice(0, i), ...got.slice(i + 2)]).toEqual(args);
  });

  it("pins a container-default AAC encode (.mp4/.m4a/.mov with no audio codec named)", () => {
    for (const out of ["o.mp4", "o.m4a", "o.mov", "O.MP4"]) {
      expect(outputRates(aacAt48k(["-i", "in.wav", out]))).toEqual([RATE]);
    }
    expect(outputRates(aacAt48k(["-i", "in.wav", "-f", "mp4", "o.bin"]))).toEqual([RATE]);
  });

  it("replaces a rate the command gave an AAC output, wherever it sits", () => {
    for (const args of [
      ["-i", "in.wav", "-ar", "16000", "-c:a", "aac", "o.m4a"],
      ["-i", "in.wav", "-c:a", "aac", "-ar:a", "16000", "o.m4a"],
      ["-i", "in.wav", "-acodec", "aac", "-ar:a:0", "22050", "o.m4a"],
    ]) {
      expect(outputRates(aacAt48k(args))).toEqual([RATE]);
    }
  });

  it("keeps an INPUT's rate: a raw PCM input needs it to be read at all", () => {
    const args = ["-ar", "16000", "-f", "s16le", "-i", "raw.pcm", "-c:a", "aac", "o.m4a"];
    const got = aacAt48k(args);
    expect(got.slice(0, 6)).toEqual(args.slice(0, 6));
    expect(outputRates(got)).toEqual([RATE]);
  });

  it("leaves every command that does not encode AAC exactly as it was (the same array)", () => {
    const untouched = [
      ["-i", "in.mp4", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "o.wav"], // whisper
      ["-i", "in.mp4", "-vn", "-c:a", "libmp3lame", "-q:a", "5", "o.mp3"], // gemini audio
      ["-i", "in.mp4", "-c", "copy", "o.mp4"], // clip_video without re-encode
      ["-i", "in.mp4", "-c:v", "libx264", "-c:a", "copy", "o.mp4"],
      ["-i", "in.mp4", "-c:v", "libx264", "-an", "o.mp4"], // export with no audio
      ["-i", "in.mp4", "-frames:v", "1", "o.png"],
      ["-i", "in.mp4", "-af", "volumedetect", "-f", "null", "-"],
      ["-i", "in.wav", "-f", "matroska", "o.mp4"], // the muxer decides, not the extension
      ["-version"],
      [],
    ];
    for (const args of untouched) expect(aacAt48k(args)).toBe(args);
  });

  it("applies to ffmpeg only", () => {
    const args = ["-i", "in.wav", "-c:a", "aac", "o.m4a"];
    expect(ffmpegPolicy("ffprobe", args)).toBe(args);
    expect(ffmpegPolicy("ffmpeg", args)).not.toBe(args);
  });

  // Found by mutation testing: each of these is a way the rule could misread a real command.
  it("reads the codec of the AUDIO: a video codec named after it does not hide an AAC encode", () => {
    const args = ["-i", "a.wav", "-c:a", "aac", "-c:v", "libx264", "o.mp4"];
    expect(outputRates(aacAt48k(args))).toEqual([RATE]);
    // A per-stream index past 9 is still an audio codec option, whatever the container.
    expect(outputRates(aacAt48k(["-i", "a.wav", "-c:a:12", "aac", "o.mkv"]))).toEqual([RATE]);
  });

  it("judges the container by the output's LAST extension, and an output with none by nothing", () => {
    const wav = ["-i", "a.wav", "clip.mp4.wav"];
    expect(aacAt48k(wav)).toBe(wav);
    const bare = ["-i", "a.wav", "out"];
    expect(aacAt48k(bare)).toBe(bare);
  });

  it("leaves a command with no input alone (nothing to encode)", () => {
    const args = ["-y", "out.mp4"];
    expect(aacAt48k(args)).toBe(args);
  });

  // An agent writes metadata freely; a VALUE that happens to end like an option is still a value.
  it("never mistakes a value that ends in -ar or -c for an option", () => {
    const args = [
      "-i",
      "a.wav",
      "-metadata",
      "title=guitar-ar",
      "-metadata",
      "artist=x-c",
      "o.m4a",
    ];
    const got = aacAt48k(args);
    expect(got).toContain("title=guitar-ar");
    expect(got).toContain("artist=x-c");
    expect(outputRates(got)).toEqual([RATE]);
  });

  it("knows every muxer and extension in its tables as an AAC encode", () => {
    for (const m of AAC_MUXERS)
      expect(outputRates(aacAt48k(["-i", "a.wav", "-f", m, "o.bin"])), m).toEqual([RATE]);
    for (const e of AAC_EXTENSIONS)
      expect(outputRates(aacAt48k(["-i", "a.wav", `o.${e}`])), e).toEqual([RATE]);
  });

  // ---- properties over generated commands ----------------------------------------------------
  const token = fc.constantFrom(
    "-y",
    "-hide_banner",
    "-shortest",
    "-vn",
    "-sn",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-b:a",
    "96k",
    "-ac",
    "2",
    "-af",
    "adelay=5000|5000",
    "-t",
    "3",
    "-movflags",
    "+faststart",
  );
  const rateOpt = fc.tuple(
    fc.constantFrom("-ar", "-ar:a", "-ar:a:0"),
    fc.constantFrom("8000", "16000", "44100", "48000"),
  );
  const codecOpt = fc.tuple(
    fc.constantFrom("-c:a", "-acodec", "-codec:a", "-c:a:0", "-c"),
    fc.constantFrom("aac", "copy", "libmp3lame", "pcm_s16le", "libopus"),
  );
  const command = fc
    .record({
      inputs: fc.array(fc.constantFrom("a.wav", "b.mp4", "c.png"), { minLength: 1, maxLength: 3 }),
      pre: fc.array(token, { maxLength: 4 }),
      opts: fc.array(
        fc.oneof(
          token.map((t) => [t]),
          rateOpt,
          codecOpt,
        ),
        { maxLength: 6 },
      ),
      an: fc.boolean(),
      out: fc.constantFrom("o.mp4", "o.m4a", "o.mov", "o.wav", "o.mp3", "o.mkv", "o.png"),
    })
    .map(({ inputs, pre, opts, an, out }) => [
      ...pre,
      ...inputs.flatMap((i) => ["-i", i]),
      ...opts.flat(),
      ...(an ? ["-an"] : []),
      out,
    ]);

  it("is idempotent", () => {
    fc.assert(
      fc.property(command, (args) => {
        const once = aacAt48k(args);
        expect(aacAt48k(once)).toEqual(once);
      }),
    );
  });

  it("when it acts, the output asks for exactly one rate, 48 kHz, and keeps every other option", () => {
    fc.assert(
      fc.property(command, (args) => {
        const got = aacAt48k(args);
        if (got === args) return;
        expect(outputRates(got)).toEqual([RATE]);
        // Inputs, the output path and every non-rate option are preserved in order.
        const strip = (a: string[]) => {
          const side = outputSide(a);
          const kept: string[] = [];
          for (let i = 0; i < side.length; i++) {
            if (/^-ar(:|$)/.test(side[i]) && i + 1 < side.length) i++;
            else kept.push(side[i]);
          }
          return [...a.slice(0, a.lastIndexOf("-i") + 2), ...kept];
        };
        expect(strip(got)).toEqual(strip(args));
      }),
    );
  });

  it("acts exactly when the output encodes AAC (a named aac, or an AAC container with no codec named)", () => {
    fc.assert(
      fc.property(command, (args) => {
        const side = outputSide(args);
        let codec: string | null = null;
        for (let i = 0; i < side.length - 1; i++)
          if (/^-(c|codec)(:a(:\d+)?)?$|^-acodec$/.test(side[i])) codec = side[++i];
        const out = args[args.length - 1];
        const aac =
          !side.includes("-an") &&
          (codec !== null ? codec === "aac" : /\.(mp4|m4a|mov)$/.test(out));
        expect(aacAt48k(args) !== args).toBe(aac);
      }),
    );
  });
});
