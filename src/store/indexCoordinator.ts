// Per-project background indexer — other NLEs' SearchIndexCoordinator, scoped to
// our needs. Observes the project's media (timeline clips AND the library
// catalog) and, on open / import / edit, runs disk-cached, best-effort passes:
//   • proxy      — poster + H.264 preview proxy for timeline VIDEO clips whose
//                  codec the in-app WebCodecs preview can't decode (HEVC/ProRes),
//                  so the live preview never goes blank waiting on a transcode;
//                  for stills, a stand-in the WebView can draw and, for an animated
//                  one, the frames the preview animates it with;
//   • transcript — on-device word-level transcript per audio/video asset, warming
//                  get_transcript (and future search) so the first read is instant;
//   • loudness   — each audio/video asset measured whole (owner decision 2026-10-04), so a look
//                  at a long file finds its loudness kept, plus the long spans looks ask for.
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
import type { Loudness } from "../tools/loudness";
import type { ProjectStoreAccess } from "../tools/store";
import { registerBackgroundTranscriber, type BackgroundLoudness } from "../tools/transcriptQueue";
import type { Timeline } from "../timeline/model";
import { kindOf } from "../media/formats";
import { reportAppError } from "../api/appEvents";

// Media imported BY REFERENCE lives wherever the user keeps it, so neither pass may require
// a path inside the project. Requiring `library/` here is why an externally-referenced clip
// got no preview proxy AND no transcript: both silently matched nothing.
// EVERY image: one the WebView cannot decode needs a stand-in, and any of them may be an animated
// still whatever it is called (a GIF saved as .png), which the preview animates from its frames.
const needsProxy = (p: string): boolean => kindOf(p) === "video" || kindOf(p) === "image";
const isIndexable = (p: string): boolean => {
  const k = kindOf(p);
  return k === "video" || k === "audio";
};

type Pass = "proxy" | "transcript" | "loudness";

/** One transcription: a source, and the language asked for ("" = the default). */
interface TxJob {
  source: string;
  language: string;
}
/** A transcript job's identity. A language other than the default is its own job: a Spanish
 *  transcript is not the default one. */
const txKey = (j: TxJob): string =>
  j.language ? `transcript\u0000${j.source}\u0000${j.language}` : `transcript\u0000${j.source}`;

/** One loudness measurement: a source over [start, end) seconds, the whole file when both are null. */
interface LoudJob {
  source: string;
  start: number | null;
  end: number | null;
}
/** A loudness job's identity. The whole file's is the pass's plain key, the one the sweep uses. */
const loudKey = (j: LoudJob): string =>
  j.start === null && j.end === null
    ? `loudness\u0000${j.source}`
    : `loudness\u0000${j.source}\u0000${j.start ?? 0}-${j.end ?? "end"}`;

type Measured = Loudness | { error: string };

/** The desktop-only modules a drain needs, resolved once rather than per job. */
interface IndexModules {
  processImportedMedia: typeof import("../preview/mediaProxy").processImportedMedia;
  ensureTranscript: typeof import("../tools/transcribe").ensureTranscript;
  isSpeechEngineUnavailable: typeof import("../tools/transcribe").isSpeechEngineUnavailable;
  measureLoudness: typeof import("../tools/loudness").measureLoudness;
  sourceHasAudio: typeof import("../timeline/placement").sourceHasAudio;
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

/** How many times a machine may fail to START the speech engine before we stop asking it to.
 *  The failure is a property of the MACHINE, not the file, so per-asset retries just repeat it:
 *  one user's box was missing a runtime and produced 56 identical errors in 100 minutes. */
const MAX_ENGINE_ATTEMPTS = 3;

export class IndexCoordinator {
  private readonly proxyQ: string[] = [];
  private readonly txQ: TxJob[] = [];
  /** The transcript job running now, by {@link txKey}. */
  private txCurrent: string | null = null;
  private readonly loudQ: LoudJob[] = [];
  /** The loudness job running now, by {@link loudKey}. */
  private loudCurrent: string | null = null;
  /** The measurement a look is waiting on, by {@link loudKey}, until it has run. */
  private readonly looks = new Map<
    string,
    { result: Promise<Measured>; settle: (m: Measured) => void }
  >();
  private readonly seen = new Set<string>(); // `${pass}\0${source}` already enqueued
  private readonly attempts = new Map<string, number>();
  private engineAttempts = 0;
  private engineDown = false;
  private readyOnce: Promise<Ready | null> | null = null;
  private proxyRunning = false;
  private txRunning = false;
  private loudRunning = false;
  private disposed = false;
  // Aborts the in-flight derived job (ffmpeg/whisper) on dispose. dispose()
  // clears the QUEUES (no new job starts); this cancels the RUNNING process, so
  // no derived work outlives its project — not just the not-yet-started jobs.
  private readonly ac = new AbortController();
  private readonly unregister: () => void;

