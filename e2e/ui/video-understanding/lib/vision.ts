// Helpers of the video-understanding lane: find the pictures the app sent the model, measure their
// colour with the shipped ffmpeg (no image library), and answer the paid vision proxy with a
// pre-written reply in the server's own shape (`{result: {ok, text}}`), so no vendor is ever reached.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { FakeArtDaddy } from "../../agent-and-models/lib/fakeServer";

function triple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

function sidecar(name: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const prefix of ["", "artdaddy-"]) {
    const p = path.resolve("src-tauri/binaries", `${prefix}${name}-${triple()}${ext}`);
    if (existsSync(p)) return p;
  }
  throw new Error(`${name} is not staged in src-tauri/binaries`);
}

/** Every JPEG or PNG carried in `value` as base64 (a data URL or bare), in order. */
export function picturesIn(value: unknown): Buffer[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const out: Buffer[] = [];
  for (const m of text.matchAll(
    /(\/9j\/[A-Za-z0-9+/]{200,}={0,2}|iVBORw0KGgo[A-Za-z0-9+/]{200,}={0,2})/g,
  ))
    out.push(Buffer.from(m[1], "base64"));
  return out;
}

/** The picture's mean colour, as the shipped ffmpeg decodes it. */
export function meanColour(picture: Buffer): [number, number, number] {
  const r = spawnSync(
    sidecar("ffmpeg"),
    [
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      "scale=1:1:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { input: picture, maxBuffer: 1 << 20 },
  );
  if (r.status !== 0 || r.stdout.length < 3)
    throw new Error(`ffmpeg could not decode the picture: ${String(r.stderr).slice(0, 300)}`);
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

/** What a person would call the colour: the strongest channel, or grey when they are within `grey` levels. */
export function colourName(
  [r, g, b]: [number, number, number],
  grey = 24,
): "red" | "green" | "blue" | "grey" {
  if (Math.max(r, g, b) - Math.min(r, g, b) < grey) return "grey";
  if (r >= g && r >= b) return "red";
  return g >= b ? "green" : "blue";
}

/** Answer `/ai/vision_video` with `text` (what the vision model would have written), and refuse any
 *  other paid route as the fake server does. Returns the requests it answered. */
export function visionAnswers(
  server: FakeArtDaddy,
  text: string | ((body: unknown) => { status: number; body: unknown }),
): Array<{ name: string; body: unknown }> {
  const seen: Array<{ name: string; body: unknown }> = [];
  server.aiAnswer = (name, body) => {
    seen.push({ name, body });
    if (name !== "vision_video")
      return { status: 503, body: { detail: { error: "internal_error" } } };
    if (typeof text === "function") return text(body);
    return { status: 200, body: { result: { ok: true, text } } };
  };
  return seen;
}

/** The clip a vision call sent inline (`media.video.b64`), probed with the shipped ffprobe: its
 *  length and where its time starts. */
export function sentClip(body: unknown): { duration: number; start: number } {
  const b64 = (body as { media?: { video?: { b64?: string } } } | null)?.media?.video?.b64;
  if (!b64) throw new Error("the vision call carried no inline clip");
  const r = spawnSync(
    sidecar("ffprobe"),
    ["-v", "error", "-show_entries", "format=duration,start_time", "-of", "json", "pipe:0"],
    { input: Buffer.from(b64, "base64"), maxBuffer: 1 << 20 },
  );
  const f =
    (JSON.parse(String(r.stdout)) as { format?: { duration?: string; start_time?: string } })
      .format ?? {};
  return { duration: Number(f.duration), start: Number(f.start_time ?? 0) };
}
