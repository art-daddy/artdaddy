// Live-preview audio: decode + play every AUDIO-KIND clip, mixed + synced to the
// playhead via Web Audio. A video's own audio is split onto a dedicated audio
// clip when it's added, so we sound only audio clips (mirroring the renderer +
// other NLEs/Premiere) -- playing the video clip's embedded track too would DOUBLE it.
// The Rendered preview plays the exported mp4's own audio; the Live composite
// draws video frames only, so without this it is silent. Browser-only (Web Audio)
// -- excluded from unit coverage and guarded so it cleanly no-ops where
// AudioContext is unavailable (e.g. the happy-dom test environment).
import type { Animatable, Timeline } from "../timeline/model";
import { useProjectNotice } from "../store/projectNotice";
import { audibleTracks, clipPlays } from "../timeline/visibility";
import type { ProjectStoreAccess } from "../tools/store";
import { conformWindow, previewRunner } from "./conformAudio";
import { displayName, overPreviewBudget, tooLargeNotice } from "./mediaBudget";
import { peakOf } from "./meter";
import { resolveSourceUrl } from "./resolve";

export { setPreviewAudioRunner } from "./conformAudio";

type AudioCtor = { new (): AudioContext };

interface Scheduled {
  trackId: string;
  source: string;
  /** Which decoded buffer this clip plays: the source alone when the whole file was decoded,
   *  the source PLUS its window when only that window was extracted. */
  key: string;
  /** Source second the decoded buffer starts at — 0 for a whole-file decode, srcIn for a
   *  conformed window. Every offset below is in BUFFER time, so it subtracts this. */
  base: number;
  startSec: number; // timeline in-point (s)
  endSec: number; // timeline out-point (s)
  srcInSec: number; // in-point within the source (s)
  srcOutSec: number; // out-point within the source (s); <= srcIn = whole buffer
  volume: number; // constant gain
  /** Volume keyframes as [clip-relative SECONDS, gain], empty when the volume is constant. */
  volumeCurve: Array<[number, number]>;
  speed: number; // playback rate
  loop: boolean; // repeat the source window to fill the slot
  stretch: boolean; // time-fit the source window to the slot (pitch approx in preview)
  fadeInSec: number;
  fadeOutSec: number;
}

function sampleVolume(v: Animatable | undefined): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length) return Number(v[0]?.v) || 0;
  return 1;
}

/** Volume keyframes as [clip-relative seconds, gain]. Empty for a constant volume.
 *
 *  This used to be `sampleVolume` alone, which took key[0] and played the WHOLE clip at it: a
 *  "duck the music under the voice" curve was audible as a flat level, and the exporter ignored
 *  it outright. The curve is the property; sampling one point of it is not. */
