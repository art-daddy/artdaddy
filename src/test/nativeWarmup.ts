import type { ChildProcess } from "node:child_process";
import path from "node:path";

import { NATIVE_RENDER_PROGRAM, nativeRenderCargoArgs } from "./nativeRenderCommand";

// Why this exists. Every native smoke case runs `cargo test --lib <test>`. Right after the pre-push
// hook's own `cargo test` the app crate's test program is out of date, so the first case rebuilds
// it (about 11 s on a quiet PC) inside its own 180 s limit, under the load of the whole lane's
// workers and 4K encodes. That case timed out in the hook and then failed the push. Building the
// program once before any test starts takes the rebuild out of every case's deadline.
//
// What it must never do: fail or slow a run that has nothing to do with it (an opt-in single file,
// the Playwright rotation probe with its 120 s limit), or take the lane down when the build goes
// wrong. A failed or missing cargo is logged and the cases then behave exactly as they did before.

const TAG = "[smoke warm-up]";
export const WARMUP_OPT_OUT = "ARTDADDY_SMOKE_NO_WARMUP";
// Generous on purpose: a cold build takes minutes, and nothing is waiting on a deadline here.
export const WARMUP_TIMEOUT_MS = 30 * 60_000;
// The calls a smoke file makes to start a native case: the harness entry, or the shared command.
const NATIVE_MARKERS = ["runNativeRenderSequence", "nativeRenderCommand"];

export type WarmChild = Pick<ChildProcess, "once" | "kill">;

export interface WarmDeps {
  cwd: string;
  timeoutMs: number;
  log: (line: string) => void;
  now: () => number;
  spawn: (program: string, args: string[], options: { cwd: string }) => WarmChild;
}

export interface WarmOutcome {
  state: "built" | "no-cargo" | "failed" | "timed-out";
  seconds: number;
  code?: number | null;
}

export function mentionsNativeCases(text: string): boolean {
  return NATIVE_MARKERS.some((marker) => text.includes(marker));
}

export interface WarmupDecisionInput {
  env: Record<string, string | undefined>;
  hasCrate: boolean;
  /** undefined when the run's file list is not known. */
  runFiles: readonly string[] | undefined;
  /** undefined when a file cannot be read. */
  readText: (file: string) => string | undefined;
}

/** Warm unless the opt-out is set, there is no crate, or every file of the run is known to be unable to start a native case. */
export function warmupDecision(input: WarmupDecisionInput): { warm: boolean; reason: string } {
  if (input.env[WARMUP_OPT_OUT] === "1") return { warm: false, reason: `${WARMUP_OPT_OUT}=1` };
  if (!input.hasCrate) return { warm: false, reason: "no src-tauri/Cargo.toml here" };
  if (!input.runFiles) return { warm: true, reason: "the run's file list is unknown" };
  for (const file of input.runFiles) {
    const text = input.readText(file);
    if (text === undefined) return { warm: true, reason: `${file} could not be read` };
    if (mentionsNativeCases(text))
      return { warm: true, reason: "the run holds native render cases" };
  }
  return { warm: false, reason: "no file of this run starts a native render case" };
}

export function warmNativeTestProgram(deps: WarmDeps): Promise<WarmOutcome> {
  const args = nativeRenderCargoArgs("build");
  const started = deps.now();
  const elapsed = () => Math.round((deps.now() - started) / 100) / 10;
  deps.log(
    `${TAG} building the native test program once, before any case starts: ` +
      `${NATIVE_RENDER_PROGRAM} ${args.join(" ")} (in src-tauri)`,
  );
  return new Promise<WarmOutcome>((resolve) => {
    let timedOut = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Node reports a spawn that fails with an 'error' and then also closes the child (code -4058 on
    // Windows): the first word is the one that counts.
    const finish = (state: WarmOutcome["state"], code?: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const seconds = elapsed();
      const outcome: WarmOutcome = { state, seconds, code };
      deps.log(
        state === "built"
          ? `${TAG} native test program ready in ${seconds.toFixed(1)} s`
          : state === "no-cargo"
            ? `${TAG} cargo not found on PATH: nothing to build, the native render cases will fail as they do without this step`
            : state === "timed-out"
              ? `${TAG} gave up after ${seconds.toFixed(1)} s and stopped cargo: the native cases build it themselves, under their own limit`
              : `${TAG} the build ended with exit code ${code ?? "none"} after ${seconds.toFixed(1)} s: the native cases report their own error`,
      );
      resolve(outcome);
    };
    let child: WarmChild;
    try {
      child = deps.spawn(NATIVE_RENDER_PROGRAM, args, { cwd: deps.cwd });
    } catch {
      finish("failed");
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, deps.timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? "no-cargo" : "failed"),
    );
    child.once("close", (code: number | null) =>
      finish(timedOut ? "timed-out" : code === 0 ? "built" : "failed", code),
    );
  });
}

export interface WarmupRunDeps extends Omit<WarmDeps, "cwd"> {
  env: Record<string, string | undefined>;
  root: string;
  /** The files vitest is about to run; may throw. */
  runFiles: () => readonly string[];
  readText: (file: string) => string | undefined;
  exists: (file: string) => boolean;
}

export async function warmupForRun(
  deps: WarmupRunDeps,
): Promise<{ warmed: boolean; reason: string; outcome?: WarmOutcome }> {
  const crate = path.resolve(deps.root, "src-tauri");
  let runFiles: readonly string[] | undefined;
  try {
    const listed = deps.runFiles();
    runFiles = Array.isArray(listed) ? listed : undefined;
  } catch {
    runFiles = undefined;
  }
  const decision = warmupDecision({
    env: deps.env,
    hasCrate: deps.exists(path.join(crate, "Cargo.toml")),
    runFiles,
    readText: (file) => {
      try {
        return deps.readText(file);
      } catch {
        return undefined;
      }
    },
  });
  if (!decision.warm) {
    deps.log(`${TAG} skipped: ${decision.reason}`);
    return { warmed: false, reason: decision.reason };
  }
  const outcome = await warmNativeTestProgram({ ...deps, cwd: crate });
  return { warmed: true, reason: decision.reason, outcome };
}
