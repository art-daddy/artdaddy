// While an export runs: how far it is and how long is left, as the dialog says it, and what happens when the
// person puts the dialog away and comes back to it.
import path from "node:path";

import {
  cardState,
  dialogState,
  exportProcesses,
  fileState,
  openExportDialog,
  pressInDialog,
  startExport,
  waitForEnd,
} from "../journey.mjs";
import { decodesCleanly, endCardSeconds, probe } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";
import { waitForPercent } from "./02-cancel.mjs";

/** "about 4 min left", "about 40 s left", "under a minute left" → seconds (the top of a range), or null. */
export function secondsSaid(text) {
  const t = text ?? "";
  if (/under a minute left/i.test(t)) return 60;
  let total = 0;
  let any = false;
  for (const [, n, unit] of t.matchAll(/(\d+)\s*(h|min|s)\b/g)) {
    any = true;
    total += Number(n) * (unit === "h" ? 3600 : unit === "min" ? 60 : 1);
  }
  return any && /left/.test(t) ? total : null;
}

export const scenarios = [
  {
    name: "progress-and-time-left",
    group: "progress",
    async run(t) {
      const seconds = 60;
      await projectWith(t, "progress", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const file = path.join(outDir(t), "progress.mp4");
      await openExportDialog(t.d);
      const { savedAt } = await startExport(t.d, t.pid, file);
      const samples = [];
      const end = await waitForEnd(t.d, {
        ms: 900_000,
        every: 250,
        onSample: (s) => samples.push({ at: performance.now() - savedAt, status: s.status ?? "", pace: s.pace ?? "", bar: s.bar }),
      });
      const total = performance.now() - savedAt;
      t.time("export.progress.save-to-done", total, { timelineSeconds: seconds, resolution: "1920x1080" });
      t.check("the export finished", end.status === "Done", end.all);

      const firstPercent = samples.find((s) => /\d+%/.test(s.status));
      const firstLeft = samples.find((s) => secondsSaid(s.pace) !== null);
      const firstFinishing = samples.find((s) => /Finishing/.test(s.pace));
      if (firstPercent) t.time("export.progress.save-to-first-percent", firstPercent.at);
      if (firstLeft) t.time("export.progress.save-to-first-time-left", firstLeft.at, { said: firstLeft.pace });
      t.check("a percentage appears while it renders", !!firstPercent, samples.slice(0, 8).map((s) => s.status).join(" | "));
      const percents = samples.map((s) => Number(/(\d+)%/.exec(s.status)?.[1] ?? NaN)).filter((n) => Number.isFinite(n));
      const middle = [...new Set(percents.filter((n) => n > 0 && n < 100))];
      t.check("it moves through percentages in between (not 0 then 100)", middle.length >= 3, middle.join(","));
      const backwards = percents.findIndex((n, i) => i > 0 && n < percents[i - 1]);
      t.check("the percentage never goes backwards", backwards === -1, backwards === -1 ? "" : `${percents[backwards - 1]} then ${percents[backwards]}`);
      t.check("the speed is shown while it renders (as a multiple of the video's length)", samples.some((s) => /\d+(\.\d)?×/.test(s.pace)), samples.map((s) => s.pace).filter(Boolean).slice(0, 5).join(" | "));
      t.check("a time left is shown before it ends", !!firstLeft || !!firstFinishing, samples.map((s) => s.pace).filter(Boolean).slice(-6).join(" | "));
      if (firstLeft) {
        const said = secondsSaid(firstLeft.pace);
        const actual = (total - firstLeft.at) / 1000;
        // "under a minute left" is a range: it holds when less than a minute was left. A figure is a figure.
        const held = /under a minute/.test(firstLeft.pace) ? actual <= 60 : actual <= said * 2 && actual >= said / 2;
        t.note(`first time left: "${firstLeft.pace}" at ${(firstLeft.at / 1000).toFixed(1)} s; it really took ${actual.toFixed(1)} s more`);
        t.check("the first time left it showed was true (within half to twice a figure; under a minute meant under a minute)", held, `${firstLeft.pace} vs ${actual.toFixed(1)} s`);
      }
      const waits = samples.filter((s) => /Saving|Checking|Finishing/i.test(`${s.status} ${s.pace}`));
      if (waits.length) t.time("export.progress.saving-and-checking", waits[waits.length - 1].at - waits[0].at);
      const info = probe(file);
      t.check("the file is the whole timeline plus the end card", near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      await pressInDialog(t.d, "Close");
    },
  },
  {
    name: "hide-the-dialog-then-come-back",
    group: "progress",
    async run(t) {
      const seconds = 40;
      await projectWith(t, "hide", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const out = outDir(t);
      const name = "hidden.mp4";
      const file = path.join(out, name);
      await openExportDialog(t.d);
      const { savedAt } = await startExport(t.d, t.pid, file);
      await waitForPercent(t.d, 10);

      await pressInDialog(t.d, "Hide");
      await t.sleep(600);
      let s = await dialogState(t.d);
      t.check("Hide puts the dialog away", !s.open);
      t.check("the export keeps running", exportProcesses().length >= 1);
      const card = await cardState(t.d);
      t.check("the card above the chat shows it with how far it is", !!card && card.text.includes(name) && card.status.some((x) => /\d+%/.test(x)), card?.text ?? "no card");
      t.check("nothing says it is done while it runs", !(card?.text ?? "").includes("Exported") && !fileState(file));

      // Back to the dialog: it rejoins the running export rather than offering a second one.
      await openExportDialog(t.d);
      s = await dialogState(t.d);
      t.check("opening Export again shows the running export, not the settings", !s.settings && /Rendering|Preparing|%/.test(s.status ?? ""), s.all);
      t.check("and offers Hide and Cancel render", s.buttons.includes("Hide") && s.buttons.includes("Cancel render"), s.buttons.join(", "));
      // Escape is a person's other way to put it away: it hides, it does not cancel.
      await t.d.key("Escape");
      await t.sleep(600);
      s = await dialogState(t.d);
      t.check("Escape puts it away too", !s.open);
      t.check("and the export is still running after Escape", exportProcesses().length >= 1);

      // It finishes while the dialog is away.
      const end = Date.now() + 600_000;
      let done = null;
      while (Date.now() < end) {
        const c = await cardState(t.d);
        if ((c?.text ?? "").includes(`Exported “${name}”`)) {
          done = c.text;
          break;
        }
        if (c?.tryAgain.includes(`try again ${name}`)) break;
        await t.sleep(300);
      }
      t.time("export.hidden.save-to-done", performance.now() - savedAt, { timelineSeconds: seconds });
      t.check("the card says it was exported", !!done, done ?? "");
      t.check("and the file is there", !!fileState(file));
      await openExportDialog(t.d);
      s = await dialogState(t.d);
      t.check("opening Export afterwards offers the settings again", s.settings && !s.status, s.all);
      t.check("and lists the finished export in the queue as Completed", s.queue.some((r) => r.name === name && /Completed/.test(r.text)), JSON.stringify(s.queue));
      const info = probe(file);
      t.check("the file is the whole timeline plus the end card", near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      const decoded = decodesCleanly(file);
      t.check("every frame decodes without an error", decoded.ok, decoded.errors);
      await pressInDialog(t.d, "Cancel");
    },
  },
];
