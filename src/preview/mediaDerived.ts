// Derived media (poster / proxy) is produced in the BACKGROUND, seconds to minutes after the
// asset itself appears. A thumbnail that mounted before that finished resolved once, found
// nothing, and had no way to learn otherwise — so a generated clip kept its placeholder for
// the rest of the session while a perfectly good poster sat on disk beside it. Refreshing the
// library did not help either: the tiles are keyed by path, so they stay mounted and never
// re-run the lookup.
//
// One name, exported, because a producer and a consumer that spell an event differently fail
// silently and look exactly like this bug.
const MEDIA_DERIVED = "artdaddy:media-derived";

/** Announce that a source now has derived artifacts on disk. */
export function announceMediaDerived(source: string): void {
  if (typeof window === "undefined") return; // non-DOM callers (tests, node tooling)
  window.dispatchEvent(new CustomEvent(MEDIA_DERIVED, { detail: { source } }));
}

/** Subscribe to the above. Returns an unsubscribe. */
export function onMediaDerived(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MEDIA_DERIVED, fn);
  return () => window.removeEventListener(MEDIA_DERIVED, fn);
}
