// Dev-only browser probe for the WebGL2 compositor (happy-dom has no WebGL, so
// the renderer + shaders are validated here). Composites a wide red image
// (letterboxed via contain) with a semi-transparent blue box on top, so a
// screenshot shows: black bands + a red middle band + a 50%-opacity blue square.
// Not part of the production build (index.html is the only vite entry).
import type { Timeline } from "../timeline/model";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene } from "./scene";

function solid(w: number, h: number, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c;
}

const canvas = document.getElementById("probe") as HTMLCanvasElement;

async function exportGpuProbe(width = 3840, height = 2160, frames = 30, encode = false, sourceUrls: string[] = [], fixture601 = false) {
  if (![1920, 3840].includes(width) || height !== width * 9 / 16 || !Number.isInteger(frames) || frames < 2 || frames > 120)
    throw new Error("private GPU probe dimensions/frame budget invalid");
  const target = document.createElement("canvas");
  target.width = width;
  target.height = height;
  document.body.appendChild(target);
  const gpu = new PreviewRenderer(target);
  const gl = target.getContext("webgl2")!;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unavailable";
  const vendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "unavailable";
  const textures = new Map<string, AssetDims>();
  const colors: Array<[number, number, number]> = [];
  const tracks: Timeline["tracks"] = [];
  const videos: import("./videoSource").VideoSource[] = [];
  if (sourceUrls.length && ![1, 16].includes(sourceUrls.length)) throw new Error("private decode reader count invalid");
  const uploadStart = performance.now();
  try {
    if (sourceUrls.length) {
      const { VideoSource } = await import("./videoSource");
      for (const url of sourceUrls) {
        if (new URL(url, location.href).origin !== location.origin) throw new Error("private decoder requires same-origin fixture");
        const source = new VideoSource(url);
        videos.push(source);
        await source.whenReady();
        if (source.dims.w !== width || source.dims.h !== height) throw new Error("decoded source dimensions differ");
      }
    }
    for (let index = 0; index < 16; index++) {
      const color: [number, number, number] = [40 + (index % 4) * 50, 40 + Math.floor(index / 4) * 50, 80 + (index % 3) * 40];
      colors.push(color);
      const source = `export-probe-${index}`;
      if (!videos.length) gpu.setTexture(source, solid(width, height, `rgb(${color.join(",")})`));
      textures.set(source, { w: width, h: height });
      tracks.push({
        id: source, kind: "video", z: index,
        clips: [{ id: source, kind: videos.length ? "video" : "image", media_ref: source, timeline_in: 0, timeline_out: frames,
          ...(videos.length ? { source_in: 0, source_out: frames } : {}),
          opacity: [{ t: 0, v: 1 }, { t: frames - 1, v: 0.5 }],
          transform: { scale: 0.25, position: { x: ((index % 4) + 0.5) / 4, y: (Math.floor(index / 4) + 0.5) / 4 } },
        }],
      });
    }
    gl.finish();
    const uploadMs = performance.now() - uploadStart;
    const timeline: Timeline = { units: "frames", canvas: { width, height, fps: 60 }, tracks };
    const drawMs: number[] = [];
    const decodeUploadMs: number[] = [];
    const sourceWaitMs: number[] = [];
    const textureSubmissionMs: number[] = [];
    const decodedTimestamps: number[][] = videos.map(() => []);
    const sourceColourSpaces: Array<{ format: VideoPixelFormat | null; colourSpace: VideoColorSpaceInit }> = [];
    let colourScratch: Uint8Array | null = null;
    const readbackMs: number[] = [];
    const checks: Array<{ frame: number; tiles: number[][] }> = [];
    const chunks: Uint8Array[] = [];
    let encodedBytes = 0;
    let encoder: VideoEncoder | null = null;
    let encoderError: Error | null = null;
    let requestedConfig: VideoEncoderConfig | null = null;
    let peakEncodeQueue = 0;
    if (encode) {
      requestedConfig = { codec: "avc1.640034", width, height, framerate: 60, bitrate: 20_000_000,
        latencyMode: "realtime", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } };
      const support = await VideoEncoder.isConfigSupported(requestedConfig);
      if (!support.supported) throw new Error("GPU encode configuration is not supported");
      encoder = new VideoEncoder({
        output: (chunk) => {
          encodedBytes += chunk.byteLength;
          if (encodedBytes > 16 * 1024 * 1024) {
            encoderError = new Error("private encode output exceeds byte budget");
            return;
          }
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          chunks.push(bytes);
        },
        error: (error) => { encoderError = error; },
      });
      encoder.configure(requestedConfig);
    }
    const runStart = performance.now();
    try {
    for (let frame = 0; frame < frames; frame++) {
      if (encoderError) throw encoderError;
      while (encoder && encoder.encodeQueueSize >= 2) {
        await new Promise<void>((resolve) => encoder!.addEventListener("dequeue", () => resolve(), { once: true }));
        if (encoderError) throw encoderError;
      }
      if (videos.length) {
        const decodeStart = performance.now();
        let waitMs = 0;
        let submissionMs = 0;
        for (let reader = 0; reader < videos.length; reader++) {
          if (reader % 4 === 0)
            for (const source of videos.slice(reader, reader + 4)) source.pump(frame / 60);
          const source = videos[reader];
          const waitStart = performance.now();
          const deadline = performance.now() + 3000;
          const expectedTimestamp = frame ? decodedTimestamps[reader][0] + Math.round(frame * 1_000_000 / 60) : null;
          let decoded = source.nearestFrame(frame / 60);
          while (!decoded || expectedTimestamp !== null && Math.abs(decoded.timestamp - expectedTimestamp) > 2) {
            if (performance.now() >= deadline)
              throw new Error(`decoder ${reader} missed exact frame ${frame}; starts=${source.decoderStarts}, nearest=${decoded?.timestamp ?? "none"}`);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            decoded = source.nearestFrame(frame / 60);
          }
          decodedTimestamps[reader].push(decoded.timestamp);
          if (frame === 0) sourceColourSpaces.push({ format: decoded.format, colourSpace: decoded.colorSpace.toJSON() });
          waitMs += performance.now() - waitStart;
          const submissionStart = performance.now();
          let upload = decoded;
          try {
            if (fixture601) {
              if (!decoded.format || !["NV12", "I420", "I420A"].includes(decoded.format))
                throw new Error("private BT.601 compatibility requires an 8-bit YUV source");
              const bytes = decoded.allocationSize();
              if (bytes > width * height * 4) throw new Error("private colour-copy byte budget exceeded");
              if (!colourScratch || colourScratch.byteLength !== bytes) colourScratch = new Uint8Array(bytes);
              const layout = await decoded.copyTo(colourScratch);
              upload = new VideoFrame(colourScratch, { format: decoded.format, codedWidth: width, codedHeight: height,
                timestamp: decoded.timestamp, layout,
                colorSpace: { ...decoded.colorSpace.toJSON(), matrix: "smpte170m" } });
            }
            for (let tile = reader; tile < 16; tile += videos.length)
              gpu.setTexture(`export-probe-${tile}`, upload, source.orientation);
          } finally {
            if (upload !== decoded) upload.close();
          }
          submissionMs += performance.now() - submissionStart;
        }
        decodeUploadMs.push(performance.now() - decodeStart);
        sourceWaitMs.push(waitMs);
        textureSubmissionMs.push(submissionMs);
      }
      const start = performance.now();
      gpu.render(buildScene(timeline, frame / 60, textures));
      if (!encode) gl.finish();
      drawMs.push(performance.now() - start);
      const readStart = performance.now();
      const pixels = !encode || frame === 0 || frame === frames - 1 ? gpu.readPixels() : null;
      if (pixels) readbackMs.push(performance.now() - readStart);
      if (frame === 0 || frame === frames - 1) {
        const tiles = colors.map((color, index) => {
          const x = Math.floor(((index % 4) + 0.5) * width / 4);
          const y = height - 1 - Math.floor((Math.floor(index / 4) + 0.5) * height / 4);
          const offset = (y * width + x) * 4;
          const actual = Array.from(pixels!.data.subarray(offset, offset + 3));
          const opacity = frame === 0 ? 1 : 0.5;
          if (!videos.length && actual.some((value, channel) => Math.abs(value - color[channel] * opacity) > 4))
            throw new Error(`GPU tile ${index} at frame ${frame} differs: ${actual.join(",")}`);
          if (videos.length && actual.reduce((total, value) => total + value, 0) < 25)
            throw new Error(`decoded tile ${index} is blank at frame ${frame}`);
          return actual;
        });
        checks.push({ frame, tiles });
      }
      if (encoder) {
        const timestamp = Math.round(frame * 1_000_000 / 60);
        const video = new VideoFrame(target, { timestamp,
          duration: Math.round((frame + 1) * 1_000_000 / 60) - timestamp });
        try { encoder.encode(video, { keyFrame: frame === 0 }); }
        finally { video.close(); }
        peakEncodeQueue = Math.max(peakEncodeQueue, encoder.encodeQueueSize);
      }
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("GPU context lost or GL error");
      if (frame % 5 === 4) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (encoder) await encoder.flush();
    if (encoderError) throw encoderError;
    const runMs = performance.now() - runStart;
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    return {
      scope: encode
        ? "existing compositor + direct canvas WebCodecs encode; generated textures or reused synthetic source bytes, no audio mixing/full effect parity or actual encoder-hardware certification"
        : "existing compositor + GPU upload/readback; no audio/encode or effect parity certification",
      width, height, layers: 16, frames, rendererName, vendor,
      hardwareGpu: !/swiftshader|llvmpipe|software|unavailable/i.test(rendererName),
      estimatedTextureBytes: width * height * 4 * 16,
      uploadMs, meanDrawMs: mean(drawMs), meanReadbackMs: mean(readbackMs),
      meanFrameMs: encode ? runMs / frames : mean(drawMs) + mean(readbackMs), runMs,
      sourceReaders: videos.length, meanDecodeUploadMs: decodeUploadMs.length ? mean(decodeUploadMs) : 0,
      sourcePumpConcurrency: Math.min(videos.length, 4),
      meanSourceWaitMs: sourceWaitMs.length ? mean(sourceWaitMs) : 0,
      meanTextureSubmissionMs: textureSubmissionMs.length ? mean(textureSubmissionMs) : 0,
      decoderStarts: videos.map((source) => source.decoderStarts),
      decodedTimestamps, sourceColourSpaces,
      fixtureColourPolicy: fixture601 ? "private frozen untagged fixture BT.601 compatibility; raw YUV copy cost included" : "decoder default",
      colourScratchBytes: colourScratch?.byteLength ?? 0,
      requestedConfig, peakEncodeQueue, encodedBytes,
      encodedChunks: encode ? chunks.map((chunk) => Array.from(chunk)) : undefined,
      drawMs, readbackMs, checks,
    };
    } finally {
      if (encoder && encoder.state !== "closed") encoder.close();
    }
  } finally {
    for (const source of videos) source.close();
    gpu.dispose();
    target.remove();
  }
}

