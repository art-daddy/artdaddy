// Per-project background indexer — other NLEs' SearchIndexCoordinator, scoped to
// our needs. Observes the project's media (timeline clips AND the library
// catalog) and, on open / import / edit, runs a SERIAL, disk-cached, best-effort
// sweep of two passes:
//   • proxy      — poster + H.264 preview proxy for timeline VIDEO clips whose
//                  codec the in-app WebCodecs preview can't decode (HEVC/ProRes),
//                  so the live preview never goes blank waiting on a transcode;
//   • transcript — on-device word-level transcript per audio/video asset, warming
//                  get_transcript (and future search) so the first read is instant.
// Proxies are drained BEFORE transcripts (preview latency beats background index).
// Desktop-only: no runner (web build) => no-op. Lifecycle-scoped: dispose() on
// project switch cancels pending work so it never leaks across projects.
import type { CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import type { ProjectStoreAccess } from "../tools/store";
import type { Timeline } from "../timeline/model";
import { kindOf, needsPreviewProxy } from "../media/formats";

// Media imported BY REFERENCE lives wherever the user keeps it, so neither pass may require
// a path inside the project. Requiring `library/` here is why an externally-referenced clip
// got no preview proxy AND no transcript: both silently matched nothing.
const needsProxy = (p: string): boolean =>
  kindOf(p) === "video" || (kindOf(p) === "image" && needsPreviewProxy(p));
const isIndexable = (p: string): boolean => {
  const k = kindOf(p);
  return k === "video" || k === "audio";
};

/** The desktop-only modules a drain needs, resolved once per drain rather than per job. */
interface IndexModules {
  processImportedMedia: typeof import("../preview/mediaProxy").processImportedMedia;
  ensureTranscript: typeof import("../tools/transcribe").ensureTranscript;
  clearSourceUrlCache: typeof import("../preview/resolve").clearSourceUrlCache;
}

export class IndexCoordinator {
  private readonly proxyQ: string[] = [];
  private readonly txQ: string[] = [];
  private readonly seen = new Set<string>(); // `${pass}\0${source}` already enqueued
  private running = false;
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

  private enqueue(pass: "proxy" | "transcript", source: string): void {
    const key = `${pass}\u0000${source}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    (pass === "proxy" ? this.proxyQ : this.txQ).push(source);
    if (!this.running) void this.drain();
  }

  private next(): { pass: "proxy" | "transcript"; source: string } | undefined {
    const p = this.proxyQ.shift();
    if (p !== undefined) return { pass: "proxy", source: p };
    const t = this.txQ.shift();
    if (t !== undefined) return { pass: "transcript", source: t };
    return undefined;
  }

  private async runJob(
    job: { pass: "proxy" | "transcript"; source: string },
    runner: CommandRunner,
    mods: IndexModules,
    markImporting: () => void,
  ): Promise<void> {
    if (job.pass === "proxy") {
      const changed = await mods.processImportedMedia(
        this.store,
        runner,
        job.source,
        markImporting,
        this.ac.signal,
      );
      if (changed && !this.disposed) {
        mods.clearSourceUrlCache();
        this.onProxyReady();
      }
      return;
    }
    await mods.ensureTranscript(
      { store: this.store, runner, signal: this.ac.signal } as ClientToolContext,
      job.source,
    );
  }

  /** Concurrent workers over the queues. Transcribing a long file is minutes of CPU, and a
   *  timeline typically has several distinct sources — draining them one after another made
   *  the last asset wait for every earlier one. Two, not more: whisper already takes several
   *  threads each, so a wider pool just oversubscribes the machine it is running on. */
  private static readonly WORKERS = 2;

  private async drain(): Promise<void> {
    this.running = true;
    let runner: CommandRunner;
    let mods: IndexModules;
    try {
      runner = await this.makeRunner();
      // Resolved ONCE, before the pool. These stay dynamic so the desktop-only transcode and
      // whisper code keeps out of the main bundle, but importing them per JOB repeated that
      // resolution for every asset.
      const [proxy, transcribe, resolve] = await Promise.all([
        import("../preview/mediaProxy"),
        import("../tools/transcribe"),
        import("../preview/resolve"),
      ]);
      mods = {
        processImportedMedia: proxy.processImportedMedia,
        ensureTranscript: transcribe.ensureTranscript,
        clearSourceUrlCache: resolve.clearSourceUrlCache,
      };
    } catch {
      this.running = false; // web build — no runner; indexing is desktop-only
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
        Array.from({ length: IndexCoordinator.WORKERS }, async () => {
          for (let job = this.next(); job && !this.disposed; job = this.next()) {
            try {
              await this.runJob(job, runner, mods, markImporting);
            } catch {
              /* best-effort; skip a bad asset */
            }
          }
        }),
      );
    } finally {
      if (importingShown) this.setImporting(false);
      this.running = false;
    }
    // Work enqueued between the last `next()` and `running = false` saw a busy drain and
    // started none of its own, so it would sit until some later enqueue happened along.
    if (!this.disposed && (this.proxyQ.length > 0 || this.txQ.length > 0)) void this.drain();
  }
}
