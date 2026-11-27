// A second export while one runs. The Export dialog shows the running export instead of starting a second, so
// a second one comes from another door: an outside assistant over MCP (the app's own server on port 19787),
// asked while the person's own export renders. One encode runs at a time; the second waits its turn, or is
// cancelled from the queue in the dialog before it starts.
import { existsSync } from "node:fs";
import path from "node:path";

import { dialogState, exportProcesses, openExportDialog, pressInDialog, startExport, waitForEnd } from "../journey.mjs";
import { mcpClient } from "../mcp.mjs";
import { decodesCleanly, endCardSeconds, partialsIn, probe } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";
import { waitForPercent } from "./02-cancel.mjs";

/** The outputs being encoded right now (one per export encoding), as a set of ids. */
function outputsNow() {
  return new Set(exportProcesses().map((p) => p.output));
}

/** An export asked for over MCP may put a question to the person first (a heads-up about its time is asked of an
 *  assistant's export, not of the menu's), and the call waits for the answer. Answer it the way a person would,
 *  and say what it was. Resolves with the call's reply. */
async function replyAnswering(t, call, answer, ms = 120_000) {
  let settled = false;
  call.then(() => (settled = true), () => (settled = true));
  const end = Date.now() + ms;
  while (!settled && Date.now() < end) {
    const title = await t.d.eval(`document.querySelector('[data-export-question] [role=dialog]')?.getAttribute('aria-label') ?? null`);
    if (title) {
      t.note(`the app asked first: "${title}"; answered ${answer}`);
      await t.d.clickText(answer, { sel: "[data-export-question] button" });
      break;
    }
    await t.sleep(150);
  }
  return call;
}

