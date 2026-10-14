import { afterEach, expect, it, vi } from "vitest";
import { VideoSource } from "./videoSource";

afterEach(() => vi.unstubAllGlobals());

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