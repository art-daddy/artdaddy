// The preview shows a rotated video the way the export does (UJ-015), in a REAL browser engine.
//
// preview-probe-rotation.html decodes each fixture in e2e/ui/fixtures/rotation with the preview's
// own decoder (mp4box + WebCodecs) and composites it with the preview's WebGL2 renderer; this spec
// reads the CANVAS and holds it to expected.json, which is what the shipped ffmpeg - the export -
// shows for that file (src/preview/orientation.smoke.e2e.ts keeps that file honest). A user's
// phone clip played on its side here while exporting upright: 4 of 14 WhatsApp clips in one
// birthday montage.
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Page, expect, test } from "@playwright/test";

import {
  PALETTE,
  ROTATION_FIXTURES,
  type RotationExpected,
} from "../../src/preview/__rotationFixtures";
import type { RotationShot } from "../../src/preview/__probeRotation";

const EXPECTED = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "e2e/ui/fixtures/rotation/expected.json"), "utf8"),
) as RotationExpected;

let page: Page;
let shots: Record<string, RotationShot>;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/preview-probe-rotation.html");
  await page.waitForFunction(() => "__rotation" in window, undefined, { timeout: 60_000 });
  shots = await page.evaluate(
    () => (window as unknown as { __rotation: Record<string, RotationShot> }).__rotation,
  );
  await test.info().attach("rotation-pixels", {
    body: JSON.stringify(shots, null, 2),
    contentType: "application/json",
  });
  console.log("rotation-controls", JSON.stringify(shots["h264_rot0.mp4"]));
  console.log("rotation-software-control", JSON.stringify(shots["software:h264_rot0.mp4"]));
  console.log(
    "rotation-configured-color-control",
    JSON.stringify(shots["configured-color:h264_rot0.mp4"]),
  );
  expect((shots as { error?: string }).error, "the probe failed to run").toBeUndefined();
});
test.afterAll(async () => {
  await page?.close();
});

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test.describe("a rotated video previews as it exports (real WebCodecs + WebGL2)", () => {
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
