import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { newSession, projectsRoot, waitFor } from "../../e2e/desktop/webdriver.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, "reports/linux-qa");
const manifest = JSON.parse(
  readFileSync(path.join(root, "src-tauri/resources/brand/manifest.json"), "utf8"),
);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
async function nativeJourney(session, profile) {
  const nativeDialog = async (choice) => {
    const driver = process.env.ARTDADDY_QA_DIALOG_DRIVER;
    assert.ok(driver && path.isAbsolute(driver) && existsSync(driver));
    const payload = realpathSync(process.env.ARTDADDY_LINUX_PAYLOAD_BINARY);
    const processes = readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .filter((name) => {
        try {
          return realpathSync(`/proc/${name}/exe`) === payload;
        } catch (error) {
          if (["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(error.code)) return false;
          throw error;
        }
      });
    assert.equal(
      processes.length,
      1,
      "Exactly one isolated app process must own the export dialog",
    );
    const args = [
      driver,
      "--pid",
      processes[0],
      "--expect-exe",
      payload,
      "--choice",
      choice,
      "--screenshot",
      path.join(output, `journey-export-${choice}-dialog.png`),
    ];
    const child = spawn(process.env.ARTDADDY_QA_DIALOG_PYTHON ?? "/usr/bin/python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    writeFileSync(path.join(output, `journey-export-${choice}-dialog-driver.log`), stderr);
    const observed = JSON.parse(stdout);
    writeFileSync(
      path.join(output, `journey-export-${choice}-dialog.json`),
      JSON.stringify(observed, null, 2),
    );
    assert.equal(code, 0, JSON.stringify(observed));
    assert.equal(observed.ok, true);
    assert.equal(observed.owned, true);
    return observed;
  };
  const api = process.env.ARTDADDY_QA_API;
  assert.equal(api, "http://127.0.0.1:18766");
  const bootstrapPath = process.env.ARTDADDY_QA_BOOTSTRAP;
  assert.ok(bootstrapPath?.startsWith(`${profile}/`));
  await waitFor(async () => existsSync(bootstrapPath) && (await fetch(`${api}/health`)).ok, {
    timeout: 20_000,
    label: "isolated signed-session fixture ready",
  });
  const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8"));
  const checks = [];
  const record = (label, detail = {}) => {
    checks.push({ label, ...detail });
    writeFileSync(
      path.join(output, "journey.json"),
      JSON.stringify({ checks, complete: false }, null, 2),
    );
  };
  const screenshot = async (name) => {
    const response = await fetch(`http://127.0.0.1:4444/session/${session.id}/screenshot`).then(
      (r) => r.json(),
    );
    assert.equal(typeof response.value, "string");
    const bytes = Buffer.from(response.value, "base64");
    const file = path.join(output, name);
    writeFileSync(file, bytes);
    return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const click = async (label) => {
    const selector = await session.exec(
      "const buttons=[...document.querySelectorAll('button')];const index=buttons.findIndex(b=>!b.disabled&&(b.textContent.trim()===arguments[0]||b.querySelector('span')?.textContent.trim()===arguments[0]));if(index<0)throw new Error('Missing enabled button: '+arguments[0]);buttons[index].setAttribute('data-native-qa-target','true');return 'button[data-native-qa-target=true]';",
      [label],
    );
    try {
      await session.click(await session.find(selector));
    } finally {
      await session.exec(
        "document.querySelector('[data-native-qa-target]')?.removeAttribute('data-native-qa-target');return true;",
      );
    }
  };
  await session.exec(
    "localStorage.setItem('artdaddy.api_base',arguments[0]);globalThis.__qaStore={done:false};window.__TAURI_INTERNALS__.invoke('store_refresh_token',{token:arguments[1]}).then(()=>globalThis.__qaStore={done:true}).catch(error=>globalThis.__qaStore={done:true,error:String(error)});return true;",
    [api, bootstrap.refresh_token],
  );
  const stored = await waitFor(
    () => session.exec("return globalThis.__qaStore?.done?globalThis.__qaStore:null;"),
    { label: "native Secret Service session storage" },
  );
  assert.equal(stored.error, undefined);
  await session.exec(
    "globalThis.__qaRead={done:false};window.__TAURI_INTERNALS__.invoke('load_refresh_token').then(value=>globalThis.__qaRead={done:true,matches:value===arguments[0],missing:value===null}).catch(error=>globalThis.__qaRead={done:true,error:String(error)});return true;",
    [bootstrap.refresh_token],
  );
  const restored = await waitFor(
    () => session.exec("return globalThis.__qaRead?.done?globalThis.__qaRead:null;"),
    { label: "native keyring session readback" },
  );
  record("native keyring writes and reads the same disposable credential", restored);
  assert.equal(restored.error, undefined);
  assert.equal(restored.matches, true, "Native keyring did not return the stored session");
  await session.exec(
    "window.__TAURI_INTERNALS__.invoke('plugin:window|close').catch(()=>{});return true;",
  );
  await session.quit();
  Object.assign(session, await newSession(process.env.ARTDADDY_APP_BINARY));
  record("actual app session closed and relaunched with the saved native credential");
  await waitFor(
    () =>
      session.exec(
        "return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='File');",
      ),
    { timeout: 60_000, label: "authenticated native editor" },
  );
  record("native keyring restore, signed authentication and compatibility admission", {
    authBypass: false,
    provider: "isolated backend fixture",
  });
  await screenshot("journey-authenticated.png");
  let rpcId = 0;
  let rpcSession;
  const rpc = async (method, params) => {
    const response = await fetch("http://127.0.0.1:19787/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(rpcSession ? { "mcp-session-id": rpcSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    rpcSession = response.headers.get("mcp-session-id") ?? rpcSession;
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.error, undefined, JSON.stringify(value.error));
    return value.result;
  };
  await waitFor(async () => Boolean(await rpc("ping", {}).catch(() => null)), {
    label: "authenticated native MCP bridge",
  });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "linux-native-journey", version: "1" },
  });
  const toolResult = async (name, args = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const value = JSON.parse(result.content[0].text);
    return { result, value };
  };
  const tool = async (name, args = {}) => {
    const { result, value } = await toolResult(name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.notEqual(value.ok, false, JSON.stringify(value));
    return value;
  };
  const project = await tool("manage_project", {
    action: "create",
    name: "linux-native-journey",
    aspect: "16:9",
    fps: 30,
  });
  assert.equal(typeof project.created, "string", JSON.stringify(project));
  const projectDir = path.join(projectsRoot(), project.created);
  assert.ok(projectDir.startsWith(`${profile}/`));
  const timelinePath = path.join(projectDir, "internals/timeline.json");
  const clips = () =>
    JSON.parse(readFileSync(timelinePath, "utf8")).tracks.flatMap((track) =>
      track.clips.map((clip) => ({ ...clip, trackKind: track.kind })),
    );
  const source = path.join(projectsRoot(), "native-red-green.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xdc201f:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x1acb32:t=fill:enable='gte(t,1)'",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const media = await tool("import_media", { source: { path: source } });
  assert.match(media.media_ref, /^media_/);
  await tool("add_clips", { entries: [{ media_ref: media.media_ref, timeline_in: 0 }] });
  await waitFor(() => clips().filter((clip) => clip.kind === "video").length === 1, {
    label: "real imported video persisted",
  });
  const original = readFileSync(timelinePath);
  writeFileSync(path.join(output, "timeline-before.json"), original);
  const video = clips().find((clip) => clip.kind === "video");
  const clipSelector = `[data-artdaddy-drop='track'] [data-clip-id='${video.id}']`;
  await waitFor(() => session.find(clipSelector), {
    label: "imported clip in native timeline",
  });
  await session.click(await session.find(clipSelector));
  const clipBox = await session.box(clipSelector);
  const ruler = await session.box("[aria-label='timeline scrubber']");
  assert.ok(clipBox?.w > 5 && ruler?.w > 0);
  record("native seek uses the timeline clip, not the stage overlay", {
    clipSelector,
    clipBox,
    ruler,
  });
  const seek = async (fraction) => {
    const point = { x: clipBox.x - clipBox.w / 2 + clipBox.w * fraction, y: ruler.y };
    await session.drag(point, point, 1);
  };
  const previewPixels = [];
  for (const [fraction, color] of [
    [0.125, "red"],
    [0.625, "green"],
  ]) {
    await seek(fraction);
    const sampled = await waitFor(
      async () => {
        const bounds = await session.exec(
          "const canvas=document.querySelector('canvas.block.h-full.w-full');if(!canvas)return null;const box=canvas.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2,width:innerWidth,height:innerHeight};",
        );
        if (!bounds) return null;
        const image = await screenshot(`journey-preview-${color}.png`);
        const png = readFileSync(image.file);
        const sampleX = Math.floor((bounds.x * png.readUInt32BE(16)) / bounds.width);
        const sampleY = Math.floor((bounds.y * png.readUInt32BE(20)) / bounds.height);
        const pixel = Array.from(
          execFileSync("ffmpeg", [
            "-v",
            "error",
            "-i",
            image.file,
            "-vf",
            `crop=1:1:${sampleX}:${sampleY}`,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
          ]),
        );
        const matched =
          color === "red" ? pixel[0] > 150 && pixel[1] < 100 : pixel[1] > 140 && pixel[0] < 100;
        return matched ? { color, pixel, screenshot: image, sampleX, sampleY } : null;
      },
      { timeout: 30_000, label: `real native preview ${color} frame` },
    );
    previewPixels.push(sampled);
  }
  assert.notDeepEqual(previewPixels[0].pixel, previewPixels[1].pixel);
  record("production native preview changes expected frames after real playhead seeking", {
    samples: previewPixels,
  });
  await seek(0.5);
  await click("Edit");
  await click("Split at Playhead");
  await waitFor(() => clips().filter((clip) => clip.kind === "video").length === 2, {
    label: "manual split persisted",
  });
  writeFileSync(path.join(output, "timeline-split.json"), readFileSync(timelinePath));
  await click("Edit");
  await click("Undo");
  await waitFor(() => readFileSync(timelinePath).equals(original), {
    label: "one manual undo restores exact document bytes",
  });
  record("real UI split and one undo restore byte-identical persisted timeline", {
    sha256: createHash("sha256").update(original).digest("hex"),
  });
  await click("File");
  await click("Close Project");
  await waitFor(() => session.exec("return !document.querySelector('[data-clip-id]');"), {
    label: "native project close",
  });
  await tool("manage_project", { action: "open", id: project.created });
  await waitFor(() => session.find(clipSelector), {
    label: "same project reopened from disk",
  });
  assert.ok(readFileSync(timelinePath).equals(original));
  writeFileSync(path.join(output, "timeline-reopened.json"), readFileSync(timelinePath));
  record("close/reopen preserves the saved document and imported references");
  await screenshot("journey-editor.png");
  const destination = path.join(projectsRoot(), "native-journey-export.mp4");
  const exportArgs = { output_path: destination, resolution: "480p", quality: "low" };
  const cancelledRequest = toolResult("export", exportArgs);
  void cancelledRequest.catch(() => {});
  const cancelledDialog = await nativeDialog("cancel");
  const cancelled = await cancelledRequest;
  assert.equal(cancelled.value.ok, false, JSON.stringify(cancelled));
  assert.match(cancelled.value.error, /cancel|declin/i);
  assert.equal(existsSync(destination), false);
  const afterCancel = await tool("manage_exports", { action: "list" });
  assert.deepEqual(afterCancel.exports, []);
  writeFileSync(
    path.join(output, "journey-cancelled-exports.json"),
    JSON.stringify(afterCancel, null, 2),
  );
  record("real native export confirmation Cancel refuses without a delivered file", {
    dialog: cancelledDialog,
    result: cancelled.value,
  });
  record("submitting native export after explicit Continue", { destination });
  const acceptedRequest = tool("export", exportArgs);
  void acceptedRequest.catch(() => {});
  const continuedDialog = await nativeDialog("continue");
  const accepted = await acceptedRequest;
  assert.equal(accepted.ok, true);
  record("real native export confirmation Continue admits an export job", {
    dialog: continuedDialog,
    job_id: accepted.job_id,
  });
  const terminalExport = await waitFor(
    async () => {
      const outcome = await tool("manage_exports", { action: "list" });
      const job = outcome.exports.find((entry) => entry.job_id === accepted.job_id);
      return job && ["done", "failed", "cancelled"].includes(job.state) ? job : null;
    },
    { timeout: 120_000, label: "native export terminal outcome" },
  );
  writeFileSync(
    path.join(output, "journey-export-outcome.json"),
    JSON.stringify(terminalExport, null, 2),
  );
  assert.equal(
    terminalExport.state,
    "done",
    terminalExport.error ?? JSON.stringify(terminalExport),
  );
  assert.ok(existsSync(destination) && readFileSync(destination).length > 10000);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", destination],
      { encoding: "utf8" },
    ),
  );
  assert.ok(Number(probe.format.duration) >= 1.95);
  assert.ok(probe.streams.some((stream) => stream.codec_type === "video" && stream.height === 480));
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
  const pixels = [0.25, 1.25].map((time) =>
    Array.from(
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-ss",
        String(time),
        "-i",
        destination,
        "-vf",
        "crop=2:2:iw/2:ih/2,scale=1:1",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ]),
    ),
  );
  assert.ok(pixels[0][0] > 150 && pixels[0][1] < 100, `first frame must be red: ${pixels[0]}`);
  assert.ok(pixels[1][1] > 140 && pixels[1][0] < 100, `later frame must be green: ${pixels[1]}`);
  assert.notDeepEqual(pixels[0], pixels[1]);
  const delivered = path.join(output, "native-journey-export.mp4");
  writeFileSync(delivered, readFileSync(destination));
  writeFileSync(path.join(output, "export-probe.json"), JSON.stringify(probe, null, 2));
  record("actual native sidecar export contains changing expected video frames and audio", {
    pixels,
    bytes: readFileSync(delivered).length,
    sha256: createHash("sha256").update(readFileSync(delivered)).digest("hex"),
  });
  await session.exec(
    "window.__TAURI_INTERNALS__.invoke('plugin:window|close').catch(()=>{});return true;",
  );
  await session.quit();
  Object.assign(session, await newSession(process.env.ARTDADDY_APP_BINARY));
  await waitFor(
    () =>
      session.exec(
        "return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='File');",
      ),
    { timeout: 60_000, label: "native auth restored after actual app relaunch" },
  );
  record("native keyring session restores again after actual app relaunch");
  await screenshot("journey-restored.png");
  writeFileSync(
    path.join(output, "journey.json"),
    JSON.stringify(
      {
        complete: true,
        checks,
        authBypass: false,
        externalClerkBrowserLoginTested: false,
        hardware: "Ubuntu 22.04 CI runner",
        authenticatedNativeEditing: true,
      },
      null,
      2,
    ),
  );
}
function executablePath(name, searchPath = process.env.PATH ?? "") {
  const found = path.isAbsolute(name)
    ? name
    : searchPath
        .split(path.delimiter)
        .map((directory) => path.resolve(directory, name))
        .find(existsSync);
  assert.ok(found && path.isAbsolute(found) && existsSync(found), `Executable not found: ${name}`);
  return found;
}
const program = `
import {getVersion} from '@tauri-apps/api/app';
import {resourceDir,resolveResource,appDataDir,appCacheDir} from '@tauri-apps/api/path';
import {readFile} from '@tauri-apps/plugin-fs';
globalThis.__linuxNative={done:false};
const sample=gl=>{const pixels=[];for(const color of [[1,0,0,1],[0,1,0,1]]){gl.clearColor(...color);gl.clear(gl.COLOR_BUFFER_BIT);const bytes=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);pixels.push(Array.from(bytes));}return pixels;};
(async()=>{
 const result={version:await getVersion(),resourceDir:await resourceDir(),appDataDir:await appDataDir(),appCacheDir:await appCacheDir(),userAgent:navigator.userAgent,assets:[],main:{},worker:{}};
 for(const name of Object.keys(${JSON.stringify(manifest.assets)})){
  const file=await resolveResource('resources/brand/'+name);
  try{const bytes=await readFile(file);const digest=await crypto.subtle.digest('SHA-256',bytes);result.assets.push({name,file,bytes:bytes.length,sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')});}
  catch(error){result.assets.push({name,file,error:String(error)});}
 }
 try{const canvas=document.createElement('canvas');canvas.width=canvas.height=4;const gl=canvas.getContext('webgl2');result.main={webgl2:Boolean(gl),pixels:gl?sample(gl):[],videoDecoder:typeof VideoDecoder==='function'};}catch(error){result.main={webgl2:false,error:String(error)};}
 const body='const sample='+sample.toString()+';onmessage=()=>{try{const canvas=new OffscreenCanvas(4,4);const gl=canvas.getContext("webgl2");postMessage({webgl2:Boolean(gl),pixels:gl?sample(gl):[],videoDecoder:typeof VideoDecoder==="function"});}catch(error){postMessage({webgl2:false,error:String(error)});}}';
 const address=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));
 let worker;
 try{result.worker=await new Promise(resolve=>{const timer=setTimeout(()=>resolve({webgl2:false,error:'worker graphics deadline exceeded'}),10000);try{worker=new Worker(address);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data);};worker.onerror=event=>{clearTimeout(timer);resolve({webgl2:false,error:event.message});};worker.postMessage({});}catch(error){clearTimeout(timer);resolve({webgl2:false,error:String(error)});}});}
 finally{worker?.terminate();URL.revokeObjectURL(address);}
 globalThis.__linuxNative={done:true,result};
})().catch(error=>{globalThis.__linuxNative={done:true,error:String(error)};});`;

