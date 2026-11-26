// The questions an export asks before it starts, when the PC is short: room for the file, or free memory.
//
// The app has no test hook for a full disk or a PC short of memory, and making either for real would mean filling
// the PC's disk. So the one native answer that carries those figures, `jobs_export_resources`,
// is rewritten on its way to the page (journey.mjs, pcSays): the app's own preflight, question, answers and export
// run unchanged. What this cannot show: a drive that really fills up part-way, or the Rust side's own figures.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

import { dialogState, exportProcesses, openExportDialog, pcSays, pressInDialog, startExport, waitForEnd } from "../journey.mjs";
import { endCardSeconds, partialsIn, probe, sha256 } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";

const QUESTION = '[data-export-question] [role=dialog]';
/** Found by this lane on 26 Nov: with the PC reporting 1 MB free where the file goes, the export started without
 *  asking. The space check (src/timeline/exportOptions.ts, assessExport) needs a measured size for this kind of
 *  export, temporary files included; without one it records "disk_unknown" and asks nothing, and the exports this
 *  PC learned from (chip-encoded HD) all lack the temporary-space figure, so it never has one. */
const NO_SPACE_QUESTION = "No space question before an export when the destination drive is nearly full";

/** The export went ahead without asking: stop it the way a person would, and put the dialog away. */
async function stopIt(t) {
  const s = await dialogState(t.d);
  if (s.buttons?.includes("Cancel render")) {
    await pressInDialog(t.d, "Cancel render");
    await waitForEnd(t.d, { ms: 60_000 }).catch(() => {});
  }
  await pressInDialog(t.d, "Close").catch(() => {});
  return s;
}

/** The question on screen: its title, lines, facts and buttons, or null. */
function question(d) {
  return d.eval(`(() => {
    const q = document.querySelector('${QUESTION}');
    if (!q) return null;
    const facts = {};
    for (const dt of q.querySelectorAll('dt')) facts[dt.innerText.trim()] = dt.nextElementSibling?.innerText.trim() ?? '';
    return {
      title: q.getAttribute('aria-label'),
      text: q.innerText.replace(/\\s+/g, ' ').trim(),
      facts,
      buttons: [...q.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean),
    };
  })()`);
}

