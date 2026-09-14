// Shared parity scene — imported by BOTH the ffmpeg reference generator
// (smoke.e2e) and the browser parity probe, so the WebGL preview and the ffmpeg
// render composite the exact same timeline. Only the fg source path differs
// (an absolute file path for ffmpeg, a URL for the browser). Dev-only.
import type { Timeline } from "../timeline/model";

export const PARITY_CANVAS = { width: 640, height: 480, fps: 30 };
export const PARITY_FG = { w: 400, h: 300 };
/** The frame (and its time in seconds) the harness probes — mid fade-in so the
 *  keyframed opacity sits strictly between its endpoints. */
export const PARITY_PROBE_FRAME = 10;
export const PARITY_PROBE_TIME = PARITY_PROBE_FRAME / PARITY_CANVAS.fps;

/** Single image clip exercising layout + cover-fit + crop + flip + keyframed
 *  position + keyframed rotate + keyframed (fade-in) opacity. */
export function parityTimeline(fgSrc: string): Timeline {
  return {
    units: "frames",
    canvas: PARITY_CANVAS,
    tracks: [
      {
        id: "fg",
        kind: "video",
        z: 0,
        clips: [
          {
            media_ref: fgSrc,
            timeline_in: 0,
            timeline_out: 30,
            opacity: [
              { t: 0, v: 0 },
              { t: 30, v: 1 },
            ],
            layout: {
              x: [
                { t: 0, v: 100 },
                { t: 30, v: 130 },
              ],
              y: [
                { t: 0, v: 50 },
                { t: 30, v: 80 },
              ],
              w: 400,
              h: 300,
              fit: "cover",
            },
            crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
            flip: { h: true },
            rotate: 18,
          },
        ],
      },
    ],
  } as unknown as Timeline;
}
