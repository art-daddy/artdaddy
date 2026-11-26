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
// never taken for that difference: such a test fails for real, unless drawing nothing is the
// mismatch itself (a case marked `undrawn`).
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

/** How close the preview must come to the export, in block means of 4x4 pixels (0-255), in each lane
 *  a picture can be drawn in. Measured on 26 Nov over the cases below:
 *  - `gpu`: Chromium on a machine with a GPU (the lab PC, the macOS runners): mean 1.5 to 3.7, max
 *    11 to 51. MAX 64 is what a one-pixel shift of the sharpest edge (black against white) does to a
 *    block: the painters round a box's edge differently (hub mismatch 7).
 *  - `noGpu`: Chromium on a machine without one (the Windows and Linux runners). Chrome then turns
 *    video frames into RGB another way, a level or two further from ffmpeg: mean up to 5.5
 *    (fit-crop), max up to 57. Chrome started with --disable-gpu on the lab PC draws the same
 *    numbers, to the hundredth.
 *  - `webkit`: WebKit (macOS, Linux): mean up to 4.1, max up to 76 at the sharpest colour edges, where
 *    its decoder's half-resolution (4:2:0) colour lands a pixel or two from ffmpeg's.
 *  Every lane still catches what matters: a missing caption moves a block by 190, a title 3 px out
 *  of place by 165, a frame shown at the wrong time by 187, a picture 15% darker the mean by 25. */
export const PREVIEW_TOLERANCE = {
  gpu: { mean: 5, max: 64 },
  noGpu: { mean: 7, max: 64 },
  webkit: { mean: 6, max: 96 },
} as const;
type Lane = keyof typeof PREVIEW_TOLERANCE;

/** The lane this run draws in. GitHub's Windows and Linux runners have no GPU; its macOS runners
 *  and the lab PC do. */
function laneOf(browserName: string): Lane {
  if (browserName === "webkit") return "webkit";
  return process.env.CI && process.platform !== "darwin" ? "noGpu" : "gpu";
}

const KEEP = process.env.ARTDADDY_PARITY_FRAMES ?? "";

// A stalled page is replaced and drawn on again, which can take a minute on its own.
test.describe.configure({ timeout: 150_000 });

let page: Page;
let opener: () => Promise<Page>;

test.beforeAll(async ({ browser }, info) => {
  info.setTimeout(180_000);
  opener = async () => {
    const opened = await browser.newPage();
    opened.on("console", (message) => {
      if (message.type() === "error") console.log(`parity-probe: ${message.text()}`);
    });
    await opened.goto("/preview-probe-parity.html", { timeout: 60_000 });
    await opened.waitForFunction(() => "__parityReady" in window, undefined, { timeout: 60_000 });
    return opened;
  };
  page = await opener();
});
test.afterAll(async () => {
  await page?.close();
});

/** The preview's picture of `c` at `frame`, drawn now. */
async function drawOn(target: Page, c: ParityCase, frame: number): Promise<ParityShot> {
  return target.evaluate(
    ([name, at]) =>
      (
        window as unknown as { __parityDraw: (n: string, f: number) => Promise<ParityShot> }
      ).__parityDraw(name, at),
    [c.name, frame] as const,
  );
}

/** As {@link drawOn}, on the lane's page. A page whose video never arrives (seen on the first draw
 *  of a fresh page on a busy Windows PC, never on CI) is replaced and asked once more, as
 *  rotation.spec does; a second stall is the answer. `retry` false: a stall is the answer at once. */
