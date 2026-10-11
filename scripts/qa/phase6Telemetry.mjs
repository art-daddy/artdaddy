import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";

if (process.argv[2] === "check") {
  const { default: ts } = await import("typescript");
  const input = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(input.config, ts.sys, process.cwd());
  const program = ts.createProgram(
    [...config.fileNames, "scripts/qa/phase6Telemetry.ts"],
    config.options,
  );
  const errors = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (errors.length) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
    process.exit(1);
  }
  console.log("PASS: repo-config typecheck including isolated telemetry QA");
  process.exit(0);
}

assert.equal(process.platform, "win32", "This driver verifies native Windows, not macOS");
const phase7 = process.argv[2] === "phase7";
const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-phase6-"));
const output = path.resolve(`reports/qa/${phase7 ? "phase7" : "phase6"}/native-live`);
await mkdir(output, { recursive: true });
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
const [apiPort, vitePort, mcpPort, cdpPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
  freePort(),
]);
const identifier = `com.artdaddy.qa.phase6-${Date.now()}`;
const backend = `http://127.0.0.1:${apiPort}`;
const url = `http://127.0.0.1:${vitePort}/scripts/qa/phase6Telemetry.html?${new URLSearchParams({ root, identifier, backend, mcp: String(mcpPort), ...(phase7 ? { phase7: "1" } : {}) })}`;
const configPath = path.join(root, "tauri.qa.json");
await writeFile(
  configPath,
  JSON.stringify({
    identifier,
    build: { devUrl: `http://127.0.0.1:${vitePort}`, beforeDevCommand: "", beforeBuildCommand: "" },
    app: {
      windows: [
        {
          label: "main",
          title: "Isolated Phase Six Telemetry QA",
          url,
          width: 1280,
          height: 820,
          additionalBrowserArgs: `--remote-debugging-port=${cdpPort} --autoplay-policy=no-user-gesture-required`,
        },
      ],
    },
    bundle: {
      active: false,
      externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"],
      resources: [],
    },
    plugins: { "deep-link": { desktop: { schemes: ["artdaddy-phase6-qa"] } } },
  }),
);
const children = [];
const logs = [];
const start = (name, executable, args, env = {}) => {
  const log = createWriteStream(path.join(output, `${name}.log`));
  logs.push(log);
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
};
const readyOutput = (child, text) =>
  new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const inspect = (chunk) => {
      output = (output + stripVTControlCharacters(chunk.toString())).slice(-8_000);
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const exited = (code) => failed(new Error(`Startup exited ${code} before ${text}`));
    const timer = setTimeout(() => failed(new Error(`Startup did not report ${text}`)), 60_000);
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", failed);
    child.once("exit", exited);
  });
const changedFile = (filename, accept = () => true) =>
  new Promise((resolve, reject) => {
    let reading = false;
    const watcher = watch(path.dirname(filename), () => void inspect());
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`No QA outcome at ${filename}`));
    }, 120_000);
    const inspect = async () => {
      if (reading) return;
      reading = true;
      try {
        const data = JSON.parse(await readFile(filename, "utf8"));
        if (accept(data)) {
          watcher.close();
          clearTimeout(timer);
          resolve(data);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          watcher.close();
          clearTimeout(timer);
          reject(error);
        }
      } finally {
        reading = false;
      }
    };
    void inspect();
  });
