// Browser-only: draw an audio clip's waveform behind it on the timeline. The peak math +
// path live in preview/waveform.ts (pure, tested); this component only does the decode + SVG,
// so it is excluded from coverage. Peaks are cached per (projectDir, source, window).
//
// It decodes the CLIP'S WINDOW, via the same ffmpeg conform the preview engine uses — not the
// source file. Fetching the whole source here is what crashed the app on a 1.84 GB recording
// (0xE0000008, out of memory in the Rust process that serves the asset): a decorative
// waveform took the editor down. It also fixes WHAT is drawn — a trimmed clip used to show
// the whole source's waveform stretched across it, rather than the part it plays.
import { useEffect, useState } from "react";

import { conformWindow, previewRunner } from "../preview/conformAudio";
import { overPreviewBudget } from "../preview/mediaBudget";
import { resolveSourceUrl } from "../preview/resolve";
import { computePeaks, peaksToPath } from "../preview/waveform";
import type { ProjectStoreAccess } from "../tools/store";

const BUCKETS = 400;
const cache = new Map<string, Float32Array>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AudioCtor = {
  new (): { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer>; close?: () => Promise<void> };
};

export function ClipWaveform({
  store,
  source,
  inSec,
  outSec,
}: {
  store: ProjectStoreAccess | null | undefined;
  source: string;
  inSec: number;
  outSec: number;
}) {
  const key =
    store && source ? `${store.projectDir}\u0000${source}\u0000${inSec}\u0000${outSec}` : "";
  const [peaks, setPeaks] = useState<Float32Array | null>(() =>
    key ? (cache.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!store || !source) return;
    const hit = cache.get(key);
    if (hit) {
      setPeaks(hit);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx: AudioCtor | undefined =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    let alive = true;
    void (async () => {
      try {
        const runner = await previewRunner();
        let ref: string | null = source;
        if (runner) {
          ref = await conformWindow({ store, runner }, source, inSec, outSec);
        } else {
          // No ffmpeg (web): the source would be read whole, so an oversized one is
          // refused outright rather than drawn.
          const abs = await store.resolveRef(source).catch(() => null);
          const size = abs ? await store.byteSize(abs).catch(() => null) : null;
          if (overPreviewBudget(size)) return;
        }
        if (!ref || !alive) return;
        const url = await resolveSourceUrl(store, ref);
        if (!url || !alive) return;
        const bytes = await (await fetch(url)).arrayBuffer();
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(bytes);
        void ctx.close?.();
        const computed = computePeaks(audio.getChannelData(0), BUCKETS);
        cache.set(key, computed);
        if (alive) setPeaks(computed);
      } catch {
        /* waveform is decorative — ignore decode/fetch failures */
      }
    })();
    return () => {
      alive = false;
    };
  }, [store, source, key, inSec, outSec]);

  if (!peaks) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full text-sky-300/60"
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={peaksToPath(peaks, 100)} fill="currentColor" />
    </svg>
  );
}