export const scenarios = [
  {
    name: "second-export-waits-its-turn",
    group: "queue",
    needsMcp: true,
    async run(t) {
      const seconds = 30;
      await projectWith(t, "queue", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const out = outDir(t);
      const first = path.join(out, "first.mp4");
      const second = path.join(out, "second.mp4");
      await openExportDialog(t.d);
      const a = await startExport(t.d, t.pid, first);
      await waitForPercent(t.d, 5);

      const mcp = await mcpClient();
      const m0 = performance.now();
      const r = await replyAnswering(t, mcp.call("export", { output_path: second }), "Continue");
      t.time("mcp.export.reply", performance.now() - m0);
      t.check("the assistant's export is accepted while the first one runs", r?.ok === true && !!r?.job_id, JSON.stringify(r).slice(0, 300));

      let s = await dialogState(t.d);
      const queued = s.queue.find((row) => row.name === "second.mp4");
      t.check("the dialog's queue shows the second one waiting", !!queued && /Queued/.test(queued.text), JSON.stringify(s.queue.slice(0, 3)));

      // Watch both to the end: never two encodes at once, and the second's only after the first's has ended.
      let both = null;
      const firstOutput = [...outputsNow()][0] ?? null;
      let secondStartedAt = null;
      let firstEndedAt = null;
      const end = Date.now() + 900_000;
      while (Date.now() < end) {
        const now = outputsNow();
        if (now.size > 1 && !both) both = `${now.size} encodes at ${new Date().toISOString()}`;
        if (firstEndedAt === null && firstOutput && !now.has(firstOutput)) firstEndedAt = performance.now();
        if (secondStartedAt === null && [...now].some((o) => o !== firstOutput)) secondStartedAt = performance.now();
        if (existsSync(first) && existsSync(second) && now.size === 0) break;
        await t.sleep(400);
      }
      s = await dialogState(t.d);
      t.check("only one encode ran at a time", both === null && firstOutput !== null, both ?? (firstOutput ? "" : "the first encode was never seen"));
      t.check("the second's encode started after the first's ended", secondStartedAt !== null && firstEndedAt !== null && secondStartedAt >= firstEndedAt,
        `first ended +${Math.round((firstEndedAt ?? 0) - a.savedAt)} ms, second started +${Math.round((secondStartedAt ?? 0) - a.savedAt)} ms`);
      if (secondStartedAt !== null) t.time("export.queue.second-waited", secondStartedAt - m0, { firstTimelineSeconds: seconds });
      t.time("export.queue.both-done", performance.now() - a.savedAt, { timelineSeconds: seconds * 2 });
      for (const [name, file] of [["first", first], ["second", second]]) {
        const info = existsSync(file) ? probe(file) : null;
        t.check(`the ${name} file is whole (${seconds} s plus the end card)`, !!info && near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), info ? `${info.duration} s` : "missing");
      }
      t.check("both are listed as Completed", ["first.mp4", "second.mp4"].every((n) => s.queue.some((row) => row.name === n && /Completed/.test(row.text))), JSON.stringify(s.queue.slice(0, 3)));
      t.check("no partial is left", partialsIn(out).length === 0, partialsIn(out).join(", "));
      // The assistant asks after it, and tries to cancel it once it has finished.
      const listed = await mcp.call("manage_exports", { action: "list" });
      t.note(`manage_exports list: ${JSON.stringify(listed).slice(0, 300)}`);
      const late = await mcp.call("manage_exports", { action: "cancel", job_id: r.job_id });
      t.check("a finished export cannot be cancelled over MCP, and the reply says so", late?.cancelled === false && /already finished/.test(String(late?.note ?? "")), JSON.stringify(late).slice(0, 300));
      t.check("and its file is still there", existsSync(second));
      await pressInDialog(t.d, "Close").catch(() => {});
    },
  },
  {
    name: "cancel-the-waiting-export",
    group: "queue",
    needsMcp: true,
    async run(t) {
      const seconds = 30;
      await projectWith(t, "queue cancel", [{ file: t.fixtures.busy(seconds), at: 0 }]);
      const out = outDir(t);
      const first = path.join(out, "keep.mp4");
      const second = path.join(out, "drop.mp4");
      await openExportDialog(t.d);
      await startExport(t.d, t.pid, first);
      await waitForPercent(t.d, 5);
      const mcp = await mcpClient();
      const r = await replyAnswering(t, mcp.call("export", { output_path: second }), "Continue");
      t.check("the assistant's export is accepted and waits", r?.ok === true, JSON.stringify(r).slice(0, 300));
      const keepOutput = [...outputsNow()][0] ?? null;
      await t.d.waitFor(`!!document.querySelector('[aria-label="export video"] button[aria-label="cancel drop.mp4"]')`, 10_000);
      const c0 = performance.now();
      await t.d.click('[aria-label="export video"] button[aria-label="cancel drop.mp4"]');
      await t.d.waitFor(`[...document.querySelectorAll('[aria-label="export video"] section[aria-label="export queue"] li')]
        .some((li) => li.innerText.includes('drop.mp4') && /Cancelled/.test(li.innerText))`, 10_000);
      t.time("export.queue.cancel-waiting.to-cancelled", performance.now() - c0);
      let otherEncode = false;
      const end = await waitForEnd(t.d, {
        ms: 600_000,
        every: 400,
        onSample: () => {
          if ([...outputsNow()].some((o) => o !== keepOutput)) otherEncode = true;
        },
      });
      t.check("the first one finishes", end.status === "Done", end.status ?? "");
      await t.sleep(4000);
      t.check("the cancelled one never started an encode", keepOutput !== null && !otherEncode && outputsNow().size === 0);
      t.check("and left no file and no partial", !existsSync(second) && partialsIn(out).length === 0, partialsIn(out).join(", "));
      const info = probe(first);
      t.check("the first file is whole", near(info.duration, seconds + endCardSeconds(1920, 1080), 0.2), `${info.duration} s`);
      const decoded = decodesCleanly(first);
      t.check("every frame of it decodes", decoded.ok, decoded.errors);
      await pressInDialog(t.d, "Close").catch(() => {});
    },
  },
];