  constructor(
    private readonly store: ProjectStoreAccess,
    private readonly makeRunner: () => CommandRunner | Promise<CommandRunner>,
    /** Called after a new proxy lands, so the preview re-resolves onto it. */
    private readonly onProxyReady: () => void,
    /** Toggles the "processing…" overlay around a (slow) proxy transcode. */
    private readonly setImporting: (v: boolean) => void,
  ) {
    // The tools (inspect_media) reach this project's queue by its directory.
    this.unregister = registerBackgroundTranscriber(store.projectDir, {
      prioritize: (source, language) => this.prioritizeTranscript(source, language),
      loudness: (source, start, end) => this.measureSoon(source, start, end),
    });
  }

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
        if (isIndexable(p)) {
          this.enqueue("transcript", p);
          this.enqueue("loudness", p);
        }
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
      if (isIndexable(p)) {
        this.enqueue("transcript", p);
        this.enqueue("loudness", p);
      }
    }
  }

  /** Index one specific just-imported source (e.g. a manual drop before it's on
   *  the timeline): proxy if it's previewable video, plus a transcript and its loudness. */
  indexSource(source: string): void {
    const s = (source ?? "").trim();
    if (!s || this.disposed) return;
    if (needsProxy(s)) this.enqueue("proxy", s);
    if (isIndexable(s)) {
      this.enqueue("transcript", s);
      this.enqueue("loudness", s);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.proxyQ.length = 0;
    this.txQ.length = 0;
    this.loudQ.length = 0;
    this.settleLooks({ error: "the project was closed before its loudness was measured" });
    this.unregister();
    this.ac.abort();
  }

  /** Transcribe `source` (in `language`, "" = the default) NEXT: a look asked for it and is not
   *  waiting, so it goes to the front of the one-at-a-time queue, even if the sweep transcribed it
   *  once already (its cache may have been swept). False when nothing will transcribe it. */
  prioritizeTranscript(source: string, language: string): boolean {
    if (this.disposed || this.engineDown) return false;
    const job: TxJob = { source, language };
    const key = txKey(job);
    if (this.txCurrent === key) return true;
    const at = this.txQ.findIndex((j) => txKey(j) === key);
    if (at >= 0) this.txQ.splice(at, 1);
    this.seen.add(key);
    this.txQ.unshift(job);
    if (!this.txRunning) void this.drainTranscripts();
    return true;
  }

  /** Measure `source` over [start, end) NEXT, for a look that does not wait for it. A look that
   *  asks again before it has run is handed the same measurement, to wait on. */
  measureSoon(source: string, start: number | null, end: number | null): BackgroundLoudness | null {
    if (this.disposed) return null;
    const job: LoudJob = { source, start, end };
    const key = loudKey(job);
    const waiting = this.looks.get(key);
    if (waiting) return { first: false, result: waiting.result };
    let settle!: (m: Measured) => void;
    const result = new Promise<Measured>((r) => (settle = r));
    this.looks.set(key, { result, settle });
    if (this.loudCurrent !== key) {
      const at = this.loudQ.findIndex((j) => loudKey(j) === key);
      if (at >= 0) this.loudQ.splice(at, 1);
      this.seen.add(key);
      this.loudQ.unshift(job);
      if (!this.loudRunning) void this.drainLoudness();
    }
    return { first: true, result };
  }

  private settleLooks(m: Measured): void {
    for (const look of this.looks.values()) look.settle(m);
    this.looks.clear();
  }

  private enqueue(pass: Pass, source: string): void {
    const key = `${pass}\u0000${source}`;
    if (this.seen.has(key)) return;
    if (pass === "transcript" && this.engineDown) return; // this machine cannot transcribe
    this.seen.add(key);
    if (pass === "proxy") {
      this.proxyQ.push(source);
      if (!this.proxyRunning) void this.drainProxies();
      return;
    }
    if (pass === "loudness") {
      this.loudQ.push({ source, start: null, end: null });
      if (!this.loudRunning) void this.drainLoudness();
      return;
    }
    this.txQ.push({ source, language: "" });
    if (!this.txRunning) void this.drainTranscripts();
  }
  /** A failed job is REPORTED, not swallowed, and retried a bounded number of times.
   *  Silence here is indistinguishable from footage with no speech — which is exactly how a
   *  broken transcriber stayed invisible until a user's first caption request timed out. */
  private onJobFailed(pass: Pass, key: string, err: unknown): void {
    if (this.disposed) return; // our own cancellation; nothing failed
    const tried = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, tried);
    if (tried < MAX_ATTEMPTS) this.seen.delete(key); // a later sweep may try again
    reportAppError(`index ${pass} failed (attempt ${tried}): ${String(err).slice(-160)}`);
  }

  /** A linked file the user moved or deleted is OFFLINE, not failing (UJ-014): the library panel
   *  shows it with Relink, so nothing is attempted, reported or counted against it. Released to the
   *  next sweep, so Relink (which announces itself and re-sweeps) or a drive coming back picks it up. */
  private async parkedOffline(key: string, source: string): Promise<boolean> {
    if (!(await this.store.offlineMedia(source).catch(() => null))) return false;
    this.seen.delete(key);
    return true;
  }

  /** The runner + desktop-only modules a drain needs. Null on the web build (no runner),
   *  where indexing is a no-op.
   *
   *  Memoized for the life of the coordinator, not per drain: the drains start together,
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
      const [proxy, transcribe, loudness, placement, resolve] = await Promise.all([
        import("../preview/mediaProxy"),
        import("../tools/transcribe"),
        import("../tools/loudness"),
        import("../timeline/placement"),
        import("../preview/resolve"),
      ]);
      return {
        runner,
        mods: {
          processImportedMedia: proxy.processImportedMedia,
          ensureTranscript: transcribe.ensureTranscript,
          isSpeechEngineUnavailable: transcribe.isSpeechEngineUnavailable,
          measureLoudness: loudness.measureLoudness,
          sourceHasAudio: placement.sourceHasAudio,
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
          for (let src = this.proxyQ.shift(); src !== undefined && !this.disposed;) {
            try {
              if (!(await this.parkedOffline(`proxy\u0000${src}`, src)))
                await this.runProxy(src, ready.runner, ready.mods, markImporting);
            } catch (e) {
              this.onJobFailed("proxy", `proxy\u0000${src}`, e);
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
      for (let job = this.txQ.shift(); job !== undefined && !this.disposed && !this.engineDown;) {
        this.txCurrent = txKey(job);
        try {
          // A video with no audio track is not a failure to report — there is simply nothing to
          // transcribe. Asking ffmpeg for an audio-only output of one fails with "Output file
          // does not contain any stream", which read as a broken transcriber.
          if (
            !(await this.parkedOffline(txKey(job), job.source)) &&
            (await this.hasAudio(ctx, ready.mods, job.source))
          ) {
            await ready.mods.ensureTranscript(
              ctx,
              job.source,
              undefined,
              job.language || undefined,
            );
          }
        } catch (e) {
          if (ready.mods.isSpeechEngineUnavailable(e)) this.onEngineUnavailable(e);
          // Gone between the check and the run: the same fact, found later.
          else if (!(await this.parkedOffline(txKey(job), job.source)))
            this.onJobFailed("transcript", txKey(job), e);
        }
        this.txCurrent = null;
        job = this.txQ.shift();
      }
    } finally {
      this.txCurrent = null;
      this.txRunning = false;
    }
    if (!this.disposed && !this.engineDown && this.txQ.length > 0) void this.drainTranscripts();
  }

  /** ONE at a time, on its own drain: a whole file's decode, which a poster must not queue behind,
   *  nor a look's span behind a multi-minute transcription. */
  private async drainLoudness(): Promise<void> {
    this.loudRunning = true;
    const ready = await this.ready();
    if (!ready) {
      this.loudRunning = false; // web build — no runner; indexing is desktop-only
      this.settleLooks({ error: "loudness cannot be measured here" });
      return;
    }
    const ctx = {
      store: this.store,
      runner: ready.runner,
      signal: this.ac.signal,
    } as ClientToolContext;
    try {
      for (let job = this.loudQ.shift(); job !== undefined && !this.disposed;) {
        const key = loudKey(job);
        this.loudCurrent = key;
        const got = await this.measure(ctx, ready.mods, job, key);
        this.loudCurrent = null;
        const look = this.looks.get(key);
        if (look) {
          this.looks.delete(key);
          look.settle(got);
        }
        job = this.loudQ.shift();
      }
    } finally {
      this.loudCurrent = null;
      this.loudRunning = false;
    }
    if (!this.disposed && this.loudQ.length > 0) void this.drainLoudness();
  }

  /** One job's figures, or why there are none. Only a measurement that FAILED is a failure: an
   *  offline file is parked, and a file with no sound has nothing to measure. */
  private async measure(
    ctx: ClientToolContext,
    mods: IndexModules,
    job: LoudJob,
    key: string,
  ): Promise<Measured> {
    try {
      if (await this.parkedOffline(key, job.source)) return { error: "the file is offline" };
      if (!(await this.hasAudio(ctx, mods, job.source))) return { error: "the file has no sound" };
      const abs = (await this.store.resolveRef(job.source)) ?? job.source;
      const got = await mods.measureLoudness(ctx, abs, job.start, job.end);
      if ("error" in got) this.onJobFailed("loudness", key, got.error);
      return got;
    } catch (e) {
      this.onJobFailed("loudness", key, e);
      return { error: `loudness could not be measured: ${String(e)}` };
    }
  }

  /** Is there any sound here? A probe that cannot answer says yes: losing a transcript or a
   *  measurement to an ffprobe hiccup is worse than one clear failure downstream. */
  private async hasAudio(
    ctx: ClientToolContext,
    mods: IndexModules,
    source: string,
  ): Promise<boolean> {
    try {
      const abs = await this.store.resolveRef(source);
      if (!abs) return true; // let ensureTranscript report the missing file
      return await mods.sourceHasAudio(ctx, abs);
    } catch {
      return true;
    }
  }

  /** The engine could not START. That is the machine's state, not this asset's, so retrying the
   *  next file repeats it exactly — stop the pass and say so ONCE instead of once per asset. */
  private onEngineUnavailable(err: unknown): void {
    if (this.disposed || this.engineDown) return;
    this.engineAttempts += 1;
    if (this.engineAttempts < MAX_ENGINE_ATTEMPTS) return;
    this.engineDown = true;
    this.txQ.length = 0;
    reportAppError(`speech engine unavailable, transcription disabled: ${String(err).slice(-160)}`);
  }
}