const compiled = await build({
  stdin: { contents: program, resolveDir: root, sourcefile: "linux-native-probe.js" },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "silent",
});
assert.equal(compiled.errors.length, 0);
assert.equal(Object.keys(manifest.assets).length, 6);
if (process.argv.includes("--check")) {
  assert.equal(
    executablePath(path.basename(process.execPath), path.dirname(process.execPath)),
    process.execPath,
  );
  assert.throws(
    () => executablePath("artdaddy-nonexistent-qa-driver", path.dirname(process.execPath)),
    /Executable not found/,
  );
  console.log("Native Linux diagnostic bundles the real Tauri APIs and six manifest assets");
  process.exit(0);
}
assert.equal(process.platform, "linux");
const application = process.env.ARTDADDY_APP_BINARY;
const payload = process.env.ARTDADDY_LINUX_PAYLOAD_BINARY;
const profile = process.env.ARTDADDY_LINUX_QA_ROOT;
assert.ok(application && path.isAbsolute(application) && existsSync(application));
assert.ok(payload && path.isAbsolute(payload) && existsSync(payload));
assert.ok(profile && path.isAbsolute(profile) && profile.includes("artdaddy-linux-qa-"));
assert.ok(application.startsWith(`${profile}/squashfs-root/`));
assert.ok(payload.startsWith(`${profile}/squashfs-root/`));
for (const name of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"])
  assert.ok(process.env[name]?.startsWith(`${profile}/`), `Isolated ${name} is required`);
assert.equal(process.env.TAURI_AUTOMATION, "1");
mkdirSync(output, { recursive: true });
const binaryHash = createHash("sha256").update(readFileSync(payload)).digest("hex");
const launcherHash = createHash("sha256").update(readFileSync(application)).digest("hex");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) =>
  originalFetch(input, {
    ...init,
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]),
  });
