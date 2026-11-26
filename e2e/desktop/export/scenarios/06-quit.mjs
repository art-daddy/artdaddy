// Closing the app while an export runs, and opening it again. Two ways out:
// - the window's X or File > Exit: the app asks first ("An export is still running. Quit and stop it?"); Cancel keeps
//   everything going, OK stops the export and closes;
// - the app dying mid-export (a crash, Task Manager): the next start takes the export over and finishes it (the
//   native journal keeps it; src/timeline/exportQueue.ts, adoptExports) or removes what it left.
// Either way, after the next start no partial may be left beside the destination, a file there must be whole, and
// what the app says must match what is on disk.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { cardState, dialogState, exportProcesses, nativeDialog, openExportDialog, openMenu, startExport } from "../journey.mjs";
import { decodesCleanly, endCardSeconds, partialsIn, probe } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";
import { encoderGone, waitForPercent } from "./02-cancel.mjs";

const QUIT_QUESTION = "An export is still running. Quit and stop it?";
/** Long enough that the quit lands while it renders, even on the graphics chip (about 4x the video's length here). */
const SECONDS = 180;

/** After a start: open the project again from the start screen, and read what the app says about the export. */
async function reopenAndLook(t, label, name) {
  await t.d.clickText(`sweep_qa-export ${label}`, { sel: "button", ms: 20_000 });
  await t.d.waitFor("!!document.querySelector('[data-track-id]')", 30_000);
  await t.sleep(2500);
  const card = await cardState(t.d);
  await openExportDialog(t.d);
  const s = await dialogState(t.d);
  await t.d.key("Escape");
  const row = s.queue.find((r) => r.name === name);
  return { card, row: row ?? null, queue: s.queue };
}

/** A file at the destination must be whole: its full length, every frame decodable. */
function whole(file, seconds) {
  const info = probe(file);
  const decoded = decodesCleanly(file);
  return { ok: near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2) && decoded.ok, detail: `${info.duration} s; ${decoded.ok ? "decodes" : decoded.errors}` };
}

const pct = (s) => Number(/(\d+)%/.exec(s ?? "")?.[1] ?? -1);
const stage = (d) => d.eval(`document.querySelector('[aria-label="export video"] [data-testid=export-status]')?.innerText ?? ''`);

export const scenarios = [
  {
    name: "quit-during-export-then-reopen",
    group: "quit",
    async run(t) {
      const label = "quit";
      await projectWith(t, label, [{ file: t.fixtures.busy(SECONDS), at: 0 }]);
      const out = outDir(t);
      const name = "quit.mp4";
      const file = path.join(out, name);
      await openExportDialog(t.d);
      await startExport(t.d, t.pid, file);
      const before = await waitForPercent(t.d, 10);

      // The window's X, then Cancel: nothing changes.
      nativeDialog(t.pid, ["-Kind", "close"]);
      const asked = nativeDialog(t.pid, ["-Kind", "message", "-Title", "ArtDaddy", "-Button", "Cancel", "-TimeoutMs", "15000"]);
      t.check("closing the window asks first, in plain words", asked.ok && asked.text.includes(QUIT_QUESTION), JSON.stringify(asked));
      await t.sleep(2500);
      const after = await stage(t.d);
      t.check("answering Cancel keeps the app and the export going", t.app.running() && (pct(after) > pct(before) || /Checking|Saving|Done/.test(after)), `${before} → ${after}`);

      // File > Exit (Escape puts the dialog away first: it covers the menu), then OK: the export stops, the app closes.
      const during = await stage(t.d);
      await openMenu(t.d, "File", "Exit");
      const q0 = performance.now();
      const ok = nativeDialog(t.pid, ["-Kind", "message", "-Title", "ArtDaddy", "-Button", "OK", "-TimeoutMs", "15000"]);
      t.check("asked again, answered OK", ok.ok, JSON.stringify(ok));
      const exited = await t.app.waitExit(30_000);
      t.time("app.quit-with-export.to-exit", performance.now() - q0);
      t.check("the app closes within 30 s", exited);
      const stopped = await encoderGone(15_000);
      t.check("the encode stopped with it", stopped !== null, stopped === null ? "still running 15 s after" : "");
      t.note(`quit while the dialog said "${during}"; left in the folder: ${readdirSync(out).join(", ") || "nothing"}`);
      if (/Rendering/.test(during)) t.check("quitting while it rendered delivered no file", !existsSync(file));

      const start = await t.app.launch("after quit");
      t.time("app.relaunch.to-menu", start.ms, { warm: true });
      await t.sleep(3000);
      t.check("after the next start, no partial is beside the destination", partialsIn(out).length === 0, partialsIn(out).join(", "));
      const seen = await reopenAndLook(t, label, name);
      t.note(`after reopening: queue row ${JSON.stringify(seen.row)}; card ${JSON.stringify(seen.card?.text ?? null)}`);
      if (existsSync(file)) {
        const w = whole(file, SECONDS);
        t.check("a file at the destination is whole", w.ok, w.detail);
      }
      const says = /Completed/.test(seen.row?.text ?? "") || (seen.card?.text ?? "").includes(`Exported “${name}”`);
      t.check("the app says it finished only if the file is there", says === existsSync(file), `says finished: ${says}; file: ${existsSync(file)}`);
    },
  },
  {
    name: "app-dies-during-export-then-reopen",
    group: "quit",
    async run(t) {
      const label = "crash";
      await projectWith(t, label, [{ file: t.fixtures.busy(SECONDS), at: 0 }]);
      const out = outDir(t);
      const name = "crash.mp4";
      const file = path.join(out, name);
      await openExportDialog(t.d);
      await startExport(t.d, t.pid, file);
      const at = await waitForPercent(t.d, 10);
      t.check("an encode is running when the app dies", exportProcesses().length >= 1, at);

      t.app.crash();
      await t.app.waitExit(15_000);
      const stopped = await encoderGone(15_000);
      t.check("the encode does not outlive the app", stopped !== null, stopped === null ? `still running: ${exportProcesses().map((p) => p.pid).join(", ")}` : `${Math.round(stopped)} ms after`);
      t.note(`left in the folder after the crash: ${readdirSync(out).join(", ") || "nothing"}`);
      t.check("no file was delivered by the dying app", !existsSync(file));

      const start = await t.app.launch("after crash");
      t.time("app.relaunch-after-crash.to-menu", start.ms, { warm: true });
      // The next start either finishes the export or removes what it left; give it the time an export takes.
      const r0 = performance.now();
      while (performance.now() - r0 < SECONDS * 1000 && partialsIn(out).length > 0) await t.sleep(500);
      t.time("app.relaunch-after-crash.to-settled", performance.now() - r0 + start.ms);
      t.check("after the next start, no partial is left", partialsIn(out).length === 0, partialsIn(out).join(", "));
      const seen = await reopenAndLook(t, label, name);
      t.note(`after reopening: file ${existsSync(file) ? "delivered" : "absent"}; queue row ${JSON.stringify(seen.row)}; card ${JSON.stringify(seen.card?.text ?? null)}`);
      if (existsSync(file)) {
        const w = whole(file, SECONDS);
        t.check("the export the next start finished is whole", w.ok, w.detail);
      }
      const says = /Completed/.test(seen.row?.text ?? "") || (seen.card?.text ?? "").includes(`Exported “${name}”`);
      t.check("the app says it finished only if the file is there", says === existsSync(file), `says finished: ${says}; file: ${existsSync(file)}`);
    },
  },
];
