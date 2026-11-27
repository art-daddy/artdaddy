// The waits people complain about most: a 4K export and a long one, run to the end and timed, with the delivered
// file checked. Heavy: they run only when named (`run.mjs heavy`), on a quiet PC on mains (a time from a busy or
// battery-powered PC is not a result, and speeds are compared only between runs made close together): each waits
// for a quiet PC first (machine.mjs) and records the PC's state with its time, and where the processor's time went
// during the export (the app itself should idle while its encoder works).
import path from "node:path";

import { importFiles, openExportDialog, place, pressInDialog, startExport, waitForEnd } from "../journey.mjs";
import { colourAt, decodesCleanly, endCardSeconds, partialsIn, probe } from "../media.mjs";
import { near, outDir, projectWith } from "./01-dialog.mjs";

/** Not a flat black or grey frame: the picture has the test pattern's colours. */
const looksLikePicture = (rgb) => Math.max(...rgb) - Math.min(...rgb) > 20 || Math.max(...rgb) > 60;

async function timedExport(t, { label, width, height, seconds, file }) {
  // A time is measured on a quiet PC only (the exporter skill's rule): other test runs, builds and encoders
  // would be measured with it. ARTDADDY_QA_ALLOW_BUSY=1 times it anyway, and the time says it was busy.
  const quiet = await t.waitQuiet();
  t.note(`PC before the export: ${quiet.quiet ? "quiet" : "NOT quiet"}: ${quiet.said}`);
  if (!quiet.quiet && process.env.ARTDADDY_QA_ALLOW_BUSY !== "1") {
    t.notRun(`the PC never got quiet enough to time an export (${quiet.said})`);
    return;
  }
  const machine = await t.machine();
  t.note(`PC at the start: ${machine}`);
  await openExportDialog(t.d);
  const { savedAt } = await startExport(t.d, t.pid, file);
  const sampler = t.cpuSampler();
  let firstPercentAt = null;
  let route = null;
  let samples = 0;
  const readRoute = `(() => { const c = document.querySelector('[aria-label="exports"]'); return c ? [...c.querySelectorAll('div,p,span')].map((e) => e.innerText.trim()).find((x) => /^Using /.test(x)) ?? null : null; })()`;
  let end;
  let cpu;
  try {
    end = await waitForEnd(t.d, {
      ms: 3 * 3600_000,
      every: 1000,
      onSample: (s) => {
        if (firstPercentAt === null && /\d+%/.test(s.status ?? "")) firstPercentAt = performance.now() - savedAt;
        // What the card says the export runs on (the graphics chip, light compression), while it runs.
        if (route === null && samples++ % 5 === 2) t.d.eval(readRoute).then((v) => (route ??= v), () => {});
      },
    });
  } finally {
    cpu = sampler.stop();
  }
  const ms = performance.now() - savedAt;
  t.time(`export.${label}.save-to-done`, ms, {
    timelineSeconds: seconds,
    resolution: `${width}x${height}`,
    ratioToLength: Number((ms / 1000 / seconds).toFixed(2)),
    route: route ?? "processor (no line shown)",
    quiet: quiet.quiet,
    machine,
    cpu,
  });
  if (firstPercentAt !== null) t.time(`export.${label}.save-to-first-percent`, firstPercentAt);
  t.note(`processor during the export (cores on average): ${JSON.stringify(cpu.cores ?? cpu)}; the rest of the PC's busiest: ${JSON.stringify(cpu.othersTop ?? [])}`);
  // The exporter rule: the app idles while ffmpeg works (on 21 Oct two app threads spun at 100% for a whole export).
  if (cpu.cores) t.check("the app itself stays nearly idle while it exports (under 10% of one core)", cpu.cores.host < 0.1, `${cpu.cores.host} cores`);
  t.check("the export finished", end.status === "Done", end.all);
  const info = probe(file);
  t.check(`the picture is ${width}x${height}`, info.video?.width === width && info.video?.height === height, JSON.stringify(info.video));
  t.check(`the length is ${seconds} s plus the end card`, near(info.duration, seconds + endCardSeconds(width, height), 0.3), `${info.duration} s`);
  for (const at of [seconds * 0.1, seconds * 0.5, seconds * 0.95]) {
    const rgb = colourAt(file, at);
    t.check(`a picture decodes at ${at.toFixed(0)} s`, looksLikePicture(rgb), rgb.join(","));
  }
  const d0 = performance.now();
  const decoded = decodesCleanly(file);
  t.note(`decoding every frame took ${((performance.now() - d0) / 1000).toFixed(1)} s`);
  t.check("every frame decodes without an error", decoded.ok, decoded.errors);
  t.check("no partial is left", partialsIn(path.dirname(file)).length === 0);
  await pressInDialog(t.d, "Close");
}

export const scenarios = [
  {
    name: "4k-export-timed",
    group: "heavy",
    heavy: true,
    async run(t) {
      const seconds = 20;
      const { canvas } = await projectWith(t, "4k", [{ file: t.fixtures.busy4k(seconds), at: 0 }]);
      t.check("the canvas took the 4K clip's size", canvas.width === 3840 && canvas.height === 2160, JSON.stringify(canvas));
      await timedExport(t, { label: "4k", width: 3840, height: 2160, seconds, file: path.join(outDir(t), "4k.mp4") });
    },
  },
  {
    name: "ten-minute-export-timed",
    group: "heavy",
    heavy: true,
    async run(t) {
      const clip = 60;
      const copies = 10;
      const p = await t.project("ten minutes");
      const file = t.fixtures.busy(clip);
      const lib = await importFiles(t.d, p, [file]);
      for (let i = 0; i < copies; i++) await place(t.d, p, lib[path.basename(file)], "v1", i * clip * 30);
      await timedExport(t, { label: "ten-minutes", width: 1920, height: 1080, seconds: clip * copies, file: path.join(outDir(t), "ten minutes.mp4") });
    },
  },
];
