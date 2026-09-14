// Per-project tool HOST for the client-owned agent loop: builds the client tool
// registry + context from the co-located project dir, WITHOUT any WS bridge. The
// loop runs every tool locally through a host BOUND to one project — there is no
// global "current project", so a turn started on project A can only ever act on A,
// even if the user navigates to B mid-turn (fixes the stale-runner class, F2).
import { ensureTimeline } from "../timeline/engine";
import { createToolRegistry } from ".";
import type { ClientToolContext } from "./context";
import type { ClientToolRegistry } from "./registry";
import type { ProjectStoreAccess } from "./store";
import { ProjectClosingError, type MutationOrigin } from "../project/MutationGate";
import { openDocumentById } from "../project/openDocuments";
import { isJobEffect, toolEffect } from "../contract/effects";
import { warmWhisperModel } from "./transcribe";

/** A tool runtime bound to ONE project. The agent runner captures the host for
 *  its project at turn start and routes every tool run + media read through it,
 *  so tool side-effects always land on that project regardless of what's active. */
export interface ToolHost {
  readonly projectId: string;
  /** Resolves once the tool context (fs + registry) is built. */
  readonly ready: Promise<void>;
  /** Is `name` a runnable client tool? */
  has(name: string): boolean;
  /** Run a tool locally (awaits the context). `signal` propagates Stop into the
   *  tool's command runner + /ai proxy calls. `origin` (agent commits) lets the mutation gate reject
   *  a commit from a superseded chat execution. */
  run(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    origin?: MutationOrigin,
  ): Promise<unknown>;
  /** The project's store (server-tool media byte I/O), or null until ready. */
  store(): ProjectStoreAccess | null;
}

async function buildContext(
  projectId: string,
  holder: { ctx: ClientToolContext | null },
): Promise<void> {
  // Lazy-import the Tauri fs + path so tests / web never load the plugins.
  const [{ projectDirFor }, tauri] = await Promise.all([import("./dataRoot"), import("./tauri")]);
  const dir = await projectDirFor(projectId);
  const c = await tauri.makeTauriContext(dir);
  holder.ctx = c;
  // Warm the transcription model + seed an (empty) timeline, best-effort.
  void warmWhisperModel(c).catch(() => undefined);
  try {
    await ensureTimeline(c.store);
  } catch {
    /* best-effort seed */
  }
}

class ProjectToolHost implements ToolHost {
  readonly ready: Promise<void>;
  private readonly holder: { ctx: ClientToolContext | null } = { ctx: null };
  private readonly registry: ClientToolRegistry;
  // The current turn's Stop signal, set for the duration of one run() call.
  private currentSignal: AbortSignal | undefined;
  // The current turn's agent origin (chat execution), set for the duration of one run() call.
  private currentOrigin: MutationOrigin | undefined;
  constructor(readonly projectId: string) {
    this.registry = createToolRegistry(() => this.viewCtx());
    this.ready = buildContext(projectId, this.holder);
  }
  // The context tools see: the base ctx plus the turn's abort signal and a runner
  // that injects it (so a running sidecar is killed on Stop) — without mutating
  // the shared base ctx or touching any tool call site.
  private viewCtx(): ClientToolContext | null {
    const base = this.holder.ctx;
    const sig = this.currentSignal;
    if (!base || !sig) return base;
    return {
      ...base,
      signal: sig,
      origin: this.currentOrigin,
      // Forward EVERY argument but the signal, which this wrapper exists to inject. Dropping the
      // trailing ones silently disabled the export progress stream: the render worked, the bar
      // never moved, and nothing failed.
      runner: { run: (p, a, _s, cwd, onStdout) => base.runner.run(p, a, sig, cwd, onStdout) },
    };
  }
  has(name: string): boolean {
    return this.registry.has(name);
  }
  async run(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    origin?: MutationOrigin,
  ): Promise<unknown> {
    await this.ready;
    this.currentOrigin = origin;
    try {
      // Effect classification (single source of truth) decides the mandatory runtime boundary. A
      // long-running project/derived JOB runs UNDER the document's ProjectJobScope so close() cancels
      // + drains it deterministically (finding #2) — not just via the turn signal. The scope is
      // resolved PER RUN (cancelClose swaps in a fresh one), and its close-abort is combined with the
      // turn's Stop so the tool reacts to EITHER. Reads / mutations / app-ops / deliverables run direct.
      const effect = toolEffect(name);
      const jobs =
        effect && isJobEffect(effect) ? openDocumentById(this.projectId)?.jobs : undefined;
      if (jobs) {
        return await jobs.run({ kind: `tool.${name}` }, (jobSignal) =>
          this.runTool(name, args, combineSignals(signal, jobSignal)),
        );
      }
      return await this.runTool(name, args, signal);
    } catch (e) {
      // The job scope refused admission because the project began closing — report a clean tool
      // failure rather than reject the turn (the registry path already returns { ok:false } too).
      if (e instanceof ProjectClosingError)
        return { ok: false, error: `${name}: not run — the project is closing` };
      throw e;
    } finally {
      this.currentOrigin = undefined;
    }
  }

  /** Run the tool with `signal` as the current turn/job cancellation, threaded into the tool ctx. */
  private async runTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.currentSignal = signal;
    try {
      return await this.registry.run(name, args);
    } finally {
      this.currentSignal = undefined;
    }
  }
  store(): ProjectStoreAccess | null {
    return this.holder.ctx?.store ?? null;
  }
}

/** A signal that aborts when EITHER the turn's Stop (`turn`) OR the job scope's close (`job`) fires,
 *  so a job-effect tool's context reacts to both. `AbortSignal.any` cleans up its own listeners. */
function combineSignals(turn: AbortSignal | undefined, job: AbortSignal): AbortSignal {
  return turn ? AbortSignal.any([turn, job]) : job;
}

// Per-project cache so the Shell warm-up and the chat runner share ONE built
// context per project (re-opening the same project reuses it). This is a keyed
// lookup, NOT a mutable "current" pointer: each caller asks by an explicit
// projectId and each runner holds the specific host it captured — so a stale turn
// can never be retargeted onto a different project.
const hosts = new Map<string, ToolHost>();

/** Open (or reuse) the tool host BOUND to `projectId`. */
export function openToolHost(projectId: string): ToolHost {
  let h = hosts.get(projectId);
  if (!h) {
    const created = new ProjectToolHost(projectId);
    hosts.set(projectId, created);
    // If warm-up FAILS, evict the broken host so the NEXT open() rebuilds it
    // instead of handing back a permanently-rejected `ready` (which would leave
    // this project's chat dead until reload) -- RF8. Guard on identity so a newer
    // rebuild is never clobbered.
    void created.ready.catch(() => {
      if (hosts.get(projectId) === created) hosts.delete(projectId);
    });
    h = created;
  }
  return h;
}

/** Evict cached tool hosts. With a `projectId`, drop just that project's host (on close, so
 *  it doesn't accumulate in the global cache until app reload); with none, drop all (e.g. on
 *  sign-out). A reopened project lazily rebuilds its host via openToolHost. */
export function closeToolHost(projectId?: string): void {
  if (projectId === undefined) hosts.clear();
  else hosts.delete(projectId);
}
