import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installE2EDocuments, libRef, openE2EDoc, resetE2EDocuments } from "../tools/__e2e";
import { runFfmpegTool } from "../tools/media";
import { INTERNAL_DIR } from "../tools/store";
import {
  assertRecoveryOutcome,
  RecoveryRuntime,
  recoveryContext,
  recoveryProjectDir,
  recoverySeed,
} from "./recovery";
import { RECOVERY_SCENARIOS } from "./scenarios/exports";
import type { RecoveryCase, Trace } from "./types";

let dir = "";
let runtime: RecoveryRuntime;

async function joinParts(
  fixture: RecoveryRuntime,
  inputs: string[],
  outputName: string,
): Promise<Record<string, unknown>> {
  const normalize = inputs
    .map(
      (_, index) =>
        `[${index}:v]scale=320:180,fps=30,setsar=1,setpts=PTS-STARTPTS[v${index}];` +
        `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}];`,
    )
    .join("");
  const concatenate =
    inputs.map((_, index) => `[v${index}][a${index}]`).join("") +
    `concat=n=${inputs.length}:v=1:a=1[v][a]`;
  return fixture.execute("run_ffmpeg", {
    inputs,
    args: [
      ...inputs.flatMap((_, index) => ["-i", `{in${index}}`]),
      "-filter_complex",
      normalize + concatenate,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "{out}",
    ],
    output_name: outputName,
  });
}

beforeAll(async () => {
  installE2EDocuments();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-recovery-proof-"));
  const ctx = recoveryContext(recoveryProjectDir(dir));
  await ctx.store.writeTextAtomic(
    path.join(ctx.store.projectDir, INTERNAL_DIR, "timeline.json"),
    JSON.stringify(recoverySeed("platform_limit"), null, 2),
  );
  await openE2EDoc(ctx.store.projectDir);
  runtime = new RecoveryRuntime("platform_limit", ctx);
  await runtime.initialize();
}, 60_000);

