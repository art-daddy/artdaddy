// Per-clip preview in the timeline: video/image clips show their pre-generated
// poster (library/thumbnails/<id>.jpg, falling back to an image source), text
// clips show their text in the clip's own colour. Browser-only (asset-URL
// resolution + <img>), so it's excluded from unit coverage like ClipWaveform.
import { useEffect, useState } from "react";

import { resolveSourceUrl } from "../preview/resolve";
import { onMediaDerived } from "../preview/mediaDerived";
import { imageProxyRel, posterRel } from "../preview/proxyPaths";
import { kindOf, needsPreviewProxy } from "../media/formats";
import type { Clip } from "../timeline/model";
import { INTERNAL_DIR, type ProjectStoreAccess } from "../tools/store";

/** library/<id>.<ext> -> internals/cache/thumbnails/<id>.jpg (or null if the source
 *  isn't a library clip). Falls back to the generated poster when absent. */
function thumbPath(source: string): string | null {
  const m = /(?:^|[\\/])library[\\/]([^\\/]+)\.[^.\\/]+$/i.exec(source);
  if (!m) return null;
  return `${INTERNAL_DIR}/cache/thumbnails/${m[1]}.jpg`;
}

function clipText(clip: Clip): string {
  if (typeof clip.text === "string" && clip.text.trim()) return clip.text;
  const c = clip.content;
  if (Array.isArray(c)) {
    return c
      .map((s) =>
        s && typeof s === "object"
          ? String((s as Record<string, unknown>).text ?? "")
          : String(s ?? ""),
      )
      .join(" ")
      .trim();
  }
  if (typeof c === "string") return c;
  return "";
}

export function ClipThumbnail({
  store,
  clip,
  kind,
  status,
}: {
  store: ProjectStoreAccess | null | undefined;
  clip: Clip;
  kind: string;
  /** "generating" | "failed" when this clip's media is not ready yet. */
  status?: string;
}) {
  const source = typeof clip.media_ref === "string" ? clip.media_ref : "";
  const isText = kind === "text" || clip.kind === "text";
  const [url, setUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The poster is generated in the background, so a clip placed (or a library tile shown)
  // before it finishes resolves to nothing and would keep its placeholder forever. Listen
  // only while there is nothing to show: once resolved, this unsubscribes and a burst of
  // other assets finishing costs it nothing.
  useEffect(() => {
    if (url) return;
    return onMediaDerived(() => setAttempt((n) => n + 1));
  }, [url]);

  useEffect(() => {
    if (!store || isText || !source) {
      setUrl(null);
      return;
    }
    let alive = true;
    void (async () => {
      // A clip stores a bare library id: it has no extension for the thumbnail /
      // image regexes, and hashes to a poster key no generator wrote. Resolve it to
      // the real path first so all three lookups see `…/library/<id>.<ext>`.
      const resolved = (await store.resolveRef(source)) ?? source;
      const thumb = thumbPath(resolved);
      let u = thumb ? await resolveSourceUrl(store, thumb) : null;
      // Imported clips have no library thumbnail — use the generated poster.
      if (!u) u = await resolveSourceUrl(store, posterRel(resolved));
      // A still the browser can draw is its own thumbnail; one it cannot (TIFF/HEIC)
      // falls back to the generated PNG rather than showing nothing.
      if (!u && kindOf(resolved) === "image")
        u = await resolveSourceUrl(
          store,
          needsPreviewProxy(resolved) ? imageProxyRel(resolved) : source,
        );
      if (alive) setUrl(u);
    })();
    return () => {
      alive = false;
    };
  }, [store, source, isText, attempt]);

  // Media that does not exist yet still occupies the timeline, so the clip has to SAY so —
  // otherwise it reads as an ordinary clip that renders black.
  if (status === "generating" || status === "failed") {
    const failed = status === "failed";
    return (
      <span
        className={`pointer-events-none absolute inset-0 flex items-center truncate px-2 text-[11px] font-semibold ${
          failed ? "bg-red-950/60 text-red-200" : "shimmer bg-black/40 text-white/90"
        }`}
      >
        {failed ? "Generation failed" : "Generating\u2026"}
      </span>
    );
  }

  if (isText) {
    const text = clipText(clip);
    if (!text) return null;
    const styleColor = (clip.style as Record<string, unknown> | undefined)?.color;
    const color = typeof styleColor === "string" ? styleColor : "#ffffff";
    return (
      <span
        className="pointer-events-none absolute inset-0 flex items-center truncate px-2 text-[11px] font-semibold"
        style={{ color }}
      >
        {text}
      </span>
    );
  }

  if (!url) return null;
  return (
    <>
      <img
        src={url}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-80"
      />
      {/* darken the left where the filename label sits, keep it legible */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/10 to-transparent" />
    </>
  );
}
