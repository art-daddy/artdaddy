// Real-clip parity of the voice-start detector with the speech study's reference (opt-in, never in the unit suite):
//
//   $env:L13_STUDY_WAVS = "1"; $env:ARTDADDY_SMOKE_NO_WARMUP = "1"
//   npx vitest run --config vitest.smoke.config.ts src/tools/speechLeadingQuiet.real.e2e.ts
//
// It reads the real clips of the study (the gate's data folder: 20 languages plus a harder English set, 3.6 to 46.5 s, 910 stored as 32-bit float and 160 as 16-bit PCM, and the 14 long
// recordings of up to 879 s) and compares the TypeScript detector with the answers the study's own reference gave for the same samples (`onset_ms`, and `ref_T["30"]` for the first 30 s), written
// once by the helper study of lane L13 (b-study/data/clips.json and long.json: the reference run on the 16-bit version of each clip, which is what the app feeds the engine). The 16-bit version is made
// here exactly as the study makes it: clip(rint(x * 32768), -32768, 32767), rint rounding half to even. Where the folders are: L13_STUDY_ROOT (default: the scratch folder of the home folder).

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { pcm16Wav } from "../test/synthAudio";
import {
  HeadReader,
  measureVoiceStart,
  speechOnsetMs,
  voiceStartOf,
  type VoiceStart,
} from "./speechLeadingQuiet";

const ROOT = process.env.L13_STUDY_ROOT ?? path.join(os.homedir(), "Akaru", "_scratch");
const DATA = path.join(ROOT, "p2", "bench", "gate", "data");
const STUDY = path.join(ROOT, "lanes", "L13-first-word", "helpers", "b-study", "data");

interface ClipRow {
  set: string;
  name: string;
  format: "float32" | "pcm16";
  seconds: number;
  onset_ms: number | null;
  ref_T: Record<string, number | null>;
}

const wavPath = (row: ClipRow): string => path.join(DATA, row.set, row.name);
const startOf = (ms: number | null | undefined): VoiceStart =>
  ms === null || ms === undefined ? { kind: "none" } : { kind: "at", ms };

/** numpy's rint: round half to even. */
function rint(v: number): number {
  const floor = Math.floor(v);
  const rest = v - floor;
  if (rest < 0.5) return floor;
  if (rest > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The 16-bit samples the app feeds the engine, from a 16 kHz mono PCM16 or float32 WAV file (the study's `read_wav_mono` then `to_pcm16`). */
function pcm16Of(bytes: Buffer): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("latin1", at, at + 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        tag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== 16000)
        throw new Error("not 16 kHz mono");
      const end = Math.min(bytes.length, body + size);
      if (format.tag === 1 && format.bits === 16) {
        const n = Math.floor((end - body) / 2);
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) out[i] = view.getInt16(body + 2 * i, true);
        return out;
      }
      if (format.tag === 3 && format.bits === 32) {
        const n = Math.floor((end - body) / 4);
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = Math.max(
            -32768,
            Math.min(32767, rint(view.getFloat32(body + 4 * i, true) * 32768)),
          );
        }
        return out;
      }
      throw new Error(`unsupported format ${JSON.stringify(format)}`);
    }
    at = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** What the app's ranged read does: the first `maxBytes` bytes of the file. */
const fileStore: HeadReader = {
  readHead: async (file, maxBytes) => {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const got = readSync(fd, buffer, 0, maxBytes, 0);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, got);
    } finally {
      closeSync(fd);
    }
  },
};

const stats = (values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `mean ${mean.toFixed(2)} ms, median ${q(0.5).toFixed(2)}, p95 ${q(0.95).toFixed(2)}, max ${sorted[sorted.length - 1].toFixed(2)}`;
};

