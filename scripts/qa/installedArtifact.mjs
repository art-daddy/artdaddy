import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Installed-candidate launch is restricted to the disposable CI runner");
assert.equal(process.platform, "win32");
const installed = path.resolve(process.env.ARTDADDY_QA_INSTALLED_EXE ?? "");
const runner = path.resolve(process.env.RUNNER_TEMP ?? "");
assert.ok(installed.toLowerCase().startsWith((runner + path.sep).toLowerCase()));
const output = path.resolve("reports/qa/installed");
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(path.dirname(installed), "resources/node_modules/playwright-core"));
const processId = Number(process.env.ARTDADDY_QA_INSTALLED_PID);
assert.ok(Number.isSafeInteger(processId) && processId > 0);
const started = Date.now();
let browser;
let lastError;
while (Date.now() - started < 30000) {
  process.kill(processId, 0);
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:18877", { timeout: 5000 });
    break;
  } catch (error) {
    lastError = error.message;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
assert.ok(browser, `Installed process stayed alive but CDP never became ready: ${lastError}`);
try {
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(candidate => /^(?:http:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(candidate.url()));
  assert.ok(page, "Installed app did not expose its own packaged page");
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, { timeout: 30000 });
  const actual = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    return {
      version: await invoke("plugin:app|version"),
      identifier: await invoke("plugin:app|identifier"),
      text: document.body.innerText,
      width: innerWidth,
      height: innerHeight,
      bodyHeight: document.body.getBoundingClientRect().height,
    };
  });
  assert.equal(actual.version, "0.22.0");
  assert.equal(actual.identifier, "com.artdaddy.app");
  assert.ok(actual.width >= 900 && actual.height >= 500 && actual.bodyHeight > 0);
  assert.match(actual.text, /ArtDaddy|Sign in|compatibility|update/i);
  await page.screenshot({ path: path.join(output, "installed.png") });
  const proof = {
    status: "INSTALLED_VERSION_AND_WEBVIEW_PAINT_VERIFIED",
    checkedAt: new Date().toISOString(),
    executableSha256: createHash("sha256").update(readFileSync(installed)).digest("hex"),
    ...actual,
    ephemeralHostedRunner: true,
    paidCallsRequested: false,
    normalUserMachineAccessed: false,
    liveUpdateManifestChanged: false,
  };
  writeFileSync(path.join(output, "installed.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
  await page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); }).catch(() => {});
} finally {
  await browser.close();
}