let driverError;
let driverExit;
let finishDriver;
const driverFinished = new Promise((resolve) => {
  finishDriver = resolve;
});
const nativeDriver = executablePath(process.env.NATIVE_DRIVER ?? "WebKitWebDriver");
const driver = spawn("tauri-driver", ["--native-driver", nativeDriver], {
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "";
for (const stream of [driver.stdout, driver.stderr])
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-20000);
  });
driver.once("error", (error) => {
  driverError = error;
  finishDriver();
});
driver.once("exit", (code, signal) => {
  driverExit = { code, signal };
  finishDriver();
});
let session;
let closeRequested = false;
try {
  await waitFor(
    async () => {
      if (driverError || driverExit)
        throw driverError ?? new Error(`Driver exited ${JSON.stringify(driverExit)}`);
      const response = await fetch("http://127.0.0.1:4444/status");
      return response.ok;
    },
    { timeout: 20_000, label: "isolated native WebDriver" },
  );
  session = await newSession(application);
  await waitFor(
    () =>
      session.exec(
        "return Boolean(window.__TAURI_INTERNALS__) && document.readyState === 'complete'",
      ),
    { timeout: 30_000, label: "actual packaged Tauri window" },
  );
  const screenshot = await fetch(`http://127.0.0.1:4444/session/${session.id}/screenshot`).then(
    (response) => response.json(),
  );
  assert.equal(typeof screenshot.value, "string");
  const png = Buffer.from(screenshot.value, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  writeFileSync(path.join(output, "native-window.png"), png);
  await session.exec(compiled.outputFiles[0].text);
  const observed = await waitFor(
    () => session.exec("return globalThis.__linuxNative?.done ? globalThis.__linuxNative : null"),
    { timeout: 30_000, label: "native Linux graphics/resource outcome" },
  );
  writeFileSync(
    path.join(output, "native.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        binary: payload,
        binarySha256: binaryHash,
        launcher: application,
        launcherSha256: launcherHash,
        observed,
        screenshot: {
          bytes: png.length,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        },
        nativeAutomation: true,
        noCreativeProjectOpened: true,
      },
      null,
      2,
    ),
  );
  assert.equal(observed.error, undefined);
  const result = observed.result;
  assert.equal(result.version, version);
  assert.ok(result.appDataDir.startsWith(profile));
  assert.ok(result.appCacheDir.startsWith(profile));
  for (const asset of result.assets) {
    assert.equal(asset.error, undefined, asset.name);
    assert.equal(asset.bytes, manifest.assets[asset.name].bytes, asset.name);
    assert.equal(asset.sha256, manifest.assets[asset.name].sha256, asset.name);
  }
  assert.equal(result.assets.length, 6);
  const viable = Object.entries({ main: result.main, worker: result.worker }).filter(
    ([, graphics]) => graphics.webgl2 && graphics.videoDecoder,
  );
  assert.ok(viable.length > 0, "No native graphics/video-decoding context is available");
  for (const [name, graphics] of viable) {
    assert.equal(graphics.pixels.length, 2, name);
    assert.ok(graphics.pixels[0][0] > 240 && graphics.pixels[0][1] < 15, `${name}: red pixel`);
    assert.ok(graphics.pixels[1][1] > 240 && graphics.pixels[1][0] < 15, `${name}: green pixel`);
  }
  console.log(
    JSON.stringify(
      {
        nativeVersion: result.version,
        bundledAssets: result.assets.length,
        viableContexts: viable.map(([name]) => name),
        requiredCapabilityPixelsPassed: true,
        capabilityOnly: true,
        productionPathSelectionMeasuredHere: false,
        binarySha256: binaryHash,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--journey")) {
    try {
      await nativeJourney(session, profile);
    } catch (error) {
      await session
        .exec(
          "globalThis.__qaJobs={done:false};window.__TAURI_INTERNALS__.invoke('jobs_list').then(jobs=>globalThis.__qaJobs={done:true,jobs}).catch(error=>globalThis.__qaJobs={done:true,error:String(error)});return true;",
        )
        .catch(() => {});
      await waitFor(() => session.exec("return globalThis.__qaJobs?.done;"), {
        timeout: 10000,
        label: "native export failure job state",
      }).catch(() => {});
      const jobs = await session.exec("return globalThis.__qaJobs??null;").catch(() => null);
      writeFileSync(path.join(output, "journey-native-jobs.json"), JSON.stringify(jobs, null, 2));
      const destination = path.join(projectsRoot(), "native-journey-export.mp4");
      if (existsSync(destination))
        writeFileSync(path.join(output, "journey-partial-export.mp4"), readFileSync(destination));
      await session
        .exec(
          "globalThis.__qaFailureRead={done:false};window.__TAURI_INTERNALS__.invoke('load_refresh_token').then(token=>globalThis.__qaFailureRead={done:true,present:Boolean(token)}).catch(error=>globalThis.__qaFailureRead={done:true,error:String(error)});return true;",
        )
        .catch(() => {});
      await waitFor(() => session.exec("return globalThis.__qaFailureRead?.done;"), {
        timeout: 10000,
        label: "redacted native failure credential readback",
      }).catch(() => {});
      const state = await session
        .exec(
          "return {origin:location.origin,path:location.pathname,apiBase:localStorage.getItem('artdaddy.api_base'),ready:document.readyState,bodyText:document.body.innerText,credential:globalThis.__qaFailureRead};",
        )
        .catch((failure) => ({ unavailable: String(failure) }));
      writeFileSync(
        path.join(output, "journey-failure.json"),
        JSON.stringify({ error: String(error), stack: error?.stack, state }, null, 2),
      );
      const screenshot = await fetch(`http://127.0.0.1:4444/session/${session.id}/screenshot`)
        .then((response) => response.json())
        .catch(() => null);
      if (typeof screenshot?.value === "string")
        writeFileSync(
          path.join(output, "journey-failure.png"),
          Buffer.from(screenshot.value, "base64"),
        );
      throw error;
    }
  }
} finally {
  if (session) {
    try {
      await session.exec(
        "window.__TAURI_INTERNALS__.invoke('plugin:window|close').catch(()=>{}); return true;",
      );
      closeRequested = true;
    } catch {}
    await session.quit();
  }
  driver.kill();
  let cleanupTimer;
  await Promise.race([
    driverFinished,
    new Promise((resolve) => {
      cleanupTimer = setTimeout(resolve, 5000);
    }),
  ]).finally(() => clearTimeout(cleanupTimer));
  globalThis.fetch = originalFetch;
  writeFileSync(path.join(output, "native-driver.log"), diagnostics);
  writeFileSync(
    path.join(output, "native-cleanup.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        closeRequested,
        sessionQuitAttempted: Boolean(session),
        driverExit,
        driverError: driverError ? String(driverError) : undefined,
        driverStopped: Boolean(driverExit) || !driver.pid,
        scopedToDisposableProfile: profile,
      },
      null,
      2,
    ),
  );
}
