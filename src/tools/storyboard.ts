// inspect_media's `overview`: one storyboard image of a video's visual flow, Palmier's
// OverviewRenderer in our terms (owner decision 2026-10-02): ~120 candidate times across the span,
// each snapped to a keyframe (cheap to decode), a candidate kept only when its 8x8 brightness grid
// differs from the last kept one by more than 12, at most 36 tiles in 6 columns, each labelled
// with its time. Tiles keep the source's shape (long edge 160) where Palmier stretches to 160x90.
//
// Candidates are seeked, not decoded in one pass: on an 80-minute 1080p60 OBS recording a
// keyframe-only pass took 33.8 s, while 120 keyframe seeks batched 30 to a process took ~3-4 s.
import type { ClientToolContext } from "./context";
import { stderrExcerpt } from "./command";
import { shortHash } from "./media";
import { withAssScratch, type AssFile } from "./assScratch";
import { OVERLAY_FONT_FILE } from "./inspectOverlay";

export const OVERVIEW = {
  candidates: 120,
  maxTiles: 36,
  columns: 6,
  longEdge: 160,
  /** Mean absolute difference of two 8x8 luma grids (0-255) above which a tile is new. */
  promoteDiff: 12,
  /** Seeks per ffmpeg process; four processes run at once. */
  batch: 30,
} as const;

/** Palmier's candidate times: one per interval of max(1 s, span/120), at each interval's middle. */
export function candidateTimes(start: number, end: number): number[] {
  const span = Math.max(end - start, 0.001);
  const interval = Math.max(1, span / OVERVIEW.candidates);
  const out: number[] = [];
  for (let t = start + interval / 2; t < end; t += interval) out.push(t);
  return out.length ? out : [start + span / 2];
}

export interface Candidate {
  /** Where the frame actually sits (the keyframe a seek landed on), seconds. */
  t: number;
  /** 64 luma values of the frame shrunk to 8x8. */
  grid: Uint8Array;
}

/** Which candidates become tiles: drop any that landed on a keyframe already shown, keep one only
 *  when it looks different from the last tile kept, then thin evenly to at most 36. Returns
 *  indices into `cands`, which must be in time order. */
export function keepTiles(cands: readonly Candidate[]): number[] {
  const kept: number[] = [];
  let last: Uint8Array | null = null;
  let lastT = -Infinity;
  cands.forEach((c, i) => {
    if (c.t <= lastT) return;
    lastT = c.t;
    if (last) {
      let d = 0;
      for (let k = 0; k < 64; k++) d += Math.abs(c.grid[k] - last[k]);
      if (d / 64 <= OVERVIEW.promoteDiff) return;
    }
    last = c.grid;
    kept.push(i);
  });
  if (kept.length <= OVERVIEW.maxTiles) return kept;
  const step = kept.length / OVERVIEW.maxTiles;
  return Array.from({ length: OVERVIEW.maxTiles }, (_, i) => kept[Math.floor(i * step)]);
}

