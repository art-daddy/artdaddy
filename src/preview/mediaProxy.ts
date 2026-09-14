// Import-time media processing (desktop): generate a poster frame (timeline
// thumbnail) and, when a clip's codec can't be decoded by the in-app WebCodecs
// preview (HEVC, ProRes, …), an H.264 PREVIEW PROXY. The timeline keeps the
// ORIGINAL as the clip source — the server renders from it; only the preview
// swaps in the proxy (see resolve.resolvePreviewUrl). Idempotent: existing
// outputs are skipped. Runs ffmpeg via the Tauri sidecar, so it's excluded from
// unit coverage. Best-effort throughout — a failure just leaves the original.
import { stderrExcerpt, type CommandRunner } from "../tools/command";
import { probePath } from "../tools/media";
import type { ProjectStoreAccess } from "../tools/store";
import { imageProxyName, posterName, proxyKey, proxyName } from "./proxyPaths";
import { announceMediaDerived } from "./mediaDerived";

import { extAlternation, kindOf, needsPreviewProxy } from "../media/formats";

const VID_RE = new RegExp(`\\.(${extAlternation("video")})$`, "i");
// Video codecs the in-app WebCodecs preview can decode in the WebView.
const WEB_VIDEO_OK = new Set(["h264", "vp8", "vp9", "av1"]);
// ...and the containers our demuxer reads. mp4box parses ISOBMFF ONLY, so h264-in-Matroska
// is undecodable here despite the codec being fine — which is exactly what a screen recording
// named ".mp4" turned out to be. Judged from ffprobe's format, never the filename: that file
// lied about its container and a name-based check would have cleared it.
const WEB_CONTAINER_OK = /(?:^|,)(?:mov|mp4|m4a|3gp|3g2|mj2)(?:,|$)/i;

/** True once a preview proxy exists for this source (or none is needed). */
export async function processImportedMedia(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  source: string,
  onTranscode?: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const changed = await deriveArtifacts(store, runner, source, onTranscode, signal);
  // Anything already on screen looked for these BEFORE they existed. Nothing else tells it
  // they arrived, and it will not look again on its own.
  if (changed) announceMediaDerived(source);
  return changed;
}

async function deriveArtifacts(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  source: string,
  onTranscode?: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (kindOf(source) === "image") return processImage(store, runner, source, onTranscode, signal);
  if (!VID_RE.test(source)) return false;
  const abs = await store.resolveRef(source);
  if (!abs) return false;
  const key = proxyKey(source);
  console.debug(`[mediaProxy] processImported source=${source} key=${key} abs=${abs}`);
  let changed = false;

  // Poster for the timeline thumbnail — if missing.
  const poster = await store.prepareArtifact(`posters/${posterName(source)}`);
  if (!(await store.exists(poster))) {
    // NOT frame 0. Films routinely open on black — Tears of Steel is black for its first 8
    // seconds — and a black tile is indistinguishable from a broken thumbnail. Seek ~10% in
    // (capped, so a feature-length seek stays quick), drop frames that are ≥90% black, and let
    // `thumbnail` pick the most representative of what is left. Scale BEFORE those filters so
    // they buffer small frames rather than full-resolution ones. The probe runs at most once
    // per asset, because the poster is written once.
    const dur = Number((await probePath(runner, abs)).duration_s) || 0;
    const seek = dur > 4 ? Math.min(dur * 0.1, 60) : 0;
    const args = (vf: string): string[] => [
      ...(seek > 0 ? ["-ss", seek.toFixed(2)] : []),
      "-i",
      abs,
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-q:v",
      "4",
    ];
    const SKIP_BLACK =
      "scale=-2:360,blackframe=amount=0," +
      "metadata=select:key=lavfi.blackframe.pblack:value=90:function=less,thumbnail=n=40";
    let made = await transcode(store, runner, poster, args(SKIP_BLACK), signal);
    // A wholly black clip has no non-black frame to find, and the filtered pass writes NOTHING
    // at all — so it needs a plain second attempt or it would end up with no poster.
    if (!made) made = await transcode(store, runner, poster, args("scale=-2:360"), signal);
    if (made) changed = true;
  }

  // H.264 preview proxy — if missing AND the source codec isn't web-decodable.
  // A `.webok` marker records "examined, web-decodable, no proxy needed" so a
  // web-codec clip isn't re-probed on every load (matters for big timelines).
  const proxy = await store.prepareArtifact(`proxies/${proxyName(source)}`);
  const webOk = await store.prepareArtifact(`proxies/${key}.webok`);
  if (!(await store.exists(proxy)) && !(await store.exists(webOk))) {
    const probe = await probePath(runner, abs);
    const video = (probe.video ?? null) as Record<string, unknown> | null;
    const codec = String(video?.codec ?? "").toLowerCase();
    const container = String(probe.format ?? "");
    const playable = WEB_VIDEO_OK.has(codec) && WEB_CONTAINER_OK.test(container);
    console.debug(
      `[mediaProxy] proxy check key=${key} codec=${codec || "?"} container=${container || "?"} needsProxy=${!!codec && !playable}`,
    );
    if (codec && !playable) {
      onTranscode?.();
      const made = await transcode(
        store,
        runner,
        proxy,
        [
          "-i",
          abs,
          "-vf",
          "scale=-2:720",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "24",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "15", // ~0.5s keyframe interval so a seek/play only decodes a few frames (x264 default is ~250)
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
        ],
        signal,
      );
      if (made) changed = true;
    } else if (codec) {
      try {
        await store.writeText(webOk, "");
      } catch {
        /* marker is best-effort */
      }
    }
  }
  return changed;
}

