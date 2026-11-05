// A scripted ffmpeg and a scripted PC for the graphics chip's test: what each kind of command does, what the PC
// reports, and what the test leaves behind. Shared by the test's own suite and by the suites of what reads its answer.
import type { ChipDeps } from "../timeline/chipTest";
import { TEST_FRAMES } from "../timeline/chipTest";
import type { GraphicsAdapter, ProbeOutcome } from "../platform/host";

export const amd: GraphicsAdapter = { maker: "amd", device: "15bf", driver: "32.0.22024.4008" };
export const nvidia: GraphicsAdapter = { maker: "nvidia", device: "2504", driver: "551.23" };
export const intel: GraphicsAdapter = { maker: "intel", device: "9a49", driver: "31.0.101.4502" };

/** What ffmpeg says at the end of a compare pass: the count of frames and the overall score. */
export const ssimText = (all: number, frames = TEST_FRAMES) =>
  `frame=   ${frames} fps=120 q=-0.0 size=N/A time=00:00:01.00 bitrate=N/A speed=4x\n` +
  `[Parsed_ssim_2 @ 000001b7bc91ed00] SSIM Y:${all.toFixed(6)} (7.1) U:0.9 (9) V:0.9 (9) All:${all.toFixed(6)} (7.1)\n`;

/** How the scripted ffmpeg behaves. */
export interface Behaviour {
  chip?: "ok" | "fail" | "no_device" | "slow" | "busy" | "stopped";
  chipSsim?: number;
  chipFrames?: number;
  decodeFails?: boolean;
  referenceSsim?: number;
  /** How the compare of the processor's own reference goes wrong: it exits with an error, says nothing readable, or
   *  reports the wrong number of frames. */
  referenceCompare?: "fails" | "unreadable" | "short";
  /** The chip's encode fails at a frame rate above this (a limit of the chip that only an encode at that rate shows). */
  failsAboveFps?: number;
}

export function harness(
  adapters: GraphicsAdapter[],
  behaviour: Behaviour = {},
  now = { t: 1_700_000_000_000 },
) {
  const calls: { args: string[]; kind: string }[] = [];
  const removed: string[] = [];
  const made: string[] = [];
  const storage = new Map<string, string>();
  const ran = (stderr: string, code = 0): ProbeOutcome => ({
    kind: "ran",
    code,
    stdout: "",
    stderr,
    ms: 5,
  });
  const deps: ChipDeps = {
    adapters: async () => adapters,
    probe: async (args, options) => {
      calls.push({ args: [...args], kind: options.kind });
      if (options.kind.includes("encode")) {
        const codec = args[args.indexOf("-c:v") + 1];
        if (codec === "libx264") return ran("");
        const mode = behaviour.chip ?? "ok";
        if (mode === "busy") return { kind: "busy" };
        if (mode === "stopped") return { kind: "stopped" };
        if (mode === "slow") return { kind: "timeout" };
        if (mode === "no_device")
          return ran("[h264_nvenc] Cannot load nvcuda.dll\nNo capable devices found", 1);
        if (mode === "fail") return ran("Error while opening encoder", 1);
        const fps = Number(args[args.indexOf("-r") + 1]);
        if (behaviour.failsAboveFps !== undefined && fps > behaviour.failsAboveFps)
          return ran("Error while opening encoder", 1);
        return ran("");
      }
      // a decode-and-compare pass: the chip's file, or the processor's reference
      const reference = args.some((part) => part.includes("-ref.mp4"));
      if (reference) {
        if (behaviour.referenceCompare === "fails") return ran("Invalid data found", 1);
        if (behaviour.referenceCompare === "unreadable") return ran("nothing useful here");
        if (behaviour.referenceCompare === "short")
          return ran(ssimText(behaviour.referenceSsim ?? 0.79, TEST_FRAMES - 1));
        return ran(ssimText(behaviour.referenceSsim ?? 0.79));
      }
      if (behaviour.decodeFails) return ran("Invalid data found when processing input", 1);
      return ran(ssimText(behaviour.chipSsim ?? 0.87, behaviour.chipFrames ?? TEST_FRAMES));
    },
    files: {
      dir: async () => "C:/cache/chip-test",
      mkdir: async (path) => void made.push(path),
      remove: async (path) => void removed.push(path),
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    },
    now: () => now.t,
    release: "artdaddy@0.0.0-test",
  };
  return { deps, calls, removed, made, storage, now };
}
