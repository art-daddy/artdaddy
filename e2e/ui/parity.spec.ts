// Whole-frame parity, the PREVIEW half (art-daddy/backlog#83): what a person sees in the preview is
// what they get in the exported file.
//
// preview-probe-parity.html draws every case of src/preview/__parityCases.ts with the preview's own
// client and runtime (real WebCodecs decode, real WebGL2 compositor, the bundled fonts) at the frames
// the export half compares, and this spec holds each to the SAME frozen reference the export is held
// to by src/preview/parity.smoke.e2e.ts: one answer, anchored from both sides. The references are
// frames of the real export, never drawn by hand (npm run fixtures:parity).
//
// The preview hub's known mismatches are cases too, and their tests are EXPECTED FAILURES
// (test.fail): each says how the preview differs today, and goes red the day the preview draws it
// like the export - then it becomes a plain test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type Page, expect, test } from "@playwright/test";

import {
  ALL_PARITY_CASES,
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
const shots = new Map<string, ParityShot>();

test.beforeAll(async ({ browser }, info) => {
  info.setTimeout(480_000);
  page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`parity-probe: ${message.text()}`);
  });
  await page.goto("/preview-probe-parity.html", { timeout: 60_000 });
  try {
    await page.waitForFunction(() => "__parity" in window, undefined, { timeout: 420_000 });
  } catch (error) {
    const stage = await page
      .evaluate(() => (window as unknown as { __parityStage?: string }).__parityStage)
      .catch(() => "page-unreachable");
    throw new Error(`the parity probe did not finish (stage ${stage}): ${String(error)}`);
  }
  const result = await page.evaluate(
    () => (window as unknown as { __parity: { shots?: ParityShot[]; error?: string } }).__parity,
  );
  expect(result.error, "the parity probe failed to run").toBeUndefined();
  for (const shot of result.shots ?? []) shots.set(`${shot.case}@${shot.frame}`, shot);
});
test.afterAll(async () => {
  await page?.close();
});

const shotOf = (c: ParityCase, frame: number): ParityShot => {
  const shot = shots.get(`${c.name}@${frame}`);
  if (!shot) throw new Error(`the probe drew no ${c.name}@${frame}`);
  return shot;
};
const picture = (shot: ParityShot): Picture => ({
  w: shot.w,
  h: shot.h,
  rgb: Uint8Array.from(shot.blocks),
});
const reference = (c: ParityCase, frame: number): Picture =>
  decodePng(readFileSync(path.resolve(PARITY_DIR, referenceName(c.name, frame))));

/** The preview's frame `frame` of `c` against the export's, with the evidence attached. */
async function compared(c: ParityCase, frame: number): Promise<Difference> {
  const shot = shotOf(c, frame);
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

test("the preview drew every case, and reported nothing wrong", () => {
  for (const c of ALL_PARITY_CASES)
    for (const frame of c.frames) {
      const shot = shotOf(c, frame);
      expect(shot.errors, `${c.name}@${frame}`).toEqual([]);
      expect(shot.renders, `${c.name}@${frame}: the preview never drew`).toBeGreaterThan(0);
    }
});

test.describe("the preview draws what the export shows (whole frames)", () => {
  for (const c of PARITY_CASES)
    for (const frame of c.frames)
      test(`${c.name}@${frame}: ${c.what}`, async () => {
        const d = await compared(c, frame);
        expect(
          within(d, PREVIEW_TOLERANCE),
          `the preview differs from the export (${told(d)}; allowed mean ${PREVIEW_TOLERANCE.mean}, max ${PREVIEW_TOLERANCE.max})`,
        ).toBe(true);
      });

  test("a moving picture is drawn at its own moment: the frames of one case differ", () => {
    for (const c of PARITY_CASES.filter((p) => p.frames.length > 1)) {
      const [first, last] = [c.frames[0], c.frames[c.frames.length - 1]];
      const d = difference(picture(shotOf(c, first)), picture(shotOf(c, last)));
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
        test.fail(true, c.known);
        const d = await compared(c, frame);
        expect(within(d, PREVIEW_TOLERANCE), told(d)).toBe(true);
      });

  test("plain@10 to the level: row 7, two scalers and two YUV conversions never agree exactly", async () => {
    test.fail(true, "row 7: bilinear sampling and the webview's YUV->RGB against ffmpeg's");
    const plain = PARITY_CASES.find((c) => c.name === "plain")!;
    const d = await compared(plain, 10);
    expect(within(d, { mean: 0, max: 0 }), told(d)).toBe(true);
  });
});
