import { useCallback, useEffect, useRef, useState } from "react";

import { platform } from "../platform";
import { PreviewAudio, publishPreviewAudio } from "../preview/audioEngine";
import { MASTER } from "../preview/meterPump";
import { resolveSourceUrl } from "../preview/resolve";
import { StallGate } from "../preview/stallGate";
import { useChat } from "../store/chat";
import { useEditor } from "../store/editor";
import { useProjects } from "../store/projects";
import { totalFrames } from "../timeline/geometry";
import type { Timeline as SceneTimeline } from "../timeline/model";
import { AudioMeter } from "./AudioMeter";
import PreviewCanvas from "./PreviewCanvas";
import PreviewTabs from "./PreviewTabs";
import SourceMonitor from "./SourceMonitor";
import StageEmpty from "./StageEmpty";
import StageOverlay from "./StageOverlay";
import { cn } from "./ui";

// Premiere's Program Monitor ladder.
const ZOOM_LEVELS: (number | "fit")[] = ["fit", 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];

// Middle pane: a tab strip (live preview, then any library clips opened from the
// library) over the preview monitor (rendered video, else the live WebGL composite)
// over a draggable transport. The editor store's playhead (seconds) is the single
// clock shared by the preview and the timeline, so scrubbing either moves both.
export default function StagePanel({ projectId }: { projectId: string }) {
  const session = useChat((s) => s.session);
  const active = useProjects((s) => s.active);
  const timeline = useEditor((s) => s.timeline);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const store = useEditor((s) => s.store);
  const importing = useEditor((s) => s.importing);
  // Empty = the live preview tab; a ref = that library clip's source monitor.
  const sourceRef = useEditor((s) => s.activeMediaTab);
  const onSource = !!sourceRef;

  const canvas = timeline?.canvas;
  const fps = Number(canvas?.fps) || 30;
  const total = timeline ? totalFrames(timeline) : 0;
  const timelineDuration = total / fps;
  // A new project already HAS a timeline — empty v1/a1 tracks — so "no timeline" is not what
  // an empty project looks like. Nothing to composite means no CLIPS.
  const empty = !timeline || timeline.tracks.every((t) => !t.clips?.length);

  const finalMp4 = session?.final_mp4 || active?.manifest?.final_mp4 || "";
  const hasVideo = Boolean(finalMp4);
  // Manual editing is LIVE-first: the WebGL composite reflects timeline edits as
  // you make them. The rendered export (final_mp4) is a stale snapshot, shown
  // only when the user flips the Live/Rendered toggle.
  const [mode, setMode] = useState<"live" | "rendered">("live");
  const showRendered = hasVideo && (mode === "rendered" || !timeline);
  // Transform and crop both want the same corner/edge handles, so they are separate modes
  // (as in Premiere and other NLEs) rather than one overlay that guesses which you meant.
  const [cropMode, setCropMode] = useState(false);
  // Program-monitor zoom, Premiere's ladder. Fit is the default and re-fits on resize;
  // a number is frame px per CSS px, so 1 = 100% = one frame pixel per screen pixel.
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [vDur, setVDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Desktop plays the exported file straight off disk (asset protocol, no HTTP
  // stream); web falls back to the server's final-video endpoint.
  const [assetSrc, setAssetSrc] = useState<string | null>(null);
  const audioRef = useRef<PreviewAudio | null>(null);
  if (!audioRef.current) audioRef.current = new PreviewAudio();
  const stallRef = useRef<StallGate | null>(null);
  if (!stallRef.current) stallRef.current = new StallGate();

  useEffect(() => {
    setPlaying(false);
    setVDur(0);
  }, [projectId, finalMp4]);
  // Leaving the live tab stops the program monitor: two transports running at once would
  // put the timeline's audio under a clip the user is auditioning.
  useEffect(() => {
    if (onSource) setPlaying(false);
  }, [onSource]);
  // Space bar (from the timeline keyboard handler) toggles play/pause.
  useEffect(() => {
    if (onSource) return; // a source tab has its own transport
    const onToggle = () => setPlaying((p) => !p);
    window.addEventListener("artdaddy:toggle-play", onToggle);
    return () => window.removeEventListener("artdaddy:toggle-play", onToggle);
  }, [onSource]);
  useEffect(() => {
    if (!hasVideo || !platform.capabilities.fileSystem || !store) {
      setAssetSrc(null);
      return;
    }
    let cancelled = false;
    void resolveSourceUrl(store, finalMp4).then((u) => {
      if (!cancelled) setAssetSrc(u ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [finalMp4, hasVideo, store]);
  useEffect(() => setMode("live"), [projectId]);

  // Live-preview audio: bind the engine to the project, feed it the store + current
  // timeline, and tear it down on unmount. (Rendered mode plays the exported video's own
  // audio, so the engine stays paused there.)
  //
  // ONE effect on purpose. These used to be three, and React runs passive setups in
  // DECLARATION order: the reset (deps [projectId]) was declared after the load (deps
  // [timeline, store, showRendered]), so every project open ran load() then reset() and
  // threw the schedule away — play() had nothing to schedule and the user heard silence
  // until an edit re-ran load(). Split across effects there is no order to enforce;
  // together, the sequence is explicit and cannot be re-broken by moving a hook.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setProject(projectId); // no-op unless the project actually changed
    audio.setStore(store);
    if (showRendered) audio.pause();
    else audio.load(timeline as unknown as SceneTimeline);
  }, [projectId, store, timeline, showRendered]);
  useEffect(() => () => audioRef.current?.dispose(), []);
  // The meters live in other panels, so the instance is published rather than passed down.
  useEffect(() => {
    publishPreviewAudio(audioRef.current);
    return () => publishPreviewAudio(null);
  }, []);

  const duration = showRendered ? vDur || timelineDuration : timelineDuration;
  // Desktop: the resolved asset URL (once ready); web: the server endpoint.
  const videoSrc = assetSrc ?? undefined;

  // Canvas playback: advance the master playhead each frame while playing, and
  // drive the audio engine with it — start on play, stop on pause, and resync if
  // the playhead is moved externally (a scrub) while playing.
  //
  // While the compositor has nothing decoded for a visible clip, the clock HOLDS
  // (see stallGate): otherwise the playhead and the audio run on through footage
  // the user never sees, which reads as "stuck on one frame, then it jumps".
  useEffect(() => {
    if (showRendered || !playing || duration <= 0) return;
    const audio = audioRef.current;
    const gate = stallRef.current;
    gate?.reset();
    let expected = useEditor.getState().playhead;
    audio?.play(expected);
    let raf = 0;
    let last = 0;
    let holding = false;
    const loop = (ts: number): void => {
      const cur = useEditor.getState().playhead;
      const dt = last ? ts - last : 0;
      last = ts;
      const hold = gate?.hold(dt) ?? false;
      if (hold !== holding) {
        holding = hold;
        // Audio has its own clock, so it must wait too or it drifts ahead of the picture.
        if (hold) audio?.pause();
        else {
          audio?.play(cur);
          expected = cur;
        }
      }
      if (dt && !hold) {
        if (Math.abs(cur - expected) > 0.12) audio?.seek(cur); // external scrub while playing
        const next = cur + dt / 1000;
        if (next >= duration) {
          setPlayhead(duration);
          setPlaying(false);
          return;
        }
        setPlayhead(next);
        expected = next;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      audio?.pause();
    };
  }, [showRendered, playing, duration, setPlayhead]);

  // Keep the rendered video aligned when the playhead moves from elsewhere
  // (timeline scrub, arrow keys). No-op when the change came from the video.
  useEffect(() => {
    const v = videoRef.current;
    if (showRendered && v && Math.abs(v.currentTime - playhead) > 0.05) {
      v.currentTime = Math.min(playhead, duration || playhead);
    }
  }, [playhead, showRendered, duration]);

  const toggle = useCallback(() => {
    if (!showRendered) {
      audioRef.current?.prime(); // resume the AudioContext within the click gesture
      setPlaying((p) => !p);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play?.();
    else v.pause?.();
  }, [showRendered]);

  const seek = useCallback(
    (t: number) => setPlayhead(Math.max(0, Math.min(t, duration || 0))),
    [duration, setPlayhead],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-950">
      <PreviewTabs />
      <header className="flex items-center gap-3 border-b border-edge px-4 py-2">
        <h2 className="truncate text-sm font-semibold">{active?.name ?? projectId}</h2>
        {canvas && !onSource && (
          <span className="text-xs text-neutral-500">
            {canvas.width}×{canvas.height} · {canvas.fps}fps
          </span>
        )}
        {hasVideo && timeline && !onSource && (
          <div className="ml-auto flex overflow-hidden rounded border border-edge text-[11px]">
            <button
              onClick={() => setMode("live")}
              className={cn(
                "px-2 py-0.5",
                mode === "live" ? "bg-accent text-white" : "text-neutral-400 hover:bg-neutral-800",
              )}
            >
              Live
            </button>
            <button
              onClick={() => setMode("rendered")}
              className={cn(
                "px-2 py-0.5",
                mode === "rendered"
                  ? "bg-accent text-white"
                  : "text-neutral-400 hover:bg-neutral-800",
              )}
            >
              Rendered
            </button>
          </div>
        )}
        {timeline && !showRendered && !onSource && (
          <select
            aria-label="canvas zoom"
            value={String(zoom)}
            onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}
            title="Canvas zoom"
            className="ml-auto rounded border border-edge bg-transparent px-1 py-0.5 text-[11px] text-neutral-400"
          >
            {ZOOM_LEVELS.map((z) => (
              <option key={String(z)} value={String(z)}>
                {z === "fit" ? "Fit" : `${Math.round(z * 100)}%`}
              </option>
            ))}
          </select>
        )}
        {timeline && !showRendered && !onSource && (
          <button
            type="button"
            aria-label="crop mode"
            aria-pressed={cropMode}
            title="Crop (C)"
            onClick={() => setCropMode((c) => !c)}
            className={cn(
              "rounded border border-edge px-2 py-0.5 text-[11px]",
              cropMode ? "bg-amber-400 text-black" : "text-neutral-400 hover:bg-neutral-800",
            )}
          >
            Crop
          </button>
        )}
      </header>

      {/* Preview: the rendered video (scrubbed by the timeline) or the WebGL composite. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2">
        {importing && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-md bg-black/70 px-3 py-1.5 text-xs text-neutral-200 ring-1 ring-white/10">
            Processing imported media…
          </div>
        )}
        {showRendered ? (
          <video
            key={String(finalMp4)}
            ref={videoRef}
            data-testid="preview-video"
            src={videoSrc}
            preload="auto"
            playsInline
            onClick={toggle}
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime || 0)}
            onDurationChange={(e) => setVDur(e.currentTarget.duration || 0)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="max-h-full max-w-full rounded"
          />
        ) : timeline && !empty ? (
          <PreviewCanvas
            timeline={timeline as unknown as SceneTimeline}
            time={playhead}
            zoom={zoom}
            onStalled={(s) => stallRef.current?.setStarved(s)}
          >
            <StageOverlay cropMode={cropMode} />
          </PreviewCanvas>
        ) : (
          <StageEmpty projectId={projectId} />
        )}
        {/* A source tab COVERS the program monitor rather than replacing it: the compositor
            keeps its canvas and its decoded frames, so switching back is instant and no
            worker is torn down for a glance at a library clip. */}
        {sourceRef && (
          <div className="absolute inset-0 z-20 bg-black">
            <SourceMonitor key={sourceRef} mediaRef={sourceRef} />
          </div>
        )}
      </div>

      {!onSource && duration > 0 && (
        <div className="flex items-center gap-3 border-t border-edge px-4 py-2">
          <button
            onClick={toggle}
            aria-label={playing ? "pause" : "play"}
            className="rounded bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.05}
            value={Math.min(playhead, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="preview time"
            className="flex-1 accent-accent"
          />
          <span className="w-24 text-right text-[11px] tabular-nums text-neutral-500">
            {playhead.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
          <AudioMeter
            channel={MASTER}
            label="master level"
            orientation="horizontal"
            className="w-16 shrink-0"
          />
        </div>
      )}
    </div>
  );
}