async function draw(c: ParityCase, frame: number, retry = true): Promise<ParityShot> {
  const shot = await drawOn(page, c, frame);
  if (!retry || !shot.errors.some((e) => e.startsWith("did not settle"))) return shot;
  console.log(`[parity] ${c.name}@${frame} stalled (${shot.errors.join("; ")}): on a fresh page`);
  await page.close();
  page = await opener();
  return drawOn(page, c, frame);
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

/** The preview's picture against the export's, held to the tolerance of the lane it was drawn in,
 *  with the picture attached when it is outside it. */
async function compared(
  c: ParityCase,
  frame: number,
  shot: ParityShot,
  lane: Lane,
): Promise<{ d: Difference; ok: boolean; told: string }> {
  const tolerance = PREVIEW_TOLERANCE[lane];
  const d = difference(picture(shot), reference(c, frame));
  const ok = within(d, tolerance);
  const how = `${told(d)}; the ${lane} lane allows mean ${tolerance.mean}, max ${tolerance.max}`;
  console.log(`[parity] preview ${c.name}@${frame}: ${how} (settled in ${shot.settledMs} ms)`);
  const png = Buffer.from(shot.png.replace(/^data:image\/png;base64,/, ""), "base64");
  if (KEEP) {
    mkdirSync(KEEP, { recursive: true });
    writeFileSync(path.join(KEEP, `${c.name}@${frame}.preview.png`), png);
  }
  if (!ok)
    await test.info().attach(`${c.name}@${frame}.preview.png`, {
      body: png,
      contentType: "image/png",
    });
  return { d, ok, told: how };
}

function expectDrawn(c: ParityCase, frame: number, shot: ParityShot): void {
  expect(shot.errors, `${c.name}@${frame}: what the preview reported`).toEqual([]);
  expect(shot.renders, `${c.name}@${frame}: the preview never drew`).toBeGreaterThan(0);
}

test.describe("the preview draws what the export shows (whole frames)", () => {
  for (const c of PARITY_CASES)
    for (const frame of c.frames)
      test(`${c.name}@${frame}: ${c.what}`, async ({ browserName }) => {
        const shot = await draw(c, frame);
        const knownHere = c.knownIn?.[browserName as "chromium" | "webkit"];
        // In an engine with a mismatch of its own, only a picture it did draw is expected to differ.
        test.fail(!!knownHere && drawn(shot), knownHere);
        expectDrawn(c, frame, shot);
        const { ok, told: how } = await compared(c, frame, shot, laneOf(browserName));
        expect(ok, `the preview differs from the export (${how})`).toBe(true);
      });

  test("a moving picture is drawn at its own moment: the frames of one case differ", async () => {
    const widest = Math.max(...Object.values(PREVIEW_TOLERANCE).map((t) => t.max));
    for (const c of PARITY_CASES.filter((p) => p.frames.length > 1)) {
      const [first, last] = [c.frames[0], c.frames[c.frames.length - 1]];
      const [a, b] = [await draw(c, first), await draw(c, last)];
      expectDrawn(c, first, a);
      expectDrawn(c, last, b);
      const d = difference(picture(a), picture(b));
      expect(d.max, `${c.name}@${first} against @${last}`).toBeGreaterThan(widest);
    }
  });
});

test.describe("known mismatches (hub table): expected to fail until the preview matches", () => {
  for (const c of KNOWN_MISMATCH_CASES)
    for (const frame of c.frames)
      test(`${c.name}@${frame}: ${c.known}`, async ({ browserName }) => {
        test.skip(
          !!c.platform && c.platform !== process.platform,
          `the reference is the ${c.platform} export: its fallback face is that platform's`,
        );
        const shot = await draw(c, frame, !c.undrawn);
        // Only a picture the preview did draw is expected to differ; one it could not draw fails,
        // unless drawing nothing is the mismatch itself.
        test.fail(!!c.undrawn || drawn(shot), c.known);
        expectDrawn(c, frame, shot);
        const { ok, told: how } = await compared(c, frame, shot, laneOf(browserName));
        expect(ok, how).toBe(true);
      });

  test("plain@10 to the level: row 7, two scalers and two YUV conversions never agree exactly", async () => {
    const plain = PARITY_CASES.find((c) => c.name === "plain")!;
    const shot = await draw(plain, 10);
    test.fail(drawn(shot), "row 7: bilinear sampling and the webview's YUV->RGB against ffmpeg's");
    expectDrawn(plain, 10, shot);
    const d = difference(picture(shot), reference(plain, 10));
    console.log(`[parity] preview plain@10 to the level: ${told(d)}`);
    expect(within(d, { mean: 0, max: 0 }), told(d)).toBe(true);
  });
});