const proof = { root, identifier, paidCalls: 0, steps: [] };
const sourcePaths = [
  "src/api/appEvents.ts",
  "src/api/agentEvents.ts",
  "src/observability/crashWatch.ts",
  "src/observability/sentry.ts",
  "src/components/StagePanel.tsx",
  "src/components/SourceMonitor.tsx",
  "src/tools/host.ts",
  "src/tools/registry.ts",
  "src/mcp/bridge.ts",
  "src/agent/loop.ts",
  "src/store/chat.ts",
  "src-tauri/src/runtime_health.rs",
  "src-tauri/src/reload_guard.rs",
  "src-tauri/src/lib.rs",
  "../Akaru/src/akaru/server/analytics.py",
  "../Akaru/src/akaru/server/schemas.py",
  "../Akaru/src/akaru/server/app.py",
];
if (phase7)
  sourcePaths.push(
    "src/components/ChatView.tsx",
    "src/components/ProjectPicker.tsx",
    "src/store/firstPrompt.ts",
    "src/tools/geminiEncode.ts",
    "src/tools/generation.ts",
    "src/tools/genModels.ts",
    "src/tools/video.ts",
    "src/tools/inspect.ts",
    "src/contract/catalog.json",
    "scripts/qa/phase6Telemetry.ts",
    "scripts/qa/phase6Telemetry.vite.mjs",
    "../Akaru/src/akaru/server/ai_pricing.py",
    "../Akaru/src/akaru/server/pricing_table.py",
    "../Akaru/utils/qa_phase6_telemetry.py",
  );
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(name))
          .digest("hex"),
      ]),
    ),
  );
