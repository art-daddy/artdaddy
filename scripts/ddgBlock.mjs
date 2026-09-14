// Is a DuckDuckGo HTML-endpoint response a BLOCK rather than a result set?
//
// Kept separate from the sidecar so it can be unit-tested: this predicate is the
// only thing standing between "the engine refused us" and the tool reporting an
// empty, authoritative-looking "no matches". Getting it wrong is silent — the
// model believes there is nothing to find and answers from memory.
//
// Two real signatures, both observed against the live endpoint:
//  1. CAPTCHA interstitial ("Unfortunately, bots use DuckDuckGo too."), which
//     renders an anomaly-modal and zero `.result` nodes.
//  2. The older soft rate-limit: a tiny body with the bare title "DuckDuckGo".
//     A SERVED page always titles "{query} at DuckDuckGo", so the missing suffix
//     is the tell that no search was actually run.
//
// A normal page with zero hits (real query, real SERP chrome, "at DuckDuckGo"
// title) is NOT blocked — that one genuinely has no matches.

/** @param {{results:number, bodyLen:number, title:string, challenge:boolean}} s */
export function ddgBlocked(s) {
  if (s.challenge) return true;
  return s.results === 0 && s.bodyLen < 500 && !/at duckduckgo/i.test(s.title || "");
}
