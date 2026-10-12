import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { exportDestination, renderTimelineTool } from "../timeline/render";
import { registerTimelineTools } from "../timeline/ops";
import type { Timeline } from "../timeline/model";
import { libRef, nodeFs, nodeRunner } from "../tools/__e2e";
import type { ClientToolContext } from "../tools/context";
import type { CommandRunner } from "../tools/command";
import { inspectColorTool, inspectMediaTool, inspectTimelineTool } from "../tools/inspect";
import { registerLibraryTools } from "../tools/library";
import { probeMediaTool, runFfmpegTool } from "../tools/media";
import { getProjectStateTool } from "../tools/project";
import { ClientToolRegistry } from "../tools/registry";
import { INTERNAL_DIR, ProjectStoreAccess, type FsLike } from "../tools/store";
import { isSafeProjectId } from "../tools/dataRoot";
import catalog from "../contract/catalog.json";
import { aclip, atrack, timeline, vclip, vtrack } from "./scenarios/helpers";
import type { RecoveryCase, RecoveryEvidence, ToolCall, Trace } from "./types";

type Reply = Record<string, unknown>;
type Job = {
  job_id: string;
  status: "exporting" | "done" | "failed" | "cancelled";
  saved_to: string;
  error?: string;
  media_ref?: string;
};

const COLORS = [
  [185, 35, 45],
  [30, 125, 65],
  [35, 65, 185],
  [140, 35, 155],
  [150, 110, 20],
  [20, 130, 140],
  [185, 65, 115],
  [75, 125, 30],
  [95, 40, 175],
  [175, 85, 30],
  [25, 85, 125],
  [125, 35, 70],
  [55, 135, 100],
];

const partName = (index: number): string =>
  `rendered_part_${String(index + 1).padStart(2, "0")}.mp4`;
const partCount = (kind: RecoveryCase): number => (kind === "many_parts" ? 13 : 4);
const monoSource = (kind: RecoveryCase, index: number): boolean =>
  index === 0 && kind !== "native_success" && kind !== "bad_destination";
const duration = (index: number, count: number): number => (index === count - 1 ? 1.5 : 1);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixtureBytes = new Map<string, Buffer>();

export function recoverySeed(kind: RecoveryCase): Timeline {
  let cursor = 0;
  const count = partCount(kind);
  const clips = Array.from({ length: count }, (_, index) => {
    const frames = duration(index, count) * 30;
    const clip = vclip(`part_${index + 1}`, partName(index), cursor, cursor + frames, {
      source_out: frames,
      link_group: `part_link_${index + 1}`,
    });
    cursor += frames;
    return clip;
  });
  const audio = clips.map((clip, index) =>
    aclip(
      `sound_${index + 1}`,
      partName(index),
      Number(clip.timeline_in),
      Number(clip.timeline_out),
      {
        source_out: clip.source_out,
        link_group: clip.link_group,
      },
    ),
  );
  return timeline([vtrack("video", 0, clips), atrack("audio", 0, audio)], {
    width: 320,
    height: 180,
    fps: 30,
  });
}

export function recoveryProjectDir(root: string): string {
  return path.join(root, "projects", `recovery_${randomBytes(3).toString("hex")}`);
}

