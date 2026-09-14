import { useEffect, useRef, useState } from "react";

import { resolvePreviewUrl } from "../preview/resolve";
import { kindOf } from "../media/formats";
import { useEditor } from "../store/editor";
import { Empty, cn } from "./ui";

// Source monitor (Premiere-style): previews the library clip selected in the
// file tree, independent of the timeline/program monitor. Video + audio use a
// transport (play + scrub + time) styled to match the live preview; images
// render full-frame; audio shows a music icon. Video uses the H.264 preview
// proxy when present so non-web codecs (HEVC/ProRes) still play.

function fmt(t: number): string {
  if (!Number.isFinite(t)) return "0:00";
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Video/audio player styled to match the live-preview transport. */
function AVPlayer({ url, kind }: { url: string; kind: "video" | "audio" }) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  // An audio-only container (e.g. AAC in an .mp4/.m4a) reports no video frame —
  // show the audio icon instead of a black video box, but keep playing its audio.
  const [noVideo, setNoVideo] = useState(false);
  const toggle = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play?.();
    else el.pause?.();
  };
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {kind === "video" ? (
          <>
            <video
              key={url}
              ref={(el) => (mediaRef.current = el)}
              src={url}
              playsInline
              onClick={toggle}
              onLoadedMetadata={(e) => {
                setDur(e.currentTarget.duration || 0);
                setNoVideo(!e.currentTarget.videoWidth);
              }}
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime || 0)}
              onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              className={cn("max-h-full max-w-full rounded", noVideo && "hidden")}
            />
            {noVideo && (
              <span className="pointer-events-none select-none text-5xl text-neutral-700">🎵</span>
            )}
          </>
        ) : (
          <>
            <span className="select-none text-5xl text-neutral-700">🎵</span>
            <audio
              key={url}
              ref={(el) => (mediaRef.current = el)}
              src={url}
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime || 0)}
              onDurationChange={(e) => setDur(e.currentTarget.duration || 0)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              className="hidden"
            />
          </>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-edge px-3 py-1.5">
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
          max={dur || 0}
          step={0.05}
          value={Math.min(t, dur || 0)}
          onChange={(e) => {
            const el = mediaRef.current;
            if (el) el.currentTime = Number(e.target.value);
          }}
          aria-label="source time"
          className="flex-1 accent-accent"
        />
        <span className="w-16 text-right text-[11px] tabular-nums text-neutral-500">
          {fmt(t)} / {fmt(dur)}
        </span>
      </div>
    </div>
  );
}

export default function SourceMonitor() {
  const ref = useEditor((s) => s.selectedLibraryRef);
  const store = useEditor((s) => s.store);
  const [url, setUrl] = useState<string | null>(null);
  // The ref may be a bare library id (external assets are keyed by id), which has no
  // extension to classify. Resolve it to a real path and classify THAT.
  const [resolved, setResolved] = useState<string>("");

  useEffect(() => {
    if (!ref || !store) {
      setUrl(null);
      setResolved("");
      return;
    }
    let cancelled = false;
    setUrl(null);
    void resolvePreviewUrl(store, ref).then((u) => {
      if (!cancelled) setUrl(u ?? "");
    });
    void store.resolveRef(ref).then((p) => {
      if (!cancelled) setResolved(p ?? ref);
    });
    return () => {
      cancelled = true;
    };
  }, [ref, store]);

  const name = ref ? ref.split("/").pop() : "";
  const probe = resolved || ref || "";
  const kind = !ref ? null : (kindOf(probe) ?? "other");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
        <span className="shrink-0">Source</span>
        {name && (
          <span className="truncate normal-case text-neutral-400" title={ref ?? undefined}>
            {name}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-black/40 p-2">
        {!ref ? (
          <Empty>Click a library clip to preview it here.</Empty>
        ) : url === null ? (
          <p className="text-xs text-neutral-600">Loading…</p>
        ) : url === "" ? (
          <p className="text-xs text-neutral-600">Couldn't resolve this file.</p>
        ) : kind === "video" || kind === "audio" ? (
          <AVPlayer key={url} url={url} kind={kind} />
        ) : kind === "image" ? (
          <img
            key={url}
            src={url}
            alt={name ?? ""}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="text-xs text-neutral-600">No preview for this file type.</p>
        )}
      </div>
    </div>
  );
}
