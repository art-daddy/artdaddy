// Shared timing helper for the QA lanes: how long a user waits, recorded as one JSON line per measurement.
//
// INTERFACE (stable: every QA lane builds on it; add to it, never rename or change a part)
//
//   Playwright specs (e2e/ui/):     import { measure, startTimer, record } from "../lib/timing";
//   Node desktop lanes (e2e/desktop/): import { measure, startTimer, record } from "../lib/timing.mjs";
//   (one folder deeper, in e2e/ui/<area>/ or e2e/desktop/<area>/: "../../lib/timing" and "../../lib/timing.mjs")
//
//   const value = await measure(scenario, async () => { ...start the wait, await its end... });
//       Times the function and records the wait when it resolves; returns what the function returned. If it throws,
//       nothing is recorded and the error goes on. So put the proof that the wait really ended (the file is there,
//       the picture is up) INSIDE the function: a wait that failed must never count as a fast one.
//   const wait = startTimer(scenario); ...; wait.stop();
//       For a wait that starts in one place and ends in another. stop() records it, once (a second stop throws).
//       A timer that is never stopped records nothing.
//   record(scenario, ms);
//       A wait timed by another clock: the app's own performance marks, its process age. Use it when the app can time
//       the wait more exactly than the test can see it from outside.
//
// Each measurement appends one line to the results file, for example
//   {"scenario":"export: 1 s timeline to a finished mp4 (dev build)","ms":4210,"machine":"LAB-PC",
//    "build":"ce2f1195fa89de0a2a4d47c77313b756ed0d5b94","at":"2026-11-26T20:30:00.000Z"}
//   ms: whole milliseconds. machine: the host name. build: ARTDADDY_BUILD if set, else the checkout's commit, with
//   "+dirty" when tracked files were changed. at: when the wait began, UTC.
//
// The results file: ARTDADDY_TIMING_FILE when set (the nightly run sets a fresh one per run), else
// <system temp folder>/artdaddy-timing/timing-<local date>.jsonl. Each process appends whole lines.
//
// Naming a scenario. The name is the key of the wait's budget in e2e/timing-budgets.json, so keep it stable and unique:
//   "<area>: <what the user waits for, in their words> (<what changes the number>)"
// e.g. "import: 3 clips to their thumbnails [chromium]". A spec that runs in several browsers puts the browser in the
// name (`[${test.info().project.name}]`); a desktop lane says "(dev build)". Renaming a scenario orphans its budget.
//
// Judging: scripts/qa/timingBudgets.mjs compares a results file with e2e/timing-budgets.json (PASS, SLOW, NEW or
// MISSING per wait) and writes the budget of a new wait from a few runs on the lab PC. Its header says how.
export { BUILD_ENV, TIMING_FILE_ENV, measure, record, startTimer, timingFile } from "./timing.mjs";
export type { Timer, TimingEntry } from "./timing.mjs";
