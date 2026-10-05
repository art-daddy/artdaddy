// Screenshot the app at given playhead times, to look at the PREVIEW itself (the webview's own
// compositor) rather than at inspect_timeline, which renders with the EXPORT's graph. The two are
// separate renderers, so a preview defect is invisible to every render-side check.
//
//   node --experimental-websocket scripts/qa/previewShots.mjs <seconds> [<seconds> ...]
//
// Writes %TEMP%/preview_<s>s.png for each time, for the project open in the dev app.
import path from "node:path";

import { open } from "../uisweep/lib/driver.mjs";

const times = process.argv
  .slice(2)
  .map(Number)
  .filter((t) => Number.isFinite(t) && t >= 0);
if (!times.length) {
  console.log("usage: previewShots.mjs <seconds> [<seconds> ...]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = await open();
const dir = await d.eval(`window.__artdaddyTest?.editor?.getState?.()?.store?.projectDir ?? null`);
console.log(`project: ${dir}`);
for (const t of times) {
  await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${t})`);
  await sleep(2500); // resolve + decode + draw; a cold source takes the longest
  const file = path.join(process.env.TEMP ?? process.env.TMPDIR ?? ".", `preview_${t}s.png`);
  await d.screenshot(file);
  console.log(file);
}
process.exit(0);
