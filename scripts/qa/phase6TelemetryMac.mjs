import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

assert.equal(process.platform, "darwin", "This verifies the native macOS app");
assert.ok(process.env.CI, "Run this isolated native-quit/process-death driver in CI only");
const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-phase6-"));
const output = path.resolve("reports/qa/phase6/native-macos");
await mkdir(output, { recursive: true });
const identifier = `com.artdaddy.qa.phase6-${Date.now()}`;
const rows = [];
const requests = [];
const sink = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  response.setHeader("Content-Type", "application/json");
  const reply = (status, value, type = "application/json") => {
    response.writeHead(status, { "Content-Type": type });
    response.end(typeof value === "string" ? value : JSON.stringify(value));
  };
  if (request.method === "OPTIONS") return reply(200, {});
  if (request.method === "GET") {
    if (request.url === "/qa/rows") return reply(200, rows);
    if (request.url === "/me")
      return reply(200, {
        user_id: "phase6_qa",
        email: "qa@example.invalid",
        display_name: "Local QA",
        metered: false,
      });
    if (request.url === "/auth/verify") return reply(200, { ok: true });
    if (request.url === "/usage")
      return reply(200, { limit: 1000, used: 0, remaining: 1000, over: false });
    return reply(404, {});
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (request.url === "/auth/desktop/refresh") {
    const claims = Buffer.from(
      JSON.stringify({
        sub: "phase6_qa",
        email: "qa@example.invalid",
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 3600,
      }),
    ).toString("base64url");
    return reply(200, {
      access_token: `qa.${claims}.not-a-real-signature`,
      refresh_token: "phase6-local-refresh",
      expires_in: 3600,
    });
  }
  if (request.url === "/inference/stream") {
    const first = Boolean(body.round_input?.user_text);
    const result = {
      kind: first ? "tool_calls" : "error",
      pending_calls: first
        ? [{ name: "get_timeline", call_id: "phase6_app_read", arguments: {} }]
        : [],
      error: first ? "" : "Synthetic model connection lost",
      usage: {},
      provider_snapshot: {},
    };
    return reply(200, `event: result\ndata: ${JSON.stringify(result)}\n\n`, "text/event-stream");
  }
  if (request.url === "/telemetry/app" || request.url === "/telemetry/agent") {
    const key = body.event_id;
    if (!key || !rows.some((row) => row.event_id === key))
      rows.push({ ...body, user_id: "phase6_qa", received_at: Date.now() / 1000 });
    requests.push({ path: request.url, body });
    await writeFile(path.join(output, "rows.json"), JSON.stringify(rows, null, 2));
    await writeFile(path.join(output, "requests.json"), JSON.stringify(requests, null, 2));
    return reply(200, { ok: true, status: "ok" });
  }
  reply(403, { error: "Paid and production endpoints disabled" });
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
const backend = `http://127.0.0.1:${sink.address().port}`;
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const vitePort = await freePort();
const mcpPort = await freePort();
const url = `http://127.0.0.1:${vitePort}/scripts/qa/phase6Telemetry.html?${new URLSearchParams({ root, identifier, backend, mcp: String(mcpPort), mac: "1" })}`;
const config = path.join(root, "tauri.qa.json");
await writeFile(
  config,
  JSON.stringify({
    identifier,
    build: { devUrl: `http://127.0.0.1:${vitePort}`, beforeDevCommand: "", beforeBuildCommand: "" },
    app: {
      windows: [
        { label: "main", title: "Isolated macOS Telemetry QA", url, width: 1280, height: 820 },
      ],
    },
    bundle: {
      active: false,
      externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"],
      resources: [],
      macOS: { signingIdentity: "-" },
    },
    plugins: { "deep-link": { desktop: { schemes: ["artdaddy-phase6-qa"] } } },
  }),
);
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const audioPath = path.join(root, "qa-mono.wav");
execFileSync(
  path.resolve(`src-tauri/binaries/artdaddy-ffmpeg-${triple}`),
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
await mkdir(path.join(os.homedir(), "Library", "Application Support", "ArtDaddy"), {
  recursive: true,
});
const children = [];
const logs = [];
const start = (name, args, env) => {
  const log = createWriteStream(path.join(output, `${name}.log`));
  logs.push(log);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
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
    let combined = "";
    const finish = () => {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
    };
    const inspect = (chunk) => {
      combined += stripVTControlCharacters(chunk.toString());
      if (combined.includes(text)) {
        finish();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`Startup did not reach ${text}`));
    }, 60_000);
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
  });
