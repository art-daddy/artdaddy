import { getIdentifier } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { mkdir, exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { dataRoot } from "../../src/tools/dataRoot";
import { EXPORT_PROTOCOL_VERSION, jobSupervisor, whenJobEnds } from "../../src/tools/jobSupervisor";
import { joinPath } from "../../src/tools/store";
import { ProjectStoreAccess } from "../../src/tools/store";
import { TauriCommandRunner, TauriFs } from "../../src/tools/tauri";
import { emptyTimeline } from "../../src/timeline/model";
import { buildRenderCommand, queueRenderJob } from "../../src/timeline/render";
import { listExportRecords, whenExportEnds, whenExportsSettle } from "../../src/timeline/exportQueue";
import { ensureTimeline } from "../../src/timeline/engine";

const params = new URLSearchParams(location.search);
const root = params.get("root") ?? "";
const identifier = params.get("identifier") ?? "";
const reportPath = joinPath(root, "native-report.json");
const armedPath = joinPath(root, "native-armed.json");
const status = document.getElementById("status")!;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function exercise(): Promise<void> {
  check(root.includes("artdaddy-export-native-"), "Not an isolated exporter directory");
  check(await getIdentifier() === identifier && identifier.startsWith("com.artdaddy.qa.exporter-"), "Wrong native app identity");
  check((await dataRoot()).replace(/\\/g, "/") === root.replace(/\\/g, "/"), "Native project root is not isolated");
  const supervisor = await jobSupervisor();
  check(supervisor?.delivery, "Missing required native delivery owner");
  check(await supervisor.delivery.protocol() === EXPORT_PROTOCOL_VERSION, "Native protocol mismatch");
  if (!(await exists(armedPath))) {
    const id = "native_capture_recovery";
    const stage = joinPath(root, ".delivered.nut.partial");
    const destination = joinPath(root, "delivered.nut");
    const source = joinPath(root, "source.nut");
    const queuedCopy = { id: "native_queued_copy", destination: joinPath(root, "queued-copy.nut") };
    await supervisor.delivery.prepare(queuedCopy.id, joinPath(root, "project"), joinPath(root, ".queued-copy.nut.partial"), queuedCopy.destination,
      { kind: "copy", path: source, media_ref: "media_native_qa_source" });
    check((await supervisor.list()).find((job) => job.id === queuedCopy.id)?.state === "queued", "Native admission lost queued copy");
    const unbound = { id: "native_unbound_failure", destination: joinPath(root, "unbound.nut") };
    await writeTextFile(unbound.destination, "previous complete output");
    await supervisor.delivery.prepare(unbound.id, joinPath(root, "project"), joinPath(root, ".unbound.nut.partial"), unbound.destination,
      { kind: "render", paths: [source] });
    await supervisor.delivery.prepare(id, joinPath(root, "project"), stage, destination, { kind: "render", paths: [source] });
    const cwd = await supervisor.delivery.stageScratch(id, [], []);
    await supervisor.submit({ id, lane: "export", program: "ffmpeg", cwd,
      args: ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-readrate", "0.1", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le",
        "-progress", "pipe:1", "-f", "nut", "captured.nut"],
      steps: [["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "captured.nut",
        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-progress", "pipe:1", "-f", "nut", stage]],
      meta: { kind: "export", qa: "native_capture_recovery", projectDir: joinPath(root, "project"), stagePath: stage, destPath: destination },
    });
    const progress = await new Promise<string>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("No native render progress before crash")); }, 60_000);
      const accept = (text: string) => {
        if (/(?:^|\n)frame=\s*[1-9]\d*/.test(text)) { clearTimeout(timeout); unsubscribe(); resolve(text); }
      };
      unsubscribe = supervisor.subscribe(() => {}, (jobId, chunk) => { if (jobId === id) accept(chunk); });
      void supervisor.list().then((jobs) => accept(jobs.find((entry) => entry.id === id)?.stdout_tail ?? ""), reject);
    });
    const job = (await supervisor.list()).find((entry) => entry.id === id);
    check(job?.state === "running", `Crash target is not running: ${JSON.stringify(job)}`);
    await writeTextFile(armedPath, JSON.stringify({ id, cwd, source, stage, destination, queuedCopy, unbound, identifier, progress, protocol: EXPORT_PROTOCOL_VERSION }));
    status.textContent = "Native job armed";
    return;
  }
  const armed = JSON.parse(await readTextFile(armedPath)) as { id: string; cwd: string; destination: string; source: string;
    queuedCopy: { id: string; destination: string }; unbound: { id: string; destination: string } };
  const ended = await whenJobEnds(supervisor, armed.id);
  check(ended?.state === "exited" && ended.code === 0 && !ended.killed, `Recovered worker failed: ${JSON.stringify(ended)}`);
  const verified = await supervisor.delivery.verify(armed.id);
  const published = await supervisor.delivery.publish(armed.id);
  check(verified.identity?.sha256 === published.identity?.sha256 && published.state === "published", "Publication identity mismatch");
  const receipt = (await invoke<Array<{ id: string; producer_complete: boolean; recovery_attempts: number;
    worker_identity: { sha256: string; size: number }; command_sha256: string }>>("jobs_export_intents")).find((entry) => entry.id === armed.id);
  check(receipt?.producer_complete && receipt.recovery_attempts === 1, "Missing native recovery/producer receipt");
  const queuedCopy = (await supervisor.list()).find((job) => job.id === armed.queuedCopy.id);
  check(queuedCopy?.state === "exited" && queuedCopy.code === 0 && queuedCopy.meta.copyOf === "media_native_qa_source", "Queued native copy did not recover");
  const recoveredCopy = await supervisor.delivery.publish(armed.queuedCopy.id);
  const liveCopy = { id: "native_live_joined_copy", destination: joinPath(root, "joined-copy.nut") };
  await supervisor.delivery.prepare(liveCopy.id, joinPath(root, "project"), joinPath(root, ".joined-copy.nut.partial"), liveCopy.destination,
    { kind: "copy", path: armed.source, media_ref: "media_native_qa_source" });
  await Promise.all([supervisor.delivery.copy(liveCopy.id), supervisor.delivery.copy(liveCopy.id)]);
  check((await supervisor.list()).find((job) => job.id === liveCopy.id)?.code === 0, "Joined native copy did not settle");
  await supervisor.delivery.verify(liveCopy.id);
  const joinedCopy = await supervisor.delivery.publish(liveCopy.id);
  const unbound = (await supervisor.list()).find((job) => job.id === armed.unbound.id);
  check(unbound?.state === "exited" && unbound.code !== 0 && unbound.meta.projectDir === joinPath(root, "project") &&
    !unbound.meta.plan && unbound.stderr_head.includes("before its render plan was retained"), "Native pre-binding failure was hidden or guessed");
  check(await readTextFile(armed.unbound.destination) === "previous complete output", "Unbound failure replaced prior output");
  await supervisor.delivery.fail(armed.unbound.id);
  for (const id of [armed.queuedCopy.id, liveCopy.id, armed.unbound.id]) {
    check(await supervisor.commit(id), "Native terminal outcome could not commit");
    check(await supervisor.delivery.complete(id), "Native follow-up acknowledgement missing");
    check(await supervisor.forget(id), "Acknowledged native job could not retire");
  }
  const projectDir = joinPath(root, "compiled-project");
  await mkdir(joinPath(projectDir, "internals"), { recursive: true });
  const store = new ProjectStoreAccess(projectDir, new TauriFs());
  const context = { store, runner: new TauriCommandRunner() };
  const timeline = emptyTimeline(320, 180, 30);
  timeline.tracks = [{ id: "video", kind: "video", z: 0, clips: Array.from({ length: 98 }, (_, index) => ({
    id: `compiled_${index}`, kind: "video", media_ref: armed.source, source_in: 0, source_out: 1,
    timeline_in: index, timeline_out: index + 1,
    transform: { position: { x: index % 2 ? 0.35 : 0.65, y: 0.5 }, scale: 0.6 },
  })) }, { id: "audio", kind: "audio", z: 0, clips: [{ id: "compiled_stereo", kind: "audio", media_ref: armed.source,
    source_in: 0, source_out: 30, timeline_in: 0, timeline_out: 98, loop: true }] }];
  timeline.tracks.push({ id: "native-caption", kind: "text", z: 2, clips: [{ id: "native-caption-clip", kind: "text", text: "Export test",
    timeline_in: 0, timeline_out: 98, transform: { position: { x: 0.5, y: 0.88 } },
    style: { font: "Poppins", fontsize: 18, color: "white" } }] });
  await ensureTimeline(store);
  const snapshot = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(timeline))));
  const admission = { version: 1 as const, projectDir, projectId: "isolated-compiled-project", documentSessionId: null,
    projectRevision: null, snapshotSha256: Array.from(snapshot, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  const encoderControl = buildRenderCommand(timeline, joinPath(root, ".encoder-control.partial"), { engine: "partition-pipes-v1" });
  const encoderThreads = encoderControl.args[encoderControl.args.lastIndexOf("-threads:v") + 1];
  check(/^\d+$/.test(encoderThreads), "Experimental fixture has no explicit encoder-thread policy");
  const compiled: Array<{ engine: string; delivered: string; jobId: string; partitions: number; selection: unknown; continuousAudio: boolean; encoderThreads: string }> = [];
  for (const engine of ["file-sequence-v1", "partition-pipes-v1", "auto"] as const) {
    const delivered = joinPath(root, `compiled-${engine}.mp4`);
    const stage = joinPath(root, `.compiled-${engine}.partial`);
    const plan = buildRenderCommand(timeline, stage, { engine });
    plan.args.splice(plan.args.lastIndexOf("-c:v") + 2, 0, "-threads:v", encoderThreads);
    if (engine !== "file-sequence-v1") {
      check((plan.steps?.length ?? 0) >= 2 && !!plan.audio, "Compiled fixture did not use partitions and a continuous audio producer");
      check(plan.selection?.backend === "partition-pipes-v1", "Planner chose the wrong backend for the high-input fixture");
    }
    const job = await queueRenderJob(context, { plan, admission, destPath: delivered, stagePath: stage,
      filename: `compiled-${engine}.mp4`, quality: "medium" });
    const outcome = await whenExportEnds(job.job_id);
    check(outcome?.state === "done", `Compiled ${engine} failed: ${JSON.stringify(outcome)}`);
    await whenExportsSettle();
    const probe = await store.probeMedia(delivered, 0);
    const asset = (await store.listClips()).find((row) => row.id === `media_${probe?.id12}`);
    const linkedPath = asset ? await store.resolveMediaRef(asset.id) : null;
    const linked = linkedPath ? await store.probeMedia(linkedPath, 0) : null;
    const ledger = await store.readJson<{ jobs: Array<{ id: string; status: string }> }>(
      joinPath(projectDir, "internals", "jobs.json"), { jobs: [] });
    const recorded = ledger.jobs.find((entry) => entry.id === job.job_id);
    const completed = listExportRecords().find((entry) => entry.job_id === job.job_id);
    const delivery = (await supervisor.delivery.list()).find((entry) => entry.id === job.job_id);
    check(asset?.external && linked?.sha256 === probe?.sha256 && linked?.size === probe?.size &&
      (asset.source as { kind?: string } | undefined)?.kind === "export" &&
      recorded?.status === "done" && completed?.mediaRef === asset.id && delivery?.state === "published" && delivery.followups_done &&
      delivery.identity?.sha256 === probe?.sha256 && delivery.identity?.size === probe?.size,
      `Compiled output was not registered through its published identity: ${JSON.stringify({ asset, linkedPath, recorded, completed, delivery, outcome })}`);
    compiled.push({ engine, delivered, jobId: job.job_id, partitions: plan.steps?.length ?? 0,
      selection: plan.selection, continuousAudio: !!plan.audio, encoderThreads });
  }
  let denseProfile: Record<string, unknown> | undefined;
  const profileSeconds = Number(params.get("profileSeconds") ?? 0);
  if (profileSeconds) {
    check([6, 15, 30, 60].includes(profileSeconds), "Invalid dense profile duration");
    const fps = 60;
    const fullFrames = 2 * 60 * 60 * fps;
    const from = 60 * 60 * fps;
    const to = from + profileSeconds * fps;
    const dense = emptyTimeline(3840, 2160, fps);
    const denseSourceRoot = params.get("denseSourceRoot") ?? root;
    for (let track = 0; track < 16; track++) {
      const count = 312 + (track < 8 ? 1 : 0);
      dense.tracks.push({ id: `dense-video-${track}`, kind: "video", z: track,
        clips: Array.from({ length: count }, (_, index) => {
          const start = Math.floor(index * fullFrames / count);
          const end = Math.floor((index + 1) * fullFrames / count);
          return { id: `dense-${track}-${index}`, kind: "video", media_ref: joinPath(denseSourceRoot, `dense-source-${track}.mp4`),
            source_in: 0, source_out: end - start, timeline_in: start, timeline_out: end, fit: "stretch",
            transform: { position: { x: ((track % 4) + 0.5) / 4, y: (Math.floor(track / 4) + 0.5) * 0.2 }, scale_x: 0.25, scale_y: 0.2 } };
        }) });
    }
    dense.tracks.push({ id: "dense-score", kind: "audio", z: 0, clips: [{ id: "dense-score-clip", kind: "audio", media_ref: armed.source,
      source_in: 0, source_out: 60, timeline_in: 0, timeline_out: fullFrames, loop: true, volume: 0.25, duck: { against: "dense-voice" } }] });
    dense.tracks.push({ id: "dense-voice", kind: "audio", z: 0, clips: [{ id: "dense-voice-clip", kind: "audio", media_ref: armed.source,
      source_in: 0, source_out: 60, timeline_in: from + fps, timeline_out: from + 4 * fps, loop: true }] });
    dense.tracks.push({ id: "dense-captions", kind: "text", z: 20,
      clips: Array.from({ length: Math.ceil(profileSeconds / 6) }, (_, index) => ({
        id: `dense-caption-${index}`, kind: "text", text: `ACTIVE EXPORT ${index + 1}`, timeline_in: from + index * 6 * fps,
        timeline_out: Math.min(to, from + (index * 6 + 5) * fps), transform: { position: { x: 0.5, y: 0.88 } },
        animation: { entrance: "fade", exit: "fade", entrance_ms: 500, exit_ms: 200 },
        style: { font: "Poppins", fontsize: 96, color: "white" },
      })) });
    const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(dense))));
    const captured = { ...admission, snapshotSha256: Array.from(fingerprint, (byte) => byte.toString(16).padStart(2, "0")).join("") };
    const delivered = joinPath(root, `dense-profile-${profileSeconds}.mp4`);
    const stage = joinPath(root, `.dense-profile-${profileSeconds}.partial`);
    const started = performance.now();
    const plan = buildRenderCommand(dense, stage, { engine: "partition-pipes-v1", quality: "medium", range: { from, to } });
    const planningMs = performance.now() - started;
    await writeTextFile(joinPath(root, "dense-fixture.json"), JSON.stringify({ timeline: dense, range: { from, to }, plan }));
    let observedId = "";
    let nativeDiagnostics: { state: string; step: number; stdout_tail: string; stderr_head: string; stderr_tail: string; stderr_elided: number } | undefined;
    let checkpoint: Promise<void> | undefined;
    let checkpointError: unknown;
    let checkpointAt = -Infinity;
    const detach = supervisor.subscribe((view) => {
      if (view.id !== observedId) return;
      nativeDiagnostics = { state: view.state, step: view.step, stdout_tail: view.stdout_tail,
        stderr_head: view.stderr_head, stderr_tail: view.stderr_tail, stderr_elided: view.stderr_elided };
      if (!checkpoint && performance.now() - checkpointAt >= 1000) {
        checkpointAt = performance.now();
        checkpoint = writeTextFile(joinPath(root, "dense-native-diagnostics.json"), JSON.stringify({ job_id: observedId, ...nativeDiagnostics }))
          .catch((error: unknown) => { checkpointError = error; })
          .finally(() => { checkpoint = undefined; });
      }
    });
    try {
      const queued = await queueRenderJob(context, { plan, admission: captured, destPath: delivered, stagePath: stage,
        filename: `dense-profile-${profileSeconds}.mp4`, quality: "medium" });
      observedId = queued.job_id;
      const outcome = await whenExportEnds(queued.job_id);
      await checkpoint;
      await writeTextFile(joinPath(root, "dense-native-diagnostics.json"), JSON.stringify({ job_id: queued.job_id, ...nativeDiagnostics }));
      check(!checkpointError, `Dense diagnostic checkpoint failed: ${String(checkpointError)}`);
      check(outcome?.state === "done", `Dense profile failed: ${JSON.stringify(outcome)}`);
      await whenExportsSettle();
      const elapsedMs = performance.now() - started;
      denseProfile = { delivered, jobId: queued.job_id, sourceTracks: 16, visualClipPlacements: 5000, projectFrames: fullFrames,
        sampledRange: [from, to], renderedSeconds: profileSeconds, planningMs, planningThroughAcknowledgementMs: elapsedMs,
        withinFourTimesOutput: elapsedMs <= profileSeconds * 4000, partitions: plan.steps?.length ?? 0,
        selection: plan.selection, continuousAudio: !!plan.audio, actualTwoHourRender: false };
    } finally { detach(); await checkpoint; }
  }
  await writeTextFile(reportPath, JSON.stringify({ ok: true, protocol: EXPORT_PROTOCOL_VERSION, launch: await supervisor.launchId(),
    delivered: armed.destination, captured: joinPath(armed.cwd, "captured.nut"), source: armed.source, identity: published.identity,
    producerComplete: receipt.producer_complete, recoveryAttempts: receipt.recovery_attempts,
    workerIdentity: receipt.worker_identity, commandSha256: receipt.command_sha256,
    copies: [{ kind: "queued-recovery", delivered: armed.queuedCopy.destination, identity: recoveredCopy.identity },
      { kind: "live-joined", delivered: liveCopy.destination, identity: joinedCopy.identity }],
    unbound: { id: armed.unbound.id, code: unbound.code, error: unbound.stderr_head, delivered: armed.unbound.destination, planGuessed: false },
    compiled,
    ...(denseProfile ? { denseProfile } : {}),
    progress: ended.stdout_tail, scope: "native-owner-capture-and-crash-recovery" }));
  status.textContent = "Native recovery delivered";
}

void exercise().catch(async (error) => {
  status.textContent = String(error);
  await writeTextFile(reportPath, JSON.stringify({ ok: false, error: String(error), scope: "native-owner-capture-and-crash-recovery" }));
});