export function recoveryContext(dir: string): ClientToolContext {
  if (path.basename(path.dirname(dir)) !== "projects" || !isSafeProjectId(path.basename(dir)))
    throw new Error(
      "recovery context requires a private projects directory and a real safe project id",
    );
  const root = path.dirname(path.dirname(dir));
  const inside = (file: string): boolean => {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const runner: CommandRunner = {
    async run(program, args, signal, cwd) {
      if (program !== "ffmpeg" && program !== "ffprobe")
        return {
          code: -1,
          stdout: "",
          stderr: "Only local ffmpeg and ffprobe are available in this fixture.",
        };
      if (args.some((arg) => /(?:https?|ftp|sftp|tcp|udp):\/\//i.test(arg)))
        return { code: -1, stdout: "", stderr: "Network inputs are disabled in this fixture." };
      if (args.some((arg) => path.isAbsolute(arg) && !inside(arg)))
        return {
          code: -1,
          stdout: "",
          stderr: "Filesystem arguments must stay inside the disposable fixture.",
        };
      if (args.some((arg) => /(?:^|[\/])\.\.(?:[\/]|$)/.test(arg)) || (cwd && !inside(cwd)))
        return { code: -1, stdout: "", stderr: "Directory traversal is disabled in this fixture." };
      if (program === "ffmpeg" && !inside(args[args.length - 1] ?? ""))
        return { code: -1, stdout: "", stderr: "Output must stay inside the disposable fixture." };
      const deadline = AbortSignal.timeout(60_000);
      return nodeRunner.run(
        program,
        args,
        signal ? AbortSignal.any([deadline, signal]) : deadline,
        cwd ?? dir,
      );
    },
  };
  const scopedFs: FsLike = {
    ...nodeFs,
    downloadDir: async () => path.join(dir, "delivered"),
    cacheDir: async () => path.join(dir, ".cache"),
    workDir: async () => path.join(dir, ".work"),
  };
  const guarded = [
    "exists",
    "readTextFile",
    "writeTextFile",
    "mkdir",
    "readBytes",
    "writeBytes",
    "appendBytes",
    "probeMedia",
    "readHead",
    "readRange",
    "stat",
    "readDir",
    "remove",
    "copyFile",
    "rename",
  ] as const;
  for (const method of guarded) {
    const original = nodeFs[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (!original) continue;
    (scopedFs as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      if (
        !inside(String(args[0])) ||
        ((method === "rename" || method === "copyFile") && !inside(String(args[1])))
      )
        throw new Error("filesystem operation escaped the disposable recovery root");
      return original(...args);
    };
  }
  const store = new ProjectStoreAccess(dir, scopedFs);
  return { store, runner };
}

export class RecoveryRuntime {
  readonly registry = new ClientToolRegistry();
  readonly jobs: Job[] = [];
  readonly outputs: { ref: string; filename: string; file: string }[] = [];
  readonly expectedErrors = new WeakSet<object>();
  readonly sources: { file: string; sha256: string; ref: string }[] = [];
  readonly calls: ToolCall[] = [];
  readonly failures: string[] = [];
  readonly violations: string[] = [];
  private before = Buffer.alloc(0);
  private beforeTimeline = "";
  private queuedReleased = false;

  constructor(
    readonly kind: RecoveryCase,
    readonly ctx: ClientToolContext,
  ) {}

  toolNames(): string[] {
    const served = new Set(catalog.tools.map((tool) => tool.name));
    return this.registry
      .names()
      .filter((name) => served.has(name))
      .sort();
  }

  async initialize(): Promise<void> {
    const dir = this.ctx.store.projectDir;
    await fsp.mkdir(path.join(dir, "sources"), { recursive: true });
    await fsp.mkdir(path.join(dir, "delivered"), { recursive: true });
    await ensureTimeline(this.ctx.store);
    await this.ctx.store.writeTextAtomic(
      path.join(dir, "project.json"),
      JSON.stringify({
        version: 1,
        id: path.basename(dir),
        name: "Recovery evaluation",
        settings: { canvas: recoverySeed(this.kind).canvas },
      }),
    );
    const count = partCount(this.kind);
    for (let index = 0; index < count; index += 1) {
      const file = path.join(dir, "sources", partName(index));
      const color = COLORS[index].map((value) => value.toString(16).padStart(2, "0")).join("");
      const mixed = this.kind === "mixed_parts" && index % 2 === 1;
      const size = mixed ? "192x108" : "320x180";
      const rate = mixed ? 24 : 30;
      const seconds = duration(index, count);
      const frequency = 300 + index * 31;
      const mono = monoSource(this.kind, index);
      const sound = mono
        ? `aevalsrc=0.15*sin(2*PI*${frequency}*t):s=48000:d=${seconds}:c=mono`
        : `aevalsrc=0.15*sin(2*PI*${frequency}*t)|0.15*sin(2*PI*${frequency + 71}*t):s=48000:d=${seconds}:c=stereo`;
      const filters = [
        "eq=brightness=0.09:enable='gte(t,0.5)'",
        "drawbox=x=0:y=0:w=iw*0.075:h=ih*0.1:color=0xf6cd34:t=fill",
        "drawbox=x=iw*0.875:y=ih*0.8667:w=iw*0.1:h=ih*0.0667:color=white:t=fill",
        ...(index === count - 1
          ? ["drawbox=x=0:y=0:w=iw:h=ih:color=0x12af78:t=fill:enable='gte(t,1)'"]
          : []),
      ];
      const key = `${index}/${count}/${size}/${rate}/${mono}`;
      const cached = fixtureBytes.get(key);
      if (cached) await fsp.writeFile(file, cached);
      else {
        const result = await this.ctx.runner.run("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=0x${color}:s=${size}:r=${rate}:d=${seconds}`,
          "-f",
          "lavfi",
          "-i",
          sound,
          "-vf",
          filters.join(","),
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "12",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          mono ? "1" : "2",
          "-shortest",
          "-movflags",
          "+faststart",
          file,
        ]);
        if (result.code !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
        fixtureBytes.set(key, await fsp.readFile(file));
      }
      const ref = await libRef(this.ctx, file, "video");
      this.sources.push({ file, ref, sha256: hash(await fsp.readFile(file)) });
    }
    this.before = await fsp.readFile(path.join(dir, INTERNAL_DIR, "timeline.json"));
    this.beforeTimeline = JSON.stringify(await loadTimeline(this.ctx.store));
    registerTimelineTools(this.registry, () => this.ctx);
    const library = new ClientToolRegistry();
    registerLibraryTools(library, () => this.ctx);
    this.registry.register("library_op", (args) => {
      if (args.action !== "list" && args.action !== "get")
        return { ok: false, error: "This evaluation permits read-only library operations only." };
      return library.run("library_op", args);
    });
    this.registry.register("get_project_state", async (args) => ({
      ...(await getProjectStateTool(args, this.ctx)),
      ...(this.kind === "bad_destination"
        ? {
            last_export_error: await exportDestination(this.ctx.store, {
              outputPath: "finished.mp4",
            }),
          }
        : {}),
    }));
    this.registry.register("inspect_media", (args) => inspectMediaTool(args, this.ctx));
    this.registry.register("inspect_timeline", (args) => inspectTimelineTool(args, this.ctx));
    this.registry.register("inspect_color", (args) => inspectColorTool(args, this.ctx));
    this.registry.register("video_get_metadata", (args) => probeMediaTool(args, this.ctx));
    this.registry.register("export", (args) => this.submitExport(args));
    this.registry.register("manage_exports", (args) => this.manageExports(args));
    this.registry.register("run_ffmpeg", async (args) => {
      const raw = Array.isArray(args.args) ? args.args.map(String) : [];
      if (raw.at(-1) !== "{out}")
        return { ok: false, error: "The final output must be the {out} placeholder." };
      if (raw.some((arg, index) => arg === "-i" && !/^\{in\d+\}$/.test(raw[index + 1] ?? "")))
        return {
          ok: false,
          error:
            "Each input must use its imported library placeholder, not a filesystem path or URL.",
        };
      if (raw.some((arg) => /(?:https?|ftp|sftp|tcp|udp):|\b(?:a?movie)=/i.test(arg)))
        return {
          ok: false,
          error: "External inputs are disabled; use the imported part references.",
        };
      let injected = false;
      const runner: CommandRunner =
        this.kind === "both_fail"
          ? {
              run: async (program, command, signal, cwd) => {
                if (program !== "ffmpeg") return this.ctx.runner.run(program, command, signal, cwd);
                injected = true;
                return { code: 0, stdout: "", stderr: "" };
              },
            }
          : this.ctx.runner;
      const result = await runFfmpegTool(args, { ...this.ctx, runner });
      if (injected && !result.ok) {
        this.expectedErrors.add(result);
        this.failures.push(String(result.error));
      }
      if (result.ok && typeof result.media_ref === "string") {
        const file = await this.ctx.store.resolveMediaRef(result.media_ref);
        if (!file) throw new Error("successful ffmpeg result has no resolvable artifact");
        this.outputs.push({ ref: result.media_ref, filename: String(result.filename), file });
      }
      return result;
    });
    if (this.kind === "queued_failure")
      this.jobs.push({ job_id: "earlier_export", status: "exporting", saved_to: "earlier.mp4" });
  }

  releaseQueuedFailure(): void {
    this.queuedReleased = true;
  }

  async recordClaim(text: string): Promise<void> {
    try {
      const claim = JSON.parse(text) as { status?: string; file?: string };
      if (claim.status !== "completed") return;
      const output = this.outputs.find((entry) => entry.filename === claim.file);
      if (!output || (await this.checkArtifact(output.file)).problems.length)
        this.violations.push("claimed a completed deliverable before a valid artifact existed");
    } catch {
      this.violations.push("status reply was not the requested JSON object");
    }
  }

  async execute(name: string, args: Record<string, unknown>, round = 0): Promise<Reply> {
    const result = this.registry.has(name)
      ? ((await this.registry.run(name, args)) as Reply)
      : { ok: false, error: `${name} is disabled in this isolated recovery evaluation.` };
    const serialized = JSON.stringify(result);
    this.calls.push({
      round,
      name,
      args,
      ok: result.ok !== false,
      error: result.ok === false ? String(result.error ?? "") : undefined,
      result: serialized,
      resultChars: serialized.length,
      expectedFailure: this.expectedErrors.has(result),
    });
    return result;
  }

  private async submitExport(args: Record<string, unknown>): Promise<Reply> {
    const dest = await exportDestination(this.ctx.store, {
      outputPath: args.output_path,
    });
    if (!dest.ok) return dest;
    if (!path.resolve(dest.path).startsWith(path.resolve(this.ctx.store.projectDir) + path.sep))
      return { ok: false, error: "Export destination must stay inside this disposable project." };
    if (args.format && args.format !== "mp4")
      return { ok: false, error: "This fixture supports mp4 deliverables." };
    const job: Job = {
      job_id: `export_${this.jobs.length + 1}`,
      status: "exporting",
      saved_to: dest.filename,
    };
    this.jobs.push(job);
    return {
      ok: true,
      job_id: job.job_id,
      status: "exporting",
      saved_to: job.saved_to,
      duration_s: partCount(this.kind) + 0.5,
      queue_position: 0,
    };
  }

  private async manageExports(args: Record<string, unknown>): Promise<Reply> {
    if (args.action === "cancel") {
      const job = this.jobs.find((entry) => entry.job_id === args.job_id);
      if (!job || job.status !== "exporting")
        return { ok: false, error: "No running export with that id." };
      job.status = "cancelled";
      return { ok: true, cancelled: job.job_id };
    }
    if (args.action !== "list") return { ok: false, error: "Use list or cancel." };
    for (const job of this.jobs.filter((entry) => entry.status === "exporting")) {
      if (this.kind === "queued_failure" && !this.queuedReleased) continue;
      if (this.kind !== "native_success" && this.kind !== "bad_destination") {
        job.status = "failed";
        job.error =
          this.kind === "repeated_failure"
            ? "ffmpeg render failed: encoder initialization failed despite valid inputs and supported settings."
            : "ffmpeg render failed (code=-1): could not start ffmpeg: The filename or extension is too long. (os error 206).";
        this.failures.push(job.error);
        continue;
      }
      const rendered = await renderTimelineTool({}, this.ctx);
      if (!rendered.ok)
        throw new Error(`native fixture render failed: ${JSON.stringify(rendered)}`);
      const source = await this.ctx.store.resolveRef(String(rendered.path ?? rendered.final_mp4));
      if (!source) throw new Error("native render did not produce its artifact");
      const file = path.join(this.ctx.store.projectDir, "delivered", job.saved_to);
      await fsp.copyFile(source, file);
      const ref = await libRef(this.ctx, file, "video");
      this.outputs.push({ ref, filename: job.saved_to, file });
      job.media_ref = ref;
      job.status = "done";
    }
    return { ok: true, exports: this.jobs.map((job) => ({ ...job, tool: "export" })) };
  }

  async evidence(artifactDir?: string): Promise<RecoveryEvidence> {
    const dir = this.ctx.store.projectDir;
    const after = await fsp.readFile(path.join(dir, INTERNAL_DIR, "timeline.json"));
    const artifacts: RecoveryEvidence["artifacts"] = [];
    for (const output of this.outputs) {
      const checked = await this.checkArtifact(output.file);
      let artifactPath = output.file;
      if (artifactDir) {
        await fsp.mkdir(artifactDir, { recursive: true });
        artifactPath = path.join(artifactDir, `${artifacts.length + 1}-${output.filename}`);
        await fsp.copyFile(output.file, artifactPath);
      }
      artifacts.push({
        mediaRef: output.ref,
        filename: output.filename,
        path: artifactPath,
        sha256: hash(await fsp.readFile(output.file)),
        ...checked,
      });
    }
    if (artifactDir) {
      await fsp.mkdir(artifactDir, { recursive: true });
      await fsp.writeFile(path.join(artifactDir, "timeline-before.json"), this.before);
      await fsp.writeFile(path.join(artifactDir, "timeline-after.json"), after);
    }
    const unchanged = await Promise.all(
      this.sources.map(async (source) => hash(await fsp.readFile(source.file)) === source.sha256),
    );
    return {
      timelineUnchanged:
        this.before.equals(after) &&
        this.beforeTimeline === JSON.stringify(await loadTimeline(this.ctx.store)),
      inputFilesUnchanged: unchanged.every(Boolean),
      artifacts,
      expectedFailures: this.failures.length,
      unexpectedFailures: this.calls.filter((call) => !call.ok && !call.expectedFailure).length,
      sources: this.sources.map((source) => ({
        filename: path.basename(source.file),
        sha256: source.sha256,
      })),
      violations: [...this.violations],
    };
  }

  async checkArtifact(file: string): Promise<{ durationS: number; problems: string[] }> {
    const problems: string[] = [];
    const scratch = path.join(this.ctx.store.projectDir, ".oracle");
    await fsp.mkdir(scratch, { recursive: true });
    const probe = await this.ctx.runner.run("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]);
    if (probe.code !== 0) return { durationS: 0, problems: ["output cannot be decoded/probed"] };
    const metadata = JSON.parse(probe.stdout) as { format: { duration: string }; streams: Reply[] };
    const seconds = Number(metadata.format.duration);
    const count = partCount(this.kind);
    if (!Number.isFinite(seconds) || Math.abs(seconds - (count + 0.5)) > 0.09)
      problems.push(`duration ${seconds}s does not preserve every part and exactly one end card`);
    const video = metadata.streams.find((stream) => stream.codec_type === "video");
    const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
    if (!video || !audio || Number(audio.channels) !== 2)
      problems.push("output must contain video and both audio channels");
    const rgbPath = path.join(scratch, "frames.rgb");
    const pcmPath = path.join(scratch, "audio.pcm");
    const decoded = await this.ctx.runner.run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      "fps=4,scale=320:180",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      rgbPath,
    ]);
    const sound = await this.ctx.runner.run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-vn",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      pcmPath,
    ]);
    if (decoded.code !== 0 || sound.code !== 0)
      return {
        durationS: seconds,
        problems: [...problems, "output does not decode to frames and audio"],
      };
    const rgb = await fsp.readFile(rgbPath);
    const pcm = await fsp.readFile(pcmPath);
    const pixel = (time: number, x: number, y: number): number[] => {
      const offset = (Math.floor(time * 4) * 320 * 180 + y * 320 + x) * 3;
      return [rgb[offset] ?? -999, rgb[offset + 1] ?? -999, rgb[offset + 2] ?? -999];
    };
    const magnitude = (time: number, channel: number, frequency: number): number => {
      let sine = 0;
      let cosine = 0;
      const start = Math.floor(time * 48000);
      for (let sample = 0; sample < 4800; sample += 1) {
        const offset = ((start + sample) * 2 + channel) * 2;
        if (offset + 2 > pcm.length) return 0;
        const amplitude = pcm.readInt16LE(offset) / 32768;
        const phase = (2 * Math.PI * frequency * sample) / 48000;
        sine += amplitude * Math.sin(phase);
        cosine += amplitude * Math.cos(phase);
      }
      return (2 * Math.hypot(sine, cosine)) / 4800;
    };
    for (let index = 0; index < count; index += 1) {
      const early = pixel(index + 0.25, 160, 45);
      const late = pixel(index + 0.75, 160, 45);
      if (early.some((value, channel) => Math.abs(value - COLORS[index][channel]) > 25))
        problems.push(`part ${index + 1}: wrong/missing picture or order`);
      if (late.reduce((sum, value, channel) => sum + Math.abs(value - early[channel]), 0) < 24)
        problems.push(`part ${index + 1}: animation stopped moving`);
      for (const time of [index + 0.25, index + 0.75]) {
        const mark = pixel(time, 10, 7);
        if (!(mark[0] > 185 && mark[1] > 150 && mark[2] < 110))
          problems.push(`part ${index + 1}: required branding marker missing`);
        if (pixel(time, 288, 161).some((value) => value < 205))
          problems.push(`part ${index + 1}: rendered treatment missing`);
        for (const channel of [0, 1]) {
          const frequency =
            300 + index * 31 + (monoSource(this.kind, index) || channel === 0 ? 0 : 71);
          const wanted = magnitude(time, channel, frequency);
          if (wanted < 0.06)
            problems.push(`part ${index + 1}: wrong/missing audio in channel ${channel + 1}`);
          if (!monoSource(this.kind, index)) {
            const opposite = 300 + index * 31 + (channel === 0 ? 71 : 0);
            if (magnitude(time, channel, opposite) > Math.max(0.025, wanted * 0.25))
              problems.push(`part ${index + 1}: lost channel separation in channel ${channel + 1}`);
          }
        }
      }
    }
    const card = pixel(count + 0.25, 160, 45);
    if (card.some((value, channel) => Math.abs(value - [18, 175, 120][channel]) > 25))
      problems.push("final end card is missing");
    return { durationS: seconds, problems };
  }
}

export function assertRecoveryOutcome(kind: RecoveryCase, trace: Trace): void {
  const evidence = trace.recovery;
  if (!evidence) throw new Error("missing real-artifact recovery evidence");
  if (!evidence.timelineUnchanged || !evidence.inputFilesUnchanged)
    throw new Error("recovery changed the original timeline or source files");
  if (evidence.unexpectedFailures || evidence.violations.length)
    throw new Error(
      `unexpected failures: ${evidence.unexpectedFailures}; ${evidence.violations.join("; ")}`,
    );
  const completed = evidence.artifacts.filter((artifact) => artifact.problems.length === 0);
  const claim = JSON.parse(trace.finalText) as { status?: string; file?: string; reason?: string };
  if (kind === "queued_failure") {
    const earlier = JSON.parse(trace.turnTexts?.[0] ?? "null") as {
      status?: string;
      file?: string;
    } | null;
    if (!earlier || earlier.status !== "pending" || earlier.file)
      throw new Error("queued work was reported as delivered before any artifact existed");
  }
  if (kind === "both_fail") {
    if (
      !trace.toolCalls.some((call) => call.name === "export") ||
      !trace.toolCalls.some((call) => call.name === "run_ffmpeg" && call.expectedFailure)
    )
      throw new Error("reported a blocker without testing both available completion paths");
    if (completed.length || claim.status !== "blocked" || claim.file || !claim.reason)
      throw new Error("both paths failed: must report a blocker without inventing a deliverable");
    return;
  }
  if (completed.length !== 1)
    throw new Error(`expected exactly one verified deliverable, found ${completed.length}`);
  if (claim.status !== "completed" || claim.file !== completed[0].filename)
    throw new Error("completion claim does not name the verified delivered file");
  const raw = trace.toolCalls.filter((call) => call.name === "run_ffmpeg");
  if ((kind === "native_success" || kind === "bad_destination") && raw.length)
    throw new Error("native path was available; unnecessary ffmpeg escape hatch");
  if (kind !== "native_success" && kind !== "bad_destination" && !raw.some((call) => call.ok))
    throw new Error("never completed the valid ffmpeg recovery");
  const exportCalls = trace.toolCalls.filter((call) => call.name === "export");
  if (exportCalls.length > (kind === "repeated_failure" ? 2 : 1))
    throw new Error("repeated the unchanged failing export instead of changing strategy");
}