/** "m:ss", or "h:mm:ss" past an hour, rounded to the second (Palmier's label). */
export function timeLabel(t: number): string {
  const s = Math.max(0, Math.round(t));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Tile size for a source of display size w x h: long edge 160, shape kept, even sides. */
export function tileSize(w: number, h: number): { w: number; h: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return w >= h
    ? { w: OVERVIEW.longEdge, h: even((OVERVIEW.longEdge * h) / w) }
    : { w: even((OVERVIEW.longEdge * w) / h), h: OVERVIEW.longEdge };
}

/** The filter index of branch `i`'s showinfo in the batch graph below. Filters are named by their
 *  position in the graph string; each branch is: trim, showinfo, scale, setsar, setpts, split,
 *  scale, format. Pinned by a test that runs the graph. */
export const showinfoIndex = (i: number): number => i * 8 + 1;

/** One batch: seek to each time, keep the first frame, report where it really sits. */
async function runBatch(
  ctx: ClientToolContext,
  path: string,
  times: number[],
  tile: { w: number; h: number },
  dir: string,
  tag: string,
): Promise<Array<{ t: number; grid: Uint8Array; file: string }>> {
  const args = ["-y", "-hide_banner", "-loglevel", "info", "-nostats"];
  for (const t of times)
    args.push("-noaccurate_seek", "-threads", "1", "-ss", t.toFixed(3), "-i", path);
  const chains: string[] = [];
  times.forEach((_, i) => {
    chains.push(
      `[${i}:v]trim=end_frame=1,showinfo,scale=${tile.w}:${tile.h},setsar=1,setpts=N/TB,split=2[t${i}][q${i}]`,
      `[q${i}]scale=8:8:flags=area,format=gray[g${i}]`,
    );
  });
  const ins = (p: string): string => times.map((_, i) => `[${p}${i}]`).join("");
  chains.push(`${ins("t")}concat=n=${times.length}:v=1:a=0[tiles]`);
  chains.push(`${ins("g")}concat=n=${times.length}:v=1:a=0[grids]`);
  const tilePattern = `${dir}/${tag}_%03d.png`;
  const gridFile = `${dir}/${tag}_grids.raw`;
  args.push(
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[tiles]",
    "-fps_mode",
    "passthrough",
    "-start_number",
    "0",
    tilePattern,
    "-map",
    "[grids]",
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    gridFile,
  );
  const r = await ctx.runner.run("ffmpeg", args, ctx.signal);
  if (r.code !== 0) throw new Error(stderrExcerpt(r.stderr, 300));
  // pts_time is relative to each input's seek point, and negative when the keyframe came first.
  const actual = new Map<number, number>();
  for (const m of r.stderr.matchAll(/Parsed_showinfo_(\d+)[^\n]*?pts_time:\s*(-?[\d.]+)/g)) {
    const branch = (Number(m[1]) - 1) / 8;
    if (Number.isInteger(branch) && !actual.has(branch))
      actual.set(branch, times[branch] + Number(m[2]));
  }
  const grids = await ctx.store.readBytes(gridFile);
  return times.map((t, i) => ({
    t: Math.max(0, actual.get(i) ?? t),
    grid: grids.subarray(i * 64, i * 64 + 64),
    file: tilePattern.replace("%03d", String(i).padStart(3, "0")),
  }));
}

/** ASS labels for a storyboard: a dark chip with the time at each tile's top-left corner. */
function labelsAss(times: number[], tile: { w: number; h: number }, sheet: { w: number; h: number }): AssFile {
  const events = times.map((t, i) => {
    const x = (i % OVERVIEW.columns) * tile.w;
    const y = Math.floor(i / OVERVIEW.columns) * tile.h;
    return `Dialogue: 0,0:00:00.00,1:00:00.00,Chip,,0,0,0,,{\\an7\\pos(${x + 4},${y + 2})}${timeLabel(t)}`;
  });
  return {
    name: "storyboard_labels.ass",
    content: [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${sheet.w}`,
      `PlayResY: ${sheet.h}`,
      "ScaledBorderAndShadow: yes",
      "WrapStyle: 2",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Chip,Poppins,10,&H00FFFFFF,&H00FFFFFF,&H59000000,&H59000000,-1,0,0,0,100,100,0,0,3,2,0,7,0,0,0,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...events,
      "",
    ].join("\n"),
  };
}

export interface Storyboard {
  /** The sheet, a JPEG in the project's inspect cache. */
  path: string;
  /** Each tile's time, seconds, in sheet order (row by row). */
  tile_times: number[];
}

/** Build the storyboard of [start, end) seconds of `path`, whose display size is w x h. Cached by
 *  file, size and window: a second overview of the same span is a file read. */
export async function makeStoryboard(
  ctx: ClientToolContext,
  path: string,
  start: number,
  end: number,
  display: { w: number; h: number },
): Promise<Storyboard> {
  const size = (await ctx.store.byteSize(path).catch(() => null)) ?? 0;
  const key = shortHash(`${path}|${size}|${start.toFixed(3)}|${end.toFixed(3)}|ov1`);
  const out = await ctx.store.prepareArtifact(`inspect/ov_${key}.jpg`);
  const meta = await ctx.store.prepareArtifact(`inspect/ov_${key}.json`);
  if ((await ctx.store.exists(out)) && (await ctx.store.exists(meta))) {
    const times = JSON.parse(await ctx.store.readText(meta)) as number[];
    return { path: out, tile_times: times };
  }
  const tile = tileSize(display.w, display.h);
  // ffmpeg's image writer does not create directories: preparing the list file makes the work dir.
  const list = await ctx.store.prepareArtifact(`inspect/ov_${key}_work/tiles.txt`);
  const work = list.slice(0, list.lastIndexOf("/"));
  try {
    const times = candidateTimes(start, end);
    const batches: number[][] = [];
    for (let i = 0; i < times.length; i += OVERVIEW.batch) batches.push(times.slice(i, i + OVERVIEW.batch));
    const results: Array<Array<{ t: number; grid: Uint8Array; file: string }>> = new Array(batches.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, batches.length) }, async () => {
        for (let b = next++; b < batches.length; b = next++)
          results[b] = await runBatch(ctx, path, batches[b], tile, work, `b${b}`);
      }),
    );
    const cands = results.flat().sort((a, b) => a.t - b.t);
    const kept = keepTiles(cands).map((i) => cands[i]);
    if (!kept.length) throw new Error("no frame could be decoded for the overview");
    const cols = Math.min(OVERVIEW.columns, kept.length);
    const rows = Math.ceil(kept.length / cols);
    const sheet = { w: cols * tile.w, h: rows * tile.h };
    const list = `${work}/tiles.txt`;
    await ctx.store.writeText(
      list,
      kept.map((k) => `file '${k.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const labels = labelsAss(
      kept.map((k) => k.t),
      tile,
      sheet,
    );
    const r = await withAssScratch(ctx, [labels], [OVERLAY_FONT_FILE], (cwd) =>
      ctx.runner.run(
        "ffmpeg",
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-vf",
          `tile=${cols}x${rows}:color=black,ass=f=${labels.name}:fontsdir=fonts`,
          "-frames:v",
          "1",
          "-q:v",
          "5",
          out,
        ],
        ctx.signal,
        cwd,
      ),
    );
    if (r.code !== 0 || !(await ctx.store.exists(out)))
      throw new Error(`composing the overview failed: ${stderrExcerpt(r.stderr, 300)}`);
    const tileTimes = kept.map((k) => Math.round(k.t * 1000) / 1000);
    await ctx.store.writeText(meta, JSON.stringify(tileTimes));
    return { path: out, tile_times: tileTimes };
  } finally {
    await ctx.store.remove(work).catch(() => undefined);
  }
}
