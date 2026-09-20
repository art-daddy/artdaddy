// Real-browser audio lane.
//
//   npm run test:audio
//
// WHY THIS EXISTS: the meter MATHS (src/preview/meter.ts) is pure and well covered, but the
// meter GRAPH is not, and the graph is where the bug was. `audioEngine.test.ts` uses a fake
// AudioContext whose createChannelSplitter() is a stub, so it cannot represent a channel count
// — and a mono file's right meter sat dead at 0% for every user with the suite green.
//
// Two probes run here:
//   * the metering graph, against synthesized channel layouts;
//   * the WHOLE PreviewAudio engine — real .wav files decoded by the browser, scheduled,
//     faded and mixed — measured on the buffer that would have reached the output device.
//
// jsdom/happy-dom have no Web Audio, so this has to leave the unit process. It bundles
// src/preview/__audioProbe.ts (which calls the PRODUCTION code), serves it, and runs it in
// headless Chromium over raw CDP. No Playwright, no new dependency — the same dependency-free
// approach as scripts/cdp.mjs.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "reports", "audiolane");

const BROWSERS = [
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "ms-playwright",
    "chromium-1223",
    "chrome-win64",
    "chrome.exe",
  ),
  path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.ProgramFiles ?? "", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findBrowser() {
  const found = BROWSERS.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      `no Chromium-family browser found. Looked in:\n  ${BROWSERS.filter(Boolean).join("\n  ")}`,
    );
  }
  return found;
}

