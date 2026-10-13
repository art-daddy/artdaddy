import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

assert.ok(process.env.CI, "Platform artifact controls run only in the authorized isolated CI job");
assert.ok(["darwin", "linux"].includes(process.platform));
const output = path.resolve("reports/qa/post-release-0214");
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artdaddy-release-0214-"));
const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
assert.equal(config.version, "0.21.4", "The QA source must be based on the release tag");
const platform = process.platform === "darwin" ? "darwin-aarch64" : "linux-x86_64";
const headers = { "User-Agent": "artdaddy-private-release-journey-qa/1.0" };
const manifest = await fetch("https://artdaddy.app/updates/latest.json", { headers }).then((response) => response.json());
assert.equal(manifest.version, "0.21.4", "Do not silently change replay target");
const target = manifest.platforms[platform];
const artifact = path.join(temporary, process.platform === "darwin" ? "app.tar.gz" : "app.AppImage");
const response = await fetch(target.url, { headers });
assert.equal(response.ok, true);
const bytes = Buffer.from(await response.arrayBuffer());
fs.writeFileSync(artifact, bytes);
const sig = `${artifact}.sig`;
fs.writeFileSync(sig, target.signature);
const signature = spawnSync(process.execPath, ["scripts/verify-release-signature.mjs", artifact, sig], { encoding: "utf8" });
fs.writeFileSync(path.join(output, "signature.txt"), (signature.stdout ?? "") + (signature.stderr ?? ""));
assert.equal(signature.status, 0, "Updater signature must match the committed key");
const report = { targetVersion: "0.21.4", platform, nativeHost: { os: process.platform, arch: process.arch }, artifactUrl: target.url, artifactBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), updaterSignatureVerified: true, paidModelCalls: 0, evidenceLimits: ["These controls do not attach to a customer's original media or hardware", "Direct sidecar success is not proof of the desktop app launch/signing path"], checks: [] };
function run(name, executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 60000, ...options });
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  fs.writeFileSync(path.join(output, `${name}.txt`), combined);
  const record = { name, code: result.status, signal: result.signal, error: result.error?.message, outputBytes: Buffer.byteLength(combined), outputTail: combined.slice(-2000) };
  report.checks.push(record);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(record));
  return { ...record, output: combined };
}
let binaries;
function findFile(directory, filename) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, filename);
      if (found) return found;
    }
  }
  return null;
}
if (process.platform === "darwin") {
  execFileSync("tar", ["-xzf", artifact, "-C", temporary]);
  const app = fs.readdirSync(temporary).find((name) => name.endsWith(".app"));
  assert.ok(app);
  const appRoot = path.join(temporary, app);
  const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleShortVersionString", path.join(appRoot, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  assert.equal(version, "0.21.4");
  binaries = path.join(appRoot, "Contents/MacOS");
  run("app-codesign", "codesign", ["-d", "--verbose=4", appRoot]);
  run("app-entitlements", "codesign", ["-d", "--entitlements", ":-", appRoot]);
  for (const name of ["artdaddy", "artdaddy-yt-dlp", "artdaddy-browser"]) {
    const file = path.join(binaries, name);
    if (!fs.existsSync(file)) continue;
    run(`${name}-file`, "file", [file]);
    run(`${name}-codesign`, "codesign", ["-d", "--verbose=4", file]);
  }
  const browser = path.join(binaries, "artdaddy-browser");
  const resources = path.join(appRoot, "Contents/Resources");
  report.resourceCandidates = fs.readdirSync(resources);
  const sidecar = findFile(resources, "artdaddy-browser.mjs");
  if (fs.existsSync(browser)) run("browser-runtime", browser, ["--version"], { cwd: resources });
  if (fs.existsSync(browser) && fs.existsSync(sidecar)) {
    const image = path.join(output, "browser-page.png");
    const sample = run("browser-public-page", browser, [sidecar, "shot", "--url", "https://example.com", "--out", image, "--viewport", "1280x800", "--dsf", "1", "--mobile", "0"], { cwd: resources });
    report.browserActualImage = fs.existsSync(image) ? { bytes: fs.statSync(image).size, sha256: createHash("sha256").update(fs.readFileSync(image)).digest("hex") } : null;
    report.browserCaptureSucceeded = sample.code === 0 && report.browserActualImage?.bytes > 1000;
  }
  const downloader = path.join(binaries, "artdaddy-yt-dlp");
  if (fs.existsSync(downloader)) {
    run("yt-dlp-version", downloader, ["--version"]);
    run("yt-dlp-local-metadata", downloader, ["--skip-download", "--dump-single-json", "https://www.youtube.com/watch?v=BaW_jenozKc", "--socket-timeout", "15"]);
  }
} else {
  fs.chmodSync(artifact, 0o755);
  const extraction = run("appimage-extract", artifact, ["--appimage-extract"], { cwd: temporary });
  assert.equal(extraction.code, 0);
  const appRoot = path.join(temporary, "squashfs-root");
  const candidates = [path.join(appRoot, "usr/bin"), path.join(appRoot, "usr/lib/artdaddy"), appRoot];
  binaries = candidates.find((candidate) => fs.existsSync(path.join(candidate, "artdaddy")));
  assert.ok(binaries);
  const probe = `import gi, json\ngi.require_version('Gtk','3.0')\ngi.require_version('WebKit2','4.1')\nfrom gi.repository import Gtk, WebKit2, GLib\nview=WebKit2.WebView()\nwindow=Gtk.Window(); window.set_default_size(640,480); window.add(view); window.show_all()\ndef finish(web, event):\n if event==WebKit2.LoadEvent.FINISHED:\n  def result(obj, value, data=None):\n   try: print(obj.evaluate_javascript_finish(value).to_string(),flush=True)\n   except Exception as error: print(json.dumps({'error':str(error)}),flush=True)\n   Gtk.main_quit()\n  view.evaluate_javascript("JSON.stringify({webgl2:!!document.createElement('canvas').getContext('webgl2'),webgl:!!document.createElement('canvas').getContext('webgl'),ua:navigator.userAgent})",-1,None,None,None,result,None)\nview.connect('load-changed',finish)\nview.load_html('<html><body>Native WebKitGTK probe</body></html>',None)\nGLib.timeout_add_seconds(20,lambda:(Gtk.main_quit(),False)[1])\nGtk.main()\n`;
  const script = path.join(temporary, "webkit-probe.py");
  fs.writeFileSync(script, probe);
  run("native-webkitgtk-gpu", "xvfb-run", ["-a", "python3", script], { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" } });
  run("native-webkitgtk-no-gl", "xvfb-run", ["-a", "python3", script], { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1", GDK_GL: "disable" } });
  report.linuxMintCustomerDriverNotAvailable = true;
}
for (const name of ["artdaddy-ffmpeg", "artdaddy-ffprobe", "artdaddy-whisper-cli"]) {
  const file = path.join(binaries, name);
  if (fs.existsSync(file)) run(`${name}-runtime`, file, name.endsWith("whisper-cli") ? ["--help"] : ["-version"]);
}
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ platform, updaterSignatureVerified: true, nativeArtifactControls: report.checks.length, paidModelCalls: 0 }));