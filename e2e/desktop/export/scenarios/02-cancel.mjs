// Stopping an export: Cancel in the dialog part-way through, and trying again to the same place.
import { copyFileSync } from "node:fs";
import path from "node:path";

import { exportProcesses, openExportDialog, pressInDialog, startExport, waitForEnd } from "../journey.mjs";
import { decodesCleanly, endCardSeconds, partialsIn, probe, sha256 } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";

/** Wait until the dialog's status shows at least `percent` %, and return what it said. */
export function waitForPercent(d, percent, ms = 180_000) {
  return d.waitFor(
    `(() => { const s = document.querySelector('[aria-label="export video"] [data-testid=export-status]')?.innerText ?? '';
      const m = /(\\d+)%/.exec(s); return m && Number(m[1]) >= ${percent} ? s : null; })()`,
    ms,
    150,
  );
}

/** How long until no export encode is running any more (null if one still is after `ms`). */
export async function encoderGone(ms = 30_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (exportProcesses().length === 0) return performance.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export const scenarios = [
  {
    name: "cancel-midway-then-retry",
    group: "cancel",
    async run(t) {
      const seconds = 40;
      await projectWith(t, "cancel", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const out = outDir(t);
      const file = path.join(out, "cancel me.mp4");
      copyFileSync(t.fixtures.red(), file);
      const oldHash = await sha256(file);

      await openExportDialog(t.d);
      const { savedAt } = await startExport(t.d, t.pid, file, { overwrite: true });
      const said = await waitForPercent(t.d, 20);
      t.time("export.cancel.save-to-20-percent", performance.now() - savedAt, { timelineSeconds: seconds });
      t.note(`cancelled at: ${said}`);
      const running = exportProcesses();
      t.check("an encode is running for it when Cancel is pressed", running.length >= 1, `${running.length} process(es)`);

      const c0 = performance.now();
      await pressInDialog(t.d, "Cancel render");
      const end = await waitForEnd(t.d, { ms: 60_000, every: 100 });
      const toCancelled = performance.now() - c0;
      const stopped = await encoderGone();
      t.time("export.cancel.to-dialog-cancelled", toCancelled);
      if (stopped !== null) t.time("export.cancel.to-encoder-stopped", stopped + toCancelled);
      t.check("the dialog says Cancelled, and names no saved file", end.status === "Cancelled" && !end.saved, end.all);
      t.check("the encode stopped within 10 s of Cancel", stopped !== null && stopped + toCancelled < 10_000, stopped === null ? "still running after 30 s" : `${Math.round(stopped + toCancelled)} ms`);
      t.check("the queue lists it as Cancelled", end.queue.some((r) => r.name === "cancel me.mp4" && /Cancelled/.test(r.text)), JSON.stringify(end.queue));
      await t.sleep(2000);
      t.check("the file that was already at that name is untouched", (await sha256(file)) === oldHash);
      t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));

      // Try again, to the same place.
      await pressInDialog(t.d, "Close");
      await openExportDialog(t.d);
      const again = await startExport(t.d, t.pid, file, { overwrite: true });
      const end2 = await waitForEnd(t.d, { ms: 600_000 });
      t.time("export.retry.save-to-done", performance.now() - again.savedAt, { timelineSeconds: seconds });
      t.check("the second try finishes and names the file", end2.status === "Done" && end2.saved === `Saved to ${file}`, end2.saved ?? end2.all);
      const info = probe(file);
      t.check("the file is the whole timeline plus the end card", near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      t.check("it replaced the old file", (await sha256(file)) !== oldHash);
      const decoded = decodesCleanly(file);
      t.check("every frame decodes without an error", decoded.ok, decoded.errors);
      t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));
      await pressInDialog(t.d, "Close");
    },
  },
];
