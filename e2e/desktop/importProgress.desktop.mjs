// Import progress, driven by a REAL Explorer drop of a 1.75 GB file in the real app.
//
// Two earlier attempts reached into the page with `import("/src/store/...")` and got a FRESH
// module instance under Vite HMR (projectId: null), which proves nothing about the running app.
// The only honest probe is the gesture the user makes and the DOM they see.
//
// The assertion is INTERMEDIATE values: a bar that only ever reads 0% or 100% is
// indistinguishable from no progress at all.
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { appBinary, appProcessName, newSession, root, sleep, startDriver, waitFor } from "./webdriver.mjs";

const BIG = path.join(process.env.USERPROFILE, "Downloads", "Screen-Recording (2).mp4");

const failures = [];
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(label);
};

function raiseAppWindow() {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "raise.ps1"), "-Process", appProcessName()],
    { encoding: "utf8" },
  ).trim();
  const [x, y, state] = out.split(",");
  if (!Number.isFinite(Number(x))) throw new Error(`bad client origin: ${out}`);
  return { x: Number(x), y: Number(y), foreground: state === "fg" };
}

if (!existsSync(BIG)) {
  console.log(`  FAIL fixture missing — ${BIG}`);
  process.exit(1);
}
const mb = (statSync(BIG).size / 1e6).toFixed(0);

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  await waitFor(
    () => s.exec("return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');"),
    { label: "the app to boot" },
  );
  const clickText = (text) =>
    s.exec(
      "const t = arguments[0]; const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t || e.textContent.trim().startsWith(t)); if (!b) throw new Error('no button: ' + t); b.click(); return true;",
      [text],
    );
  await clickText("File");
  await sleep(400);
  await clickText("New Project");
  await sleep(700);
  const nameBox = await waitFor(() => s.find("input[placeholder*='roject']"), { label: "the new-project dialog" });
  await s.type(nameBox, `impprog${Date.now().toString().slice(-5)}`);
  await sleep(300);
  await clickText("Create");
  await waitFor(
    async () => (await s.exec("return document.querySelectorAll(\"[data-artdaddy-drop='library']\").length;")) > 0,
    { label: "the library drop zone" },
  );

  const origin = raiseAppWindow();
  // Informational: osDrop.ps1 refuses to release unless the cursor is over the app window, and
  // that guard (not this one) is what keeps a synthetic drag out of another application.
  console.log(`  info window raise: ${JSON.stringify(origin)}`);
  await sleep(1200);

  const zone = await s.exec(
    "const el = document.querySelector(\"[data-artdaddy-drop='library']\"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: window.devicePixelRatio };",
  );
  if (!zone) throw new Error("no library zone");
  const screenX = Math.round(origin.x + zone.x * zone.dpr);
  const screenY = Math.round(origin.y + zone.y * zone.dpr);

  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "osDrop.ps1"),
      "-File", BIG, "-X", String(screenX), "-Y", String(screenY), "-Process", appProcessName()],
    { encoding: "utf8" },
  ).trim();
  check("the drag was not aborted by the safety guard", !out.includes("ABORT"), out);

  // Sample the rendered indicator for the life of the import.
  const pcts = new Set();
  let sawWidget = false;
  let sawAnalysing = false;
  let sawName = false;
  for (let i = 0; i < 120; i++) {
    const state = await s.exec(
      "const el = document.querySelector('[aria-label=\"importing media\"]');" +
        "if (!el) return null;" +
        "const p = el.querySelector('[data-testid=\"import-pct\"]');" +
        "return JSON.stringify({ pct: p ? p.dataset.pct : '', text: el.textContent });",
    );
    if (typeof state === "string") {
      sawWidget = true;
      const { pct, text } = JSON.parse(state);
      // Read the VALUE, not the rendered string: ".mp4" + "1%" scrapes as "41%".
      if (pct !== "") pcts.add(Number(pct));
      if (/analysing/i.test(text)) sawAnalysing = true;
      if (/Screen-Recording/.test(text)) sawName = true;
    } else if (sawWidget) {
      break; // it appeared and has now cleared
    }
    await sleep(700);
  }

  const sorted = [...pcts].sort((a, b) => a - b);
  console.log(`  info percentages seen: ${sorted.join(",") || "(none)"}`);
  check("the progress indicator appeared during the import", sawWidget, `${mb} MB`);
  check("it showed the file name", sawName, String(sawName));
  // The point: a bar stuck at 0 or jumping straight to 100 would tell the user nothing.
  const mid = sorted.filter((p) => p > 2 && p < 98);
  check("it moved through intermediate percentages", mid.length >= 2, `mid=${mid.join(",")}`);
  check("the percentages only ever increase", sorted.every((p, i) => i === 0 || p >= sorted[i - 1]), sorted.join(","));
  check("it reported the analysing tail as well", sawAnalysing, String(sawAnalysing));
  const gone = async () =>
    (await s.exec(
      "return document.querySelector('[aria-label=\"importing media\"]') ? 'here' : 'cleared';",
    )) === "cleared";
  // Poll it out rather than asserting on the first look: the analysing tail (ffprobe over a
  // 1.75 GB file) legitimately outlasts the byte phase.
  let cleared = await gone();
  for (let i = 0; i < 60 && !cleared; i++) {
    await sleep(1000);
    cleared = await gone();
  }
  check("the indicator cleared when the import ended", cleared, cleared ? "" : "still on screen 60s after the bytes finished");

  console.log(failures.length ? `\n${failures.length} failure(s): ${failures.join(", ")}` : "\nall checks passed");
} finally {
  try {
    await s?.quit();
  } catch {
    /* gone */
  }
  driver.kill();
  await sleep(300);
}
process.exit(failures.length ? 1 : 0);
