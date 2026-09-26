// Per-project background indexer — other NLEs' SearchIndexCoordinator, scoped to
// our needs. Observes the project's media (timeline clips AND the library
// catalog) and, on open / import / edit, runs disk-cached, best-effort passes:
//   • proxy      — poster + H.264 preview proxy for timeline VIDEO clips whose
//                  codec the in-app WebCodecs preview can't decode (HEVC/ProRes),
//                  so the live preview never goes blank waiting on a transcode;
//   • transcript — on-device word-level transcript per audio/video asset, warming
//                  get_transcript (and future search) so the first read is instant.
// Each pass drains INDEPENDENTLY, so a poster the user is waiting on never queues behind a
// multi-minute transcription.
// Desktop-only: no runner (web build) => no-op. Lifecycle-scoped: dispose() on
// project switch cancels pending work so it never leaks across projects.
//
// The transcript pass was removed once, because its 465 MiB model was buffered whole in the
// webview and killed macOS at project open. The download streams to disk and reports progress
// now, so the warm-up is back — but nothing here may silently download again: the model is
// visible while it installs, and a transcript that fails says so instead of reading as silence.
import type { CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import type { ProjectStoreAccess } from "../tools/store";
import type { Timeline } from "../timeline/model";
import { kindOf, needsPreviewProxy } from "../media/formats";
import { reportAppError } from "../api/appEvents";

// Media imported BY REFERENCE lives wherever the user keeps it, so neither pass may require
// a path inside the project. Requiring `library/` here is why an externally-referenced clip
// got no preview proxy AND no transcript: both silently matched nothing.
const needsProxy = (p: string): boolean =>
  kindOf(p) === "video" || (kindOf(p) === "image" && needsPreviewProxy(p));
const isIndexable = (p: string): boolean => {
  const k = kindOf(p);
  return k === "video" || k === "audio";
};

type Pass = "proxy" | "transcript";

/** The desktop-only modules a drain needs, resolved once rather than per job. */
interface IndexModules {
  processImportedMedia: typeof import("../preview/mediaProxy").processImportedMedia;
  ensureTranscript: typeof import("../tools/transcribe").ensureTranscript;
  clearSourceUrlCache: typeof import("../preview/resolve").clearSourceUrlCache;
}

interface Ready {
  runner: CommandRunner;
  mods: IndexModules;
}

/** A transient failure (a dropped model download, a busy disk) must not cost an asset its only
 *  chance at a transcript, because `seen` is permanent. Bounded, so a permanently bad file
 *  cannot make every subsequent sweep re-run the same doomed job. */
const MAX_ATTEMPTS = 3;

export class IndexCoordinator {
  private readonly proxyQ: string[] = [];
  private readonly txQ: string[] = [];
  private readonly seen = new Set<string>(); // `${pass}\0${source}` already enqueued
  private readonly attempts = new Map<string, number>();
  private readyOnce: Promise<Ready | null> | null = null;
  private proxyRunning = false;
  private txRunning = false;
  private disposed = false;
  // Aborts the in-flight derived job (ffmpeg/whisper) on dispose. dispose()
  // clears the QUEUES (no new job starts); this cancels the RUNNING process, so
  // no derived work outlives its project — not just the not-yet-started jobs.
  private readonly ac = new AbortController();

  constructor(
    private readonly store: ProjectStoreAccess,
    private readonly makeRunner: () => CommandRunner | Promise<CommandRunner>,
    /** Called after a new proxy lands, so the preview re-resolves onto it. */
    private readonly onProxyReady: () => void,
    /** Toggles the "processing…" overlay around a (slow) proxy transcode. */
    private readonly setImporting: (v: boolean) => void,
  ) {}

  /** Scan the timeline + library catalog and enqueue any not-yet-seen work. Cheap
   *  to call on every edit — the seen-set means only NEW media enqueues anything. */
  async sweep(timeline: Timeline | null): Promise<void> {
    if (this.disposed) return;
    // A clip's media_ref is a bare library id, which carries no extension — and both
    // passes are gated on one. Map ids to their catalog path FIRST so placed clips
    // still enqueue; without it every timeline clip silently fell through and no
    // preview proxy was ever built.
    let byId = new Map<string, string>();
    // Media still being generated has a catalog row and a path, but NO FILE. Indexing it would
    // fail both passes, and `seen` is permanent -- one premature sweep would cost that asset its
    // only chance at a proxy and a transcript. Skip until it lands; a later sweep picks it up.
    let pending = new Set<string>();
    let clips: Awaited<ReturnType<typeof this.store.listClips>> = [];
    try {
      clips = await this.store.listClips();
      byId = new Map(
        clips.map((c) => [String(c.id ?? ""), typeof c.path === "string" ? c.path : ""]),
      );
      pending = new Set(
        clips
          .filter((c) => c.status === "generating" || c.status === "failed")
          .map((c) => (typeof c.path === "string" ? c.path : "")),
      );
    } catch {
      /* no catalog yet — fall back to the ref as given */
    }
    if (this.disposed) return;
    for (const tr of timeline?.tracks ?? []) {
      for (const c of tr.clips ?? []) {
        if (c.kind === "text") continue;
        const ref = typeof c.media_ref === "string" ? c.media_ref : "";
        if (!ref) continue;
        // Enqueue the catalog PATH, not the ref: the library loop below enqueues the
        // same string, so the seen-set dedupes them into ONE transcription per asset.
        const p = byId.get(ref) || ref;
        if (pending.has(p)) continue;
        if (c.kind !== "audio" && needsProxy(p)) this.enqueue("proxy", p);
        if (isIndexable(p)) this.enqueue("transcript", p);
      }
    }
    // Library assets not yet placed on the timeline still get transcribed, so the
    // whole library is searchable — this is the single choke point every import
    // path (upload, drag-drop, agent import_media, download, generation) funnels through.
    for (const clip of clips) {
      const p = typeof clip.path === "string" ? clip.path : "";
      if (pending.has(p)) continue;
      // ...and a POSTER, or the library panel shows a blank tile. indexOne() enqueues this on
      // the import path, but that was the only door that did: an asset whose import predates
      // the poster pass, or whose queue never drained (agent import, generation, a restart),
      // had nothing left to give it one — `seen` is permanent and the loop above only covers
      // PLACED clips. The pass itself skips a poster that already exists.
      if (needsProxy(p)) this.enqueue("proxy", p);
      if (isIndexable(p)) this.enqueue("transcript", p);
    }
  }

  /** Index one specific just-imported source (e.g. a manual drop before it's on
   *  the timeline): proxy if it's previewable video, plus a transcript. */
  indexSource(source: string): void {
    const s = (source ?? "").trim();
    if (!s || this.disposed) return;
    if (needsProxy(s)) this.enqueue("proxy", s);
    if (isIndexable(s)) this.enqueue("transcript", s);
  }

  dispose(): void {
    this.disposed = true;
    this.proxyQ.length = 0;
    this.txQ.length = 0;
    this.ac.abort();
  }

  private enqueue(pass: Pass, source: string): void {
    const key = `${pass}\u0000${source}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (pass === "proxy") {
      this.proxyQ.push(source);
      if (!this.proxyRunning) void this.drainProxies();
      return;
    }
    this.txQ.push(source);
    if (!this.txRunning) void this.drainTranscripts();
  }

  /** A failed job is REPORTED, not swallowed, and retried a bounded number of times.
   *  Silence here is indistinguishable from footage with no speech — which is exactly how a
   *  broken transcriber stayed invisible until a user's first caption request timed out. */
  private onJobFailed(pass: Pass, source: string, err: unknown): void {
    if (this.disposed) return; // our own cancellation; nothing failed
    const key = `${pass}\u0000${source}`;
    const tried = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, tried);
    if (tried < MAX_ATTEMPTS) this.seen.delete(key); // a later sweep may try again
    reportAppError(`index ${pass} failed (attempt ${tried}): ${String(err).slice(-160)}`);
  }

  /** The runner + desktop-only modules a drain needs. Null on the web build (no runner),
   *  where indexing is a no-op.
   *
   *  Memoized for the life of the coordinator, not per drain: the two drains start together,
   *  and two concurrent dynamic imports of the same module never both resolve — the second
   *  pass simply never ran. */
  private ready(): Promise<Ready | null> {
    if (!this.readyOnce) {
      this.readyOnce = this.resolveModules();
      // A transient runner failure must not disable indexing for the life of the project.
      void this.readyOnce.then((r) => {
        if (!r) this.readyOnce = null;
      });
    }
    return this.readyOnce;
  }

  private async resolveModules(): Promise<Ready | null> {
    try {
      const runner = await this.makeRunner();
      // Dynamic so the desktop-only transcode and whisper code stays out of the main bundle.
      const [proxy, transcribe, resolve] = await Promise.all([
        import("../preview/mediaProxy"),
        import("../tools/transcribe"),
        import("../preview/resolve"),
      ]);
      return {
        runner,
        mods: {
          processImportedMedia: proxy.processImportedMedia,
          ensureTranscript: transcribe.ensureTranscript,
          clearSourceUrlCache: resolve.clearSourceUrlCache,
        },
      };
    } catch {
      return null;
    }
  }

  private async runProxy(
    source: string,
    runner: CommandRunner,
    mods: IndexModules,
    markImporting: () => void,
  ): Promise<void> {
    const changed = await mods.processImportedMedia(
      this.store,
      runner,
      source,
      markImporting,
      this.ac.signal,
    );
    if (changed && !this.disposed) {
      mods.clearSourceUrlCache();
      this.onProxyReady();
    }
  }

  /** Two workers keep independent posters/proxies moving without unbounded ffmpeg fan-out. */
  private static readonly PROXY_WORKERS = 2;

  private async drainProxies(): Promise<void> {
    this.proxyRunning = true;
    const ready = await this.ready();
    if (!ready) {
      this.proxyRunning = false; // web build — no runner; indexing is desktop-only
      return;
    }
    let importingShown = false;
    const markImporting = (): void => {
      if (importingShown) return;
      importingShown = true;
      this.setImporting(true);
    };
    try {
      await Promise.all(
        Array.from({ length: IndexCoordinator.PROXY_WORKERS }, async () => {
          for (let src = this.proxyQ.shift(); src !== undefined && !this.disposed; ) {
            try {
              await this.runProxy(src, ready.runner, ready.mods, markImporting);
            } catch (e) {
              this.onJobFailed("proxy", src, e);
            }
            src = this.proxyQ.shift();
          }
        }),
      );
    } finally {
      if (importingShown) this.setImporting(false);
      this.proxyRunning = false;
    }
    // Work enqueued between the last queue read and `proxyRunning = false` saw a busy drain and
    // started none of its own, so it would sit until some later enqueue happened along.
    if (!this.disposed && this.proxyQ.length > 0) void this.drainProxies();
  }

  /** ONE at a time, and on its OWN drain rather than sharing the proxy pool.
   *
   *  whisper maps the whole ~465 MiB model per process, so two concurrent runs double that on a
   *  machine already running the editor. Separating the drains is what makes one worker safe:
   *  sharing the pool would have parked a poster behind a multi-minute transcription, and a
   *  preview the user is waiting on must never queue behind an index they did not ask for. */
  private async drainTranscripts(): Promise<void> {
    this.txRunning = true;
    const ready = await this.ready();
    if (!ready) {
      this.txRunning = false; // web build — no runner; indexing is desktop-only
      return;
    }
    const ctx = {
      store: this.store,
      runner: ready.runner,
      signal: this.ac.signal,
    } as ClientToolContext;
    try {
      for (let src = this.txQ.shift(); src !== undefined && !this.disposed; ) {
        try {
          await ready.mods.ensureTranscript(ctx, src);
        } catch (e) {
          this.onJobFailed("transcript", src, e);
        }
        src = this.txQ.shift();
      }
    } finally {
      this.txRunning = false;
    }
    if (!this.disposed && this.txQ.length > 0) void this.drainTranscripts();
  }
}
