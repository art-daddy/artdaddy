import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import MP4Box, { type MP4ArrayBuffer } from "mp4box";
import { VideoSource, indexedVideoSamples } from "./videoSource";

afterEach(() => vi.unstubAllGlobals());

it("every indexed video packet matches the independent reader in the retained Mac recording", () => {
  const fixture = path.resolve("e2e/ui/fixtures/mac-recording-preview.mp4");
  const data = readFileSync(fixture);
  const file = MP4Box.createFile();
  let samples: ReturnType<typeof indexedVideoSamples> = [];
  file.onReady = (info) => { samples = indexedVideoSamples(file, info.videoTracks[0].id); };
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as MP4ArrayBuffer;
  bytes.fileStart = 0;
  file.appendBuffer(bytes);
  expect(createHash("sha256").update(data).digest("hex")).toBe("bc112240be3dc61e81f8c6b2cdb58160d19a4cdc96a84d193f9c0860142db6fb");
  expect(samples).toHaveLength(84);
  const packets = samples.map((sample) => ({
    offset: sample.offset, size: sample.size, cts: sample.cts, duration: sample.duration, isSync: sample.isSync,
    hash: `SHA256:${createHash("sha256").update(data.subarray(sample.offset, sample.offset + sample.size)).digest("hex")}`,
  }));
  expect(createHash("sha256").update(JSON.stringify(packets)).digest("hex")).toBe("96c37d02c928effb579804874004e654b4c64568833af79d0f56e2ac45226a22");
});

it("a paused seek reaches later frames without exhausting a small native frame pool", async () => {
  const sources = new Set<{ timestamp: number; close: () => void }>();
  let queue: Array<{ timestamp: number }> = [];
  let output: (frame: unknown) => void = () => undefined;
  let scheduled = false;
  const drain = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (queue.length && sources.size < 4) {
        const chunk = queue.shift()!;
        const frame = { timestamp: chunk.timestamp, close: () => { sources.delete(frame); drain(); } };
        sources.add(frame);
        output(frame);
      }
    });
  };
  vi.stubGlobal("VideoDecoder", class {
    state = "configured";
    constructor(options: { output: (frame: unknown) => void }) { output = options.output; }
    configure() {}
    decode(chunk: { timestamp: number }) { queue.push(chunk); drain(); }
    flush() { drain(); return Promise.resolve(); }
    close() { this.state = "closed"; queue = []; }
  });
  vi.stubGlobal("EncodedVideoChunk", class {
    constructor(public input: { timestamp: number }) {}
    get timestamp() { return this.input.timestamp; }
  });
  const source = Object.create(VideoSource.prototype) as VideoSource;
  Object.assign(source, {
    samples: Array.from({ length: 100 }, (_, index) => ({ cts: index, duration: 1, isSync: index === 0, offset: index, size: 1 })),
    timescale: 30, startCts: 0, ready: Promise.resolve(), config: { codec: "avc1.42001e" },
    buffer: new Map(), decoder: null, fedIndex: -1, requestedIndex: -1, feeding: Promise.resolve(),
    feedEpoch: 0, drainedRun: -1, runStart: -1, pending: null, maxOutputTs: -1, keepTs: -1,
    decoderStarts: 0,
    readRange: async (start: number, end: number) => ({ bytes: new Uint8Array(end - start + 1), start, total: 100 }),
  });
  try {
    const later = await source.frameAt(2);
    expect(later?.timestamp).toBe(2000000);
    const early = await source.frameAt(0.4);
    expect(early?.timestamp).toBe(400000);
    expect(sources.size).toBeLessThanOrEqual(4);
  } finally {
    source.close();
  }
  expect(sources.size).toBe(0);
});