import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { WARMUP_TIMEOUT_MS, warmupForRun, type WarmupRunDeps } from "./nativeWarmup";

// vitest passes the project; only the list of files this run is about to execute is read from it.
interface RunProject {
  vitest: { state: { getPaths(): string[] } };
}

const writeLine = (line: string) => void process.stdout.write(`${line}\n`);

/** `overrides` replaces the real process, file system and clock: the tests drive the same code with fakes. */
export async function setupWith(
  project: RunProject,
  overrides: Partial<WarmupRunDeps> = {},
): Promise<void> {
  const log = overrides.log ?? writeLine;
  try {
    await warmupForRun({
      env: process.env,
      root: process.cwd(),
      runFiles: () => project.vitest.state.getPaths(),
      readText: (file) => {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return undefined;
        }
      },
      exists: existsSync,
      timeoutMs: WARMUP_TIMEOUT_MS,
      log,
      now: () => performance.now(),
      spawn: (program, args, options) =>
        spawn(program, args, { cwd: options.cwd, stdio: "inherit", windowsHide: true }),
      ...overrides,
    });
  } catch (error) {
    // The warm-up only saves the cases a rebuild: whatever goes wrong in it must never stop the run.
    try {
      log(
        `[smoke warm-up] skipped: unexpected error, the run goes on (${error instanceof Error ? error.message : "not an Error"})`,
      );
    } catch {
      // nothing left to tell
    }
  }
}

// Runs once, in the main process, before any worker starts: see nativeWarmup.ts for what it is for.
export default function setup(project: RunProject): Promise<void> {
  return setupWith(project);
}
