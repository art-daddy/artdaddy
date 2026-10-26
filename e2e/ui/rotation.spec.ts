// The preview shows a rotated video the way the export does (UJ-015), in a REAL browser engine.
//
// preview-probe-rotation.html decodes each fixture in e2e/ui/fixtures/rotation with the preview's
// own decoder (mp4box + WebCodecs) and composites it with the preview's WebGL2 renderer; this spec
// reads the CANVAS and holds it to expected.json, which is what the shipped ffmpeg - the export -
// shows for that file (src/preview/orientation.smoke.e2e.ts keeps that file honest). A user's
// phone clip played on its side here while exporting upright: 4 of 14 WhatsApp clips in one
// birthday montage.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { type Page, type TestInfo, expect, test } from "@playwright/test";

import {
  PALETTE,
  ROTATION_FIXTURES,
  type RotationExpected,
} from "../../src/preview/__rotationFixtures";
import type { RotationShot } from "../../src/preview/__probeRotation";
import { ProbeStalled, retryStalledProbe } from "../../src/test/probeRetry";

const EXPECTED = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "e2e/ui/fixtures/rotation/expected.json"), "utf8"),
) as RotationExpected;

let page: Page;
let shots: Record<string, RotationShot>;

/** The probe's last reported stage, without trusting a page that may be too stuck to answer. */
async function stageOf(target: Page): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.evaluate(
        () =>
          (window as unknown as { __rotationStage?: string }).__rotationStage ??
          "module-not-started",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("page-unresponsive"), 5_000);
      }),
    ]);
  } catch {
    return "page-unreachable";
  } finally {
    clearTimeout(timer);
  }
}

async function closeWithin(target: Page, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    target.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

async function normalizedSources(info: TestInfo): Promise<Record<string, string>> {
  const reportPath = info.outputPath("normalized-sources.json");
  await promisify(execFile)(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.smoke.config.ts",
      "src/preview/orientation.smoke.e2e.ts",
      "-t",
      "prepares normalized fixtures for the native pixel gate",
      "--reporter=dot",
    ],
    {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        ARTDADDY_PIXEL_PROJECT: info.outputPath("preview-project"),
        ARTDADDY_PIXEL_REPORT: reportPath,
        ARTDADDY_PIXEL_BASE_URL: info.project.use.baseURL!,
      },
    },
  );
  return JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, string>;
}