proof.sourceHashes = await fingerprint();
async function verifyPhase7(page, app) {
  const prompt = "Create a creative Instagram reel";
  await page.locator("#picker-prompt").fill(prompt);
  await page.locator("#picker-prompt").press("Enter");
  await page.waitForFunction(
    (prompt) => window.phase7.paths().projectDir && !window.phase7.chat().streaming &&
      window.phase7.chat().turns.some((turn) => turn.userText === prompt),
    prompt,
  );
  const paths = await page.evaluate(() => window.phase7.paths());
  const relative = path.relative(await realpath(root), await realpath(paths.projectDir));
  await writeFile(path.join(output, "paths.json"), JSON.stringify({ root, ...paths, relative }, null, 2));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const transcript = await changedFile(paths.transcriptPath, (saved) =>
    saved.requests?.some((request) => request.message?.text === prompt),
  );
  assert.equal(transcript.requests.filter((request) => request.message?.text === prompt).length, 1);
  const before = await readFile(paths.timelinePath);
  assert.ok(JSON.parse(before).tracks.every((track) => track.clips.length === 0));
  await copyFile(paths.transcriptPath, path.join(output, "first-request.json"));
  await writeFile(path.join(output, "timeline-before.json"), before);
  proof.steps.push(
    "actual start-screen Enter sent and persisted one first request in an empty project without a second click",
  );
  const rpc = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e8),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  const ffmpeg = path.resolve("src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
  const source = path.join(root, "phase7-pattern.mp4");
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=12:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      source,
    ],
    { stdio: "ignore" },
  );
  const sourceHash = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  const imported = await rpc("import_media", { source: { path: source } });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const callsBefore = await page.evaluate(() => (globalThis.phase7Sidecars ?? []).length);
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      rpc("video_find_moment", {
        media_ref: imported.media_ref,
        query: `Find opening pattern ${index}`,
      }),
    ),
  );
  assert.ok(results.every((result) => result.ok === true));
  const sidecars = await page.evaluate(() => globalThis.phase7Sidecars ?? []);
  const encodes = sidecars
    .slice(callsBefore)
    .filter(
      (call) =>
        call.program.includes("ffmpeg") &&
        call.args.some((arg) => /encode-[a-f0-9-]+\.mp4$/.test(arg)),
    );
  assert.equal(encodes.length, 1);
  const requests = await (await fetch(`${backend}/qa/requests`)).json();
  const vision = requests.filter((request) => request.path === "/ai/vision_video");
  assert.equal(vision.length, 4);
  const samples = vision.map((request) => request.body.media.video.b64);
  assert.ok(samples.every((sample) => sample === samples[0]));
  const encoded = path.join(output, "shared-video.mp4");
  await writeFile(encoded, Buffer.from(samples[0], "base64"));
  const decoded = execFileSync(ffmpeg, ["-v", "error", "-i", encoded, "-f", "framemd5", "-"], {
    encoding: "utf8",
  });
  const hashes = decoded
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1).trim());
  assert.ok(hashes.length >= 2 && new Set(hashes).size > 1);
  assert.equal(
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    sourceHash,
  );
  await writeFile(path.join(output, "sidecars.json"), JSON.stringify(sidecars, null, 2));
  await writeFile(path.join(output, "search-results.json"), JSON.stringify(results, null, 2));
  proof.steps.push(
    "four real MCP searches shared one native ffmpeg encode and identical complete video bytes with changing decoded frames",
  );
  const refused = await rpc("generate_image", {
    prompt: "Create a headshot",
    model: "mai-image-2.5",
    reference_images: ["first.png", "second.png"],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /1 reference image/);
  const listed = await rpc("list_models", { type: "image" });
  assert.equal(listed.models.find((model) => model.id === "mai-image-2.5").max_reference_images, 1);
  const lookup = await rpc("inspect_media", { clip_id: "missing" });
  assert.equal(lookup.ok, false);
  assert.match(lookup.error, /media_ref/);
  const url = await rpc("video_ask", {
    media_ref: "https://example.invalid/video.mp4",
    prompt: "Describe it",
  });
  assert.equal(url.ok, false);
  assert.match(url.error, /returned media_ref/);
  assert.doesNotMatch(url.error, /local path|file paths/i);
  const afterRequests = await (await fetch(`${backend}/qa/requests`)).json();
  assert.equal(afterRequests.filter((request) => request.path === "/ai/generate_image").length, 0);
  assert.equal(
    afterRequests.filter(
      (request) =>
        request.path === "/inference/stream" &&
        request.body.round_input?.user_text?.includes(prompt),
    ).length,
    1,
  );
  assert.deepEqual(await readFile(paths.timelinePath), before);
  await writeFile(path.join(output, "timeline-after.json"), await readFile(paths.timelinePath));
  await writeFile(
    path.join(output, "refusals.json"),
    JSON.stringify({ refused, listed, lookup, url }, null, 2),
  );
  await page.screenshot({ path: path.join(output, "phase7-app.png") });
  proof.steps.push(
    "real MCP reference overflow and lookup/URL errors refused before generation, with unchanged timeline bytes",
  );
  const exited = new Promise((resolve) => app.once("exit", resolve));
  await page.evaluate(() => void window.phase7.close()).catch(() => undefined);
  await exited;
  assert.deepEqual(await fingerprint(), proof.sourceHashes, "Source changed during Phase 7 QA");
  proof.phase = 7;
  proof.ok = true;
  await writeFile(path.join(output, "proof.json"), JSON.stringify(proof, null, 2));
  console.log("PASS", JSON.stringify(proof));
}
let browser;
const connections = [];
try {
  const server = start("server", path.resolve("../Akaru/.venv/Scripts/python.exe"), [
    path.resolve("../Akaru/utils/qa_phase6_telemetry.py"),
    "--port",
    String(apiPort),
    "--report",
    path.join(output, "rows.json"),
    ...(phase7 ? ["--phase7"] : []),
  ]);
  await readyOutput(server, "QA_READY");
  const vite = start(
    "vite",
    process.execPath,
    [
      path.resolve("node_modules/vite/bin/vite.js"),
      "--config",
      "scripts/qa/phase6Telemetry.vite.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    {
      VITE_API_BASE_URL: backend,
      VITE_SENTRY_DSN: "",
      VITE_E2E_AUTH_BYPASS: "1",
      ARTDADDY_PHASE6_DATA_DIR: root,
    },
  );
  await readyOutput(vite, "Local:");
  const { chromium } = await import("playwright");
  const warmup = await chromium.launch();
  try {
    const page = await warmup.newPage();
    await page.goto(`${url}&warmup=1`, { waitUntil: "load", timeout: 300_000 });
    assert.equal(
      await page.evaluate(() => globalThis.phase6BootCheckpoint),
      "module-loaded",
      "QA module did not execute during warmup",
    );
  } finally {
    await warmup.close();
  }
  let launches = 0;
  const startApp = () =>
    start(
      `native-${++launches}`,
      process.execPath,
      [
        path.resolve("node_modules/@tauri-apps/cli/tauri.js"),
        "dev",
        "--no-watch",
        "--config",
        configPath,
      ],
      {
        VITE_API_BASE_URL: backend,
        VITE_SENTRY_DSN: "",
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      },
    );
  let app = startApp();
  let ready;
  try {
    ready = await changedFile(path.join(root, "ready.json"));
  } catch (error) {
    const diagnostic = await chromium
      .connectOverCDP(`http://127.0.0.1:${cdpPort}`)
      .catch(() => null);
    if (diagnostic) {
      connections.push(diagnostic);
      const page = diagnostic.contexts()[0].pages()[0];
      await writeFile(
        path.join(output, "boot-failure.json"),
        JSON.stringify(
          await page.evaluate(() => ({
            url: location.href,
            checkpoint: globalThis.phase6BootCheckpoint,
            errors: globalThis.phase6BootErrors ?? [],
            text: document.body.innerText,
            resources: performance
              .getEntriesByType("resource")
              .map((entry) => ({ name: entry.name, duration: entry.duration })),
          })),
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(output, "boot-failure.png") });
    }
    throw error;
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  connections.push(browser);
  let page = browser.contexts()[0].pages()[0];
  if (phase7) {
    await page.waitForFunction(() => window.phase7?.ready);
    await verifyPhase7(page, app);
  } else {
    await page.waitForFunction(() => window.phase6?.ready);
    const before = await page.evaluate(() => window.phase6.timeline());
    await writeFile(path.join(output, "timeline-before.json"), before);
    const rows = async () => (await fetch(`${backend}/qa/rows`)).json();
    await page.evaluate(() => window.phase6.checking());
    assert.equal(
      (await rows()).filter((row) => row.reason === "phase6 early startup witness").length,
      0,
    );
    await page.evaluate(() => window.phase6.signIn());
    assert.equal(
      (await rows()).filter((row) => row.reason === "phase6 early startup witness").length,
      1,
    );
    proof.steps.push("late sign-in stored one early event");
    const rpc = async (name, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1e8),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      proof.rpcReplies ??= [];
      proof.rpcReplies.push({ name, result });
      await writeFile(
        path.join(output, "rpc-replies.json"),
        JSON.stringify(proof.rpcReplies, null, 2),
      );
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result;
    };
    await rpc("get_timeline");
    await rpc("manage_project", { action: "current" });
    await rpc("not_an_offered_tool");
    await changedFile(path.join(output, "rows.json"), (saved) =>
      saved.some((row) => row.surface === "mcp" && row.events?.length >= 3),
    );
    const external = (await rows())
      .filter((row) => row.surface === "mcp")
      .flatMap((row) => row.events);
    assert.equal(
      external.filter((event) => event.name === "not_an_offered_tool" && event.ok === false).length,
      1,
    );
    proof.steps.push("real MCP socket batched calls with correct labels and refusal");
    await page
      .getByPlaceholder("Message the editor…")
      .fill("Phase six read the timeline then fail");
    await page.getByPlaceholder("Message the editor…").press("Enter");
    await changedFile(path.join(output, "rows.json"), (saved) =>
      saved.some(
        (row) =>
          row.surface === "app" && row.events?.some((event) => event.call_id === "phase6_app_read"),
      ),
    );
    assert.equal(await page.evaluate(() => window.phase6.timeline()), before);
    await writeFile(
      path.join(output, "timeline-after-read.json"),
      await page.evaluate(() => window.phase6.timeline()),
    );
    proof.timelineSha256 = createHash("sha256").update(before).digest("hex");
    proof.steps.push(
      "real composer retained tool trace after synthetic model failure; timeline bytes unchanged",
    );
    await page.evaluate(() => window.phase6.clock(7_200));
    await rpc("get_timeline");
    await changedFile(path.join(output, "rows.json"), (saved) =>
      saved.some((row) => row.clock_offset_s < -7_000),
    );
    const shifted = (await rows()).find((row) => row.clock_offset_s < -7_000);
    assert.ok(Math.abs(shifted.created_at - shifted.events[0].at) < 10);
    await page.evaluate(() => window.phase6.clock(0));
    proof.steps.push("two-hour client drift corrected in actual saved row");
    await page.screenshot({ path: path.join(output, "app-trace.png") });
    const audioPath = path.join(root, "qa-mono.wav");
    execFileSync(
      path.resolve("src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe"),
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-ac",
        "1",
        "-ar",
        "48000",
        audioPath,
      ],
      { stdio: "ignore" },
    );
    const audioHash = createHash("sha256")
      .update(await readFile(audioPath))
      .digest("hex");
    const imported = await rpc("import_media", { source: { path: audioPath } });
    const importedBody = JSON.parse(imported.result.content[0].text);
    assert.equal(importedBody.ok, true, JSON.stringify(importedBody));
    await page.evaluate((ref) => window.phase6.openSource(ref), importedBody.media_ref);
    await page.locator("audio").waitFor({ state: "attached" });
    await page.locator("audio").evaluate((audio) => {
      audio.muted = true;
    });
    await page.getByRole("button", { name: "play", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector("audio")?.currentTime ?? 0) > 0.1);
    const playingRecord = await changedFile(
      ready.healthPath,
      (saved) => saved.current.context.activity === "source-playback",
    );
    await writeFile(path.join(output, "health-source-playing.json"), JSON.stringify(playingRecord));
    await page.getByRole("button", { name: "pause", exact: true }).click();
    const pausedRecord = await changedFile(
      ready.healthPath,
      (saved) => saved.current.context.activity !== "source-playback",
    );
    await writeFile(path.join(output, "health-source-paused.json"), JSON.stringify(pausedRecord));
    assert.equal(
      createHash("sha256")
        .update(await readFile(audioPath))
        .digest("hex"),
      audioHash,
    );
    await page.evaluate(() => window.phase6.openSource(null));
    proof.steps.push(
      "actual mono-audio source playback advanced and its native activity cleared on pause; source bytes unchanged",
    );
    const oldReady = JSON.parse(await readFile(path.join(root, "ready.json"), "utf8"));
    await page.evaluate(() => window.phase6.prepareCrash());
    const session = await page.context().newCDPSession(page);
    void session.send("Page.crash").catch(() => undefined);
    await changedFile(path.join(root, "ready.json"), (value) => value.at > oldReady.at);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    connections.push(browser);
    page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => window.phase6?.ready);
    await changedFile(path.join(output, "rows.json"), (saved) =>
      saved.some((row) => row.via === "renderer_exited"),
    );
    const recovered = await page.evaluate(() => window.phase6.health());
    assert.equal(recovered.failures.length, 0);
    await copyFile(ready.healthPath, path.join(output, "health-after-recovery.json"));
    proof.steps.push(
      "actual WebView2 death reloaded and its observed failure was stored then acknowledged",
    );
    const nativeCount = (await rows()).filter((row) => row.event_id).length;
    const exited = new Promise((resolve) => app.once("exit", resolve));
    await page.evaluate(() => void window.phase6.close()).catch(() => undefined);
    await exited;
    const clean = JSON.parse(await readFile(ready.healthPath, "utf8"));
    assert.equal(clean.current.exit, "quit");
    await copyFile(ready.healthPath, path.join(output, "health-after-quit.json"));
    await browser.close().catch(() => undefined);
    browser = null;
    const lastReady = JSON.parse(await readFile(path.join(root, "ready.json"), "utf8"));
    app = startApp();
    await changedFile(path.join(root, "ready.json"), (value) => value.at > lastReady.at);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    connections.push(browser);
    page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => window.phase6?.ready);
    assert.equal((await rows()).filter((row) => row.event_id).length, nativeCount);
    proof.steps.push("native clean quit and relaunch emitted no false crash");
    const finalExit = new Promise((resolve) => app.once("exit", resolve));
    await page.evaluate(() => void window.phase6.close()).catch(() => undefined);
    await finalExit;
    proof.ok = true;
    assert.deepEqual(
      await fingerprint(),
      proof.sourceHashes,
      "Source changed during native verification",
    );
    await writeFile(path.join(output, "proof.json"), JSON.stringify(proof, null, 2));
    console.log("PASS", JSON.stringify(proof));
  }
} finally {
  await browser?.close().catch(() => undefined);
  for (const connection of connections) await connection.close().catch(() => undefined);
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }
  }
  for (const log of logs) log.end();
}
