// Dev-only probe for e2e/ui/parity.spec.ts (art-daddy/backlog#83). Draws a parity case of
// __parityCases.ts, on demand (window.__parityDraw), with the preview's OWN client -
// createPreviewClient: the real source resolution (resolvePreviewUrl, with its H.264 calibration), the
// runtime the preview worker runs (startPreviewRuntime, here on the main thread, which is where the app
// runs it when the worker has no WebGL2), the main thread's text rasteriser and the bundled fonts - at
// one compared frame, and reports what the canvas SHOWS, pooled into the same block means the export's
// references hold. Nothing is read back from the code under test: the answer is read off the pixels.
// Not part of the production build.
import {
  ALL_PARITY_CASES,
  PARITY_BLOCK,
  PARITY_DIR,
  PARITY_MEDIA,
  type ParityCase,
} from "./__parityCases";
import { createPreviewClient } from "./previewClient";
import { createMainThreadPreview } from "./previewRuntime";
import {
  type PreviewEndpoint,
  type PreviewInbound,
  type PreviewOutbound,
  timelineSources,
} from "./protocol";
import { setAssetAccessGrant, setAssetUrlConverter } from "./resolve";
import { fromRgba, pool } from "../test/frameParity";
import type { ProjectStoreAccess } from "../tools/store";

export interface ParityShot {
  case: string;
  frame: number;
  /** The block grid, PARITY_BLOCK times smaller than the canvas each way. */
  w: number;
  h: number;
  /** RGB block means, row by row. */
  blocks: number[];
  /** The whole frame as a PNG data URL: kept as evidence when its test fails. */
  png: string;
  /** How many times the runtime drew, and how long the picture took to settle. */
  renders: number;
  settledMs: number;
  /** Anything the preview reported going wrong (a source it could not show, a render error). */
  errors: string[];
}

const SETTLE_MS = 400; // no new picture for this long, with nothing outstanding: the frame is final
const SHOT_LIMIT_MS = 30_000;
const LIBRARY = "/parity-probe/library/";

const stage = (what: string): void => {
  (window as unknown as { __parityStage: string }).__parityStage = what;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The library the app would resolve a ref through: here a ref is the media file's own name, and its
// file is served by the dev server from the fixtures folder.
setAssetUrlConverter(
  (abs) => new URL(`/${PARITY_DIR}/${abs.slice(abs.lastIndexOf("/") + 1)}`, location.href).href,
);
setAssetAccessGrant(async () => {});
const store = {
  projectDir: "/parity-probe",
  resolveRef: async (ref: string) => `${LIBRARY}${ref}`,
  exists: async () => false,
  resolveWritable: () => null,
  linksFile: async () => false,
  readText: async () => "",
} as unknown as ProjectStoreAccess;

/** The runtime's endpoint, with every message in and out shown to the probe first. */
function tapped(
  inner: PreviewEndpoint,
  out: (message: PreviewOutbound) => void,
  into: (message: PreviewInbound) => void,
): PreviewEndpoint {
  const outer: PreviewEndpoint = {
    onmessage: null,
    postMessage(message, transfer) {
      into(message);
      inner.postMessage(message, transfer);
    },
    terminate() {
      inner.terminate();
    },
  };
  inner.onmessage = (event) => {
    out(event.data);
    outer.onmessage?.(event);
  };
  return outer;
}

async function shoot(c: ParityCase, frame: number): Promise<ParityShot> {
  const timeline = c.timeline((media) => PARITY_MEDIA[media]);
  const fps = timeline.canvas.fps;
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const snapshot = document.createElement("canvas");
  snapshot.width = timeline.canvas.width;
  snapshot.height = timeline.canvas.height;
  const pen = snapshot.getContext("2d", { willReadFrequently: true })!;
  const errors: string[] = [];
  const sized = new Set<string>();
  let renders = 0;
  let lastRender = 0;
  let stalled = false;
  let textOut = 0;
  const started = performance.now();
  const client = createPreviewClient(canvas, {
    createWorker: () => {
      throw new Error("the parity probe draws with the main-thread runtime");
    },
    createFallback: () =>
      tapped(
        createMainThreadPreview(),
        (message) => {
          if (message.type === "rendered") {
            // The SAME task as the draw: the WebGL context does not preserve its drawing buffer.
            pen.drawImage(canvas, 0, 0);
            renders += 1;
            lastRender = performance.now();
          } else if (message.type === "stalled") stalled = message.stalled;
          else if (message.type === "needText") textOut += 1;
          else if (message.type === "dims") sized.add(message.source);
          else if (message.type === "failure")
            errors.push(`${message.source}: ${message.reason} ${message.codec}`.trim());
          else if (message.type === "error") errors.push(message.message);
        },
        (message) => {
          if (message.type === "textBitmap") textOut -= 1;
        },
      ),
    resolveAnimation: async () => null,
    report: () => undefined,
    onError: (message) => errors.push(message),
  });
  try {
    client.setStore(store);
    client.render(timeline, frame / fps);
    const sources = timelineSources(timeline).length;
    for (;;) {
      await sleep(50);
      const now = performance.now();
      const settled =
        renders > 0 &&
        !stalled &&
        textOut === 0 &&
        sized.size >= sources &&
        now - lastRender >= SETTLE_MS;
      if (settled || errors.length) break;
      if (now - started > SHOT_LIMIT_MS) {
        errors.push(
          `did not settle in ${SHOT_LIMIT_MS} ms (renders ${renders}, stalled ${stalled}, text outstanding ${textOut}, sources sized ${sized.size}/${sources})`,
        );
        break;
      }
    }
    const pixels = pen.getImageData(0, 0, snapshot.width, snapshot.height);
    const blocks = pool(fromRgba(pixels.data, pixels.width, pixels.height), PARITY_BLOCK);
    return {
      case: c.name,
      frame,
      w: blocks.w,
      h: blocks.h,
      blocks: Array.from(blocks.rgb),
      png: snapshot.toDataURL("image/png"),
      renders,
      settledMs: Math.round(lastRender - started),
      errors,
    };
  } finally {
    client.dispose();
    // Release the context now rather than at garbage collection: a page holds only a few.
    canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  }
}

/** What the spec calls: draw one case at one frame, on demand, so a failed test costs one picture. */
async function draw(name: string, frame: number): Promise<ParityShot> {
  const c = ALL_PARITY_CASES.find((p) => p.name === name);
  if (!c) throw new Error(`no parity case named ${name}`);
  stage(`${name}@${frame}`);
  try {
    return await shoot(c, frame);
  } finally {
    stage("idle");
  }
}

Object.assign(window, { __parityDraw: draw, __parityReady: true });