async function waitForQuestion(d, title, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const q = await question(d);
    if (q && (!title || q.title === title)) return q;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function answer(d, label) {
  await d.clickText(label, { sel: `${QUESTION} button` });
}

/** "about 20 MB" / "about 1.3 GB" → bytes (the question rounds what is needed up and what there is down). */
const bytesOf = (s) => {
  const m = /about ([\d.]+) (MB|GB)/.exec(s ?? "");
  return m ? Number(m[1]) * (m[2] === "GB" ? 1e9 : 1e6) : NaN;
};

export const scenarios = [
  {
    name: "not-enough-room-asks-before-starting",
    group: "prompts",
    async run(t) {
      await projectWith(t, "room", [{ file: t.fixtures.busy(12), at: 0 }]);
      const out = outDir(t);
      // One export first, so the app has learned this kind of export on this PC (its time and its sizes): the space
      // check works from what it learned.
      await openExportDialog(t.d);
      await startExport(t.d, t.pid, path.join(out, "learn.mp4"));
      const learnt = await waitForEnd(t.d, { ms: 300_000 });
      await pressInDialog(t.d, "Close");
      const samples = await t.d
        .eval(`JSON.parse(localStorage.getItem('artdaddy-export-calibration-v4') ?? '[]').map((c) => ({ seconds: c.workload?.durationSeconds ?? null, finalBytes: c.finalBytes ?? null, temporaryBytes: c.temporaryBytes ?? null }))`)
        .catch((e) => String(e));
      t.note(`learned from a first export of this edit (${learnt.status}): ${JSON.stringify(samples)}`);
      const file = path.join(out, "room.mp4");
      const undo = await pcSays(t.d, { destination_free_bytes: 1_000_000, scratch_free_bytes: 900_000_000_000 });
      try {
        await openExportDialog(t.d);
        const { savedAt } = await startExport(t.d, t.pid, file);
        const q = await waitForQuestion(t.d, "Not enough space for the exported file", 8000);
        if (!q) {
          const s = await stopIt(t);
          t.knownBug(NO_SPACE_QUESTION, "the app asks before it starts: not enough space for the exported file", false, `it started instead: ${s.status}`);
          // Why (src/timeline/exportOptions.ts, assessExport): the space check needs the temporary space this kind of
          // export uses, as learned from earlier exports; a sample without it leaves the check "unknown".
          if (Array.isArray(samples) && samples.length && samples.every((x) => x.temporaryBytes === null))
            t.note("every export the app learned from has no temporary-space figure, so its space check cannot decide");
          return;
        }
        t.knownBug(NO_SPACE_QUESTION, "the app asks before it starts: not enough space for the exported file", true);
        t.time("export.prompt.space.save-to-question", performance.now() - savedAt);
        await t.shot("space-question");
        t.note(`it said: ${q.text}`);
        t.check("it names the drive and what the space is for", /on drive C: for the exported video and its temporary files/.test(q.text), q.text);
        const need = bytesOf(q.facts.Needed);
        const free = bytesOf(q.facts["Free on C:"]);
        t.check("its numbers agree with its verdict (needed is more than free)", need > free, JSON.stringify(q.facts));
        t.check("it offers Cancel, Continue and Start anyway", ["Cancel", "Continue", "Start anyway"].every((b) => q.buttons.includes(b)), q.buttons.join(", "));
        t.check("nothing has started while it asks", exportProcesses().length === 0 && !existsSync(file) && partialsIn(out).length === 0);

        // Continue without making room: it looks again and asks again.
        const c0 = performance.now();
        await answer(t.d, "Continue");
        await t.d.waitFor(`!document.querySelector('${QUESTION}')`, 5000, 50).catch(() => {});
        const again = await waitForQuestion(t.d, "Not enough space for the exported file", 15_000);
        t.time("export.prompt.space.recheck", performance.now() - c0);
        t.check("Continue with the disk still full asks again, after looking again", !!again);
        t.check("still nothing started", exportProcesses().length === 0 && !existsSync(file));

        // The person makes room; Continue starts it.
        await undo();
        const r0 = performance.now();
        await answer(t.d, "Continue");
        const end = await waitForEnd(t.d, { ms: 300_000 });
        t.time("export.prompt.space.continue-to-done", performance.now() - r0, { timelineSeconds: 12 });
        t.check("with room made, Continue exports it", end.status === "Done" && end.saved === `Saved to ${file}`, end.all);
        const info = probe(file);
        t.check("the file is whole", near(info.duration, 12 + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
        await pressInDialog(t.d, "Close");
      } finally {
        await undo();
      }
    },
  },
  {
    name: "declining-the-question-leaves-everything-as-it-was",
    group: "prompts",
    async run(t) {
      await projectWith(t, "decline", [{ file: t.fixtures.blue(), at: 0 }]);
      const out = outDir(t);
      const file = path.join(out, "keep me.mp4");
      copyFileSync(t.fixtures.red(), file);
      const oldHash = await sha256(file);
      const undo = await pcSays(t.d, { destination_free_bytes: 1_000_000 });
      try {
        await openExportDialog(t.d);
        await startExport(t.d, t.pid, file, { overwrite: true });
        const q = await waitForQuestion(t.d, "Not enough space for the exported file", 8000);
        if (!q) {
          const s = await stopIt(t);
          t.knownBug(NO_SPACE_QUESTION, "the app asks before it starts", false, `it started instead: ${s.status}`);
          await t.sleep(1500);
          // Without the question the export runs (here the disk is not really full, so it can finish and replace
          // the file): what declining would have kept is part of the same bug.
          t.knownBug(NO_SPACE_QUESTION, "the file already there is untouched", (await sha256(file)) === oldHash, `the export ${s.status === "Done" ? "finished before it could be stopped" : "was stopped"}`);
          t.check("and no partial was left", partialsIn(out).length === 0, partialsIn(out).join(", "));
          return;
        }
        t.knownBug(NO_SPACE_QUESTION, "the app asks before it starts", true);
        await answer(t.d, "Cancel");
        await t.d.waitFor(`!document.querySelector('${QUESTION}')`, 5000).catch(() => {});
        await t.sleep(1500);
        const s = await dialogState(t.d);
        t.note(`the dialog then said: ${s.status ?? "(nothing)"}; the queue row: ${JSON.stringify(s.queue.find((r) => r.name === "keep me.mp4") ?? null)}`);
        t.check("the dialog does not say Done or Failed", !["Done", "Failed"].includes(s.status ?? "") && !s.saved, s.all);
        t.check("nothing was encoded", exportProcesses().length === 0);
        t.check("the file already there is untouched", (await sha256(file)) === oldHash);
        t.check("and no partial was left", partialsIn(out).length === 0, partialsIn(out).join(", "));
        if (s.open) await t.d.key("Escape");
      } finally {
        await undo();
      }
    },
  },
  {
    name: "not-enough-memory-asks-before-starting",
    group: "prompts",
    async run(t) {
      await projectWith(t, "memory", [{ file: t.fixtures.busy(12), at: 0 }]);
      const out = outDir(t);
      const file = path.join(out, "memory.mp4");
      const undo = await pcSays(t.d, { available_memory_bytes: 50_000_000 });
      try {
        await openExportDialog(t.d);
        const { savedAt } = await startExport(t.d, t.pid, file);
        const q = await waitForQuestion(t.d, "Not enough free memory");
        t.time("export.prompt.memory.save-to-question", performance.now() - savedAt);
        await t.shot("memory-question");
        t.check("the app asks before it starts: not enough free memory", !!q, JSON.stringify(await question(t.d)));
        if (!q) return;
        t.note(`it said: ${q.text}`);
        const need = bytesOf(q.facts.Needed);
        const have = bytesOf(q.facts["Available now"]);
        t.check("it shows what is needed and what is available, and they agree with the verdict", need > have, JSON.stringify(q.facts));
        t.check("nothing has started while it asks", exportProcesses().length === 0 && !existsSync(file));
        const c0 = performance.now();
        await answer(t.d, "Continue");
        await t.d.waitFor(`!document.querySelector('${QUESTION}')`, 5000, 50).catch(() => {});
        const again = await waitForQuestion(t.d, "Not enough free memory", 15_000);
        t.time("export.prompt.memory.recheck", performance.now() - c0);
        t.check("Continue with memory still short asks again", !!again);
        // The person cannot close anything: Start anyway.
        await answer(t.d, "Start anyway");
        const end = await waitForEnd(t.d, { ms: 300_000 });
        t.check("Start anyway exports it", end.status === "Done", end.all);
        if (end.status === "Done") {
          const info = probe(file);
          t.check("the file is whole", near(info.duration, 12 + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
        }
        await pressInDialog(t.d, "Close").catch(() => {});
      } finally {
        await undo();
      }
    },
  },
];
