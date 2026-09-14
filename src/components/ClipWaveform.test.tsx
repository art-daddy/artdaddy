// The third door onto the same crash: a decorative timeline waveform fetched the WHOLE source
// to draw peaks, so a 1.84 GB recording took the editor down (0xE0000008 — out of memory in
// the Rust process that serves the asset) after the video and audio paths had both been fixed.
// It now reads the ffmpeg-conformed extract of the clip's window instead.
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolved: [] as string[] }));

vi.mock("../preview/resolve", () => ({
  resolveSourceUrl: vi.fn(async (_s: unknown, ref: string) => {
    h.resolved.push(ref);
    return "blob:fake";
  }),
}));

import { ClipWaveform } from "./ClipWaveform";
import { setPreviewAudioRunner } from "../preview/conformAudio";

const SOURCE = "media_9a07ca3d8344";
const HUGE = 1_840_198_666;

/** A store over a multi-GB source whose files exist once ffmpeg "writes" them. */
function storeOver(size: number | null) {
  const written = new Set<string>();
  return {
    written,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: {
      projectDir: "/p",
      resolveRef: async (r: string) => (r.startsWith("/p/") ? r : `C:/Downloads/${r}.mp4`),
      byteSize: async () => size,
      prepareArtifact: async (rel: string) => `/p/internals/cache/${rel}`,
      exists: async (p: string) => written.has(p),
    } as any,
  };
}

beforeEach(() => {
  h.resolved = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).AudioContext = function () {
    return {
      decodeAudioData: async () => ({ getChannelData: () => new Float32Array(2048) }),
      close: async () => undefined,
    };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

describe("ClipWaveform — bounded by the clip, not the file", () => {
  it("draws from the conformed WINDOW and never fetches the multi-GB source", async () => {
    const ran: string[][] = [];
    const { store, written } = storeOver(HUGE);
    setPreviewAudioRunner(
      async () =>
        ({
          run: async (_p: string, args: string[]) => {
            ran.push(args);
            written.add(args[args.length - 1]);
            return { code: 0, stdout: "", stderr: "" };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    render(<ClipWaveform store={store} source={SOURCE} inSec={2} outSec={5} />);

    await waitFor(() => expect(h.resolved.length).toBeGreaterThan(0));
    // The OUTCOME: what it asked to read is the extract, not the recording.
    expect(h.resolved).toHaveLength(1);
    expect(h.resolved[0]).toContain("/internals/cache/preview/audio_");
    expect(h.resolved[0]).not.toContain(SOURCE);
    // ...and it asked ffmpeg for exactly the clip's 3 seconds.
    expect(ran[0][ran[0].indexOf("-ss") + 1]).toBe("2.000");
    expect(ran[0][ran[0].indexOf("-t") + 1]).toBe("3.000");
  });

  // The failure direction: with no ffmpeg the source WOULD be read whole, so an oversized one
  // is refused rather than drawn. A waveform is decorative; crashing the editor for it is not.
  it("refuses an oversized source where there is no ffmpeg to conform with", async () => {
    setPreviewAudioRunner(async () => null);
    const { store } = storeOver(HUGE);
    render(<ClipWaveform store={store} source={SOURCE} inSec={0} outSec={5} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.resolved).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("...but still draws an ordinary file there — the ceiling is not refusing everything", async () => {
    setPreviewAudioRunner(async () => null);
    const { store } = storeOver(4_000_000);
    render(<ClipWaveform store={store} source={SOURCE} inSec={0} outSec={5} />);
    await waitFor(() => expect(h.resolved).toEqual([SOURCE]));
  });
});
