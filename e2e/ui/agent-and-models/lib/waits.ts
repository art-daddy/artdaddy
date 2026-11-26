// The waits a person feels, recorded per test. The same three calls as the shared helper being
// built for every QA lane (e2e/lib/timing: measure, startTimer, record), so moving to it is a
// change of one import. Until then each wait goes on the test's report (an annotation), on the
// run's output, and, when ARTDADDY_TIMING_FILE is set, as one JSON line in that file.
//
// Name a wait "agent: <what the person waits for> [<browser>]": stable, because it is the key a
// budget will be kept under.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

import { test } from "@playwright/test";

export interface TimingEntry {
  scenario: string;
  ms: number;
  machine: string;
  build: string;
  at: string;
}

export interface Timer {
  stop(): TimingEntry;
}

export function record(scenario: string, ms: number): TimingEntry {
  const entry: TimingEntry = {
    scenario,
    ms: Math.round(ms),
    machine: hostname(),
    build: process.env.ARTDADDY_BUILD ?? process.env.GITHUB_SHA ?? "local",
    at: new Date(Date.now() - ms).toISOString(),
  };
  test.info().annotations.push({ type: "wait", description: `${entry.scenario}: ${entry.ms} ms` });
  console.log(`[wait] ${entry.scenario}: ${entry.ms} ms`);
  const file = process.env.ARTDADDY_TIMING_FILE;
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function startTimer(scenario: string): Timer {
  const t0 = performance.now();
  let done = false;
  return {
    stop() {
      if (done) throw new Error(`the wait "${scenario}" was already recorded`);
      done = true;
      return record(scenario, performance.now() - t0);
    },
  };
}

/** Times `fn` and records it when it resolves. A wait that failed is never recorded as a fast one. */
export async function measure<T>(scenario: string, fn: () => T | PromiseLike<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  record(scenario, performance.now() - t0);
  return out;
}

/** The browser in a wait's name, as the shared helper asks. */
export function inBrowser(what: string): string {
  return `agent: ${what} [${test.info().project.name}]`;
}