test.beforeAll(async ({ browser }, info) => {
  // Every try at the probe is bounded (30 s to load, 60 s to report, a few seconds to diagnose and
  // replace the page), a stall earns one more try, and the normalization pass can need both. The
  // old 180 s was for a single try.
  info.setTimeout(480_000);
  const nativeEngine = info.project.name === "system-wkwebview";
  const openPage = async (): Promise<Page> => {
    const fresh = await browser.newPage();
    fresh.on("console", (message) => {
      if (message.text().startsWith("rotation-stage")) console.log(message.text());
    });
    return fresh;
  };
  if (!nativeEngine) page = await openPage();
  const load = async (url: string, phase: string): Promise<Record<string, RotationShot>> => {
    if (nativeEngine) {
      const reportPath = info.outputPath(`system-wkwebview-${phase}.json`);
      await promisify(execFile)(
        "swift",
        [path.resolve("scripts/qa/systemWebkitPixels.swift"), url, reportPath],
        { timeout: 80_000 },
      );
      const report = readFileSync(reportPath, "utf8");
      const native = JSON.parse(report) as { engine: string; shots: Record<string, RotationShot> };
      expect(native.engine).toBe("system WKWebView");
      await info.attach(`system-wkwebview-${phase}`, {
        body: report,
        contentType: "application/json",
      });
      return native.shots;
    }
    // A page that stalls (macos-14's Chrome did, twice in three runs) is replaced and asked once
    // more; a probe that stalls on every try, or any other failure, still fails.
    return retryStalledProbe(
      async () => {
        try {
          await page.goto(url, { timeout: 30_000 });
          await page.waitForFunction(() => "__rotation" in window, undefined, { timeout: 60_000 });
        } catch (error) {
          const stage = await stageOf(page);
          await info.attach("rotation-initialization-stage", {
            body: JSON.stringify({ phase, stage, url }),
            contentType: "application/json",
          });
          throw new ProbeStalled(
            `Rotation probe did not finish during ${phase}; stage=${stage}: ${String(error)}`,
            stage,
          );
        }
        return page.evaluate(
          () => (window as unknown as { __rotation: Record<string, RotationShot> }).__rotation,
        );
      },
      async (stalled, tryNumber) => {
        console.log(
          `rotation-probe-stalled phase=${phase} try=${tryNumber} stage=${stalled.stage}; trying again on a fresh page`,
        );
        const stale = page;
        page = await openPage();
        await closeWithin(stale, 10_000);
      },
    );
  };
  const url = new URL("/preview-probe-rotation.html", info.project.use.baseURL!);
  shots = await load(url.href, "original");
  expect((shots as { error?: string }).error, "the original probe failed to run").toBeUndefined();
  expect(typeof shots["native-h264"]?.decoded, "no runtime calibration evidence").toBe("boolean");
  if (!shots["native-h264"].decoded || info.project.name === "chromium-proxy") {
    await info.attach("original-native-pixels", {
      body: JSON.stringify(shots, null, 2),
      contentType: "application/json",
    });
    url.searchParams.set("sources", JSON.stringify(await normalizedSources(info)));
    shots = await load(url.href, "normalized");
    console.log("rotation-normalized-runtime", JSON.stringify(shots["h264_rot0.mp4"]));
  }
  await test.info().attach("rotation-pixels", {
    body: JSON.stringify(shots, null, 2),
    contentType: "application/json",
  });
  console.log("rotation-controls", JSON.stringify(shots["h264_rot0.mp4"]));
  console.log(
    "rotation-encoding-controls",
    JSON.stringify({
      high640: shots["h264_size_control.mp4"],
      baseline160: shots["h264_baseline_control.mp4"],
    }),
  );
  console.log("rotation-tagged-stream-control", JSON.stringify(shots["tagged:h264_rot0.mp4"]));
  console.log("rotation-software-control", JSON.stringify(shots["software:h264_rot0.mp4"]));
  console.log(
    "rotation-configured-color-control",
    JSON.stringify(shots["configured-color:h264_rot0.mp4"]),
  );
  console.log("rotation-html-video-control", JSON.stringify(shots["html-video:h264_rot0.mp4"]));
  expect((shots as { error?: string }).error, "the probe failed to run").toBeUndefined();
});
test.afterAll(async () => {
  await page?.close();
});

test("failed calibration selects normalization without waiting for stalled original decoders", async ({
  browser,
}) => {
  const controlPage = await browser.newPage();
  const fixtureRequests: string[] = [];
  try {
    controlPage.on("request", (request) => {
      if (request.url().includes("/fixtures/rotation/")) fixtureRequests.push(request.url());
    });
    await controlPage.route("**/h264Calibration.mp4", (route) => route.abort());
    await controlPage.addInitScript(() => {
      if (typeof VideoDecoder !== "undefined") {
        VideoDecoder.prototype.decode = function () {};
        VideoDecoder.prototype.flush = function () {
          return new Promise<void>(() => {});
        };
      }
    });
    await controlPage.goto("/preview-probe-rotation.html");
    await controlPage.waitForFunction(() => "__rotation" in window, undefined, { timeout: 10_000 });
    const result = await controlPage.evaluate(
      () => (window as unknown as { __rotation: Record<string, RotationShot> }).__rotation,
    );
    expect(result["native-h264"].decoded).toBe(false);
    expect(Object.keys(result)).toEqual(["native-h264"]);
    expect(fixtureRequests).toEqual([]);
  } finally {
    await controlPage.close();
  }
});

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The browser's own <video> is a control the log shows beside the decoder path; nothing holds a
// picture to it. On macos-14 it once never presented a frame and the whole probe page waited on it
// for good (`stage=html-video:present`), failing every test below. It must be reported, not waited on.
test("a video control that never presents a frame is reported, not waited on", async ({
  browser,
}) => {
  const controlPage = await browser.newPage();
  try {
    await controlPage.addInitScript(() => {
      HTMLVideoElement.prototype.requestVideoFrameCallback = () => 0; // never calls back
    });
    await controlPage.goto("/preview-probe-rotation.html?controlOnly=1&controlMs=1500");
    await controlPage.waitForFunction(() => "__rotation" in window, undefined, { timeout: 15_000 });
    const result = await controlPage.evaluate(
      () => (window as unknown as { __rotation: Record<string, RotationShot> }).__rotation,
    );
    const control = result["html-video:h264_rot0.mp4"];
    expect(control.decoded).toBe(false);
    expect(control.error).toMatch(/HTML video control/);
  } finally {
    await controlPage.close();
  }
});

