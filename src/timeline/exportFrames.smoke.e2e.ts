// What the exported FILE actually shows, frame by frame, through the bundled ffmpeg.
//
// A user session reported black frames in a delivered export: a flash across a gap in
// variable-frame-rate footage, and a single black frame at a cut. Neither is visible in the
// filtergraph, in the exit code, or in the file's duration — only in the pixels. Every
// assertion here reads the frames back out of the written file.
//
// Sources are SOLID COLOURS on purpose. "Not black" is a weak claim (a wrong-but-bright frame
// passes it), so each frame is classified by chroma and checked against the clip that owns
// that instant — which catches a frame that is merely the WRONG clip as well as a dropped one.
//
// buildRenderCommand consumes a SECONDS-view timeline (toSecondsView runs before it in the real
// path), so every span below is in seconds, not frames.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

function bundled(tool: "ffmpeg" | "ffprobe"): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const triples =
    process.platform === "win32"
      ? ["x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
        : ["x86_64-unknown-linux-gnu"];
  for (const t of triples) {
    const p = path.join(dir, `${tool}-${t}`);
    if (existsSync(p)) return p;
  }
  return null;
}
const FF = bundled("ffmpeg");
const FP = bundled("ffprobe");

function run(
  program: string,
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-frames-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const FPS = 30;
const CANVAS = { width: 320, height: 180, fps: FPS };

/** A solid-colour CFR clip. */
async function solid(dir: string, colour: string, seconds = 3): Promise<string> {
  const out = path.join(dir, `${colour}.mp4`);
  const r = await run(FF!, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:size=320x180:rate=30:duration=${seconds}`,
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  expect(r.code, `source ${colour} failed: ${r.stderr.slice(-300)}`).toBe(0);
  return out;
}

/** A solid-colour clip with REAL timestamp gaps, like a screen recorder that emits nothing
 *  while the screen is still. The gaps are asserted, not assumed — a "VFR" fixture that is
 *  secretly CFR would make the test pass for the wrong reason. */
async function vfrWithGaps(dir: string): Promise<string> {
  const out = path.join(dir, "vfr.mp4");
  const r = await run(FF!, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:size=320x180:rate=120:duration=3",
    "-vf",
    "select='(not(mod(n,4))+eq(mod(n,120),1))*not(between(t,0.8,1.4))*not(between(t,1.9,2.3))',setpts=PTS-STARTPTS",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  expect(r.code, `vfr source failed: ${r.stderr.slice(-300)}`).toBe(0);
  const p = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    out,
  ]);
  const t = p.stdout
    .split(/\r?\n/)
    .map((s) => Number(s.replace(/,$/, "")))
    .filter(Number.isFinite);
  const gaps = t.slice(1).filter((v, i) => v - t[i] > 0.05);
  expect(gaps.length, "fixture must actually contain timestamp gaps").toBeGreaterThan(0);
  const rates = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=r_frame_rate,avg_frame_rate",
    "-of",
    "default=noprint_wrappers=1",
    out,
  ]);
  const fraction = (raw: string): number => {
    const [n, d = "1"] = raw.split("/");
    return Number(n) / Number(d);
  };
  const rateByName = Object.fromEntries(
    rates.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("=", 2)),
  );
  const nominal = fraction(rateByName.r_frame_rate);
  const average = fraction(rateByName.avg_frame_rate);
  expect(nominal, "fixture must advertise the macOS-style high nominal rate").toBeGreaterThan(100);
  expect(average, "fixture average rate must stay near the emitted ~30 fps").toBeLessThan(40);
  return out;
}

type Frame = { t: number; y: number; u: number; v: number };

/** Every frame of a written file, with its luma and chroma. */
async function frames(file: string): Promise<Frame[]> {
  const r = await run(FF!, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print:file=-",
    "-f",
    "null",
    "-",
  ]);
  const out: Frame[] = [];
  let t: number | null = null;
  let y: number | null = null;
  let u: number | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) {
      t = Number(pts[1]);
      y = u = null;
      continue;
    }
    const yv = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (yv) y = Number(yv[1]);
    const uv = /lavfi\.signalstats\.UAVG=([\d.]+)/.exec(line);
    if (uv) u = Number(uv[1]);
    const vv = /lavfi\.signalstats\.VAVG=([\d.]+)/.exec(line);
    if (vv && t !== null && y !== null && u !== null) {
      out.push({ t, y, u, v: Number(vv[1]) });
      t = null;
    }
  }
  expect(out.length, "no frames could be read back from the export").toBeGreaterThan(0);
  return out;
}

/** Classify by chroma. Luma alone cannot tell blue (Y~41) from a dark frame, which is exactly
 *  the confusion that makes a bare "not black" assertion untrustworthy. */
function colourOf(f: Frame): "black" | "red" | "green" | "blue" | "other" {
  if (f.y < 24 && f.u > 118 && f.u < 138 && f.v > 118 && f.v < 138) return "black";
  if (f.u > 200 && f.v < 150) return "blue";
  if (f.v > 200 && f.u < 150) return "red";
  if (f.u < 120 && f.v < 120) return "green";
  return "other";
}

/** Render a timeline through the real export path and read the result back. */
async function exported(dir: string, timeline: Timeline, name: string): Promise<Frame[]> {
  const out = path.join(dir, `${name}.mp4`);
  const plan = buildRenderCommand(timeline, out);
  const r = await run(FF!, plan.args);
  expect(r.code, `render failed: ${r.stderr.slice(-800)}`).toBe(0);
  return frames(out);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tl = (tracks: unknown[]): Timeline => ({ canvas: CANVAS, tracks }) as any;
const clip = (o: Record<string, unknown>) => ({ kind: "video", ...o });
const track = (id: string, clips: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  kind: "video",
  z: 0,
  clips,
  ...extra,
});
/** The colour shown at a given FRAME index. */
const at = (f: Frame[], frame: number) => {
  const hit = f.find((x) => Math.abs(x.t - frame / FPS) < 0.4 / FPS);
  expect(hit, `no frame ${frame} in the export`).toBeDefined();
  return colourOf(hit!);
};

const maybe = FF && FP ? describe : describe.skip;

maybe("what the exported file actually shows (real ffmpeg)", () => {
  it("a solid clip exports solid — no black frame anywhere", async () => {
    // The floor. If this ever fails, nothing below means anything.
    const dir = await scratch();
    const red = await solid(dir, "red");
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 2,
            source_in: 0,
            source_out: 2,
          }),
        ]),
      ]),
      "solid",
    );
    expect(f.filter((x) => colourOf(x) === "black")).toEqual([]);
    expect(f.every((x) => colourOf(x) === "red")).toBe(true);
  }, 180_000);

  it("the frame at a CUT belongs to the incoming clip, and is not black", async () => {
    // Reported: "a clip's first frame at a cut simply doesn't get drawn". A single black frame
    // is invisible when scrubbing and survives into the delivered file.
    const dir = await scratch();
    const [red, blue] = [await solid(dir, "red"), await solid(dir, "blue")];
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 2,
            source_in: 0,
            source_out: 2,
          }),
          clip({
            id: "b",
            media_ref: blue,
            timeline_in: 2,
            timeline_out: 4,
            source_in: 0,
            source_out: 2,
          }),
        ]),
      ]),
      "cut",
    );
    expect(f.filter((x) => colourOf(x) === "black")).toEqual([]);
    expect(at(f, 59)).toBe("red"); // last frame of the outgoing clip
    expect(at(f, 60)).toBe("blue"); // FIRST frame of the incoming clip — the reported one
    expect(at(f, 61)).toBe("blue");
  }, 180_000);

  it("holds up across SEVERAL cuts, not just the first", async () => {
    // The session saw one bad cut out of several. Verifying one boundary is evidence about that
    // boundary only.
    const dir = await scratch();
    const [red, green, blue] = [
      await solid(dir, "red"),
      await solid(dir, "green"),
      await solid(dir, "blue"),
    ];
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 1,
            source_in: 0,
            source_out: 1,
          }),
          clip({
            id: "b",
            media_ref: green,
            timeline_in: 1,
            timeline_out: 2,
            source_in: 0,
            source_out: 1,
          }),
          clip({
            id: "c",
            media_ref: blue,
            timeline_in: 2,
            timeline_out: 3,
            source_in: 0,
            source_out: 1,
          }),
        ]),
      ]),
      "cuts",
    );
    expect(f.filter((x) => colourOf(x) === "black")).toEqual([]);
    expect([at(f, 5), at(f, 25), at(f, 35), at(f, 55), at(f, 65), at(f, 85)]).toEqual([
      "red",
      "red",
      "green",
      "green",
      "blue",
      "blue",
    ]);
  }, 180_000);

  it("a 120-nominal/30-average macOS-style source holds across timestamp gaps", async () => {
    // Reported: a 0.23s black flash mapping exactly onto a gap in a macOS screen recording. This
    // fixture advertises 120 fps but emits about 30, plus two long gaps. The renderer must hold the
    // last picture across those gaps rather than exposing the black canvas.
    const dir = await scratch();
    const src = await vfrWithGaps(dir);
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: src,
            timeline_in: 0,
            timeline_out: 3,
            source_in: 0,
            source_out: 3,
          }),
        ]),
      ]),
      "vfr-export",
    );
    expect(f.filter((x) => colourOf(x) === "black").map((x) => x.t)).toEqual([]);
    expect(f.every((x) => colourOf(x) === "green")).toBe(true);
  }, 180_000);

  it("a trim that starts inside a source timestamp gap still begins with video", async () => {
    // The adversarial seek case: source_in lands in the 0.8s-1.4s gap. Input seeking must not
    // leave the beginning of the placed clip transparent while waiting for the next packet.
    const dir = await scratch();
    const src = await vfrWithGaps(dir);
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: src,
            timeline_in: 0,
            timeline_out: 1,
            source_in: 1,
            source_out: 2,
          }),
        ]),
      ]),
      "vfr-trim-in-gap",
    );
    expect(f.length).toBe(FPS);
    expect(f.filter((x) => colourOf(x) === "black").map((x) => x.t)).toEqual([]);
    expect(f.every((x) => colourOf(x) === "green")).toBe(true);
  }, 180_000);

  it("renders black ONLY where the timeline is actually empty", async () => {
    // The failure direction: "never black" is the wrong rule. A real gap SHOULD be black, so a
    // fix that painted over every gap would be just as broken as the bug.
    const dir = await scratch();
    const red = await solid(dir, "red");
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 1,
            source_in: 0,
            source_out: 1,
          }),
          clip({
            id: "b",
            media_ref: red,
            timeline_in: 2,
            timeline_out: 3,
            source_in: 0,
            source_out: 1,
          }),
        ]),
      ]),
      "gap",
    );
    // Sampled off the boundaries: which side a boundary frame lands on is a rounding question,
    // not the rule under test.
    expect([at(f, 5), at(f, 25)]).toEqual(["red", "red"]);
    expect([at(f, 35), at(f, 55)]).toEqual(["black", "black"]);
    expect([at(f, 65), at(f, 85)]).toEqual(["red", "red"]);
  }, 180_000);

  it("writes as many frames as the timeline is long", async () => {
    // A dropped or duplicated frame at a boundary shifts everything after it out of sync with
    // the audio, and the file's duration alone is too coarse to show it.
    const dir = await scratch();
    const [red, blue] = [await solid(dir, "red"), await solid(dir, "blue")];
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 1.5,
            source_in: 0,
            source_out: 1.5,
          }),
          clip({
            id: "b",
            media_ref: blue,
            timeline_in: 1.5,
            timeline_out: 3.5,
            source_in: 0,
            source_out: 2,
          }),
        ]),
      ]),
      "count",
    );
    expect(f.length).toBe(Math.round(3.5 * FPS));
  }, 180_000);

  it("a hidden track contributes nothing to the file", async () => {
    // hidden is a render-time exclusion; if it leaked, the top clip would cover the one below
    // and the export would be the wrong footage entirely.
    const dir = await scratch();
    const [red, blue] = [await solid(dir, "red"), await solid(dir, "blue")];
    const f = await exported(
      dir,
      tl([
        track(
          "v1",
          [
            clip({
              id: "hidden",
              media_ref: blue,
              timeline_in: 0,
              timeline_out: 2,
              source_in: 0,
              source_out: 2,
            }),
          ],
          { z: 1, hidden: true },
        ),
        track("v0", [
          clip({
            id: "shown",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 2,
            source_in: 0,
            source_out: 2,
          }),
        ]),
      ]),
      "hidden",
    );
    expect(f.every((x) => colourOf(x) === "red")).toBe(true);
  }, 180_000);

  // ...and it must not set the LENGTH either. The duration was the last frame on ANY track while the
  // compositor filtered hidden ones, so a 15.8s cut exported as a 40.8s file with 25s of black on
  // the end. Counted in FRAMES OF THE FILE, because the fix is only real if the artifact is shorter.
  it("a hidden track does not pad the file with black either", async () => {
    const dir = await scratch();
    const [red, blue] = [await solid(dir, "red", 6), await solid(dir, "blue", 6)];
    const f = await exported(
      dir,
      tl([
        track(
          "v1",
          [clip({ id: "long", media_ref: blue, timeline_in: 0, timeline_out: 5, source_in: 0, source_out: 5 })],
          { z: 1, hidden: true },
        ),
        track("v0", [
          clip({ id: "shown", media_ref: red, timeline_in: 0, timeline_out: 2, source_in: 0, source_out: 2 }),
        ]),
      ]),
      "hiddenlen",
    );
    expect(f.length).toBe(Math.round(2 * FPS)); // 2s of cut, not 5s of hidden track
    expect(f.filter((x) => colourOf(x) === "black")).toEqual([]);
  }, 180_000);

  it("a sped-up clip still shows its footage the whole way through", async () => {
    // speed rescales the source window; getting it wrong runs off the end of the media and the
    // tail renders black.
    const dir = await scratch();
    const green = await solid(dir, "green", 5);
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: green,
            timeline_in: 0,
            timeline_out: 2,
            source_in: 0,
            source_out: 4,
            speed: 2,
          }),
        ]),
      ]),
      "speed",
    );
    expect(f.filter((x) => colourOf(x) === "black")).toEqual([]);
    expect(f.every((x) => colourOf(x) === "green")).toBe(true);
  }, 180_000);

  // exportStem now ALLOWS non-ASCII names instead of stripping them to the project name. That is
  // only an improvement if such a name survives the rest of the chain — argv encoding, the
  // bundled ffmpeg, and the filesystem. Otherwise a silent rename has been traded for a hard
  // failure, which is worse. Deliberately the least representative names, not the easiest.
  for (const name of ["夏休みの動画", "Café Séance", "Видео 2", "فيديو"]) {
    it(`writes a deliverable actually named "${name}"`, async () => {
      const dir = await scratch();
      const red = await solid(dir, "red");
      const out = path.join(dir, `${name}.mp4`);
      const plan = buildRenderCommand(
        tl([
          track("v0", [
            clip({
              id: "a",
              media_ref: red,
              timeline_in: 0,
              timeline_out: 1,
              source_in: 0,
              source_out: 1,
            }),
          ]),
        ]),
        out,
      );
      const r = await run(FF!, plan.args);
      expect(r.code, `render failed: ${r.stderr.slice(-400)}`).toBe(0);
      // Read it back through the DIRECTORY listing, not the path we just built: that is what
      // proves the bytes on disk carry the name, rather than our own string round-tripping.
      expect(await fsp.readdir(dir)).toContain(`${name}.mp4`);
      const f = await frames(out);
      expect(f.every((x) => colourOf(x) === "red")).toBe(true);
    }, 180_000);
  }

  it("a source read from a non-ASCII path still renders", async () => {
    // The other half: footage the user imported from a folder in their own language.
    const dir = await scratch();
    const nested = path.join(dir, "素材 folder");
    await fsp.mkdir(nested, { recursive: true });
    const green = await solid(nested, "green", 1);
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: green,
            timeline_in: 0,
            timeline_out: 1,
            source_in: 0,
            source_out: 1,
          }),
        ]),
      ]),
      "nonascii-source",
    );
    expect(f.every((x) => colourOf(x) === "green")).toBe(true);
  }, 180_000);

  it("a one-frame timeline exports one frame, not zero and not a broken file", async () => {
    // The shortest thing a user can ask for. A duration that rounds to nothing produces a file
    // ffprobe still reports as valid, so the frame COUNT is the only assertion that catches it.
    const dir = await scratch();
    const red = await solid(dir, "red");
    const f = await exported(
      dir,
      tl([
        track("v0", [
          clip({
            id: "a",
            media_ref: red,
            timeline_in: 0,
            timeline_out: 1 / FPS,
            source_in: 0,
            source_out: 1 / FPS,
          }),
        ]),
      ]),
      "one-frame",
    );
    expect(f.length).toBe(1);
    expect(colourOf(f[0])).toBe("red");
  }, 180_000);
});
