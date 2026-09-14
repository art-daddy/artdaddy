// Real-media robustness e2e — opt-in smoke lane (vitest.smoke.config.ts). Throws
// the metadata shapes real user files carry (no audio, an odd 44.1k sample rate, a
// single frame, a truncated/corrupt file) at the REAL ffprobe -> probePath path and
// asserts a graceful trimmed contract (or a principled {ok:false}) — never a throw
// or fabricated media. The pure parse edge-cases (VFR, rotation via side-data vs
// tags.rotate, corrupt payloads) are pinned fast + portably in media.test.ts; this
// lane proves the real ffprobe pipeline survives real files end-to-end.
//   npx vitest run --config vitest.smoke.config.ts src/tools/realmedia.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ff, have, nodeFs, nodeRunner, srcSolid } from "./__e2e";
import { probePath } from "./media";
import { joinPath } from "./store";

type Rec = Record<string, unknown>;
const ROOT = joinPath(os.tmpdir(), `artdaddy-realmedia-${Date.now()}`);
const FIXTURES = path.join(process.cwd(), "src", "tools", "__fixtures__", "media");
let HAVE = false;

beforeAll(async () => {
  HAVE = (await have("ffmpeg")) && (await have("ffprobe"));
  await nodeFs.mkdir(ROOT);
});
afterAll(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("real-media robustness (probe survives nasty files)", () => {
  it("no-audio video: has_audio=false, no invented audio block", async () => {
    if (!HAVE) return;
    const f = await srcSolid(joinPath(ROOT, "noaudio.mp4"), {
      color: "blue",
      w: 64,
      h: 48,
      dur: 0.3,
    });
    const r = (await probePath(nodeRunner, f)) as Rec;
    expect(r.ok).toBe(true);
    expect(r.has_audio).toBe(false);
    expect(r.audio).toBeNull();
    expect((r.video as Rec).width).toBe(64);
  }, 30_000);

  it("odd 44.1k sample rate: preserved as reported, no crash", async () => {
    if (!HAVE) return;
    const f = joinPath(ROOT, "oddrate.wav");
    await ff([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.3",
      "-ar",
      "44100",
      "-ac",
      "1",
      f,
    ]);
    const r = (await probePath(nodeRunner, f)) as Rec;
    expect(r.ok).toBe(true);
    expect(r.has_audio).toBe(true);
    expect((r.audio as Rec).sample_rate).toBe("44100");
  }, 30_000);

  it("single-frame clip: probes without a divide-by-zero / throw", async () => {
    if (!HAVE) return;
    const f = joinPath(ROOT, "oneframe.mp4");
    await ff([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=30",
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuv420p",
      f,
    ]);
    const r = (await probePath(nodeRunner, f)) as Rec;
    expect(r.ok).toBe(true);
    expect((r.video as Rec).width).toBe(64);
  }, 30_000);

  it("checked-in truncated/corrupt mp4: principled result, never a throw", async () => {
    if (!HAVE) return;
    const f = path.join(FIXTURES, "truncated.mp4");
    if (!(await nodeFs.exists(f))) return; // corpus not present
    const r = (await probePath(nodeRunner, f)) as Rec;
    // Either a principled error, or (on lenient ffprobe builds) a contract with no
    // usable streams — never a throw and never fabricated media.
    if (r.ok) {
      expect(r.video).toBeNull();
      expect(r.audio).toBeNull();
    } else {
      expect(typeof r.error).toBe("string");
    }
  }, 30_000);
});
