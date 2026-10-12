import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { installE2EDocuments, openE2EDoc, resetE2EDocuments } from "../../src/tools/__e2e";
import {
  RecoveryRuntime,
  recoveryContext,
  recoveryProjectDir,
  recoverySeed,
} from "../../src/eval/recovery";
import { INTERNAL_DIR } from "../../src/tools/store";
import { isSafeProjectId } from "../../src/tools/dataRoot";
import type { RecoveryCase } from "../../src/eval/types";

const [command, rawRoot, kind, projectId] = process.argv.slice(2);
if (!rawRoot || !rawRoot.includes("artdaddy-phase6-sol-mcp-"))
  throw new Error("This driver requires the private Sol MCP QA root");
const root = path.resolve(rawRoot);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

if (command === "archive") {
  const report = path.resolve("reports/eval/copilot-mcp-sol-2026-10-12");
  const claims = JSON.parse(await fsp.readFile(path.join(report, "claims.json"), "utf8")) as {
    requestedModel: string;
    selectedModelVerified: boolean;
    limits: string[];
    samples: {
      kind: string;
      repetition: number;
      projectId: string;
      status: string;
      media_ref: string;
      file: string;
    }[];
  };
  const samples = [];
  const sourceHashes = new Map<string, string>();
  for (const sample of claims.samples) {
    if (!isSafeProjectId(sample.projectId) || !["many_parts", "both_fail"].includes(sample.kind))
      throw new Error("Invalid archived sample identity");
    const record = path.join(root, "records", sample.projectId);
    const evidence = JSON.parse(
      await fsp.readFile(path.join(record, "artifact-evidence.json"), "utf8"),
    ) as {
      timelineUnchanged: boolean;
      sourcesUnchanged: boolean;
      artifacts: {
        id: string;
        filename: string;
        path: string;
        sha256: string;
        problems: string[];
      }[];
      verifiedDeliverables: number;
    };
    const captured = JSON.parse(
      await fsp.readFile(path.join(record, "capture-native.json"), "utf8"),
    ) as {
      calls: { name: string; result: { ok?: boolean; error?: string }; injected: boolean }[];
      nativeFailures: number;
      rawFailures: number;
    };
    const unchanged = (await fsp.readFile(path.join(record, "timeline-before.json"))).equals(
      await fsp.readFile(path.join(record, "timeline-after.json")),
    );
    const beforeLibrary = JSON.parse(
      await fsp.readFile(path.join(record, "library-before.json"), "utf8"),
    ) as {
      clips: { id: string; path: string; filename: string }[];
    };
    const seedHashes = await Promise.all(
      beforeLibrary.clips.map(async (entry) => {
        const relative = path.relative(root, entry.path);
        if (relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("Source escaped private QA root");
        return { filename: entry.filename, sha256: digest(await fsp.readFile(entry.path)) };
      }),
    );
    const signature = JSON.stringify(seedHashes);
    if (sourceHashes.has(sample.kind) && sourceHashes.get(sample.kind) !== signature)
      throw new Error("Repetitions received different source media bytes");
    sourceHashes.set(sample.kind, signature);
    const destination = path.join(report, "samples", sample.projectId);
    await fsp.mkdir(destination, { recursive: true });
    for (const name of [
      "timeline-before.json",
      "timeline-after.json",
      "library-before.json",
      "setup-native.json",
      "capture-native.json",
      "artifact-evidence.json",
    ])
      await fsp.copyFile(path.join(record, name), path.join(destination, name));
    for (const [index, artifact] of evidence.artifacts.entries()) {
      const relative = path.relative(root, artifact.path);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Artifact escaped private QA root");
      const bytes = await fsp.readFile(artifact.path);
      if (digest(bytes) !== artifact.sha256) throw new Error("Scored artifact bytes changed");
      await fsp.writeFile(
        path.join(destination, `artifact-${index + 1}${path.extname(artifact.path)}`),
        bytes,
      );
    }
    const unexpected = captured.calls.filter((call) => call.result?.ok === false && !call.injected);
    const completed = evidence.artifacts.filter((artifact) => artifact.problems.length === 0);
    const outcomeMet =
      unchanged &&
      evidence.timelineUnchanged &&
      evidence.sourcesUnchanged &&
      (sample.kind === "many_parts"
        ? sample.status === "completed" &&
          completed.length === 1 &&
          completed[0].id === sample.media_ref
        : sample.status === "blocked" &&
          !sample.file &&
          !sample.media_ref &&
          evidence.artifacts.length === 0 &&
          captured.nativeFailures > 0 &&
          captured.rawFailures > 0);
    samples.push({
      ...sample,
      outcomeMet,
      cleanPass: outcomeMet && unexpected.length === 0,
      hostCalls: captured.calls.length,
      nativeFailures: captured.nativeFailures,
      rawFailures: captured.rawFailures,
      unexpectedErrors: unexpected.map((call) => ({ tool: call.name, error: call.result.error })),
      timelineUnchanged: unchanged && evidence.timelineUnchanged,
      sourcesUnchanged: evidence.sourcesUnchanged,
      completedArtifacts: completed.map(({ id, filename, sha256 }) => ({ id, filename, sha256 })),
    });
  }
  const requests = (await fetch("http://127.0.0.1:8789/qa/requests", {
    signal: AbortSignal.timeout(5000),
  }).then((response) => response.json())) as { path: string }[];
  const modelRequests = requests.filter(
    (entry) => entry.path.startsWith("/inference") || entry.path.startsWith("/ai/"),
  );
  if (modelRequests.length) throw new Error("Unexpected AI endpoint request in no-credit MCP test");
  await fsp.writeFile(
    path.join(report, "local-backend-requests.json"),
    JSON.stringify(requests, null, 2),
  );
  const summary = {
    requestedModel: claims.requestedModel,
    selectedModelVerified: claims.selectedModelVerified,
    host: "Copilot video subagent through actual native ArtDaddy MCP",
    repetitions: 5,
    samples: samples.length,
    artdaddyInferenceOrAiRequests: modelRequests.length,
    sourceBytesIdentical: true,
    artifactOracleSha256: digest(await fsp.readFile("src/eval/recovery.ts")),
    limits: claims.limits,
    rows: ["many_parts", "both_fail"].map((scenario) => {
      const selected = samples.filter((sample) => sample.kind === scenario);
      return {
        scenario,
        outcomeMet: selected.filter((sample) => sample.outcomeMet).length,
        cleanPass: selected.filter((sample) => sample.cleanPass).length,
        attempts: selected.length,
      };
    }),
  };
  await fsp.writeFile(path.join(report, "samples.json"), JSON.stringify(samples, null, 2));
  await fsp.writeFile(path.join(report, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} else if (command === "setup-native" || command === "capture-native") {
  if ((kind !== "many_parts" && kind !== "both_fail") || !isSafeProjectId(projectId))
    throw new Error("A known recovery case and real private project id are required");
  const { connect, evaluate, pageTarget } = await import("../cdp.mjs");
  const client = await connect(await pageTarget());
  try {
    const observed = await evaluate(
      client,
      `(async () => {
      const projectId = ${JSON.stringify(projectId)};
      const kind = ${JSON.stringify(kind)};
      const root = ${JSON.stringify(root.replace(/\\/g, "/"))};
      const urls = performance.getEntriesByType('resource').map(entry => entry.name);
      const loaded = name => urls.filter(url => new URL(url).pathname === name).pop() ?? name;
      const roots = await import(loaded('/src/tools/dataRoot.ts'));
      if ((await roots.dataRoot()).replace(/\\\\/g, '/') !== root)
        throw new Error('Refusing a non-isolated application');
      const docs = await import(loaded('/src/project/openDocuments.ts'));
      const hostModule = await import(loaded('/src/tools/host.ts'));
      const host = hostModule.openToolHost(projectId);
      await host.ready;
      const store = host.store();
      if (!store || !store.projectDir.replace(/\\\\/g, '/').startsWith(root + '/projects/'))
        throw new Error('Refusing a project outside the private root');
      await docs.openDocumentById(projectId)?.autosave.flush();
      const states = globalThis.recoveryMcpStates ??= {};
      if (${JSON.stringify(command)} === 'capture-native') {
        const state = states[projectId];
        if (!state) throw new Error('Missing native MCP call recorder');
        return { projectId, kind, calls: state.calls, nativeFailures: state.nativeFailures, rawFailures: state.rawFailures };
      }
      if (states[projectId]) throw new Error('Refusing to stack fault injectors');
      const state = states[projectId] = { calls: [], nativeFailures: 0, rawFailures: 0 };
      const original = host.run.bind(host);
      const base = host.holder.ctx;
      const rawRunner = base.runner;
      const originalRun = rawRunner.run.bind(rawRunner);
      const finalPrefix = store.artifactPath('ffmpeg/').replace(/\\\\/g, '/');
      if (kind === 'both_fail') {
        rawRunner.run = async (program, args, ...rest) => {
          const target = String(args.at(-1) ?? '').replace(/\\\\/g, '/');
          if (program === 'ffmpeg' && target.startsWith(finalPrefix)) {
            state.rawFailures += 1;
            return { code: 0, stdout: '', stderr: '' };
          }
          return originalRun(program, args, ...rest);
        };
      }
      const render = await import(loaded('/src/timeline/render.ts'));
      const privateOutput = root + '/delivered/' + projectId;
      await store.ensureDir(privateOutput);
      store.exportPath = async filename => privateOutput + '/' + filename;
      const local = new Set(['add_clips','add_text_clips','add_track','apply_color','apply_effects','export','get_project_state','get_timeline','insert_clips','inspect_color','inspect_media','inspect_timeline','library_op','link_clips','manage_exports','move_clips','redo','remove_clips','remove_tracks','ripple_delete','run_ffmpeg','set_clip_properties','set_keyframes','set_track','set_tracks','set_transition','split_clips','undo','unlink_clips','update_text','video_get_metadata']);
      host.run = async (name, args, options) => {
        let result;
        let injected = false;
        if (!local.has(name)) result = { ok: false, error: 'Paid and unrelated operations are disabled in this isolated recovery test.' };
        else if (name === 'library_op' && !['list','get'].includes(args.action))
          result = { ok: false, error: 'This evaluation permits read-only library operations only.' };
        else if (name === 'run_ffmpeg' && Array.isArray(args.args) && args.args.some((arg, index) =>
          /https?:|ftp:|tcp:|udp:|\\b(?:a?movie)=/i.test(String(arg)) ||
          (arg === '-i' && !/^\\{in\\d+\\}$/.test(String(args.args[index + 1])))))
          result = { ok: false, error: 'Use imported placeholders only; external inputs are disabled.' };
        else if (name === 'export') {
          const destination = await render.exportDestination(store, { outputPath: args.output_path });
          if (!destination.ok) result = destination;
          else if (!destination.path.replace(/\\\\/g, '/').startsWith(root + '/'))
            result = { ok: false, error: 'Export destination must stay inside the disposable project root.' };
          else {
            injected = true;
            state.nativeFailures += 1;
            result = { ok: false, error: 'ffmpeg render failed (code=-1): could not start ffmpeg: The filename or extension is too long. (os error 206).' };
          }
        } else {
          const before = state.rawFailures;
          result = await original(name, args, options);
          injected = state.rawFailures > before;
        }
        state.calls.push({ name, args, result, injected });
        return result;
      };
      return { projectId, kind, privateRoot: root, callRecorder: true, nativeFailure: 'os206', rawFault: kind === 'both_fail' ? 'exit-zero-no-file' : 'none' };
    })()`,
    );
    const recordDir = path.join(root, "records", projectId);
    await fsp.mkdir(recordDir, { recursive: true });
    await fsp.writeFile(path.join(recordDir, `${command}.json`), JSON.stringify(observed, null, 2));
    console.log(JSON.stringify(observed));
  } finally {
    client.close();
  }
} else if (command === "fixtures") {
  installE2EDocuments();
  try {
    for (const scenario of ["many_parts", "both_fail"] as const) {
      const ctx = recoveryContext(recoveryProjectDir(path.join(root, `fixture_${scenario}`)));
      await ctx.store.writeTextAtomic(
        path.join(ctx.store.projectDir, INTERNAL_DIR, "timeline.json"),
        JSON.stringify(recoverySeed(scenario), null, 2),
      );
      await openE2EDoc(ctx.store.projectDir);
      const fixture = new RecoveryRuntime(scenario, ctx);
      await fixture.initialize();
      const destination = path.join(root, "media", scenario);
      await fsp.mkdir(destination, { recursive: true });
      const sources = [];
      for (const source of fixture.sources) {
        const file = path.join(destination, path.basename(source.file));
        await fsp.copyFile(source.file, file);
        const bytes = await fsp.readFile(file);
        if (digest(bytes) !== source.sha256) throw new Error("Copied fixture bytes changed");
        sources.push({ filename: path.basename(file), file, sha256: source.sha256 });
      }
      await fsp.writeFile(
        path.join(destination, "manifest.json"),
        JSON.stringify({ kind: scenario, sources }, null, 2),
      );
      console.log(JSON.stringify({ kind: scenario, sourceCount: sources.length, destination }));
    }
  } finally {
    await resetE2EDocuments();
  }
} else if (command === "snapshot" || command === "grade") {
  if ((kind !== "many_parts" && kind !== "both_fail") || !isSafeProjectId(projectId))
    throw new Error("A known recovery case and real private project id are required");
  const project = path.join(root, "projects", projectId);
  const recordDir = path.join(root, "records", projectId);
  await fsp.mkdir(recordDir, { recursive: true });
  const timelineFile = path.join(project, INTERNAL_DIR, "timeline.json");
  const libraryFile = path.join(project, INTERNAL_DIR, "library.json");
  const timeline = await fsp.readFile(timelineFile);
  const library = JSON.parse(await fsp.readFile(libraryFile, "utf8")) as {
    clips: { id: string; path: string; filename?: string; external?: boolean }[];
  };
  if (command === "snapshot") {
    await fsp.writeFile(path.join(recordDir, "timeline-before.json"), timeline);
    await fsp.writeFile(
      path.join(recordDir, "library-before.json"),
      JSON.stringify(library, null, 2),
    );
    console.log(
      JSON.stringify({ projectId, timelineSha256: digest(timeline), assets: library.clips.length }),
    );
  } else {
    const before = JSON.parse(
      await fsp.readFile(path.join(recordDir, "library-before.json"), "utf8"),
    ) as typeof library;
    const oldIds = new Set(before.clips.map((entry) => entry.id));
    const fixture = new RecoveryRuntime(kind as RecoveryCase, recoveryContext(project));
    const artifacts = [];
    for (const entry of library.clips.filter((entry) => !oldIds.has(entry.id))) {
      if (!/\.(mp4|mkv|mov|webm)$/i.test(entry.filename ?? entry.path)) continue;
      const file = entry.external ? entry.path : path.join(project, entry.path);
      const relative = path.relative(root, file);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Output escaped private root");
      artifacts.push({
        id: entry.id,
        filename: entry.filename,
        path: file,
        sha256: digest(await fsp.readFile(file)),
        ...(await fixture.checkArtifact(file)),
      });
    }
    const manifest = JSON.parse(
      await fsp.readFile(path.join(root, "media", kind, "manifest.json"), "utf8"),
    ) as {
      sources: { file: string; sha256: string }[];
    };
    const hashes = await Promise.all(
      manifest.sources.map(
        async (source) => digest(await fsp.readFile(source.file)) === source.sha256,
      ),
    );
    const result = {
      kind,
      projectId,
      timelineUnchanged: timeline.equals(
        await fsp.readFile(path.join(recordDir, "timeline-before.json")),
      ),
      sourcesUnchanged: hashes.every(Boolean),
      artifacts,
      verifiedDeliverables: artifacts.filter((artifact) => artifact.problems.length === 0).length,
    };
    await fsp.writeFile(
      path.join(recordDir, "artifact-evidence.json"),
      JSON.stringify(result, null, 2),
    );
    await fsp.writeFile(path.join(recordDir, "timeline-after.json"), timeline);
    console.log(JSON.stringify(result));
  }
} else {
  throw new Error("Use fixtures, snapshot, or grade");
}
