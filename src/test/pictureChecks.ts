// Measuring what a picture SHOWS, for e2e tests that judge a consumer by its output: mean colour of a
// region, the four quadrants, a layout comparison, and the decoded size. Read with the real ffmpeg.
import { nodeRunner } from "../tools/__e2e";

export type Chroma = { y: number; u: number; v: number };

/** Mean colour of a region of the first frame of `file` (an ffmpeg crop expression). */
export async function meanColour(file: string, crop = "iw:ih:0:0"): Promise<Chroma> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=${crop},signalstats,metadata=print:file=-`,
    "-f",
    "null",
    "-",
  ]);
  const num = (k: string) => Number(new RegExp(`${k}=([\\d.]+)`).exec(r.stdout)?.[1] ?? NaN);
  return { y: num("YAVG"), u: num("UAVG"), v: num("VAVG") };
}

/** Mean colour of each quadrant: TL, TR, BL, BR. */
export async function quadrants(file: string): Promise<Chroma[]> {
  const out: Chroma[] = [];
  for (const at of ["0:0", "iw/2:0", "0:ih/2", "iw/2:ih/2"])
    out.push(await meanColour(file, `iw/2:ih/2:${at}`));
  return out;
}

const NAMES = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const fmt = (c: Chroma): string =>
  `y${c.y.toFixed(0)} u${c.u.toFixed(0)} v${c.v.toFixed(0)}`;
export function differs(a: Chroma, b: Chroma, tol: number): boolean {
  return !(Math.abs(a.y - b.y) <= tol && Math.abs(a.u - b.u) <= tol && Math.abs(a.v - b.v) <= tol);
}
/** Every quadrant within `tol` of the reference; one line per quadrant that is not. */
export function sameLayout(what: string, got: Chroma[], want: Chroma[], tol = 14): string[] {
  return got.flatMap((g, i) =>
    differs(g, want[i], tol) ? [`${what} ${NAMES[i]}: got ${fmt(g)}, want ${fmt(want[i])}`] : [],
  );
}

/** The STREAM size ffprobe reports (for a file ffmpeg wrote, that is the size it shows). */
export async function dims(file: string): Promise<[number, number]> {
  const r = await nodeRunner.run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    file,
  ]);
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return [w, h];
}

/** The size ffmpeg DECODES `file` at: what every renderer shows, rotation applied. */
export async function decodedSize(file: string): Promise<[number, number]> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v",
    "info",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "showinfo",
    "-f",
    "null",
    "-",
  ]);
  const m = / s:(\d+)x(\d+)/.exec(`${r.stderr}\n${r.stdout}`);
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
}