function volumeCurve(v: Animatable | undefined, fps: number): Array<[number, number]> {
  if (!Array.isArray(v) || v.length < 2) return [];
  return v
    .map((k) => [(Number(k?.t) || 0) / fps, Number(k?.v) || 0] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Linear interpolation of a `[seconds, gain]` curve at clip-relative `t`, holding the end
 *  values outside it — the same shape `sampleAnim` gives the exporter. */
function sampleCurve(curve: Array<[number, number]>, t: number): number {
  if (!curve.length) return 1;
  if (t <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i];
    if (t > t1) continue;
    const [t0, v0] = curve[i - 1];
    const span = t1 - t0;
    return span > 0 ? v0 + ((v1 - v0) * (t - t0)) / span : v1;
  }
  return last[1];
}

/** A metering tap: the point audio passes through, plus a stereo pair of analysers hanging off
 *  it. The analysers are a BRANCH, never in series — a meter that broke the audio path would be
 *  a bad trade for a picture of the audio path. */
interface Bus {
  input: GainNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

export type StereoPeaks = [left: number, right: number];

/** The analyser pair `createMeterTap` hangs off a node. Exported so the real-browser audio lane
 *  can build the SAME graph against an OfflineAudioContext — a fake AudioContext cannot model
 *  channel counts, which is exactly how the mono bug below survived a green suite. */
export interface MeterTap {
  readonly left: AnalyserNode;
  readonly right: AnalyserNode;
}

/** Hang a stereo analyser pair off `input`. A splitter feeds one analyser per channel, so a
 *  hard-panned signal reads on the side it is actually on rather than as a mono average.
 *
 *  The `stereo` gain in front is load-bearing: a ChannelSplitter interprets its input as
 *  DISCRETE, so a mono source lights channel 0 and leaves channel 1 at silence — the right
 *  meter sat dead at 0% for every mono file, which is not what the user hears. Forcing an
 *  explicit 2-channel "speakers" input up-mixes mono to both sides first. */
export function createMeterTap(ctx: BaseAudioContext, input: AudioNode): MeterTap | null {
  try {
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit";
    stereo.channelInterpretation = "speakers";
    const split = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    // 2048 samples is ~43ms at 48k — comfortably longer than a 60Hz frame, so consecutive
    // reads OVERLAP and a transient cannot fall between two of them unseen.
    left.fftSize = 2048;
    right.fftSize = 2048;
    input.connect(stereo);
    stereo.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    return { left, right };
  } catch {
    return null; // metering is never worth failing playback over
  }
}

/** Linear peak on each side over the analyser's most recent window. */
export function readTapPeaks(
  tap: MeterTap | null,
  scratch?: Float32Array<ArrayBuffer>,
): StereoPeaks {
  if (!tap?.left || !tap.right) return [0, 0];
  const buf = scratch ?? new Float32Array(new ArrayBuffer(tap.left.fftSize * 4));
  tap.left.getFloatTimeDomainData(buf);
  const l = peakOf(buf);
  tap.right.getFloatTimeDomainData(buf);
  return [l, peakOf(buf)];
}

/** The engine the meters read. StagePanel owns the instance and publishes it here rather than
 *  the meters constructing their own — a second PreviewAudio would mean a second AudioContext,
 *  a second output of the same clips, and meters measuring a graph nobody can hear. */
let current: PreviewAudio | null = null;
export function publishPreviewAudio(a: PreviewAudio | null): void {
  current = a;
}
export function previewAudio(): PreviewAudio | null {
  return current;
}

export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterBus: Bus | null = null;
  private readonly buses = new Map<string, Bus>();
  /** Reused across every read so metering at 60Hz allocates nothing. */
  private scratch: Float32Array<ArrayBuffer> | null = null;
  private readonly buffers = new Map<string, AudioBuffer | null>(); // null = in-flight / no audio
  private nodes: AudioBufferSourceNode[] = [];
  private clips: Scheduled[] = [];
  private store: ProjectStoreAccess | null = null;
  private project: string | null = null; // whose schedule `clips`/`buffers` belong to
  private playing = false;
  private fromSec = 0; // playhead when play() was called
  private startedAt = 0; // ctx.currentTime when play() was called

  setStore(store: ProjectStoreAccess | null | undefined): void {
    this.store = store ?? null;
  }

  /** Bind the engine to a project, dropping the previous one's schedule + decoded audio.
   *  Idempotent BY DESIGN: re-announcing the project that is already loaded must never
   *  throw its schedule away. StagePanel used to call the bare reset() from an effect
   *  declared after load(), so on every project open React ran load() then reset() and
   *  the user pressed play to silence. Keying the teardown on the project makes a stray
   *  or late reset a no-op instead of a bug. */
  setProject(id: string | null | undefined): void {
    const next = id ?? null;
    if (next === this.project) return;
    this.project = next;
    this.reset();
  }

  /** Rebuild the schedule from the timeline and decode any not-yet-seen sources. */
  load(timeline: Timeline | null): void {
    const fps = Number(timeline?.canvas?.fps) || 30;
    const clips: Scheduled[] = [];
    for (const tr of audibleTracks(timeline)) {
      for (const c of tr.clips ?? []) {
        // Sound ONLY audio-kind clips (mirrors the renderer + other NLEs/Premiere):
        // a video's audio is split onto its own audio clip on add, so playing the
        // video clip's embedded audio here would double it.
        if (c.kind !== "audio") continue;
        if (!clipPlays(c)) continue;
        const src = typeof c.media_ref === "string" ? c.media_ref : "";
        if (!src) continue;
        if (typeof c.timeline_in !== "number" || typeof c.timeline_out !== "number") continue;
        const speed = Number(c.speed) > 0 ? Number(c.speed) : 1;
        const srcIn = Number(c.source_in) || 0;
        // source_out is OPTIONAL for audio (model + validator); when absent/degenerate,
        // derive it from the timeline span AT THE CLIP'S SPEED — mirrors the exporter
        // (render.ts) + deriveSourceSpans (source_out = source_in + span*speed) so a
        // source-window-less clip plays its full duration at the right rate, not silence,
        // and preview matches export (no drift at non-1x speed).
        const rawSrcOut = Number(c.source_out);
        const srcOut =
          Number.isFinite(rawSrcOut) && rawSrcOut > srcIn
            ? rawSrcOut
            : srcIn + Math.max(0, c.timeline_out - c.timeline_in) * speed;
        clips.push({
          trackId: String(tr.id ?? ""),
          source: src,
          key: src, // rewritten to the window's key if this clip gets conformed
          base: 0,
          startSec: c.timeline_in / fps,
          endSec: c.timeline_out / fps,
          srcInSec: srcIn / fps,
          srcOutSec: srcOut / fps,
          volume: sampleVolume(c.volume),
          volumeCurve: volumeCurve(c.volume, fps),
          speed,
          loop: c.loop === true,
          stretch: c.stretch === true,
          fadeInSec: (Number(c.fade?.in) || 0) / fps,
          fadeOutSec: (Number(c.fade?.out) || 0) / fps,
        });
      }
    }
    this.clips = clips;
    void this.decode(clips);
  }

  private ctor(): AudioCtor | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    return g.AudioContext ?? g.webkitAudioContext;
  }

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = this.ctor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.masterBus = this.tap(this.ctx, this.master);
    } catch {
      this.ctx = null;
      this.master = null;
      this.masterBus = null;
    }
    return this.ctx;
  }

  /** Hang a tap off `input` and remember it as this bus's meter source. */
  private tap(ctx: AudioContext, input: GainNode): Bus | null {
    const t = createMeterTap(ctx, input);
    if (!t) return null;
    this.scratch ??= new Float32Array(new ArrayBuffer(t.left.fftSize * 4));
    return { input, left: t.left, right: t.right };
  }

  /** The bus a track's clips play through, created on first use. */
  private busFor(ctx: AudioContext, trackId: string): GainNode | null {
    if (!this.master) return null;
    const existing = this.buses.get(trackId);
    if (existing) return existing.input;
    let input: GainNode;
    try {
      input = ctx.createGain();
      input.connect(this.master);
    } catch {
      return this.master;
    }
    const bus = this.tap(ctx, input) ?? { input, left: null!, right: null! };
    this.buses.set(trackId, bus);
    return input;
  }

  private peaks(bus: Bus | null): StereoPeaks {
    if (!bus?.left || !bus.right) return [0, 0];
    return readTapPeaks(
      bus,
      (this.scratch ??= new Float32Array(new ArrayBuffer(bus.left.fftSize * 4))),
    );
  }

  /** Linear peak levels since the last read: the master, and every track that has sounded.
   *  Returns zeros when paused, so a stopped meter falls to silence instead of freezing. */
  levels(): { master: StereoPeaks; tracks: Record<string, StereoPeaks> } {
    if (!this.playing) return { master: [0, 0], tracks: {} };
    const tracks: Record<string, StereoPeaks> = {};
    for (const [id, bus] of this.buses) tracks[id] = this.peaks(bus);
    return { master: this.peaks(this.masterBus), tracks };
  }

  /** Decode what each clip needs. Preview audio is bounded by the clip's WINDOW, not the
   *  source file: ffmpeg extracts just that span (see conformAudio) and only the extract is
   *  pulled into memory. Without an ffmpeg (the web build) it falls back to decoding the
   *  source whole, which is why the size ceiling still guards that path. */
  private async decode(clips: Scheduled[]): Promise<void> {
    if (!this.store || clips.length === 0) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const runner = await previewRunner();
    // One decode per distinct window, not per clip: two clips on the same span share a buffer.
    const wanted = new Map<string, Scheduled[]>();
    for (const c of clips) {
      const key = runner
        ? `${c.source}|${c.srcInSec.toFixed(3)}|${c.srcOutSec.toFixed(3)}`
        : c.source;
      c.key = key;
      c.base = runner ? Math.max(0, c.srcInSec) : 0;
      (wanted.get(key) ?? wanted.set(key, []).get(key)!).push(c);
    }
    await Promise.all(
      [...wanted].map(async ([key, group]) => {
        if (this.buffers.has(key)) return; // decoded or already in-flight
        this.buffers.set(key, null);
        const c = group[0];
        try {
          let ref = c.source;
          if (runner) {
            const wav = await conformWindow(
              { store: this.store!, runner },
              c.source,
              c.srcInSec,
              c.srcOutSec,
            );
            if (!wav) return; // no audio in that span — legitimately silent
            ref = wav;
          } else if (await this.tooBigToDecode(c.source)) return;
          const url = await resolveSourceUrl(this.store!, ref);
          if (!url) return;
          const bytes = await (await fetch(url)).arrayBuffer();
          const audio = await ctx.decodeAudioData(bytes);
          // Only keep it if the slot is still present — reset() (project switch)
          // deletes it, which is how we drop a stale in-flight decode.
          if (this.buffers.has(key)) this.buffers.set(key, audio);
        } catch {
          /* video with no audio track / undecodable — stays null and is skipped */
        }
      }),
    );
    if (this.playing) this.reschedule(); // late-decoded audio joins in-progress playback
  }

  /** Only reachable without an ffmpeg to conform with (the web build): there the source is
   *  still pulled in whole, so an oversized one would be an out-of-memory crash. Answered
   *  from a stat, never by reading the file. */
  private async tooBigToDecode(src: string): Promise<boolean> {
    const abs = await this.store?.resolveRef?.(src).catch(() => null);
    const size = abs ? await this.store?.byteSize?.(abs).catch(() => null) : null;
    if (!overPreviewBudget(size)) return false;
    useProjectNotice.getState().notify(tooLargeNotice(displayName(abs, src), size as number));
    return true;
  }

  /** Ensure the context is live + resumed. Call inside the Play click so the
   *  browser's autoplay policy lets audio start. */
  prime(): void {
    const ctx = this.ensureCtx();
    void ctx?.resume?.();
  }

  /** Start playback from `fromSec` (the playhead). */
  play(fromSec: number): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) {
      console.log("[audio] play: no ctx/master");
      return;
    }
    void ctx.resume?.();
    this.stopNodes();
    this.playing = true;
    this.fromSec = fromSec;
    this.startedAt = ctx.currentTime + 0.02; // tiny lead so every source schedules in the future
    for (const c of this.clips) this.scheduleClip(ctx, c, fromSec, this.startedAt);
  }

  pause(): void {
    this.playing = false;
    this.stopNodes();
  }

  /** Resync to a new playhead mid-playback (e.g. a scrub while playing). No-op when paused. */
  seek(toSec: number): void {
    if (this.playing) this.play(toSec);
  }

  dispose(): void {
    this.stopNodes();
    this.playing = false;
    try {
      void this.ctx?.close?.();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.master = null;
    this.masterBus = null;
    this.buses.clear();
    this.scratch = null;
    this.buffers.clear();
    this.clips = [];
    this.project = null; // a disposed engine holds no project, so a rebind reloads
  }

  /** Drop the schedule + decoded audio; keep the context. Prefer setProject() for a
   *  project switch — it only tears down when the project actually changed. */
  reset(): void {
    this.stopNodes();
    this.playing = false;
    this.buffers.clear();
    this.clips = [];
    // Track ids belong to the project that just went away; keeping their buses would leave
    // meters reading against lanes that no longer exist.
    for (const bus of this.buses.values()) {
      try {
        bus.input.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.buses.clear();
  }

  private reschedule(): void {
    if (!this.ctx) return;
    const now = this.fromSec + (this.ctx.currentTime - this.startedAt);
    this.play(Math.max(0, now));
  }

  private scheduleClip(ctx: AudioContext, c: Scheduled, fromSec: number, t0: number): void {
    if (c.endSec <= fromSec) return; // already finished before the playhead
    const buf = this.buffers.get(c.key);
    if (!buf || !this.master) return; // not decoded yet / no audio track
    const clipFrom = Math.max(c.startSec, fromSec);
    const when = t0 + (clipFrom - fromSec); // ctx time this clip should sound
    const wallDur = c.endSec - clipFrom; // seconds it occupies on the timeline
    if (wallDur <= 0) return;
    const into = clipFrom - c.startSec; // timeline seconds already elapsed in the clip

    // Source window within the decoded buffer, in BUFFER time: a conformed extract starts at
    // the clip's source in-point, so `base` shifts both edges back to it (0 when whole-file).
    const srcIn = Math.max(0, c.srcInSec - c.base);
    const srcOut =
      c.srcOutSec > c.srcInSec ? Math.min(c.srcOutSec - c.base, buf.duration) : buf.duration;
    const srcSpan = Math.max(0, srcOut - srcIn);

    const node = ctx.createBufferSource();
    node.buffer = buf;

    let offset: number;
    let rate: number;
    let startDur: number | undefined; // start()'s 3rd arg (source secs); undefined = run until stop()
    let looped = false;
    if (c.loop && srcSpan > 1e-4) {
      // Repeat the source window to fill the slot; stop() bounds it to the clip.
      rate = c.speed;
      node.loop = true;
      node.loopStart = srcIn;
      node.loopEnd = srcOut;
      offset = srcIn + ((((into * rate) % srcSpan) + srcSpan) % srcSpan);
      looped = true;
    } else if (c.stretch && srcSpan > 1e-4) {
      // Time-fit the window to the slot. playbackRate shifts pitch in preview
      // (export uses pitch-preserving atempo); timing/sync is what matters here.
      rate = srcSpan / (c.endSec - c.startSec);
      offset = srcIn + into * rate;
      startDur = wallDur * rate; // consumes exactly up to srcOut
    } else {
      // Play the source once at `speed`, clamped to what's left of the buffer.
      rate = c.speed;
      offset = srcIn + into * c.speed;
      if (offset >= buf.duration) return;
      startDur = Math.min(wallDur * c.speed, buf.duration - offset);
      if (startDur <= 0) return;
    }
    node.playbackRate.value = rate;

    // Two gains, in graph order: the volume ENVELOPE then the fade ramps. Interleaving both
    // onto one AudioParam means two independent schedules fighting over the same automation
    // timeline; separate nodes multiply, which is what the exporter's `volume` then `afade`
    // chain does too.
    const envGain = ctx.createGain();
    const gain = ctx.createGain();
    // When the clip stops sounding: looped nodes run until we stop() them at the
    // slot end; the others auto-stop after startDur (source secs) at their rate.
    const audibleEnd = looped ? when + wallDur : when + (startDur as number) / rate;
    const vol = c.volume;
    if (c.volumeCurve.length) {
      // Keyframe times are clip-relative, but playback can start mid-clip (scrubbing), so the
      // schedule is anchored to the clip's own start and past keys are skipped after seeding
      // the level the curve is already at.
      const clipStartCtxTime = when - (clipFrom - c.startSec) / rate;
      envGain.gain.setValueAtTime(sampleCurve(c.volumeCurve, clipFrom - c.startSec), when);
      for (const [tSec, v] of c.volumeCurve) {
        const at = clipStartCtxTime + tSec / rate;
        if (at <= when) continue;
        envGain.gain.linearRampToValueAtTime(v, at);
      }
    } else {
      envGain.gain.setValueAtTime(vol, when);
    }
    // Micro-fade clip edges (declick): a hard cut mid-waveform pops. Ramp a few
    // ms at head/tail; a real user fade (longer) supersedes it.
    const dur = audibleEnd - when;
    const declick = Math.min(0.005, dur / 2);
    // Fade in only at the clip head — scrubbing INTO a clip lands mid-waveform
    // deliberately and shouldn't fade.
    const fin = clipFrom === c.startSec ? Math.max(c.fadeInSec, declick) : 0;
    if (fin > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + Math.min(fin, dur));
    } else {
      gain.gain.setValueAtTime(1, when);
    }
    const fout = Math.max(c.fadeOutSec, declick);
    if (fout > 0 && fout < dur) {
      gain.gain.setValueAtTime(1, audibleEnd - fout);
      gain.gain.linearRampToValueAtTime(0, audibleEnd);
    }
    node
      .connect(envGain)
      .connect(gain)
      .connect(this.busFor(ctx, c.trackId) ?? this.master);
    try {
      if (startDur !== undefined) node.start(when, offset, startDur);
      else node.start(when, offset);
    } catch {
      return;
    }
    if (looped) {
      try {
        node.stop(audibleEnd);
      } catch {
        /* ignore */
      }
    }
    node.onended = () => {
      try {
        node.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
    this.nodes.push(node);
  }

  private stopNodes(): void {
    for (const n of this.nodes) {
      try {
        n.onended = null;
        n.stop();
        n.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
  }
}
