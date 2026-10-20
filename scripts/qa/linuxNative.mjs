import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { newSession, waitFor } from "../../e2e/desktop/webdriver.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, "reports/linux-qa");
const manifest = JSON.parse(
  readFileSync(path.join(root, "src-tauri/resources/brand/manifest.json"), "utf8"),
);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
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
