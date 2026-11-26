// Whole-frame parity, the PREVIEW half (art-daddy/backlog#83): what a person sees in the preview is
// what they get in the exported file.
//
// preview-probe-parity.html draws a case of src/preview/__parityCases.ts with the preview's own
// client and runtime (real WebCodecs decode, real WebGL2 compositor, the bundled fonts) at a frame the
// export half compares, and this spec holds it to the SAME frozen reference the export is held to by
// src/preview/parity.smoke.e2e.ts: one answer, anchored from both sides. The references are frames of
// the real export, never drawn by hand (npm run fixtures:parity).
//
// The preview hub's known mismatches are cases too, and their tests are EXPECTED FAILURES
// (test.fail): each says how the preview differs today, and goes red the day the preview draws it
// like the export - then it becomes a plain test. A picture the preview could not draw at all is
// never taken for that difference: such a test fails for real.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type Page, expect, test } from "@playwright/test";

import {
  KNOWN_MISMATCH_CASES,
  PARITY_CASES,
  PARITY_DIR,
  type ParityCase,
  referenceName,
} from "../../src/preview/__parityCases";
import type { ParityShot } from "../../src/preview/__probeParity";
import {
  type Difference,
  type Picture,
  describe as told,
  difference,
  within,
} from "../../src/test/frameParity";
import { decodePng } from "../../src/test/png";

/** How close the preview must come to the export, in block means of 4x4 pixels (0-255):
 *  - MAX 64 for any one block: what a one-pixel shift of the sharpest edge (black against white)
 *    does to a 4x4 block. The two painters round a box's position and sample its edges differently
 *    (hub mismatch 7) and rasterise text twice (mismatch 10); neither promises the pixel.
 *  - MEAN 5 over the frame: the colour conversions differ by two or three levels.
 *  Measured on 26 Nov (Chromium, Windows): the cases below sit at mean 1.5 to 3.7 and max 11 to 51.
 *  A missing or moved caption, box or frame moves blocks by 100 and more; a colour cast moves the
 *  mean by 10 and more. */
export const PREVIEW_TOLERANCE = { mean: 5, max: 64 };

const KEEP = process.env.ARTDADDY_PARITY_FRAMES ?? "";

let page: Page;

test.beforeAll(async ({ browser }, info) => {
  info.setTimeout(180_000);
  page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`parity-probe: ${message.text()}`);
  });
  await page.goto("/preview-probe-parity.html", { timeout: 60_000 });
  await page.waitForFunction(() => "__parityReady" in window, undefined, { timeout: 60_000 });
});
test.afterAll(async () => {
  await page?.close();
});

/** The preview's picture of `c` at `frame`, drawn now. */
async function draw(c: ParityCase, frame: number): Promise<ParityShot> {
  return page.evaluate(
    ([name, at]) =>
      (
        window as unknown as { __parityDraw: (n: string, f: number) => Promise<ParityShot> }
      ).__parityDraw(name, at),
    [c.name, frame] as const,
  );
}

const picture = (shot: ParityShot): Picture => ({
  w: shot.w,
  h: shot.h,
  rgb: Uint8Array.from(shot.blocks),
});
const reference = (c: ParityCase, frame: number): Picture =>
  decodePng(readFileSync(path.resolve(PARITY_DIR, referenceName(c.name, frame))));

/** Did the preview draw a picture at all: nothing it reported going wrong, and at least one draw. */
const drawn = (shot: ParityShot): boolean => shot.errors.length === 0 && shot.renders > 0;

/** The preview's picture against the export's, with the picture attached when they differ. */
async function compared(c: ParityCase, frame: number, shot: ParityShot): Promise<Difference> {
  const d = difference(picture(shot), reference(c, frame));
  console.log(`[parity] preview ${c.name}@${frame}: ${told(d)} (settled in ${shot.settledMs} ms)`);
  const png = Buffer.from(shot.png.replace(/^data:image\/png;base64,/, ""), "base64");
  if (KEEP) {
    mkdirSync(KEEP, { recursive: true });
    writeFileSync(path.join(KEEP, `${c.name}@${frame}.preview.png`), png);
  }
  if (!within(d, PREVIEW_TOLERANCE))
    await test.info().attach(`${c.name}@${frame}.preview.png`, {
      body: png,
      contentType: "image/png",
    });
  return d;
}

function expectDrawn(c: ParityCase, frame: number, shot: ParityShot): void {
  expect(shot.errors, `${c.name}@${frame}: what the preview reported`).toEqual([]);
  expect(shot.renders, `${c.name}@${frame}: the preview never drew`).toBeGreaterThan(0);
}

test.describe("the preview draws what the export shows (whole frames)", () => {
  for (const c of PARITY_CASES)
    for (const frame of c.frames)
      test(`${c.name}@${frame}: ${c.what}`, async () => {
        const shot = await draw(c, frame);
        expectDrawn(c, frame, shot);
        const d = await compared(c, frame, shot);
        expect(
          within(d, PREVIEW_TOLERANCE),
          `the preview differs from the export (${told(d)}; allowed mean ${PREVIEW_TOLERANCE.mean}, max ${PREVIEW_TOLERANCE.max})`,
        ).toBe(true);
      });

  test("a moving picture is drawn at its own moment: the frames of one case differ", async () => {
    for (const c of PARITY_CASES.filter((p) => p.frames.length > 1)) {
      const [first, last] = [c.frames[0], c.frames[c.frames.length - 1]];
      const [a, b] = [await draw(c, first), await draw(c, last)];
      expectDrawn(c, first, a);
      expectDrawn(c, last, b);
      const d = difference(picture(a), picture(b));
      expect(d.max, `${c.name}@${first} against @${last}`).toBeGreaterThan(PREVIEW_TOLERANCE.max);
    }
  });
});

test.describe("known mismatches (hub table): expected to fail until the preview matches", () => {
  for (const c of KNOWN_MISMATCH_CASES)
    for (const frame of c.frames)
      test(`${c.name}@${frame}: ${c.known}`, async () => {
        test.skip(
          !!c.platform && c.platform !== process.platform,
          `the reference is the ${c.platform} export: its fallback face is that platform's`,
        );
        const shot = await draw(c, frame);
        // Only a picture the preview did draw is expected to differ; one it could not draw fails.
        test.fail(drawn(shot), c.known);
        expectDrawn(c, frame, shot);
        const d = await compared(c, frame, shot);
        expect(within(d, PREVIEW_TOLERANCE), told(d)).toBe(true);
      });

  test("plain@10 to the level: row 7, two scalers and two YUV conversions never agree exactly", async () => {
    const plain = PARITY_CASES.find((c) => c.name === "plain")!;
    const shot = await draw(plain, 10);
    test.fail(drawn(shot), "row 7: bilinear sampling and the webview's YUV->RGB against ffmpeg's");
    expectDrawn(plain, 10, shot);
    const d = await compared(plain, 10, shot);
    expect(within(d, { mean: 0, max: 0 }), told(d)).toBe(true);
  });
});
