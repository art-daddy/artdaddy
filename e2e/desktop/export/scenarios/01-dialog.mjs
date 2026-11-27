// The Export dialog through to the delivered file: the settings a person can change, Save As (cancelled and
// answered), and the file they get, judged on its streams, its length and pictures decoded from it.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  canvas,
  dialogState,
  fileState,
  importFiles,
  openExportDialog,
  place,
  pressInDialog,
  saveAs,
  startExport,
  waitForEnd,
} from "../journey.mjs";
import { colourAt, decodesCleanly, endCardSeconds, isColour, partialsIn, probe, sha256 } from "../media.mjs";

export const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

/** A project holding `clips` (fixture files) one after another on v1. */
export async function projectWith(t, label, clips) {
  const p = await t.project(label);
  const lib = await importFiles(t.d, p, [...new Set(clips.map((c) => c.file))]);
  for (const c of clips) await place(t.d, p, lib[path.basename(c.file)], "v1", c.at);
  return { p, canvas: await canvas(t.d) };
}

export function outDir(t, name = "out") {
  const out = path.join(t.dir, name);
  mkdirSync(out, { recursive: true });
  return out;
}

export const scenarios = [
  {
    name: "dialog-to-file",
    group: "dialog",
    async run(t) {
      const { canvas: cv } = await projectWith(t, "dialog", [
        { file: t.fixtures.red(), at: 0 },
        { file: t.fixtures.blue(), at: 90 },
      ]);
      t.check("the timeline is two 3 s clips on a 1920x1080, 30 fps canvas", cv.width === 1920 && cv.height === 1080 && cv.fps === 30 && cv.frames === 180, JSON.stringify(cv));

      t.time("export.dialog.open", await openExportDialog(t.d));
      let s = await dialogState(t.d);
      const busy = (rows) => rows.filter((r) => !/Completed|Cancelled|Failed|couldn't|wrong|closed/.test(r.text));
      t.check("the dialog opens on its settings, with nothing rendering", s.settings && !s.status && busy(s.queue).length === 0, s.all);
      const rowsBefore = JSON.stringify(s.queue);

      // Save As, cancelled: nothing may start.
      await pressInDialog(t.d, "Export");
      const cancelled = saveAs(t.pid, "", { cancel: true });
      t.check("Save As opens, suggesting the project's title as the name", cancelled.ok && cancelled.suggested === "sweep_qa-export dialog", JSON.stringify(cancelled));
      await t.sleep(1000);
      s = await dialogState(t.d);
      t.check("cancelling Save As starts nothing: the settings stay and the queue is as it was", s.settings && !s.status && JSON.stringify(s.queue) === rowsBefore, s.all);

      // Save As, answered.
      const out = outDir(t);
      const file = path.join(out, "dialog to file.mp4");
      const { answer, savedAt } = await startExport(t.d, t.pid, file);
      t.note(`Save As opened in "${answer.folder}" suggesting "${answer.suggested}"`);
      let doneWithoutFile = false;
      const seen = [];
      const end = await waitForEnd(t.d, {
        ms: 120_000,
        onSample: (x) => {
          const said = (x.status ?? "").replace(/\d+%/, "N%");
          if (said && seen[seen.length - 1] !== said) seen.push(said);
          if (x.status === "Done" && !fileState(file)) doneWithoutFile = true;
        },
      });
      t.time("export.short.save-to-done", performance.now() - savedAt, { timelineSeconds: 6, resolution: "1920x1080" });
      t.note(`the dialog said, in order: ${seen.join(" → ")}`);
      t.check("the dialog says Done and names the file where it was saved", end.status === "Done" && end.saved === `Saved to ${file}`, end.saved ?? end.all);
      t.check("it did not say Done before the file was there", !doneWithoutFile);
      t.check("the queue lists it as Completed", end.queue.some((r) => r.name === "dialog to file.mp4" && /Completed/.test(r.text)), JSON.stringify(end.queue));

      const info = probe(file);
      const card = endCardSeconds(1920, 1080);
      t.check("the file has an H.264 picture and an AAC sound", info.video?.codec === "h264" && info.audio?.codec === "aac", JSON.stringify(info.streams));
      t.check("the picture is the project's: 1920x1080 at 30 fps", info.video?.width === 1920 && info.video?.height === 1080 && near(info.video?.fps, 30, 0.01), JSON.stringify(info.video));
      t.check("its length is the timeline's 6 s plus the end card", near(info.duration, 6 + card, 0.15), `${info.duration} s (end card ${card} s)`);
      const at15 = colourAt(file, 1.5);
      const at45 = colourAt(file, 4.5);
      const tail = colourAt(file, 6 + card / 2);
      t.check("1.5 s in shows the first clip (red)", isColour(at15, "red"), at15.join(","));
      t.check("4.5 s in shows the second clip (blue)", isColour(at45, "blue"), at45.join(","));
      t.check("after the clips comes the end card, not a clip", !isColour(tail, "red") && !isColour(tail, "blue"), tail.join(","));
      const decoded = decodesCleanly(file);
      t.check("every frame decodes without an error", decoded.ok, decoded.errors);
      t.check("nothing else is left in the folder (no partial, no second file)", readdirSync(out).join("|") === "dialog to file.mp4", readdirSync(out).join("|"));
      await pressInDialog(t.d, "Close");
    },
  },
  {
    name: "settings-reach-the-file",
    group: "dialog",
    async run(t) {
      await projectWith(t, "settings", [{ file: t.fixtures.green(), at: 0 }]);
      await openExportDialog(t.d);
      await pressInDialog(t.d, "Advanced settings");
      await t.d.waitFor("!!document.querySelector('select[aria-label=\"frame rate\"]')");
      const defaults = await t.d.eval(`[...document.querySelectorAll('[aria-label="export video"] select')].map((s) => s.getAttribute('aria-label') + '=' + s.value).join(', ')`);
      t.check("Advanced settings open on the defaults: the project's size and rate, Medium quality", defaults === "resolution=source, frame rate=, quality=medium", defaults);
      await t.d.select('select[aria-label="resolution"]', "720p");
      await t.d.select('select[aria-label="frame rate"]', "25");
      await t.d.select('select[aria-label="quality"]', "low");
      const shown = await t.d.eval(`[...document.querySelectorAll('[aria-label="export video"] select')].map((s) => s.getAttribute('aria-label') + '=' + s.value).join(', ')`);
      t.note(`chosen: ${shown}`);
      const file = path.join(outDir(t), "settings 720p 25.mp4");
      const { savedAt } = await startExport(t.d, t.pid, file);
      const end = await waitForEnd(t.d, { ms: 120_000 });
      t.time("export.settings.save-to-done", performance.now() - savedAt, { timelineSeconds: 3, resolution: "1280x720", fps: 25 });
      t.check("the export finished", end.status === "Done", end.all);
      const info = probe(file);
      t.check("the file is 1280x720, the resolution chosen", info.video?.width === 1280 && info.video?.height === 720, JSON.stringify(info.video));
      t.check("the file runs at 25 fps, the frame rate chosen", near(info.video?.fps ?? 0, 25, 0.01), String(info.video?.fps));
      t.check("its length is the clip's 3 s plus the end card", near(info.duration, 3 + endCardSeconds(1280, 720), 0.15), `${info.duration} s`);
      const mid = colourAt(file, 1.5);
      t.check("the picture is the clip's (green)", isColour(mid, "green"), mid.join(","));
      await pressInDialog(t.d, "Close");
    },
  },
  {
    name: "old-file-kept-until-the-new-one-is-ready",
    group: "dialog",
    async run(t) {
      await projectWith(t, "replace", [{ file: t.fixtures.busy(12), at: 0 }]);
      const out = outDir(t);
      const file = path.join(out, "replace me.mp4");
      // The video a person exported yesterday, at the same name.
      copyFileSync(t.fixtures.red(), file);
      const oldHash = await sha256(file);
      const old = fileState(file);
      await openExportDialog(t.d);
      const { answer, savedAt } = await startExport(t.d, t.pid, file, { overwrite: true });
      t.check("Windows asked before replacing the file, and the answer was Yes", answer.overwriteAsked && answer.overwriteAnswer === "yes", JSON.stringify(answer));
      let changedWhileRendering = null;
      let midway = null;
      const end = await waitForEnd(t.d, {
        ms: 180_000,
        onSample: (x) => {
          const now = fileState(file);
          const same = now && now.size === old.size && now.mtimeMs === old.mtimeMs;
          if (!same && /Rendering/.test(x.status ?? "") && changedWhileRendering === null)
            changedWhileRendering = `${x.status} · ${JSON.stringify(now)}`;
          if (!midway && /Rendering.*\b[3-7]\d%/.test(x.status ?? ""))
            midway = sha256(file).catch((e) => `unreadable: ${e.message}`);
        },
      });
      t.time("export.replace.save-to-done", performance.now() - savedAt, { timelineSeconds: 12 });
      t.check("the export finished", end.status === "Done", end.all);
      t.check("while it rendered, the old file stayed exactly as it was", changedWhileRendering === null, changedWhileRendering ?? "");
      if (midway) t.check("halfway through, the old file's bytes were unchanged", (await midway) === oldHash);
      else t.note("no sample landed between 30 and 79 %: the midway hash was not taken");
      const info = probe(file);
      t.check("afterwards the name holds the new video (12 s plus the end card)", near(info.duration, 12 + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      t.check("and it is not the old file", (await sha256(file)) !== oldHash);
      t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));
      await pressInDialog(t.d, "Close");
    },
  },
];