afterAll(async () => {
  await resetE2EDocuments();
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

describe("recovery oracle reads delivered frames and audio", () => {
  it("uses a real project identity and publishes only executable local tools", async () => {
    const state = await runtime.execute("get_project_state", {});
    expect(state.ok, JSON.stringify(state)).toBe(true);
    expect(state.project_id).toBe(path.basename(runtime.ctx.store.projectDir));
    expect(state.library_count).toBe(4);
    const proofDir = path.resolve(
      process.env.ARTDADDY_RECOVERY_REPORT_DIR ?? "reports/eval/ffmpeg-recovery-2026-10-12",
    );
    await fsp.mkdir(proofDir, { recursive: true });
    await fsp.writeFile(
      path.join(proofDir, "runtime-tools.json"),
      JSON.stringify(runtime.toolNames(), null, 2),
    );
    await expect(
      runtime.ctx.store.writeText(path.join(dir, "..", "escaped-recovery.json"), "bad"),
    ).rejects.toThrow("escaped");
  });
  it("lets the model inspect real timeline frames before or after exporting", async () => {
    const inspected = await runtime.execute("inspect_timeline", {
      start_frame: 0,
      end_frame: 135,
      max_frames: 2,
    });
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
    const attachments = inspected._attachments as { path: string }[];
    expect(attachments).toHaveLength(2);
    for (const attachment of attachments)
      expect((await fsp.stat(attachment.path)).size).toBeGreaterThan(100);
  });
  it("accepts a real ordered join with animation, treatments, mono/stereo audio and one end card", async () => {
    const inputs = runtime.sources.map((source) => source.ref);
    const result = await runtime.execute("run_ffmpeg", {
      inputs,
      args: [
        ...inputs.flatMap((_, index) => ["-i", `{in${index}}`]),
        "-filter_complex",
        inputs
          .map(
            (_, index) =>
              `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${index}];`,
          )
          .join("") + "[0:v][a0][1:v][a1][2:v][a2][3:v][a3]concat=n=4:v=1:a=1[v][a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "{out}",
      ],
      output_name: "ordered.mp4",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const evidence = await runtime.evidence();
    expect(evidence.artifacts).toHaveLength(1);
    expect(evidence.artifacts[0].problems).toEqual([]);
    expect(evidence.timelineUnchanged).toBe(true);
    expect(evidence.inputFilesUnchanged).toBe(true);
  });

  it("rejects a playable source file that is not the requested completed deliverable", async () => {
    const checked = await runtime.checkArtifact(runtime.sources[0].file);
    expect(checked.problems.length).toBeGreaterThan(0);
    expect(checked.problems.some((problem) => problem.includes("duration"))).toBe(true);
  });

  it("rejects opposite part ordering even when the file plays and has the correct duration", async () => {
    const inputs = [...runtime.sources].reverse().map((source) => source.ref);
    const result = await runtime.execute("run_ffmpeg", {
      inputs,
      args: [
        ...inputs.flatMap((_, index) => ["-i", `{in${index}}`]),
        "-filter_complex",
        inputs
          .map(
            (_, index) =>
              `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${index}];`,
          )
          .join("") + "[0:v][a0][1:v][a1][2:v][a2][3:v][a3]concat=n=4:v=1:a=1[v][a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "{out}",
      ],
      output_name: "wrong-order.mp4",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const checked = await runtime.checkArtifact(runtime.outputs.at(-1)!.file);
    expect(checked.durationS).toBeCloseTo(4.5, 1);
    expect(checked.problems.some((problem) => problem.includes("order"))).toBe(true);
    expect(checked.problems.some((problem) => problem.includes("audio"))).toBe(true);
  });

  it("rejects dropped sound and duplicated content rather than accepting an exit-zero file", async () => {
    const source = runtime.outputs[0].ref;
    const result = await runtime.execute("run_ffmpeg", {
      inputs: [source],
      args: ["-stream_loop", "1", "-i", "{in0}", "-an", "-c:v", "copy", "{out}"],
      output_name: "duplicated-silent.mp4",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const checked = await runtime.checkArtifact(runtime.outputs.at(-1)!.file);
    expect(checked.problems.some((problem) => problem.includes("duration"))).toBe(true);
    expect(checked.problems.some((problem) => problem.includes("audio"))).toBe(true);
  });

  it("walks every recovery case against actual tool replies and on-disk artifacts", async () => {
    const cases: RecoveryCase[] = [
      "native_success",
      "bad_destination",
      "platform_limit",
      "repeated_failure",
      "mixed_parts",
      "many_parts",
      "both_fail",
      "queued_failure",
    ];
    expect(RECOVERY_SCENARIOS.map((scenario) => scenario.recovery)).toEqual(cases);
    for (const kind of cases) {
      const project = await fsp.mkdtemp(path.join(os.tmpdir(), `artdaddy-recovery-${kind}-`));
      const ctx = recoveryContext(recoveryProjectDir(project));
      await ctx.store.writeTextAtomic(
        path.join(ctx.store.projectDir, INTERNAL_DIR, "timeline.json"),
        JSON.stringify(recoverySeed(kind), null, 2),
      );
      const doc = await openE2EDoc(ctx.store.projectDir);
      const fixture = new RecoveryRuntime(kind, ctx);
      await fixture.initialize();
      const projectState = await fixture.execute("get_project_state", {});
      expect(projectState.ok, `${kind}: ${JSON.stringify(projectState)}`).toBe(true);
      if (kind !== "queued_failure") {
        const submitted = await fixture.execute("export", {});
        expect(submitted.ok, `${kind}: ${JSON.stringify(submitted)}`).toBe(true);
      }
      const status = await fixture.execute("manage_exports", { action: "list" });
      const jobs = status.exports as { status: string }[];
      expect(jobs[0].status).toBe(
        kind === "queued_failure"
          ? "exporting"
          : kind === "native_success" || kind === "bad_destination"
            ? "done"
            : "failed",
      );
      if (kind === "native_success" || kind === "bad_destination") {
        expect((await fixture.evidence()).artifacts[0].problems, kind).toEqual([]);
      }
      if (kind === "both_fail") {
        const failed = await fixture.execute("run_ffmpeg", {
          inputs: [fixture.sources[0].ref],
          args: ["-i", "{in0}", "-c", "copy", "{out}"],
          output_name: "never-written.mp4",
        });
        expect(failed.ok).toBe(false);
        expect(fixture.calls.at(-1)!.expectedFailure).toBe(true);
        expect(fixture.outputs).toHaveLength(0);
        const trace: Trace = {
          toolCalls: fixture.calls,
          reasoning: [],
          rounds: 1,
          finalText: JSON.stringify({ status: "blocked", file: "", reason: String(failed.error) }),
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
          recovery: await fixture.evidence(),
        };
        expect(() => assertRecoveryOutcome(kind, trace)).not.toThrow();
        expect(() =>
          assertRecoveryOutcome(kind, {
            ...trace,
            finalText: JSON.stringify({ status: "completed", file: "never-written.mp4" }),
          }),
        ).toThrow();
      }
      if (kind === "many_parts") {
        const group = await joinParts(
          fixture,
          fixture.sources.slice(0, 8).map((source) => source.ref),
          "first-eight.mp4",
        );
        expect(group.ok, JSON.stringify(group)).toBe(true);
        const finished = await joinParts(
          fixture,
          [String(group.media_ref), ...fixture.sources.slice(8).map((source) => source.ref)],
          "all-thirteen.mp4",
        );
        expect(finished.ok, JSON.stringify(finished)).toBe(true);
        expect((await fixture.checkArtifact(fixture.outputs.at(-1)!.file)).problems).toEqual([]);
        const tooMany = await fixture.execute("run_ffmpeg", {
          inputs: fixture.sources.map((source) => source.ref),
          args: ["-i", "{in0}", "{out}"],
          output_name: "oversized.mp4",
        });
        expect(tooMany.ok).toBe(false);
        expect(fixture.calls.at(-1)!.expectedFailure).toBe(false);
        expect((await fixture.evidence()).unexpectedFailures).toBe(1);
      }
      if (kind === "mixed_parts") {
        const finished = await joinParts(
          fixture,
          fixture.sources.map((source) => source.ref),
          "normalized.mp4",
        );
        expect(finished.ok, JSON.stringify(finished)).toBe(true);
        expect((await fixture.checkArtifact(fixture.outputs.at(-1)!.file)).problems).toEqual([]);
      }
      if (kind === "queued_failure") {
        expect(fixture.outputs).toHaveLength(0);
        fixture.releaseQueuedFailure();
        const settled = await fixture.execute("manage_exports", { action: "list" });
        expect((settled.exports as { status: string }[])[0].status).toBe("failed");
      }
      await doc.close();
      await fsp.rm(project, { recursive: true, force: true });
    }
  }, 120_000);

  it("does not accept a queued job as a completed artifact", async () => {
    await runtime.recordClaim(JSON.stringify({ status: "completed", file: "not-written.mp4" }));
    expect((await runtime.evidence()).violations).toContain(
      "claimed a completed deliverable before a valid artifact existed",
    );
  });

  it("rejects dual mono masquerading as preserved stereo", async () => {
    const stereo = await joinParts(
      runtime,
      runtime.sources.map((source) => source.ref),
      "stereo-control.mp4",
    );
    expect(stereo.ok, JSON.stringify(stereo)).toBe(true);
    const collapsed = await runtime.execute("run_ffmpeg", {
      inputs: [String(stereo.media_ref)],
      args: [
        "-i",
        "{in0}",
        "-af",
        "pan=mono|c0=0.5*c0+0.5*c1,pan=stereo|c0=c0|c1=c0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "{out}",
      ],
      output_name: "dual-mono.mp4",
    });
    expect(collapsed.ok, JSON.stringify(collapsed)).toBe(true);
    const checked = await runtime.checkArtifact(runtime.outputs.at(-1)!.file);
    expect(checked.problems.some((problem) => problem.includes("channel separation"))).toBe(true);
  });

  it("regrades a retained deliverable in a fresh private project", async () => {
    const joined = await joinParts(
      runtime,
      runtime.sources.map((source) => source.ref),
      "regrade-source.mp4",
    );
    expect(joined.ok, JSON.stringify(joined)).toBe(true);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-recovery-offline-"));
    try {
      const context = recoveryContext(recoveryProjectDir(root));
      const fixture = new RecoveryRuntime("platform_limit", context);
      const file = path.join(root, "retained.mp4");
      await fsp.copyFile(runtime.outputs.at(-1)!.file, file);
      const checked = await fixture.checkArtifact(file);
      expect(checked.problems).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish an output after cancellation or close when the subprocess ignores cancellation", async () => {
    const joined = await joinParts(
      runtime,
      runtime.sources.map((source) => source.ref),
      "lifecycle-source.mp4",
    );
    expect(joined.ok, JSON.stringify(joined)).toBe(true);
    for (const stop of ["abort", "close"] as const) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-recovery-lifecycle-"));
      const context = recoveryContext(recoveryProjectDir(root));
      await fsp.mkdir(context.store.projectDir, { recursive: true });
      const doc = await openE2EDoc(context.store.projectDir);
      const controller = new AbortController();
      try {
        const source = path.join(context.store.projectDir, "source.mp4");
        await fsp.copyFile(runtime.outputs.at(-1)!.file, source);
        const ref = await libRef(context, source, "video");
        const catalog = path.join(context.store.projectDir, INTERNAL_DIR, "library.json");
        const before = await fsp.readFile(catalog);
        let wroteAfterStop = false;
        const result = await runFfmpegTool(
          {
            inputs: [ref],
            output_name: "cancelled-output.mp4",
            args: [
              "-i",
              "{in0}",
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-crf",
              "21",
              "-c:a",
              "aac",
              "{out}",
            ],
          },
          {
            ...context,
            signal: controller.signal,
            runner: {
              run: async (program, args, _signal, cwd) => {
                if (program === "ffmpeg") {
                  if (stop === "abort") controller.abort();
                  else await doc.close();
                }
                const outcome = await context.runner.run(program, args, undefined, cwd);
                if (program === "ffmpeg" && outcome.code === 0) {
                  wroteAfterStop = (await fsp.stat(args.at(-1)!)).size > 100;
                }
                return outcome;
              },
            },
          },
        ).catch(() => ({ ok: false }));
        expect(wroteAfterStop).toBe(true);
        expect(result.ok).toBe(false);
        expect((await fsp.readFile(catalog)).equals(before)).toBe(true);
      } finally {
        await doc.close();
        await fsp.rm(root, { recursive: true, force: true });
      }
    }
  });
});
