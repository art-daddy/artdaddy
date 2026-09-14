// OS file drops, once Tauri owns them.
//
// The webview deliberately hides a dropped file's real path, so an HTML5 drop can only ever hand
// us bytes — which is why a drop used to COPY the file into the project while File → Import linked
// it in place. Tauri's own drag-drop handler gives the paths, so both doors can behave the same.
//
// The cost, from Tauri's docs: "Disabling [dragDropEnabled] is required to use HTML5 drag and drop
// on the frontend on Windows since we replace the drag drop handler of WebView2." Turning it on
// therefore takes ALL drag events, including in-app ones — see dragSource.ts for those.
//
// Targets declare themselves with `data-artdaddy-drop="<id>"` rather than registering handlers, so
// hit-testing is one lookup and the target is whatever is under the cursor at drop time.
import { platform } from "../platform";

export interface OsDrop {
  paths: string[];
  /** `data-artdaddy-drop` of the element under the cursor, "" if none. */
  target: string;
  /** The element itself, for readers that need its dataset (e.g. which track). */
  element: HTMLElement | null;
  /** CSS pixels, so callers can reuse their existing coordinate maths. */
  x: number;
  y: number;
}

export const OS_DROP_EVENT = "artdaddy:os-drop";
export const OS_DRAG_OVER_EVENT = "artdaddy:os-drag-over";

/**
 * True when the WEB layer owns OS file drops, i.e. when its `dragover`/`drop` handlers may
 * claim the drag. On desktop Tauri's native handler is the SOLE authority and this is false.
 *
 * Claiming it anyway is not the harmless no-op the HTML5 handlers assumed. `preventDefault`
 * on `dragover` makes the PAGE the drop target, and WKWebView then delivers the drop to the
 * page instead of to Tauri: macOS hands over the pasteboard's QuickLook PREVIEW — a .jpeg
 * still of the dropped video, with no path and no duration — so the library filled with
 * stills and a lane got a 1-frame sliver. Windows never showed it because WebView2's drag
 * handler is REPLACED outright, so the page never sees the drag to claim it in the first
 * place. Every file-drop handler asks here rather than restating the rule in a comment.
 */
export function webOwnsFileDrops(): boolean {
  return platform.name !== "tauri";
}

/** Physical device pixels -> CSS pixels. Tauri reports the former; the DOM speaks the latter,
 *  and on a 150% display ignoring this lands the drop a third of the way up the window. */
function toCss(p: { x: number; y: number }): { x: number; y: number } {
  const r = window.devicePixelRatio || 1;
  return { x: p.x / r, y: p.y / r };
}

function hit(x: number, y: number): { target: string; element: HTMLElement | null } {
  const el = document.elementFromPoint(x, y);
  const zone = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-artdaddy-drop]") : null;
  return { target: zone?.dataset.artdaddyDrop ?? "", element: zone };
}

/** Route OS drops to whatever is under the cursor. No-op outside Tauri, where the webview's
 *  own drop events still apply. Returns an unsubscribe. */
export async function startOsDropRouter(): Promise<() => void> {
  if (platform.name !== "tauri") return () => {};
  let webview;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    webview = getCurrentWebview();
  } catch (e) {
    // Not a real webview (tests, an older shell). File -> Import still works, so this is a
    // degraded drop experience rather than a broken app -- but say so rather than go quiet.
    console.warn("[drop] native file drops unavailable; use File > Import", e);
    return () => {};
  }
  const un = await webview.onDragDropEvent((e) => {
    const payload = e.payload as {
      type: string;
      paths?: string[];
      position?: { x: number; y: number };
    };
    if (payload.type === "leave") {
      window.dispatchEvent(new CustomEvent(OS_DRAG_OVER_EVENT, { detail: null }));
      return;
    }
    if (!payload.position) return;
    const { x, y } = toCss(payload.position);
    const { target, element } = hit(x, y);
    if (payload.type === "over") {
      window.dispatchEvent(new CustomEvent(OS_DRAG_OVER_EVENT, { detail: { target, x, y } }));
      return;
    }
    if (payload.type !== "drop" || !payload.paths?.length) return;
    const detail: OsDrop = { paths: payload.paths, target, element, x, y };
    window.dispatchEvent(new CustomEvent<OsDrop>(OS_DROP_EVENT, { detail }));
  });
  return un;
}

/** Subscribe to routed OS drops. `target` filters on the zone's `data-artdaddy-drop`. */
export function onOsDrop(target: string, fn: (d: OsDrop) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<OsDrop>).detail;
    if (d.target === target) fn(d);
  };
  window.addEventListener(OS_DROP_EVENT, h);
  return () => window.removeEventListener(OS_DROP_EVENT, h);
}

/** Subscribe to hover, for the same highlight the HTML5 path drew on dragover. Carries the
 *  POSITION too: a timeline lane needs it to show where the file would land, and the router
 *  already knows it — recovering it from a second listener would be a second source of truth. */
export function onOsDragOver(
  fn: (d: { target: string; x: number; y: number } | null) => void,
): () => void {
  const h = (e: Event) => {
    fn((e as CustomEvent<{ target: string; x: number; y: number } | null>).detail);
  };
  window.addEventListener(OS_DRAG_OVER_EVENT, h);
  return () => window.removeEventListener(OS_DRAG_OVER_EVENT, h);
}