const fileReady = (filename, accept = () => true) =>
  new Promise((resolve, reject) => {
    let reading = false;
    const listener = watch(path.dirname(filename), () => void inspect());
    const finish = () => {
      clearTimeout(timeout);
      listener.close();
    };
    const inspect = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = JSON.parse(await readFile(filename, "utf8"));
        if (accept(value)) {
          finish();
          resolve(value);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          finish();
          reject(error);
        }
      } finally {
        reading = false;
      }
    };
    const timeout = setTimeout(async () => {
      finish();
      const failure = await readFile(path.join(root, "failure.json"), "utf8").catch(() => "");
      reject(new Error(`No native outcome at ${filename}: ${failure}`));
    }, 180_000);
    void inspect();
  });
const contentProcesses = () => {
  try {
    return execFileSync("pgrep", ["-f", "com.apple.WebKit.WebContent"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
};
const waitExit = (child) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native app did not exit")), 60_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Native exit ${code}`));
    });
  });
const quit = async (child, healthPath) => {
  const record = JSON.parse(await readFile(healthPath, "utf8"));
  const match = /^launch-[a-f0-9]+-([a-f0-9]+)$/.exec(record.current.launch_id);
  assert.ok(match, "Native launch identity did not contain its process");
  const pid = Number.parseInt(match[1], 16);
  const exited = waitExit(child);
  execFileSync(
    "swift",
    [
      "-e",
      `import AppKit\nlet pid = Int32(CommandLine.arguments.last!)!\nguard let app = NSRunningApplication(processIdentifier: pid), app.terminate() else { fatalError("Native quit was refused") }`,
      String(pid),
    ],
    { stdio: "inherit" },
  );
  await exited;
};
const rendererOwners = (pids) =>
  JSON.parse(
    execFileSync(
      "swift",
      [
        "-e",
        `import Foundation
import Darwin
typealias ResponsibleProcess = @convention(c) (Int32) -> Int32
guard let handle = dlopen(nil, RTLD_LAZY), let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else { fatalError("Cannot establish WebContent ownership") }
let responsible = unsafeBitCast(symbol, to: ResponsibleProcess.self)
let owners = CommandLine.arguments.dropFirst().compactMap { Int32($0) }.map { ["pid": Int($0), "owner": Int(responsible($0))] }
print(String(data: try JSONSerialization.data(withJSONObject: owners), encoding: .utf8)!)`,
        ...pids.map(String),
      ],
      { encoding: "utf8" },
    ),
  );
