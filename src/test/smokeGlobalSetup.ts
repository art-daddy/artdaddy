import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { WARMUP_TIMEOUT_MS, warmupForRun } from "./nativeWarmup";

// vitest passes the project; only the list of files this run is about to execute is read from it.
interface RunProject {
  vitest: { state: { getPaths(): string[] } };
}

// Runs once, in the main process, before any worker starts: see nativeWarmup.ts for what it is for.
export default async function setup(project: RunProject): Promise<void> {
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
    log: (line) => void process.stdout.write(`${line}\n`),
    now: () => performance.now(),
    spawn: (program, args, options) =>
      spawn(program, args, { cwd: options.cwd, stdio: "inherit", windowsHide: true }),
  });
}
