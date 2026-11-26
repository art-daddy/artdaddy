// Whole-frame parity, the EXPORT half (art-daddy/backlog#83). Every case of __parityCases.ts is
// exported through the app's own export tool with the shipped ffmpeg, and each compared frame of the
// file, decoded by ffmpeg and pooled into block means, is held to its frozen reference. The browser
// lane (e2e/ui/parity.spec.ts) holds the PREVIEW to the very same references: one frozen answer,
// anchored from both sides, as the rotation fixtures are.
//
//   npx vitest run --config vitest.smoke.config.ts src/preview/parity.smoke.e2e.ts
//
// ARTDADDY_PARITY_WRITE=1 writes the references instead (npm run fixtures:parity does, after making
// the media); never to make this test pass. ARTDADDY_PARITY_FRAMES=<dir> also keeps every full-size
// frame there, to look at. A frame that fails is kept under reports/qa/exporter/parity either way.
import { existsSync, promises as fsp, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ALL_PARITY_CASES,
  PARITY_BLOCK,
  PARITY_CANVAS,
  PARITY_DIR,
  PARITY_MEDIA,
  type ParityCase,
  type ParityMedia,
  referenceName,
} from "./__parityCases";
import { type Picture, describe as told, difference, pool, within } from "../test/frameParity";
import { decodePng, encodePng } from "../test/png";
import { ensureTimeline, loadTimeline, replaceTimeline } from "../timeline/engine";
import { whenExportEnds } from "../timeline/exportQueue";
import { exportTimelineTool } from "../timeline/render";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  probe,
  resetE2EDocuments,
} from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import { joinPath } from "../tools/store";

type Rec = Record<string, unknown>;

/** How close the export must come to its own frozen reference on any platform: the shipped ffmpeg
 *  builds differ by platform and x264 by thread count, which moves a block by a level or two. A
 *  look that changed (a missing caption, a moved box, another frame) moves blocks by tens. */
export const EXPORT_TOLERANCE = { mean: 1.5, max: 12 };

const WRITE = process.env.ARTDADDY_PARITY_WRITE === "1";
const KEEP = process.env.ARTDADDY_PARITY_FRAMES ?? "";
const DIR = path.resolve(process.cwd(), PARITY_DIR);
const EVIDENCE = path.resolve(process.cwd(), "reports/qa/exporter/parity");
const ROOT = joinPath(os.tmpdir(), `artdaddy-parity-${Date.now()}`);
const { width: W, height: H } = PARITY_CANVAS;

// No test here may reach a network: an export that looks for its branding finds none, and says so.
const fetched: string[] = [];
beforeAll(async () => {
  installE2EDocuments();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("no network in the parity lane");
  });
  await fsp.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function project(name: string): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  const ctx = mkCtx(dir);
  await openE2EDoc(dir);
  await ensureTimeline(ctx.store);
  return ctx;
}

/** Export `c` through the app's export tool; the exported file. */
async function exported(c: ParityCase): Promise<string> {
  const ctx = await project(c.name);
  const refs = {} as Record<ParityMedia, string>;
  for (const media of Object.keys(PARITY_MEDIA) as ParityMedia[])
    refs[media] = await libRef(ctx, path.join(DIR, PARITY_MEDIA[media]));
  const authored = c.timeline((media) => refs[media]);
  const current = await loadTimeline(ctx.store);
  expect(await replaceTimeline(ctx.store, { ...current, ...authored })).toBe(true);
  const res = (await exportTimelineTool({ name: c.name }, ctx)) as Rec;
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const ended = await whenExportEnds(String(res.job_id));
  expect(ended?.state, String(ended?.error)).toBe("done");
  return ctx.store.exportPath(`${c.name}.mp4`);
}

/** Frame `n` of `file` as ffmpeg decodes it, the picture a player shows. */
async function frame(file: string, n: number): Promise<Picture> {
  const raw = joinPath(ROOT, `frame-${process.pid}-${Math.random().toString(36).slice(2)}.rgb`);
  await ff([
    ...["-y", "-v", "error", "-i", file],
    ...["-vf", `select=eq(n\\,${n})`, "-fps_mode", "passthrough", "-frames:v", "1"],
    ...["-f", "rawvideo", "-pix_fmt", "rgb24", raw],
  ]);
  const rgb = new Uint8Array(readFileSync(raw));
  expect(rgb.length, `frame ${n} of ${path.basename(file)}`).toBe(W * H * 3);
  return { w: W, h: H, rgb };
}

async function keep(dir: string, name: string, picture: Picture): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  writeFileSync(path.join(dir, name), encodePng(picture));
}

describe("the export shows the frozen parity references", () => {
  it("every case has a reference for every frame it compares, and nothing else is kept", () => {
    if (WRITE) return;
    const wanted = new Set(
      ALL_PARITY_CASES.flatMap((c) => c.frames.map((f) => referenceName(c.name, f))),
    );
    for (const name of wanted) expect(existsSync(path.join(DIR, name)), name).toBe(true);
    const kept = existsSync(path.join(DIR, "ref"))
      ? readdirSync(path.join(DIR, "ref")).map((f) => `ref/${f}`)
      : [];
    expect(kept.filter((f) => !wanted.has(f))).toEqual([]);
  });

  const seen = new Map<string, Picture>();
  for (const c of ALL_PARITY_CASES) {
    const here = !c.platform || c.platform === process.platform;
    it.skipIf(!here)(
      `${c.name}: ${c.what}`,
      async () => {
        const file = await exported(c);
        const size = await probe(file);
        expect([size.width, size.height]).toEqual([W, H]);
        for (const n of c.frames) {
          const full = await frame(file, n);
          const blocks = pool(full, PARITY_BLOCK);
          seen.set(`${c.name}@${n}`, blocks);
          const name = referenceName(c.name, n);
          if (KEEP) await keep(KEEP, `${c.name}@${n}.export.png`, full);
          if (WRITE) {
            writeFileSync(path.join(DIR, name), encodePng(blocks));
            continue;
          }
          const reference = decodePng(readFileSync(path.join(DIR, name)));
          const d = difference(blocks, reference);
          console.log(`[parity] export ${c.name}@${n}: ${told(d)}`);
          if (!within(d, EXPORT_TOLERANCE)) {
            await keep(EVIDENCE, `${c.name}@${n}.export.png`, full);
            await keep(EVIDENCE, `${c.name}@${n}.export-blocks.png`, blocks);
          }
          expect(
            within(d, EXPORT_TOLERANCE),
            `${name}: the export differs from its reference (${told(d)}; allowed mean ${EXPORT_TOLERANCE.mean}, max ${EXPORT_TOLERANCE.max})`,
          ).toBe(true);
        }
      },
      240_000,
    );
  }

  it("a moving picture is exported at its own moment: the frames of one case differ", () => {
    for (const c of ALL_PARITY_CASES.filter((p) => p.frames.length > 1)) {
      const [first, last] = [c.frames[0], c.frames[c.frames.length - 1]];
      const [a, b] = [seen.get(`${c.name}@${first}`), seen.get(`${c.name}@${last}`)];
      if (!a || !b) continue; // that case did not run here
      expect(difference(a, b).max, `${c.name}@${first} against @${last}`).toBeGreaterThan(
        EXPORT_TOLERANCE.max * 4,
      );
    }
  });

  it("reached no network", () => {
    expect(fetched.filter((url) => !/\/exports\/branding\//.test(url))).toEqual([]);
  });
});
