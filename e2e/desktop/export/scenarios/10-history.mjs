// What the app remembers about exports across a restart: the queue shows the exports of this session, and the
// time an export is expected to take is worked out from the earlier exports on this PC (src/store/exportJob.ts,
// the calibration history). A finished export must not come back after a restart, and must not teach the
// estimate a time it never took.
//
// The case: a person exports, moves the file somewhere else, and exports the same edit again (the same bytes, so
// the library already knows the video by another path), then quits and starts the app again later.
import { renameSync } from "node:fs";
import path from "node:path";

import { cardState, dialogState, openExportDialog, openMenu, pressInDialog, startExport, waitForEnd } from "../journey.mjs";
import { sha256 } from "../media.mjs";
import { outDir, projectWith } from "./01-dialog.mjs";

const SECONDS = 12;

/** Found by this lane on 26 Nov: an export whose file has the same bytes as one the library already holds (the same
 *  edit exported again; exports are byte-for-byte repeatable) is never marked finished in the app's export journal
 *  (src/timeline/exportQueue.ts: the journal entry is completed only once the library registers the file, and
 *  registering bytes it already holds fails), so every later start takes it over again: the queue lists it, the card
 *  announces it, timed from when it began to that start, and that time is learned as what such an export takes. */
const STALE_EXPORT = "An edit exported again comes back after every restart and teaches the time estimate a time it never took";

const samplesOf = (d) =>
  d.eval(`JSON.parse(localStorage.getItem('artdaddy-export-calibration-v4') ?? '[]').map((c) => ({ seconds: c.workload?.durationSeconds ?? null, elapsed: c.elapsedSeconds ?? null }))`);

/** "about 4 h 45 min", "about 40 s", "under a minute" → seconds. */
function secondsOf(text) {
  if (/under a minute/.test(text)) return 59;
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*(h|min|s)\b/g)) total += Number(n) * (unit === "h" ? 3600 : unit === "min" ? 60 : 1);
  return total || null;
}

async function exportTo(t, file) {
  await openExportDialog(t.d);
  const { savedAt } = await startExport(t.d, t.pid, file);
  let expected = null;
  const end = await waitForEnd(t.d, {
    ms: 300_000,
    every: 200,
    onSample: () => {
      if (expected === null)
        t.d.eval(`document.querySelector('[data-testid=export-card-expected]')?.innerText ?? null`).then((v) => (expected ??= v), () => {});
    },
  });
  const took = (performance.now() - savedAt) / 1000;
  await pressInDialog(t.d, "Close");
  return { end, took, expected };
}

export const scenarios = [
  {
    name: "same-export-again-after-moving-the-first-file",
    group: "history",
    async run(t) {
      const label = "history";
      await projectWith(t, label, [{ file: t.fixtures.busy(SECONDS), at: 0 }]);
      const out = outDir(t);
      const first = path.join(out, "first.mp4");
      const second = path.join(out, "second.mp4");
      const one = await exportTo(t, first);
      t.check("the first export finishes", one.end.status === "Done", one.end.status ?? "");
      const moved = path.join(out, "moved away.mp4");
      renameSync(first, moved);
      const two = await exportTo(t, second);
      t.check("the same edit exported again finishes", two.end.status === "Done", two.end.status ?? "");
      t.note(`the two files are ${(await sha256(moved)) === (await sha256(second)) ? "the same bytes" : "different bytes"}; they took ${one.took.toFixed(1)} s and ${two.took.toFixed(1)} s`);
      await t.sleep(5000);
      const learnedBefore = (await samplesOf(t.d)).filter((s) => s.seconds === SECONDS).length;

      // Quit (nothing is running, so nothing is asked) and start again.
      await openMenu(t.d, "File", "Exit");
      t.check("the app quits", await t.app.waitExit(30_000));
      const start = await t.app.launch("after quit");
      t.time("app.relaunch.to-menu", start.ms, { warm: true });
      await t.d.clickText(`sweep_qa-export ${label}`, { sel: "button", ms: 20_000 });
      await t.d.waitFor("!!document.querySelector('[data-track-id]')", 30_000);
      await t.sleep(3000);
      await openExportDialog(t.d);
      const s = await dialogState(t.d);
      await t.d.key("Escape");
      t.knownBug(STALE_EXPORT, "after the restart, the exports that finished before it are not listed again", !s.queue.some((r) => r.name === "first.mp4" || r.name === "second.mp4"), JSON.stringify(s.queue));
      const card = await cardState(t.d);
      t.knownBug(STALE_EXPORT, "and the card above the chat does not announce them again", !/Exported “(first|second)\.mp4”/.test(card?.text ?? ""), card?.text ?? "no card");
      // What the app learned at the restart: no new time for this edit, since nothing was exported.
      const learned = (await samplesOf(t.d)).filter((x) => x.seconds === SECONDS);
      const longest = Math.max(one.took, two.took);
      t.knownBug(STALE_EXPORT, "the restart teaches the time estimate nothing", learned.length === learnedBefore, `${learnedBefore} sample(s) of this edit before the restart, ${learned.length} after: ${learned.map((x) => `${x.elapsed?.toFixed(1)} s`).join(", ")} (the exports took ${one.took.toFixed(1)} s and ${two.took.toFixed(1)} s, longest ${longest.toFixed(1)} s)`);

      // The next export of this edit: what it is expected to take, against what it takes.
      const three = await exportTo(t, path.join(out, "third.mp4"));
      t.check("the next export finishes", three.end.status === "Done", three.end.status ?? "");
      const said = three.expected ? secondsOf(three.expected) : null;
      t.note(`the card said "${three.expected ?? "(nothing)"}"; it took ${three.took.toFixed(1)} s`);
      t.time("export.history.third.save-to-done", three.took * 1000, { timelineSeconds: SECONDS, expected: three.expected });
      if (said !== null)
        t.check("what it is expected to take is within five times what it takes", said <= Math.max(5 * three.took, 60), `${three.expected} vs ${three.took.toFixed(1)} s`);
    },
  },
];
