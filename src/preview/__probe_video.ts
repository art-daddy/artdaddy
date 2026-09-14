// Dev-only browser probe for the WebCodecs video path: mp4box demux + decode +
// composite one frame at t. Fetches /test-clip.mp4, decodes the frame at source
// time 1s, and composites it into the canvas — a screenshot shows the testsrc2
// pattern filling the frame. Not part of the production build.
import type { Timeline } from "../timeline/model";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene } from "./scene";
import { VideoSource } from "./videoSource";

const canvas = document.getElementById("probe") as HTMLCanvasElement;
const status = document.getElementById("status");
const set = (v: string): void => {
  (window as unknown as { __probe: string }).__probe = v;
  if (status) status.textContent = v;
};

void (async () => {
  try {
    // Reading the file WHOLE is what crashed the app on a large recording, and no fixture
    // small enough to commit can prove a byte budget — so assert the property that holds at
    // any size: every media read is a RANGE read. A revert to `fetch(url)` fails this.
    const realFetch = window.fetch.bind(window);
    let mediaReads = 0;
    let unranged = 0;
    let bytesRead = 0;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : String((input as Request).url ?? input);
      const ranged = Boolean(
        (init?.headers as Record<string, string> | undefined)?.Range ??
        (init?.headers as Record<string, string> | undefined)?.range,
      );
      if (u.includes("test-clip.mp4")) {
        mediaReads += 1;
        if (!ranged) unranged += 1;
      }
      const resp = await realFetch(input as RequestInfo, init);
      if (u.includes("test-clip.mp4"))
        void resp
          .clone()
          .arrayBuffer()
          .then((b) => {
            bytesRead += b.byteLength;
          })
          .catch(() => undefined);
      return resp;
    };
    const renderer = new PreviewRenderer(canvas);
    const vs = new VideoSource("/test-clip.mp4");
    await vs.whenReady();
    const dims = new Map<string, AssetDims>([["/test-clip.mp4", vs.dims]]);
    const tl = {
      units: "frames",
      canvas: { width: 640, height: 480, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            {
              media_ref: "/test-clip.mp4",
              source_in: 0,
              source_out: 60,
              timeline_in: 0,
              timeline_out: 60,
            },
          ],
        },
      ],
    } as unknown as Timeline;

    // Forward playback: request frames 0..30 in order (source time = k/30).
    const stamps: number[] = [];
    for (let k = 0; k <= 30; k++) {
      const f = await vs.frameAt(k / 30);
      stamps.push(f ? f.timestamp : -1);
    }
    const fwdStarts = vs.decoderStarts;

    // Backward seek, then a forward jump into a later GOP.
    const back = await vs.frameAt(9 / 30);
    const jump = await vs.frameAt(57 / 30);

    const step = 1e6 / 30;
    let maxErr = 0;
    for (let k = 0; k <= 30; k++) {
      maxErr = Math.max(maxErr, Math.abs(stamps[k] - stamps[0] - Math.round(k * step)));
    }
    const backErr = back ? Math.abs(back.timestamp - stamps[0] - Math.round(9 * step)) : -1;
    const jumpErr = jump ? Math.abs(jump.timestamp - stamps[0] - Math.round(57 * step)) : -1;

    // Render frame 30 (t=1.0s) for the screenshot.
    const scene = buildScene(tl, 1.0, dims);
    const f30 = await vs.frameAt((scene.layers[0] as { sourceTime?: number })?.sourceTime ?? 0);
    if (f30) renderer.setTexture("/test-clip.mp4", f30);
    renderer.render(scene);
    vs.close();

    const ok =
      maxErr < 2000 &&
      backErr >= 0 &&
      backErr < 2000 &&
      jumpErr >= 0 &&
      jumpErr < 2000 &&
      fwdStarts <= 2 &&
      mediaReads > 0 &&
      unranged === 0;
    set(
      `${ok ? "ok" : "FAIL"} fwdMaxErrUs=${maxErr} backErrUs=${backErr} jumpErrUs=${jumpErr} decoderStartsFwd=${fwdStarts} mediaReads=${mediaReads} unrangedReads=${unranged} bytesRead=${bytesRead}`,
    );
  } catch (e) {
    set(`error: ${String(e)}`);
  }
})();
