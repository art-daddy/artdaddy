// Stable short digests for deterministic artifact filenames.
//
// A LEAF module on purpose: proxyPaths (and through it the still-picture owner, which the encoder
// that uploads stills to a model reads through) needs this, and its old home, tools/media, imports the
// import door, which imports that same encoder. Keeping the hash here keeps that a line, not a cycle.

/** Stable 12-hex digest for deterministic artifact filenames (double FNV-1a). */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}
