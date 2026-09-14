// Does the music actually get quieter under the voice? Measured, with real ffmpeg.
//
// `duck` was accepted by the schema, persisted, clamped, and rendered in the PREVIEW, while the
// exporter emitted `duck not rendered (scoped)` and mixed the bed at full level. The agent set the
// duck, the preview agreed, and the delivered file did not: measured once at -13.7 LUFS of score
// against a -21.3 LUFS voiceover, with the narration buried. A filtergraph containing the string
// `sidechaincompress` is not evidence any of that changed — the level is.
//
// The source is deliberately shaped so the answer cannot come from anywhere else: the "voice" is
// LOUD for the first half and SILENT for the second, and the music is a constant tone throughout.
// If ducking works, the music is quieter in the first half than the second. If it does not, the two
// halves measure the same, which is exactly what shipped.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildRenderCommand } from "../timeline/render";
import { ff, have, nodeRunner } from "../tools/__e2e";

const HALF = 2; // seconds per half
const DUR = HALF * 2;

let dir = "";
let voice = "";
let music = "";
let ok = false;

/** mean_volume (dB) of the MUSIC BAND over a window. Isolating the band matters: a plain
 *  measurement of the mix is dominated by the voice's own level in the first half, which moves the
 *  number in the same direction whether ducking works or not. */
async function musicDb(file: string, ss: number, dur: number): Promise<number> {
  const r = await nodeRunner.run("ffmpeg", [
    "-ss",
    String(ss),
    "-t",
    String(dur),
    "-i",
    file,
    "-af",
    "bandpass=f=900:width_type=h:w=120,volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = r.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  if (!m) throw new Error(`no mean_volume: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
}

/** Render a two-track audio timeline (voice on `vo`, music on `music`) to `out`. */
async function render(out: string, duck: Record<string, unknown> | null): Promise<void> {
  const plan = buildRenderCommand(
    {
      canvas: { width: 64, height: 64, fps: 30 },
      tracks: [
        {
          id: "vo",
          kind: "audio",
          z: 0,
          clips: [
            {
              id: "speech",
              kind: "audio",
              media_ref: voice,
              source_in: 0,
              source_out: DUR,
              timeline_in: 0,
              timeline_out: DUR,
            },
          ],
        },
        {
          id: "music",
          kind: "audio",
          z: 1,
          clips: [
            {
              id: "bed",
              kind: "audio",
              media_ref: music,
              source_in: 0,
              source_out: DUR,
              timeline_in: 0,
              timeline_out: DUR,
              ...(duck ? { duck } : {}),
            },
          ],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    out,
  );
  await ff(plan.args);
}

beforeAll(async () => {
  ok = (await have("ffmpeg")) && (await have("ffprobe"));
  if (!ok) return;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-duck-"));
  voice = path.join(dir, "voice.wav");
  music = path.join(dir, "music.wav");
  // Voice: loud tone for the first half, silence for the second.
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=300:duration=${HALF}`,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=44100:cl=mono:d=${HALF}`,
    "-filter_complex",
    "[0:a]volume=6dB[a];[a][1:a]concat=n=2:v=0:a=1[out]",
    "-map",
    "[out]",
    voice,
  ]);
  // Music: one constant tone across the whole span.
  await ff(["-y", "-f", "lavfi", "-i", `sine=frequency=900:duration=${DUR}`, music]);
});

afterAll(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("duck actually ducks (real ffmpeg)", () => {
  it("the MUSIC is quieter while the voice is speaking than after it stops", async () => {
    if (!ok) return;
    const out = path.join(dir, "ducked.mp4");
    await render(out, { against: "vo", ratio: 12, threshold: 0.02 });
    const under = await musicDb(out, 0.3, HALF - 0.6); // voice present
    const after = await musicDb(out, HALF + 0.4, HALF - 0.6); // voice gone, music alone
    expect(after - under).toBeGreaterThan(4);
  }, 120_000);

  // Without this, the test above would pass on any timeline where the voice merely stops — the
  // whole point is that the DUCK is what moves the level, not the arrangement.
  it("...and without the duck the music measures the same in both halves", async () => {
    if (!ok) return;
    const out = path.join(dir, "flat.mp4");
    await render(out, null);
    const under = await musicDb(out, 0.3, HALF - 0.6);
    const after = await musicDb(out, HALF + 0.4, HALF - 0.6);
    expect(Math.abs(after - under)).toBeLessThan(1.5);
  }, 120_000);

  it("the key track survives into the mix instead of being spent on the sidechain", async () => {
    if (!ok) return;
    const out = path.join(dir, "ducked.mp4");
    await render(out, { against: "vo", ratio: 12, threshold: 0.02 });
    // If the asplit were missing, the voice would key the compressor and vanish from the output.
    // Measured in the VOICE band, where only the voice lives.
    const r = await nodeRunner.run("ffmpeg", [
      "-ss",
      "0.3",
      "-t",
      String(HALF - 0.6),
      "-i",
      out,
      "-af",
      "bandpass=f=300:width_type=h:w=60,volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const db = Number(r.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)![1]);
    expect(db).toBeGreaterThan(-40);
  }, 120_000);
});
