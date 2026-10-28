import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { chromium } from "@playwright/test";
import { unzipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (file) => path.relative(root, file).replaceAll("\\", "/");
const token = `export-failure-evidence-${randomUUID()}`;
const reportRoot = path.join(root, "reports", "qa", "browser", token);
const outputRoot = path.join(root, "test-results", token);
const configFile = path.join(root, "playwright.config.ts");
const scriptFile = fileURLToPath(import.meta.url);
const configSha256 = hash(fs.readFileSync(configFile));
const scriptSha256 = hash(fs.readFileSync(scriptFile));
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA) assert.equal(process.env.GITHUB_SHA, headSha);

function testCases(suites) {
  assert.ok(Array.isArray(suites), "Invalid Playwright suite tree");
  return suites.flatMap((suite) => [
    ...suite.specs.flatMap((spec) => spec.tests.map((test) => ({ ...test, title: spec.title }))),
    ...(suite.suites === undefined ? [] : testCases(suite.suites)),
  ]);
}

function artifact(attempt, role) {
  const matches = attempt.attachments.filter((attachment) => attachment.name === role);
  assert.equal(matches.length, 1, `Missing or ambiguous ${role} attachment`);
  const file = fs.realpathSync(matches[0].path);
  const owned = path.relative(fs.realpathSync(outputRoot), file);
  assert.ok(owned && !path.isAbsolute(owned) && !owned.split(path.sep).includes(".."));
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 0 && bytes.length <= 32 * 1024 * 1024);
  return {
    record: { role, file: relative(file), bytes: bytes.length, sha256: hash(bytes) },
    bytes,
  };
}

async function screenshotPixels(page, bytes, project, witness) {
  const { viewport, deviceScaleFactor: scale } = project;
  assert.ok(viewport && Number.isInteger(viewport.width) && Number.isInteger(viewport.height));
  assert.ok(Number.isFinite(scale) && scale > 0);
  const digest = createHash("sha256").update(witness).digest();
  const expected = Array.from({ length: 32 }, (_, index) =>
    (digest[index >> 3] >> (index & 7)) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255],
  );
  const positions = expected.map((_, index) => [
    Math.floor((index * 8 + 4) * scale),
    Math.floor(4 * scale),
  ]);
  positions.push(
    [Math.floor(300 * scale), Math.floor(4 * scale)],
    [Math.floor((viewport.width - 4) * scale), Math.floor((viewport.height - 4) * scale)],
  );
  const actual = await page.evaluate(
    async ({ image, positions }) => {
      const picture = new Image();
      picture.src = `data:image/png;base64,${image}`;
      await picture.decode();
      const canvas = document.createElement("canvas");
      canvas.width = picture.naturalWidth;
      canvas.height = picture.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Native PNG decoder has no 2D context");
      context.drawImage(picture, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        samples: positions.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)),
      };
    },
    { image: bytes.toString("base64"), positions },
  );
  assert.equal(actual.width, viewport.width * scale);
  assert.equal(actual.height, viewport.height * scale);
  assert.deepEqual(
    actual.samples,
    [...expected, [0, 255, 255, 255], [0, 255, 255, 255]],
    "Retained screenshot is blank, belongs to another fixture, or lost rendered pixels",
  );
  return actual;
}

