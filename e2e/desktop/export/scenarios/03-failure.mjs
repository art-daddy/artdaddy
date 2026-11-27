// An export that fails: what the person is told (one plain sentence, the raw text one click away), that a
// failure is never shown as a success, that nothing half-made is left, and that trying again (Try again on the
// card above the chat, or Export again when the failure came before the export was queued) gets the file once
// the cause is gone.
import { copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import {
  cardState,
  linkMedia,
  lockFile,
  openExportDialog,
  place,
  pressInDialog,
  startExport,
  waitForEnd,
} from "../journey.mjs";
import { decodesCleanly, endCardSeconds, partialsIn, probe, sha256 } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";

/** The sentences the app says for a failure (src/timeline/exportWords.ts, PLAIN), as a person reads them. */
const SAYS = {
  storage: "ArtDaddy couldn't save to that folder. It may be read-only, the file may be open in another program, or the drive may be disconnected.",
  source: "Some clips couldn't be read. They may have been moved or renamed, or are on a drive that is disconnected.",
};
/** What the face of a failure must never show: an encoder's log, an OS error, a path, an error code. */
const isRaw = (text) =>
  /os error|ffmpeg|stderr|exit code|errno/i.test(text) || /\\\\\?\\|[A-Z]:\\|\bE[A-Z]{3,}\b|\bat [\w.]+ \(|Error:/.test(text);

/** Found by this lane on 26 Nov 2026: Windows' "being used by another process" (os error 32) is not among the
 *  texts src/api/exportReason.ts reads as a storage failure, so a file held open by another program is explained as
 *  "Something went wrong" and no Save somewhere else is offered. */
const IN_USE_BUG = "A file open in another program is explained as 'Something went wrong while exporting'";

/** Wait until the card above the chat says the export of `name` ended, and return what it shows. */
async function cardSaysEnded(d, name, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const c = await cardState(d);
    const text = c?.text ?? "";
    if (text.includes(`Exported “${name}”`)) return { state: "done", text };
    if (c?.tryAgain.includes(`try again ${name}`) && !/Starting…/.test(text)) return { state: "failed", text };
    if (Date.now() > end) return { state: "timeout", text };
    await new Promise((r) => setTimeout(r, 300));
  }
}

export const scenarios = [
  {
    name: "file-in-use-says-why-then-try-again",
    group: "failure",
    async run(t) {
      const seconds = 12;
      await projectWith(t, "in use", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const out = outDir(t);
      const name = "in use.mp4";
      const file = path.join(out, name);
      copyFileSync(t.fixtures.red(), file);
      const oldHash = await sha256(file);

      await openExportDialog(t.d);
      const { savedAt } = await startExport(t.d, t.pid, file, { overwrite: true });
      // While it renders, another program opens the old video and will not share it (a player, a sync client).
      const lock = await lockFile(file);
      let end;
      try {
        end = await waitForEnd(t.d, { ms: 180_000 });
        t.time("export.failure.save-to-failed", performance.now() - savedAt, { timelineSeconds: seconds, cause: "destination held open" });
        await t.shot("failed");
      } finally {
        lock.release();
      }
      t.check("the dialog says Failed, and names no saved file", end.status === "Failed" && !end.saved, end.all);
      t.knownBug(IN_USE_BUG, "the reason is the plain sentence about the folder (the file may be open in another program)", end.error === SAYS.storage, end.error ?? "");
      t.check("its face shows no raw error text", !isRaw(end.error ?? ""), end.error ?? "");
      t.check("the raw text is one click away, under Show details", (end.details ?? "").trim().length > 0, (end.details ?? "").slice(0, 200));
      t.knownBug(IN_USE_BUG, "the queue row says the same sentence", end.queue.some((r) => r.name === name && r.text.includes(SAYS.storage)), JSON.stringify(end.queue.filter((r) => r.name === name)));
      await t.sleep(1500);
      t.check("the old file is untouched", (await sha256(file)) === oldHash);
      t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));

      // The program lets go of the file; Try again on the card above the chat.
      await pressInDialog(t.d, "Close");
      const card = await cardState(t.d);
      t.check("the card above the chat offers Try again for it", !!card?.tryAgain.includes(`try again ${name}`), card?.text ?? "no card");
      t.knownBug(IN_USE_BUG, "and, since the folder is the problem, Save somewhere else", !!card?.elsewhere.includes(`save ${name} somewhere else`), card?.text ?? "no card");
      if (!card?.tryAgain.includes(`try again ${name}`)) return;
      const r0 = performance.now();
      await t.d.click(`button[aria-label="try again ${name}"]`);
      const after = await cardSaysEnded(t.d, name);
      t.time("export.try-again.to-done", performance.now() - r0, { timelineSeconds: seconds });
      t.check("Try again delivers the file", after.state === "done", after.text);
      const info = probe(file);
      t.check("the file is the new video (12 s plus the end card)", near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      t.check("it replaced the old one", (await sha256(file)) !== oldHash);
      t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));
    },
  },
  {
    name: "moved-source-says-why-then-try-again",
    group: "failure",
    async run(t) {
      const p = await t.project("moved source");
      // The person's own footage, linked where it is (File > Import Media), as the desktop app does.
      const footage = outDir(t, "footage");
      const source = path.join(footage, "interview.mp4");
      copyFileSync(t.fixtures.blue(), source);
      const entry = await linkMedia(t.d, t.pid, p, source);
      t.note(`linked as ${entry.path}`);
      await place(t.d, p, entry, "v1", 0);
      // ...and later moves it.
      const moved = `${source}.moved`;
      let movedOk = true;
      try {
        renameSync(source, moved);
      } catch (e) {
        movedOk = false;
        t.note(`could not move the source: ${e.message}`);
      }
      if (!movedOk) return t.check("the source could be moved away (it is not held open)", false);

      const out = outDir(t);
      const name = "moved source.mp4";
      const file = path.join(out, name);
      await openExportDialog(t.d);
      const { savedAt } = await startExport(t.d, t.pid, file);
      const end = await waitForEnd(t.d, { ms: 120_000 });
      t.time("export.failure.missing-source-to-failed", performance.now() - savedAt);
      await t.shot("failed");
      t.check("the dialog says Failed, and names no saved file", end.status === "Failed" && !end.saved, end.all);
      t.check("the reason is the plain sentence about clips that couldn't be read", end.error === SAYS.source, end.error ?? "");
      t.check("its face shows no raw error text", !isRaw(end.error ?? ""), end.error ?? "");
      t.check("nothing was written where the video was going", !existsSync(file) && readdirSync(out).length === 0, readdirSync(out).join(", "));

      t.check("Show details names the clip that couldn't be read", (end.details ?? "").includes("interview.mp4"), end.details ?? "no details");

      // The footage is put back. This failure is found before the export is queued, so there is no card with
      // Try again (the queue never held it): the person closes the dialog and exports again.
      renameSync(moved, source);
      await pressInDialog(t.d, "Close");
      const card = await cardState(t.d);
      t.note(card ? `card above the chat: ${card.text}` : "no card above the chat for it: the way to try again is Export again");
      await openExportDialog(t.d);
      const again = await startExport(t.d, t.pid, file);
      const end2 = await waitForEnd(t.d, { ms: 120_000 });
      t.time("export.again-after-footage-back.save-to-done", performance.now() - again.savedAt, { timelineSeconds: 3 });
      t.check("exporting again delivers the file once the footage is back", end2.status === "Done" && existsSync(file), end2.all);
      if (existsSync(file)) {
        const decoded = decodesCleanly(file);
        t.check("the file decodes without an error", decoded.ok, decoded.errors);
        t.check("no partial is left beside it", partialsIn(out).length === 0, partialsIn(out).join(", "));
      }
    },
  },
];