async function bundleProbe() {
  const result = await build({
    entryPoints: [path.join(ROOT, "src/preview/__audioProbe.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome110",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

function serve(js) {
  const html = `<!doctype html><meta charset="utf-8"><title>audio probe</title><script>${js}</script>`;
  const media = makeFixtures();
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const wav = media[(req.url ?? "").replace(/^\//, "")];
      if (wav) {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(wav);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    // Port 0 = let the OS pick, so the lane can never collide with a dev server.
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }),
    );
  });
}

function bundledFfmpeg() {
  const dir = path.join(ROOT, "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? ["artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["artdaddy-ffmpeg-aarch64-apple-darwin", "artdaddy-ffmpeg-x86_64-apple-darwin"]
        : ["artdaddy-ffmpeg-x86_64-unknown-linux-gnu"];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

/** SYNTHESIZED, never committed: a fixture made by hand can encode the same misreading as the
 *  code it is meant to catch. Mono is one channel at MONO_AMP; stereo is deliberately asymmetric
 *  so a collapse to mono cannot pass for correct.
 *
 *  ffmpeg's `sine` source is NOT full-scale (measured -18.1 dBFS with this build), so the
 *  fixtures are calibrated against a measured reference and then VERIFIED — a fixture whose
 *  level I merely assumed would quietly weaken every rule that reads it. */
const MONO_AMP = 0.5;
const STEREO_L = 0.5;
const STEREO_R = 0.125;
const SINE = "sine=frequency=440:duration=3:sample_rate=48000";

function makeFixtures() {
  const ff = bundledFfmpeg();
  if (!ff) throw new Error("no bundled ffmpeg in src-tauri/binaries — cannot synthesize fixtures");
  const dir = mkdtempSync(path.join(tmpdir(), "artdaddy-audiofx-"));
  const raw = path.join(dir, "raw.wav");
  const mono = path.join(dir, "mono.wav");
  const stereo = path.join(dir, "stereo.wav");
  const ffmpeg = (args) => {
    const r = spawnSync(ff, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr ?? "").slice(-500)}`);
    return r.stderr ?? "";
  };
  /** Peak of ONE channel, linear. */
  const peak = (file, ch) => {
    const err = ffmpeg([
      "-hide_banner",
      "-i",
      file,
      "-af",
      `pan=mono|c0=c${ch},volumedetect`,
      "-f",
      "null",
      "-",
    ]);
    const m = err.match(/max_volume:\s*(-?[\d.]+) dB/);
    if (!m) throw new Error(`could not measure ${path.basename(file)} channel ${ch}`);
    return 10 ** (Number(m[1]) / 20);
  };

  ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    SINE,
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    raw,
  ]);
  const g = 1 / peak(raw, 0); // gain that takes this generator to full scale

  ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    SINE,
    "-af",
    `volume=${g * MONO_AMP}`,
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    mono,
  ]);
  ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-filter_complex",
    `${SINE},volume=${g * STEREO_L}[l];` +
      `sine=frequency=660:duration=3:sample_rate=48000,volume=${g * STEREO_R}[r];` +
      "[l][r]join=inputs=2:channel_layout=stereo[a]",
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    stereo,
  ]);

  // The fixtures ARE what the rules assume. volumedetect reports to 0.1 dB, hence the 2%.
  const near = (got, want, what) => {
    if (Math.abs(got - want) / want > 0.02)
      throw new Error(
        `fixture ${what} is ${got.toFixed(4)}, expected ${want} — the rules would be wrong`,
      );
  };
  near(peak(mono, 0), MONO_AMP, "mono");
  near(peak(stereo, 0), STEREO_L, "stereo left");
  near(peak(stereo, 1), STEREO_R, "stereo right");

  const out = { "mono.wav": readFileSync(mono), "stereo.wav": readFileSync(stereo) };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Chromium writes its chosen debugging port here once it is listening. */
async function waitForPort(userDataDir, timeoutMs = 30_000) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = readFileSync(file, "utf8").split("\n")[0].trim();
      if (port) return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("browser never reported a debugging port");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          id += 1;
          const mid = id;
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      });
  });
}

async function measureInBrowser(pageUrl) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "artdaddy-audiolane-"));
  const proc = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      pageUrl,
    ],
    { stdio: "ignore" },
  );
  try {
    const port = await waitForPort(userDataDir);
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("browser opened no page target");
    const cdp = await connect(page.webSocketDebuggerUrl);
    // The bundle may still be evaluating when the target appears.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ready = await cdp.send("Runtime.evaluate", {
        expression:
          "typeof window.__audioProbe === 'function' && typeof window.__audioRender === 'function'",
        returnByValue: true,
      });
      if (ready.result?.value === true) break;
      if (Date.now() > deadline) throw new Error("probe never installed its entry points");
      await new Promise((r) => setTimeout(r, 100));
    }
    const evaluate = async (expression) => {
      const out = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (out.exceptionDetails) {
        throw new Error(`probe threw: ${JSON.stringify(out.exceptionDetails).slice(0, 800)}`);
      }
      return out.result.value;
    };
    const taps = await evaluate("window.__audioProbe()");
    const render = await evaluate(
      `window.__audioRender({ mono: "${pageUrl}mono.wav", stereo: "${pageUrl}stereo.wav" })`,
    );
    cdp.close();
    return { taps, render };
  } finally {
    proc.kill();
    // Chromium releases its profile lock asynchronously; a failed cleanup must not mask the
    // measurement we came here for.
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* a stray temp profile is cheaper than a false failure */
    }
  }
}

// ---------------------------------------------------------------------------
// The rules. Each one is a claim about what the user hears, not about the graph's shape.
// ---------------------------------------------------------------------------
const LOUD = 0.4; // a 0.5-amplitude tone must read at least this
const QUIET = 0.02; // a channel with no signal must stay under this

/** @param {import("../../src/preview/__audioProbe").AudioProbeResult} m */
function rules(m) {
  const [ml, mr] = m.mono;
  const [sl, sr] = m.stereo;
  return [
    // THE regression. A mono file is one channel; the meter shows two.
    ["a mono source lights BOTH meters", ml > LOUD && mr > LOUD, `mono=${m.mono}`],
    ["a mono source reads the SAME on both", Math.abs(ml - mr) < 0.01, `mono=${m.mono}`],

    // The failure direction of that fix: collapsing everything to mono would satisfy the two
    // rules above and destroy the meter. A real stereo source must stay apart.
    ["a stereo source keeps its sides apart", sl - sr > 0.15, `stereo=${m.stereo}`],
    [
      "the louder side is the left one here",
      sl > LOUD && sr > 0.15 && sr < 0.35,
      `stereo=${m.stereo}`,
    ],

    // The up-mix must not bleed a hard-panned signal across.
    [
      "hard left leaves the right meter silent",
      m.hardLeft[0] > LOUD && m.hardLeft[1] < QUIET,
      `hardLeft=${m.hardLeft}`,
    ],
    [
      "hard right leaves the left meter silent",
      m.hardRight[1] > LOUD && m.hardRight[0] < QUIET,
      `hardRight=${m.hardRight}`,
    ],

    // Silence must read as silence, or "both meters lit" above proves nothing.
    [
      "silence reads silent on both",
      m.silence[0] < QUIET && m.silence[1] < QUIET,
      `silence=${m.silence}`,
    ],

    // More channels than the meter has: down-mix, never throw and never zero.
    [
      "a 5.1 source still reads on both",
      m.fiveOne[0] > LOUD && m.fiveOne[1] > LOUD,
      `fiveOne=${m.fiveOne}`,
    ],
  ];
}

// ---------------------------------------------------------------------------
// The whole engine: real .wav files, decoded and scheduled by PreviewAudio, measured on the
// buffer that would have reached the output device.
//
// The project (see __audioProbe.ts): a MONO clip 0.5-2.0s with 0.5s fades; a STEREO clip
// 2.5-4.0s at volume 0.5; a MONO clip 4.5-6.0s whose volume ramps 0 -> 1 by keyframe.
// ---------------------------------------------------------------------------
function renderRules(r) {
  // Peak at timeline second `t` on each side. The +leadSec is the schedule offset play() adds.
  const at = (t) => {
    const i = Math.floor((t + r.leadSec) / r.windowSec);
    return [r.left[i] ?? 0, r.right[i] ?? 0];
  };
  const max = (a, b) => Math.max(a, b);
  const lvl = (t) => max(...at(t));

  const monoMid = at(1.25);
  const stereoMid = at(3.25);
  return [
    // Decode + scheduling: sound exists only where a clip is.
    ["silent before the first clip", lvl(0.2) < 0.01, `t0.2=${at(0.2)}`],
    ["silent in the gap between clips", lvl(2.2) < 0.01, `t2.2=${at(2.2)}`],
    ["silent after the last clip", lvl(6.2) < 0.01, `t6.2=${at(6.2)}`],
    ["the mono clip sounds where it was placed", lvl(1.25) > 0.3, `t1.25=${monoMid}`],

    // The mono bug, at the OUTPUT this time rather than at the meter.
    [
      "a mono source reaches BOTH output channels",
      monoMid[0] > 0.3 && monoMid[1] > 0.3 && Math.abs(monoMid[0] - monoMid[1]) < 0.02,
      `t1.25=${monoMid}`,
    ],

    // Fades: two points that must DIFFER, and in the right direction.
    [
      "the fade-in ramps up",
      lvl(0.65) > 0.02 && lvl(0.65) < lvl(1.25) * 0.6,
      `t0.65=${at(0.65)} t1.25=${monoMid}`,
    ],
    [
      "the fade-out ramps down",
      lvl(1.85) > 0.02 && lvl(1.85) < lvl(1.25) * 0.6,
      `t1.85=${at(1.85)} t1.25=${monoMid}`,
    ],
    [
      "the fade is not just an on/off gate",
      lvl(0.65) > 0.02 && lvl(1.85) > 0.02,
      `t0.65=${at(0.65)} t1.85=${at(1.85)}`,
    ],

    // Constant volume actually attenuates: the source's left is 0.5, the clip asks for 0.5.
    [
      "volume 0.5 halves the source",
      stereoMid[0] > 0.2 && stereoMid[0] < 0.3,
      `t3.25=${stereoMid}`,
    ],
    // ...and the stereo image survives the whole engine, not just the tap.
    [
      "the stereo clip keeps its sides apart",
      stereoMid[0] - stereoMid[1] > 0.1,
      `t3.25=${stereoMid}`,
    ],

    // A volume CURVE is the property; sampling one point of it is not. Three rising points.
    [
      "the volume curve ramps across the clip",
      lvl(4.7) < lvl(5.2) && lvl(5.2) < lvl(5.8) && lvl(5.8) > 0.3,
      `t4.7=${lvl(4.7).toFixed(3)} t5.2=${lvl(5.2).toFixed(3)} t5.8=${lvl(5.8).toFixed(3)}`,
    ],
    [
      "the curve starts near its first keyframe (0), not at full",
      lvl(4.7) < 0.15,
      `t4.7=${at(4.7)}`,
    ],
  ];
}

async function main() {
  const js = await bundleProbe();
  const server = await serve(js);
  let measured;
  try {
    measured = await measureInBrowser(server.url);
  } finally {
    server.close();
  }

  const checks = [...rules(measured.taps), ...renderRules(measured.render)];
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  }
  const failed = checks.filter(([, ok]) => !ok);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "audio.json"),
    JSON.stringify(
      {
        when: new Date().toISOString(),
        taps: measured.taps,
        render: measured.render,
        checks: checks.map(([n, ok, d]) => ({ name: n, ok, detail: d })),
      },
      null,
      2,
    ),
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
