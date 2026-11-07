// Hardware decode for the agent's looks (inspect_media and inspect_timeline frames).
//
// Why. A look decodes forward from the last keyframe before its frame. On a source with a long gap that is
// minutes of video, and no way of seeking avoids it. Measured on a 1 GB 1080p HEVC phone clip, decoding to a
// frame 5 minutes in took 92 s in software and 22 s on the GPU (4.3x), and the frame was byte-identical:
// H.264 and HEVC decoding is exact by the standard, so the GPU may change how long a look takes and nothing
// about what it shows.
//
// The rule that keeps that true on every PC: the hardware decoder is used only for a stream SHAPE (OS, codec,
// pixel format, size) this PC has proved to decode to the same bytes as the software decoder, and a hardware
// run that does not succeed is redone in software. A driver may cost time. It may never cost a different
// picture, or a look that fails when software would have worked. Exports are not touched: this is looks only.
import { hostInfo, type HostOs } from "../platform/host";
import type { CommandResult, CommandRunner } from "./command";

/** The hardware decoder ffmpeg is asked for on each OS. Null: software only (Linux needs a device path and
 *  cannot be proved here, so it stays off until it is). */
export function accelFor(os: HostOs): string | null {
  switch (os) {
    case "windows":
      return "d3d11va";
    case "macos":
      return "videotoolbox";
    default:
      return null;
  }
}

/** Codecs whose hardware decode is exact by their standard and common enough to matter. */
const HW_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"]);
/** Frames the proof compares, from the start of the file. */
const PROOF_FRAMES = 6;
/** A hardware proof run that has not answered by now is a hung driver, not a slow one. */
const PROOF_LIMIT_MS = 20_000;
/** How long a verdict is trusted. A failure is retried sooner: drivers get fixed. */
const OK_TTL_MS = 30 * 24 * 3_600_000;
const BAD_TTL_MS = 3 * 24 * 3_600_000;
const STORE_KEY = "artdaddy-look-decode-v1";
const MAX_VERDICTS = 64;

type LookVideo = Record<string, unknown> | null | undefined;
type Verdict = { ok: boolean; at: number };
type Store = Pick<Storage, "getItem" | "setItem">;

/** One checksum per frame from ffmpeg's `-f framemd5` output; header lines and blanks are ignored. */
export function parseFrameMd5(text: string): string[] {
  const sums: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sum = line.split(",").pop()?.trim() ?? "";
    if (sum) sums.push(sum);
  }
  return sums;
}

export interface LookDecoderDeps {
  os: () => HostOs;
  storage: Store | null;
  now: () => number;
}

export interface LookAttempt<T> {
  ok: boolean;
  value: T;
}

export interface LookDecoder {
  /** Whether this OS has a hardware decoder to ask for at all. False: skip every probe and every proof. */
  enabled(): boolean;
  /** The ffmpeg input options to put before `-i` for this source: `[]` is software. The first time a stream
   *  shape is seen on this PC it is proved (a moment, once). */
  flags(
    runner: CommandRunner,
    src: string,
    video: LookVideo,
    signal?: AbortSignal,
  ): Promise<string[]>;
  /** Remember that a hardware look of this shape failed where software then worked. */
  demote(video: LookVideo): void;
  /** Make a look with the flags; if hardware was used and the look did not succeed, make it again in
   *  software, and remember the shape as bad only when software then worked (otherwise it was the file). */
  run<T>(
    runner: CommandRunner,
    src: string,
    video: LookVideo,
    signal: AbortSignal | undefined,
    attempt: (flags: string[]) => Promise<LookAttempt<T>>,
  ): Promise<T>;
}