const proof = {
  root,
  identifier,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  os: os.release(),
  arch: process.arch,
  paidCalls: 0,
  backend: "local HTTP recorder; server transforms verified separately",
  steps: [],
};
try {
  const vite = start(
    "vite",
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
  const { chromium } = createRequire(path.resolve("reports/qa/phase6/browser/package.json"))(
    "playwright",
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${url}&warmup=1`, { waitUntil: "load", timeout: 300_000 });
    assert.equal(await page.evaluate(() => globalThis.phase6BootCheckpoint), "module-loaded");
  } finally {
    await browser.close();
  }
  const oldContent = new Set(contentProcesses());
  let launches = 0;
  const startApp = () =>
    start(
      `native-${++launches}`,
      [
        path.resolve("node_modules/@tauri-apps/cli/tauri.js"),
        "dev",
        "--no-watch",
        "--config",
        config,
      ],
      { VITE_API_BASE_URL: backend, VITE_SENTRY_DSN: "" },
    );
  let app = startApp();
  let ready = await fileReady(path.join(root, "ready.json"));
  const ui = await fileReady(path.join(root, "mac-ui-proof.json"));
  await copyFile(path.join(root, "mac-ui-proof.json"), path.join(output, "mac-ui-proof.json"));
  assert.equal(ui.ok, true);
  assert.ok(ui.playedSeconds > ui.sourceStartTime + 0.1);
  assert.equal(ui.recoveryUrl, url);
  assert.equal(ui.playing.current.context.activity, "source-playback");
  assert.notEqual(ui.paused.current.context.activity, "source-playback");
  assert.equal(
    createHash("sha256")
      .update(await readFile(audioPath))
      .digest("hex"),
    audioHash,
  );
  assert.deepEqual(
    await readFile(path.join(root, "timeline-before.json")),
    await readFile(path.join(root, "timeline-after-read.json")),
  );
  proof.steps.push(
    "native composer trace survived failed synthetic round; actual mono source played and paused; source and timeline bytes unchanged",
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
    return reply.result;
  };
  assert.equal((await rpc("get_timeline")).isError, false);
  assert.equal((await rpc("manage_project", { action: "current" })).isError, false);
  assert.equal((await rpc("not_an_offered_tool")).isError, true);
  await fileReady(path.join(output, "rows.json"), (saved) =>
    saved.some(
      (row) =>
        row.surface === "mcp" &&
        row.events?.some((event) => event.name === "not_an_offered_tool" && event.ok === false),
    ),
  );
  assert.equal(rows.filter((row) => row.reason === "phase6 early startup witness").length, 1);
  const traces = rows.filter((row) => row.surface === "mcp");
  assert.ok(
    traces.every(
      (row) => row.project_id === ready.projectId && row.model === "" && row.transcript_id === "",
    ),
  );
  proof.steps.push(
    "early event survived late sign-in; real MCP socket delivered correctly labelled batched calls and refusal",
  );
  const beforeCrash = JSON.parse(await readFile(ready.healthPath, "utf8"));
  const launch = /^launch-[a-f0-9]+-([a-f0-9]+)$/.exec(beforeCrash.current.launch_id);
  assert.ok(launch, "Native launch identity did not contain its process");
  const nativePid = Number.parseInt(launch[1], 16);
  const owners = rendererOwners(contentProcesses().filter((pid) => !oldContent.has(pid)));
  await writeFile(
    path.join(output, "renderer-processes.json"),
    JSON.stringify({ nativePid, owners }, null, 2),
  );
  const observed = owners.filter((process) => process.owner === nativePid);
  assert.equal(
    observed.length,
    1,
    "Refusing to guess among processes not uniquely owned by this isolated app",
  );
  await writeFile(path.join(output, "ready-before-crash.json"), JSON.stringify(ready, null, 2));
  process.kill(observed[0].pid, "SIGKILL");
  await fileReady(path.join(output, "rows.json"), (saved) =>
    saved.some(
      (row) =>
        row.via === "web_content_terminated" &&
        row.event_id?.startsWith(beforeCrash.current.launch_id),
    ),
  );
  const health = await fileReady(
    ready.healthPath,
    (record) =>
      record.failures.length === 0 &&
      record.current.launch_id === beforeCrash.current.launch_id &&
      record.current.renderer_epoch > beforeCrash.current.renderer_epoch,
  );
  assert.equal(health.current.context.user_id, "phase6_qa");
  await copyFile(ready.healthPath, path.join(output, "health-after-renderer-recovery.json"));
  proof.steps.push(
    "actual WKWebView content process died, reloaded, and its observation was stored then acknowledged",
  );
  const nativeCount = rows.filter((row) => row.event_id).length;
  await quit(app, ready.healthPath);
  const closed = JSON.parse(await readFile(ready.healthPath, "utf8"));
  assert.equal(closed.current.exit, "quit");
  await copyFile(ready.healthPath, path.join(output, "health-after-native-quit.json"));
  const previousReady = ready;
  app = startApp();
  ready = await fileReady(path.join(root, "ready.json"), (value) => value.at > previousReady.at);
  assert.equal(rows.filter((row) => row.event_id).length, nativeCount);
  assert.equal(JSON.parse(await readFile(ready.healthPath, "utf8")).failures.length, 0);
  proof.steps.push("macOS native quit bypassed web unload and relaunch emitted no false crash");
  await quit(app, ready.healthPath);
  proof.ok = true;
  await writeFile(path.join(output, "proof.json"), JSON.stringify(proof, null, 2));
  console.log("PASS", JSON.stringify(proof));
} finally {
  for (const child of children.reverse())
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  for (const log of logs) log.end();
  await new Promise((resolve) => sink.close(resolve));
}