(window as unknown as { __exportGpuProbe: typeof exportGpuProbe }).__exportGpuProbe = exportGpuProbe;

try {
  const renderer = new PreviewRenderer(canvas);
  renderer.setTexture("red.png", solid(800, 400, "#ee0000"));
  renderer.setTexture("blue.png", solid(400, 400, "#0000ee"));
  const dims = new Map<string, AssetDims>([
    ["red.png", { w: 800, h: 400 }],
    ["blue.png", { w: 400, h: 400 }],
  ]);
  const tl = {
    units: "frames",
    canvas: { width: 600, height: 600, fps: 30 },
    tracks: [
      {
        id: "a",
        kind: "video",
        z: 0,
        clips: [{ media_ref: "red.png", timeline_in: 0, timeline_out: 30 }],
      },
      {
        id: "b",
        kind: "video",
        z: 1,
        clips: [
          {
            media_ref: "blue.png",
            timeline_in: 0,
            timeline_out: 30,
            opacity: 0.5,
            // The model's own shape (normBox): normalised centre + scale, NOT a pixel rect.
            // This said `layout: {x,y,w,h}`, which nothing reads — so the overlay silently
            // covered the whole canvas and two of the pixel tests passed for that reason.
            transform: { position: { x: 0.5, y: 0.5 }, scale_x: 400 / 600, scale_y: 400 / 600 },
          },
        ],
      },
    ],
  } as unknown as Timeline;
  renderer.render(buildScene(tl, 0, dims));
  // SAME TASK as render(): the context is not preserveDrawingBuffer, so the drawing
  // buffer is discarded once this task yields and any later drawImage reads black.
  // Copying it here gives the pixel tests something that is still there when they look.
  const snap = document.createElement("canvas");
  snap.id = "probe-snapshot";
  snap.width = canvas.width;
  snap.height = canvas.height;
  (snap.getContext("2d") as CanvasRenderingContext2D).drawImage(canvas, 0, 0);
  document.body.appendChild(snap);
  (window as unknown as { __probe: string }).__probe = "ok";
} catch (e) {
  (window as unknown as { __probe: string }).__probe = `error: ${String(e)}`;
}