async function main() {
  fs.mkdirSync(path.dirname(reportRoot), { recursive: true });
  fs.mkdirSync(reportRoot);
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  fs.mkdirSync(outputRoot);
  const input = fs.mkdtempSync(path.join(root, "reports", "qa", "failure-evidence-input-"));
  const temporaryConfig = path.join(input, "playwright.config.ts");
  const schemaFile = path.join(reportRoot, "contract.json");
  const resultFile = path.join(reportRoot, "results.json");
  const fixtureFile = path.join(input, "failure-evidence.spec.ts");
  let browser, proof;
  const failures = [];
  try {
    // Keep actual capture/project policies without booting a second editor.
    fs.writeFileSync(
      temporaryConfig,
      `
import base from ${JSON.stringify(pathToFileURL(configFile).href)};
import { defineConfig } from "@playwright/test";
const projects = base.projects;
if (!projects || !projects.length) throw new Error("No real browser projects declared");
const evidenceSchema = {
  token: ${JSON.stringify(token)}, configSha256: ${JSON.stringify(configSha256)},
  projects: projects.map(project => {
    const use = { ...base.use, ...project.use };
    return { name: project.name, viewport: use.viewport, deviceScaleFactor: use.deviceScaleFactor,
      trace: use.trace, screenshot: use.screenshot };
  })
};
export default defineConfig({
  ...base, testDir: ${JSON.stringify(input)}, testMatch: "failure-evidence.spec.ts",
  metadata: { ...base.metadata, failureEvidence: evidenceSchema },
  globalSetup: undefined, globalTeardown: undefined, webServer: undefined,
  outputDir: ${JSON.stringify(outputRoot)},
  reporter: [["json", { outputFile: ${JSON.stringify(resultFile)} }]],
  projects: projects.map(project => ({ ...project, testDir: ${JSON.stringify(input)},
    testMatch: "failure-evidence.spec.ts", testIgnore: [] }))
});
`,
      { flag: "wx" },
    );
    fs.writeFileSync(
      fixtureFile,
      `
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
test("failure evidence negative control", async ({ page }, info) => {
  const witness = ${JSON.stringify(token)} + "/" + info.project.name;
  const digest = createHash("sha256").update(witness).digest();
  await page.setContent('<!doctype html><html><body style="margin:0;background:#00ffff"><h1 style="position:absolute;left:12px;top:40px"></h1></body></html>');
  await page.evaluate(({ witness, pattern }) => {
    document.querySelector("h1").textContent = witness;
    for (let index = 0; index < 32; index++) {
      const bit = document.createElement("div");
      bit.style.cssText = "position:absolute;top:0;width:8px;height:8px;left:" + (index * 8) + "px;background:" +
        (pattern[index] ? "#ffffff" : "#000000");
      document.body.appendChild(bit);
    }
  }, { witness, pattern: Array.from({ length: 32 }, (_, index) => (digest[index >> 3] >> (index & 7)) & 1) });
  await expect(page.getByRole("heading")).toHaveText(witness);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect("capture-" + witness).toBe("deliberately-fail-" + witness);
});
`,
      { flag: "wx" },
    );
    const environment = { ...process.env };
    for (const name of [
      "PLAYWRIGHT_JSON_OUTPUT_NAME",
      "PLAYWRIGHT_JSON_OUTPUT_DIR",
      "PLAYWRIGHT_JSON_OUTPUT_FILE",
    ])
      delete environment[name];
    const command = spawnSync(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", "--config", temporaryConfig],
      {
        cwd: root,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(reportRoot, "command.log"),
      `${command.stdout ?? ""}${command.stderr ?? ""}`,
      { flag: "wx" },
    );
    if (command.error) throw command.error;
    assert.equal(command.signal, null);
    assert.equal(
      command.status,
      1,
      "The unannotated fixture must actually fail, not disappear or pass",
    );
    const resultBytes = fs.readFileSync(resultFile);
    const result = JSON.parse(resultBytes.toString("utf8"));
    const schema = result.config.metadata.failureEvidence;
    assert.equal(schema.token, token);
    assert.equal(schema.configSha256, configSha256);
    // Retries only exist if Playwright APPLIED them. The config records the policy it meant; every
    // project must resolve to exactly that, so a per-project override or an ignored option is loud.
    const policy = result.config.metadata.browserRunPolicy;
    assert.ok(
      policy && Number.isInteger(policy.retries) && Number.isInteger(policy.maxFailures),
      "playwright.config.ts no longer records its retry policy",
    );
    assert.equal(result.config.maxFailures, policy.maxFailures);
    for (const project of result.config.projects)
      assert.equal(
        project.retries,
        policy.retries,
        `${project.name} does not run with the retry policy the config declares`,
      );
    if (process.platform === "darwin" && process.env.CI)
      assert.ok(policy.retries >= 1, "A flaky browser test on a macOS CI runner must be retried");
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2), { flag: "wx" });
    assert.equal(
      result.errors.length,
      0,
      "A setup/worker error is not the deliberate test failure",
    );
    const projects = schema.projects.map((project) => project.name).sort();
    assert.equal(new Set(projects).size, projects.length);
    assert.deepEqual(result.config.projects.map((project) => project.name).sort(), projects);
    const cases = testCases(result.suites);
    assert.deepEqual(cases.map((test) => test.projectName).sort(), projects);
    assert.equal(result.stats.unexpected, projects.length);
    for (const field of ["expected", "skipped", "flaky"]) assert.equal(result.stats[field], 0);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const records = [];
    for (const test of cases) {
      assert.equal(test.title, "failure evidence negative control");
      assert.equal(test.status, "unexpected");
      assert.equal(test.expectedStatus, "passed");
      const project = schema.projects.find((project) => project.name === test.projectName);
      const declared = result.config.projects.find((project) => project.name === test.projectName);
      assert.equal(test.results.length, declared.retries + 1);
      const witness = `${token}/${test.projectName}`;
      for (const attempt of test.results) {
        assert.equal(attempt.status, "failed");
        assert.ok(
          stripVTControlCharacters(attempt.error.message).includes(`deliberately-fail-${witness}`),
          "A setup/worker/other assertion error is not the intended negative-control failure",
        );
        const screenshot = artifact(attempt, "screenshot");
        const trace = artifact(attempt, "trace");
        const context = artifact(attempt, "error-context");
        assert.ok(
          context.bytes.toString("utf8").includes(witness),
          "Failure context lost its actual page",
        );
        const archive = unzipSync(trace.bytes);
        const entries = Object.keys(archive);
        assert.ok(entries.length > 0 && entries.length <= 16384);
        assert.ok(
          Object.values(archive).reduce((bytes, entry) => bytes + entry.length, 0) <=
            128 * 1024 * 1024,
        );
        assert.ok(
          entries
            .filter((name) => name.endsWith(".trace"))
            .some((name) => Buffer.from(archive[name]).includes(Buffer.from(witness))),
          "Trace archive lost its actual failure witness",
        );
        const pixels = await screenshotPixels(page, screenshot.bytes, project, witness);
        records.push({
          project: test.projectName,
          retry: attempt.retry,
          witness,
          pixels,
          traceEntries: entries,
          artifacts: [screenshot.record, trace.record, context.record],
        });
      }
    }
    assert.equal(hash(fs.readFileSync(configFile)), configSha256);
    assert.equal(hash(fs.readFileSync(scriptFile)), scriptSha256);
    proof = {
      kind: "Actual failing-browser evidence v1",
      headSha,
      token,
      runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      platform: process.platform,
      configSha256,
      scriptSha256,
      childExit: command.status,
      schemaFile: relative(schemaFile),
      resultFile: relative(resultFile),
      resultSha256: hash(resultBytes),
      everyDeclaredProjectVerified: true,
      records,
      applicationCasesOrPoliciesChanged: false,
      realApplicationOrOldGpuFailureReproduced: false,
    };
  } catch (error) {
    failures.push(error);
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    fs.rmSync(input, { recursive: true });
  } catch (error) {
    failures.push(error);
  }
  if (fs.existsSync(input)) failures.push(new Error("Owned fixture input survived cleanup"));
  if (failures.length) {
    fs.writeFileSync(
      path.join(reportRoot, "failure.json"),
      JSON.stringify(
        failures.map((error) => ({ message: error.message, stack: error.stack })),
        null,
        2,
      ),
      { flag: "wx" },
    );
    throw new AggregateError(
      failures,
      `Failure-evidence probe refused qualification; retained ${relative(reportRoot)}`,
    );
  }
  proof.temporaryInputObservedAbsent = true;
  fs.writeFileSync(path.join(reportRoot, "qualified.json"), JSON.stringify(proof, null, 2), {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      negativeControl: true,
      actualFixtureExit: proof.childExit,
      projects: proof.records.map((record) => record.project),
      verifiedAttachments: proof.records.reduce(
        (count, record) => count + record.artifacts.length,
        0,
      ),
      nativeScreenshotPixelsVerified: true,
      report: relative(path.join(reportRoot, "qualified.json")),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