test.describe("a rotated video previews as it exports (real WebCodecs + WebGL2)", () => {
  for (const file of ["h264_size_control.mp4", "h264_baseline_control.mp4"]) {
    test(`${file} preserves the original picture`, () => {
      const shot = shots[file];
      expect(shot.decoded, shot.error ?? "the encoding control did not decode").toBe(true);
      expect(shot.box, "nothing was drawn").not.toBeNull();
      expect(shot.corners).toEqual(EXPECTED.fixtures["h264_rot0.mp4"].corners);
    });
  }
  for (const fx of ROTATION_FIXTURES) {
    test(fx.file, () => {
      const want = EXPECTED.fixtures[fx.file];
      const shot = shots[fx.file];
      expect(shot.decoded, shot.error ?? "this browser did not decode the H.264 fixture").toBe(
        true,
      );
      expect(shot.box, "nothing was drawn").not.toBeNull();
      // The SHAPE the picture is drawn in: contain-fitted into a square canvas, a portrait picture
      // is pillarboxed and a landscape one letterboxed. 1 px of edge filtering either way.
      const [w, h] = want.display;
      const fit = Math.min(200 / w, 200 / h);
      expect(
        Math.abs(shot.box!.w - w * fit),
        `drawn ${shot.box!.w}x${shot.box!.h}`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(shot.box!.h - h * fit),
        `drawn ${shot.box!.w}x${shot.box!.h}`,
      ).toBeLessThanOrEqual(2);
      // The PICTURE: each corner the colour ffmpeg shows there.
      expect(shot.corners).toEqual(want.corners);
    });
  }

  test("a crop cuts the shown picture, not the stored one", () => {
    const want = EXPECTED.fixtures["h264_rot270.mp4"];
    const shot = shots["crop:h264_rot270.mp4"];
    expect(shot.decoded, shot.error).toBe(true);
    // crop.left 0.5 of a 96x160 portrait leaves its right half, 48x160: the shown top-right and
    // bottom-right colours, one above the other.
    expect(shot.box!.h).toBeGreaterThan(shot.box!.w * 2.5);
    expect([shot.corners[0], shot.corners[2]]).toEqual([want.corners[1], want.corners[3]]);
    expect([shot.corners[1], shot.corners[3]]).toEqual([want.corners[1], want.corners[3]]);
  });

  test("the motion smear runs across the shown picture, not along the stored frame", () => {
    const want = EXPECTED.fixtures["h264_rot270.mp4"];
    const shot = shots["motion:h264_rot270.mp4"];
    expect(shot.decoded, shot.error).toBe(true);
    const topLeft = PALETTE[want.corners[0]].rgb;
    const { acrossLeftRight, acrossTopBottom } = shot.at;
    // Beside the left|right boundary the smear blends the two halves; beside the top/bottom
    // boundary it must leave the top-left colour alone. A smear computed on the stored (sideways)
    // frame does the opposite.
    expect(dist(acrossLeftRight, topLeft), `left|right sample ${acrossLeftRight}`).toBeGreaterThan(
      40,
    );
    expect(dist(acrossTopBottom, topLeft), `top/bottom sample ${acrossTopBottom}`).toBeLessThan(25);
  });
});