/** Stills the WebView has no decoder for (TIFF, HEIC) get a PNG stand-in, plus the same
 *  poster the timeline thumbnail reads — otherwise an imported still is simply invisible
 *  everywhere in the app while exporting perfectly well. */
async function processImage(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  source: string,
  onTranscode?: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!needsPreviewProxy(source)) return false;
  const abs = await store.resolveRef(source);
  if (!abs) return false;
  let changed = false;
  const proxy = await store.prepareArtifact(`proxies/${imageProxyName(source)}`);
  if (!(await store.exists(proxy))) {
    onTranscode?.();
    // Bounded on the long edge: a camera TIFF can exceed what a GPU texture (or
    // av_image_check_size2) will take, and the preview never needs more than the canvas.
    if (
      await transcode(
        store,
        runner,
        proxy,
        ["-i", abs, "-frames:v", "1", "-vf", "scale='min(3840,iw)':-1"],
        signal,
      )
    )
      changed = true;
  }
  const poster = await store.prepareArtifact(`posters/${posterName(source)}`);
  if (!(await store.exists(poster))) {
    if (
      await transcode(
        store,
        runner,
        poster,
        ["-i", abs, "-frames:v", "1", "-vf", "scale=-2:360", "-q:v", "4"],
        signal,
      )
    )
      changed = true;
  }
  return changed;
}

/** Run ffmpeg writing to a temp sibling, then atomically rename onto `dest` only
 *  on a clean exit — so an interrupted/killed transcode (e.g. the app relaunching
 *  mid-encode) never leaves a corrupt file that later runs skip as "already
 *  done". Falls back to a direct write if the fs has no rename. Returns success. */
async function transcode(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  dest: string,
  midArgs: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const canRename = store.canRename;
  const dot = dest.lastIndexOf(".");
  const rand = Math.random().toString(36).slice(2, 8);
  const out = !canRename
    ? dest
    : dot < 0
      ? `${dest}.tmp-${rand}`
      : `${dest.slice(0, dot)}.tmp-${rand}${dest.slice(dot)}`;
  const r = await runner
    .run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...midArgs, out], signal)
    .catch(() => ({ code: -1, stdout: "", stderr: "" }));
  if (r.code !== 0 || !(await store.exists(out))) {
    console.warn(
      `[mediaProxy] ffmpeg failed dest=${dest} code=${r.code} stderr=${stderrExcerpt(r.stderr, 300)}`,
    );
    if (canRename) await store.remove(out).catch(() => undefined);
    return false;
  }
  if (canRename) {
    try {
      await store.rename(out, dest);
    } catch (e) {
      console.warn(`[mediaProxy] rename failed ${out} -> ${dest}: ${String(e)}`);
      await store.remove(out).catch(() => undefined);
      return false;
    }
  }
  return true;
}