describe.skipIf(process.env.L13_STUDY_WAVS !== "1")(
  "the detector on the study's real clips",
  () => {
    it("answers what the study's reference answered for every one of the 1070 clips (the pure function, and the whole WAV path)", () => {
      const rows: ClipRow[] = JSON.parse(readFileSync(path.join(STUDY, "clips.json"), "utf8"));
      expect(rows).toHaveLength(1070);
      const different: string[] = [];
      let offByOneFrame = 0;
      let wholePathDifferent = 0;
      let nativeCompared = 0;
      let nativeDifferent = 0;
      let withVoice = 0;
      let withNone = 0;
      let overScan = 0;
      const times: number[] = [];
      for (const row of rows) {
        const bytes = readFileSync(wavPath(row));
        const pcm = pcm16Of(bytes);
        const t0 = performance.now();
        const got = speechOnsetMs(pcm, 16000);
        times.push(performance.now() - t0);
        if (got === null) withNone++;
        else withVoice++;
        if (got !== row.onset_ms) {
          if (got !== null && row.onset_ms !== null && Math.abs(got - row.onset_ms) === 20)
            offByOneFrame++;
          different.push(`${row.set}/${row.name}: ${got} against ${row.onset_ms}`);
        }
        // the whole path on the 16-bit version of every clip, against the reference on its first 30 s
        const wanted = startOf(row.ref_T["30"]);
        if (row.seconds > 30) overScan++;
        const answer = voiceStartOf(pcm16Wav(pcm));
        if (JSON.stringify(answer) !== JSON.stringify(wanted)) wholePathDifferent++;
        // and on the real file bytes of a clip that already is 16-bit PCM
        if (row.format === "pcm16") {
          nativeCompared++;
          if (JSON.stringify(voiceStartOf(bytes)) !== JSON.stringify(wanted)) nativeDifferent++;
        }
      }
      console.log(
        [
          `clips compared: ${rows.length} (${withVoice} with an onset, ${withNone} with none; ${overScan} longer than 30 s)`,
          `pure function vs the reference's onset_ms: ${rows.length - different.length} agree, ${different.length} differ (${offByOneFrame} of them by exactly one 20 ms frame)`,
          `whole WAV path (16-bit version of each clip, first 30 s) vs the reference's ref_T[30]: ${rows.length - wholePathDifferent} agree, ${wholePathDifferent} differ`,
          `real file bytes of the ${nativeCompared} clips already 16-bit PCM: ${nativeCompared - nativeDifferent} agree, ${nativeDifferent} differ`,
          `TS detector time per clip (speechOnsetMs on the samples): ${stats(times)}`,
          ...different.slice(0, 20),
        ].join("\n"),
      );
      expect(different).toEqual([]);
      expect(wholePathDifferent).toBe(0);
      expect(nativeDifferent).toBe(0);
      expect(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]).toBeLessThan(25);
    }, 600_000);

    it("answers for the first 30 seconds of each of the 14 long recordings, read as the app reads them (the first 1 MiB of the file)", async () => {
      const rows: ClipRow[] = JSON.parse(readFileSync(path.join(STUDY, "long.json"), "utf8"));
      expect(rows).toHaveLength(14);
      const lines: string[] = [];
      for (const row of rows) {
        const wanted = startOf(row.ref_T["30"]);
        const t0 = performance.now();
        const answer = await measureVoiceStart(fileStore, wavPath(row));
        const took = performance.now() - t0;
        lines.push(
          `${row.set.padEnd(9)} ${String(row.seconds).padStart(8)} s: head read + detect ${took.toFixed(1)} ms -> ${JSON.stringify(answer)}; the reference on the first 30 s ${JSON.stringify(wanted)}; on the whole recording ${row.onset_ms}`,
        );
        expect(answer, row.set).toEqual(wanted);
      }
      console.log(lines.join("\n"));
      // the whole recording, for the one pure call at scale (the answer for the whole file is the study's, not the module's cut)
      for (const row of rows) {
        const pcm = pcm16Of(readFileSync(wavPath(row)));
        expect(speechOnsetMs(pcm, 16000), `${row.set} whole`).toBe(row.onset_ms);
      }
    }, 600_000);
  },
);