export function createLookDecoder(deps: LookDecoderDeps): LookDecoder {
  const verdicts = new Map<string, Verdict>();
  const proofs = new Map<string, Promise<boolean | null>>();
  let loaded = false;

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed: unknown = JSON.parse(deps.storage?.getItem(STORE_KEY) ?? "null");
      if (parsed === null || typeof parsed !== "object") return;
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = v as Partial<Verdict> | null;
        if (entry && typeof entry.ok === "boolean" && typeof entry.at === "number")
          verdicts.set(key, { ok: entry.ok, at: entry.at });
      }
    } catch {
      /* storage disabled or holding junk: start with no verdicts */
    }
  };
  const save = (): void => {
    try {
      const newest = [...verdicts.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_VERDICTS);
      deps.storage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(newest)));
    } catch {
      /* a verdict kept only for this session is still a verdict */
    }
  };
  const verdictFor = (key: string): Verdict | undefined => {
    load();
    const v = verdicts.get(key);
    if (!v) return undefined;
    return deps.now() - v.at < (v.ok ? OK_TTL_MS : BAD_TTL_MS) ? v : undefined;
  };
  const record = (key: string, ok: boolean): void => {
    load();
    verdicts.set(key, { ok, at: deps.now() });
    save();
  };

  const keyFor = (video: LookVideo): { accel: string; key: string } | null => {
    const os = deps.os();
    const accel = accelFor(os);
    if (!accel || !video) return null;
    const codec = typeof video.codec === "string" ? video.codec.toLowerCase() : "";
    const pix = typeof video.pix_fmt === "string" ? video.pix_fmt : "";
    if (!HW_CODECS.has(codec) || !pix) return null;
    return {
      accel,
      key: `${os}|${accel}|${codec}|${pix}|${String(video.width ?? "?")}x${String(video.height ?? "?")}`,
    };
  };

  /** Run the hardware side of a proof, giving up on a hung driver. Null in `timedOut` means the caller stopped. */
  const runLimited = async (
    runner: CommandRunner,
    args: string[],
    signal: AbortSignal | undefined,
  ): Promise<{ result: CommandResult; timedOut: boolean }> => {
    const own = new AbortController();
    const onParent = (): void => own.abort();
    if (signal?.aborted) own.abort();
    else signal?.addEventListener("abort", onParent);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      own.abort();
    }, PROOF_LIMIT_MS);
    try {
      return { result: await runner.run("ffmpeg", args, own.signal), timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParent);
    }
  };

  /** True: identical bytes. False: not usable. Null: nothing can be said (the file is unreadable, or Stop). */
  const prove = async (
    runner: CommandRunner,
    src: string,
    video: NonNullable<LookVideo>,
    accel: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean | null> => {
    // Both runs compare in the source's OWN pixel format, so a hardware repack (nv12, p010) is not a difference.
    const tail = [
      "-i",
      src,
      "-frames:v",
      String(PROOF_FRAMES),
      "-vf",
      `format=${String(video.pix_fmt)}`,
      "-f",
      "framemd5",
      "-",
    ];
    // Software first: if it cannot decode the file, the file is the problem and the hardware is not to blame.
    const soft = await runner.run("ffmpeg", ["-v", "error", ...tail], signal);
    if (signal?.aborted) return null;
    const softSums = soft.code === 0 ? parseFrameMd5(soft.stdout) : [];
    if (softSums.length === 0) return null;
    const hard = await runLimited(runner, ["-v", "error", "-hwaccel", accel, ...tail], signal);
    if (signal?.aborted && !hard.timedOut) return null;
    const hardSums = hard.result.code === 0 ? parseFrameMd5(hard.result.stdout) : [];
    return hardSums.length === softSums.length && hardSums.every((sum, i) => sum === softSums[i]);
  };

  const flags = async (
    runner: CommandRunner,
    src: string,
    video: LookVideo,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    if (signal?.aborted) return [];
    const shape = keyFor(video);
    if (!shape || !video) return [];
    const known = verdictFor(shape.key);
    if (known) return known.ok ? ["-hwaccel", shape.accel] : [];
    let pending = proofs.get(shape.key);
    if (!pending) {
      pending = prove(runner, src, video, shape.accel, signal).then(
        (verdict) => {
          if (verdict !== null) record(shape.key, verdict);
          proofs.delete(shape.key);
          return verdict;
        },
        () => {
          proofs.delete(shape.key);
          return null;
        },
      );
      proofs.set(shape.key, pending);
    }
    return (await pending) === true ? ["-hwaccel", shape.accel] : [];
  };

  return {
    enabled: () => accelFor(deps.os()) !== null,
    flags,
    demote(video: LookVideo): void {
      const shape = keyFor(video);
      if (shape) record(shape.key, false);
    },
    async run<T>(
      runner: CommandRunner,
      src: string,
      video: LookVideo,
      signal: AbortSignal | undefined,
      attempt: (flags: string[]) => Promise<LookAttempt<T>>,
    ): Promise<T> {
      const used = await flags(runner, src, video, signal);
      const first = await attempt(used);
      if (first.ok || used.length === 0 || signal?.aborted) return first.value;
      const second = await attempt([]);
      if (second.ok) this.demote(video);
      return second.value;
    },
  };
}

let shared: LookDecoder | null = null;

/** The decoder every look uses in the app: this PC's verdicts, kept in the webview's storage. */
export function lookDecoder(): LookDecoder {
  if (!shared) {
    shared = createLookDecoder({
      os: () => hostInfo().os,
      storage: (() => {
        try {
          return typeof localStorage === "undefined" ? null : localStorage;
        } catch {
          return null;
        }
      })(),
      now: () => Date.now(),
    });
  }
  return shared;
}
