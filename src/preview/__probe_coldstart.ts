// Dev-only browser probe: WHERE the preview's cold start spends its time.
//
// Splits the first picture into its two phases — reading the mp4 index, then decoding forward
// from a keyframe — and counts the range reads each costs. The COUNT is the number that carries
// over to the real app: in Tauri every read is an IPC round-trip to the Rust asset protocol,
// which is far more expensive per call than the dev server's HTTP.
//
// Query params: ?src=/clip.mp4&t=0   (t = source seconds of the first frame wanted)
import { VideoSource } from "./videoSource";

interface Phase {
  ms: number;
  reads: number;
  bytes: number;
}
interface Result {
  src: string;
  at: number;
  index: Phase;
  firstFrame: Phase;
  totalMs: number;
  dims: string;
  durationS: number;
  decoderStarts: number;
  error?: string;
}

const status = document.getElementById("status");
const set = (v: unknown): void => {
  (window as unknown as { __cold: unknown }).__cold = v;
  if (status) status.textContent = JSON.stringify(v, null, 2);
};

let reads = 0;
let bytes = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const resp = await realFetch(input as RequestInfo, init);
  reads += 1;
  const len = Number(resp.headers.get("content-length") ?? 0);
  bytes += Number.isFinite(len) ? len : 0;
  return resp;
};

function mark(): { ms: number; reads: number; bytes: number } {
  return { ms: performance.now(), reads, bytes };
}
function since(m: { ms: number; reads: number; bytes: number }): Phase {
  return {
    ms: Math.round(performance.now() - m.ms),
    reads: reads - m.reads,
    bytes: bytes - m.bytes,
  };
}

void (async () => {
  const q = new URLSearchParams(location.search);
  const src = q.get("src") ?? "/test-clip.mp4";
  const at = Number(q.get("t") ?? "0");
  const out: Partial<Result> = { src, at };
  const t0 = mark();
  try {
    const vs = new VideoSource(src);
    await vs.whenReady();
    out.index = since(t0);
    out.dims = `${vs.dims.w}x${vs.dims.h}`;
    out.durationS = Math.round(vs.duration * 10) / 10;

    // The first PICTURE, the way the worker gets one: pump, then poll for a frame.
    const t1 = mark();
    let frame = null;
    for (let i = 0; i < 2000 && !frame; i++) {
      vs.pump(at);
      frame = vs.nearestFrame(at);
      if (!frame) await new Promise((r) => setTimeout(r, 5));
    }
    out.firstFrame = since(t1);
    out.decoderStarts = vs.decoderStarts;
    if (!frame) out.error = "no frame decoded within 10s";
    out.totalMs = Math.round(performance.now() - t0.ms);
    vs.close();
  } catch (e) {
    out.error = String(e);
    out.totalMs = Math.round(performance.now() - t0.ms);
  }
  set(out);
})();
