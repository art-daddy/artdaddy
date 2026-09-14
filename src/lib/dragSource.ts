// In-app dragging, on pointer events.
//
// Library -> timeline used HTML5 drag-and-drop, which Tauri's native drag-drop handler takes over
// on Windows the moment it is enabled ("we replace the drag drop handler of WebView2"). Pointer
// events are delivered by every webview regardless, so the gesture no longer depends on which
// handler owns the window.
//
// A 5px threshold arms the drag, so an ordinary click still selects rather than starting one.

export interface DragPayload {
  /** Library ref (media id or project-relative path) — the same string the drop consumed before. */
  ref: string;
  name: string;
}

const THRESHOLD_PX = 5;

let active: DragPayload | null = null;
let ghost: HTMLElement | null = null;
const listeners = new Set<(p: DragPayload | null) => void>();
/** Where the drag is RIGHT NOW. Kept here rather than re-listened for by each drop target, so
 *  "is a drag happening and where" has one answer. */
const pointListeners = new Set<
  (p: { payload: DragPayload; x: number; y: number } | null) => void
>();

export function activeDrag(): DragPayload | null {
  return active;
}

/** Subscribe to the live pointer position during a drag; null when it ends. */
export function onDragPoint(
  fn: (p: { payload: DragPayload; x: number; y: number } | null) => void,
): () => void {
  pointListeners.add(fn);
  return () => pointListeners.delete(fn);
}

function announcePoint(x: number, y: number): void {
  if (!active) return;
  for (const fn of [...pointListeners]) fn({ payload: active, x, y });
}

export function onDragChange(fn: (p: DragPayload | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  for (const fn of [...listeners]) fn(active);
}

function moveGhost(x: number, y: number): void {
  if (!ghost) return;
  ghost.style.left = `${x + 12}px`;
  ghost.style.top = `${y + 12}px`;
}

function makeGhost(label: string, x: number, y: number): void {
  ghost = document.createElement("div");
  ghost.textContent = label;
  // Must not be hit-testable: elementFromPoint under the cursor has to find the DROP ZONE.
  ghost.style.cssText =
    "position:fixed;z-index:9999;pointer-events:none;padding:2px 6px;border-radius:4px;" +
    "background:rgba(23,23,23,.95);border:1px solid #444;color:#e5e5e5;font-size:11px;" +
    "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  moveGhost(x, y);
  document.body.appendChild(ghost);
}

function teardown(): void {
  ghost?.remove();
  ghost = null;
  active = null;
  announce();
  for (const fn of [...pointListeners]) fn(null);
}

/** Begin a potential drag from a pointerdown. Nothing happens until the pointer actually moves,
 *  so a click is unaffected. `onDrop` fires with the element under the cursor at release. */
export function beginDrag(
  e: { clientX: number; clientY: number; button: number },
  payload: DragPayload,
  onDrop: (target: HTMLElement | null, x: number, y: number) => void,
): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let armed = false;

  const move = (ev: PointerEvent) => {
    if (!armed) {
      if (
        Math.abs(ev.clientX - startX) < THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) < THRESHOLD_PX
      )
        return;
      armed = true;
      active = payload;
      makeGhost(payload.name, ev.clientX, ev.clientY);
      announce();
    }
    moveGhost(ev.clientX, ev.clientY);
    announcePoint(ev.clientX, ev.clientY);
  };

  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    if (!armed) return; // a plain click
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = el instanceof HTMLElement ? el : null;
    teardown();
    onDrop(target, ev.clientX, ev.clientY);
  };

  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    if (armed) teardown();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}
