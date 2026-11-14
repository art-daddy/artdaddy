// Cancel on the top-bar chip (S2-05): it stops ONE run and nothing else, and what the run's callers are then
// told is that the person stopped it, never that anything failed. Driven through the REAL transcription
// path (`runWhisper`, `engineFor`, the job supervisor, the work gate) with a fake app process whose jobs a
// test plays: what is checked is what the process is asked to do, what stays on disk, what the store of jobs
// says, and what each tool answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportAppError, reportTranscription } = vi.hoisted(() => ({
  reportAppError: vi.fn(),
  reportTranscription: vi.fn(),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportAppError,
  reportTranscription,
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));

import { __resetExportFlags } from "../api/exportFlags";
import { __resetSpeechJobs, cancelSpeechJob, useSpeechJobs } from "../store/speechJobs";
import { FakeJobs } from "../test/fakeJobs";
import { DIR, flagValues, freshSource, speechRig, transcriptJson } from "../test/speechRig";
import { buildTranscript } from "./inspect";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "./jobSupervisor";
import { __resetSpeechSession } from "./speechAdmission";
import { cpuOnlyNow } from "./speechBackend";
import { isSpeechCancelled } from "./speechFailure";
import { __resetPlanLog } from "./speechPlanLog";
import { getTranscriptTool, peekTranscript, runWhisper } from "./transcribe";
import { __resetWaiting } from "./transcriptWait";
import { __resetWorkGate } from "./workGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CRASH = -1073740791; // 0xC0000409, the exit the chip's crash is known for
const GPU_LOG =
  "ggml_vulkan: Found 1 Vulkan devices:\nwhisper_init_from_file_with_params_no_state: loading model\n";
const ADVICE = /person stopped this transcription in the app\. Do not start it again unless/;

let jobs: FakeJobs;
beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
  __resetWaiting();
  reportAppError.mockClear();
  reportTranscription.mockClear();
  jobs = new FakeJobs();
  __setJobSupervisor(jobs);
});
afterEach(() => __resetJobSupervisor());

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(pred()).toBe(true);
}
const listed = () => useSpeechJobs.getState().jobs;
/** The process of job `spec` ends having written its transcript. */
async function finish(
  rig: ReturnType<typeof speechRig>,
  spec: JobSpec,
  text = "hello",
): Promise<void> {
  rig.texts.set(`${spec.args[spec.args.indexOf("-of") + 1]}.json`, transcriptJson(text));
  rig.files.add(`${spec.args[spec.args.indexOf("-of") + 1]}.json`);
  jobs.exit(spec.id, 0, "");
}
const whisperJobs = (): JobSpec[] => jobs.submitted.filter((s) => s.program === "whisper-cli");

describe("Cancel on one run", () => {
  it("stops the run it was pressed for and no other: with two going, only the named process dies", async () => {
    const rig = speechRig();
    const [a, b] = [freshSource(), freshSource()];
    const background = runWhisper(rig.ctx({ background: true }), a).catch((e: unknown) => e);
    const look = runWhisper(rig.ctx(), b);
    await until(() => whisperJobs().length === 2);
    const [first, second] = whisperJobs();
    expect(listed().map((j) => j.id)).toEqual([first.id, second.id]);
    expect(cancelSpeechJob(first.id)).toBe(true);
    expect(isSpeechCancelled(await background)).toBe(true);
    // The other one was not touched: it is still running, and it finishes with its words.
    expect(jobs.killed).toEqual([first.id]);
    expect(jobs.view(second.id)?.state).toBe("running");
    await finish(rig, second, "other");
    expect((await look).words.map((w) => w.word)).toEqual(["other"]);
    // The store tells the chip so: the stopped one stays for a moment as stopped, the finished one is gone.
    expect(listed().map((j) => [j.id, j.phase, j.stop])).toEqual([
      [first.id, "stopped", "cancelled"],
    ]);
  });

  it("is answered as the person's cancel, keeps nothing and leaves nothing: no words, no scratch, no report", async () => {
    const rig = speechRig();
    const src = freshSource();
    const run = runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    await until(() => whisperJobs().length === 1);
    // A half-written output, as a process killed while it wrote would leave.
    const [spec] = whisperJobs();
    const json = `${spec.args[spec.args.indexOf("-of") + 1]}.json`;
    rig.files.add(json);
    rig.texts.set(json, '{"result":{"language":"en"},"transcr');
    cancelSpeechJob(spec.id);
    const error = await run;
    expect(isSpeechCancelled(error)).toBe(true);
    expect((error as Error).message).toMatch(ADVICE);
    expect(await peekTranscript(rig.ctx(), src)).toBeNull();
    expect(rig.leftovers()).toEqual([]);
    expect(reportAppError).not.toHaveBeenCalled();
    expect(reportTranscription).not.toHaveBeenCalled();
    expect(jobs.forgotten).toEqual([spec.id]);
  });

  // The opposite order of the obvious one: the process crashed as the cancel came. It exits non-zero with
  // the chip's crash status and the chip's log, which is exactly what a crash of the chip looks like.
  it("is not taken for a crash of the graphics chip, whatever status the stopped process exits with", async () => {
    const rig = speechRig();
    const src = freshSource();
    const run = runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    jobs.exit(spec.id, CRASH, GPU_LOG); // it died by itself...
    cancelSpeechJob(spec.id); // ...as the person pressed Cancel
    expect(isSpeechCancelled(await run)).toBe(true);
    expect(whisperJobs(), "no automatic retry with the chip off").toHaveLength(1);
    expect(cpuOnlyNow(), "no hold on the chip").toBe(false);
    expect(reportAppError).not.toHaveBeenCalled();
    expect(await peekTranscript(rig.ctx(), src)).toBeNull();
  });

  it("during the retry that the chip's crash caused, stops that retry: no hold, no crash report, and the first run's job is not the one named", async () => {
    const rig = speechRig();
    const src = freshSource();
    jobs.onStart = (spec) => {
      if (whisperJobs()[0]?.id === spec.id)
        queueMicrotask(() => jobs.exit(spec.id, CRASH, GPU_LOG));
    };
    const run = runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    await until(() => whisperJobs().length === 2);
    const [first, retry] = whisperJobs();
    expect(retry.args).toContain("-ng");
    expect(cancelSpeechJob(first.id), "the crashed run has ended: nothing to stop there").toBe(
      false,
    );
    expect(listed().map((j) => j.id)).toEqual([retry.id]);
    expect(listed()[0].facts).toMatchObject({ backend: "cpu", gpuHeld: true });
    expect(cancelSpeechJob(retry.id)).toBe(true);
    expect(isSpeechCancelled(await run)).toBe(true);
    expect(jobs.killed).toEqual([retry.id]);
    expect(whisperJobs()).toHaveLength(2);
    expect(cpuOnlyNow(), "the retry never worked, so nothing is remembered").toBe(false);
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("is nothing after the run has finished, and once however many times it is pressed", async () => {
    const rig = speechRig();
    const src = freshSource();
    const run = runWhisper(rig.ctx({ background: true }), src);
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    expect(cancelSpeechJob(spec.id)).toBe(true);
    expect(cancelSpeechJob(spec.id), "twice").toBe(true); // still registered until the page hears it end
    await expect(run).rejects.toMatchObject({ code: "speech_cancelled" });
    expect(jobs.killed, "one kill").toEqual([spec.id]);
    expect(cancelSpeechJob(spec.id), "after it ended").toBe(false);

    const src2 = freshSource();
    const done = runWhisper(rig.ctx({ background: true }), src2);
    await until(() => whisperJobs().length === 2);
    const second = whisperJobs()[1];
    await finish(rig, second);
    await done;
    expect(cancelSpeechJob(second.id), "after it finished").toBe(false);
    expect(jobs.killed).toEqual([spec.id]);
    expect(await peekTranscript(rig.ctx(), src2)).not.toBeNull();
  });

  it("is nothing for a run that is still waiting for its turn: there is no process yet", async () => {
    const rig = speechRig();
    const [a, b] = [freshSource(), freshSource()];
    const first = runWhisper(rig.ctx(), a);
    const waiting = runWhisper(rig.ctx(), b); // a look runs after the look before it
    await until(() => whisperJobs().length === 1);
    expect(listed()).toHaveLength(1);
    expect(cancelSpeechJob("whisper-not-launched-yet")).toBe(false);
    expect(jobs.killed).toEqual([]);
    await finish(rig, whisperJobs()[0], "first");
    await first;
    await until(() => whisperJobs().length === 2);
    await finish(rig, whisperJobs()[1], "second");
    expect((await waiting).words.map((w) => w.word)).toEqual(["second"]);
  });

  it("ends with the caller's own Stop too: either one ends the job", async () => {
    const rig = speechRig();
    const stop = new AbortController();
    const run = runWhisper(rig.ctx({ signal: stop.signal }), freshSource()).catch(
      (e: unknown) => e,
    );
    await until(() => whisperJobs().length === 1);
    stop.abort();
    expect(((await run) as Error).message).toMatch(/transcription cancelled/);
    expect(jobs.killed).toEqual([whisperJobs()[0].id]);
    expect(isSpeechCancelled(await run), "Stop is the caller's, not the person's Cancel").toBe(
      false,
    );
  });

  it("leaves a request for the same stretch free to run it again: only that window, never the whole file", async () => {
    const rig = speechRig();
    const src = freshSource();
    const span = { start: 100, end: 160 };
    const first = runWhisper(rig.ctx(), src, "small", undefined, span).catch((e: unknown) => e);
    await until(() => whisperJobs().length === 1);
    cancelSpeechJob(whisperJobs()[0].id);
    expect(isSpeechCancelled(await first)).toBe(true);
    const again = runWhisper(rig.ctx(), src, "small", undefined, span);
    await until(() => whisperJobs().length === 2);
    const spec = whisperJobs()[1];
    const wav = flagValues(spec.args, "-f")[0];
    expect(rig.sourceOf(wav)).toBe(src);
    expect(rig.programs.filter((p) => p === "ffmpeg")).toHaveLength(2);
    await finish(rig, spec, "window");
    expect((await again).words.map((w) => w.word)).toEqual(["window"]);
  });
});

describe("what a tool answers when the person stopped the run", () => {
  const timeline = (ref: string): string =>
    JSON.stringify({
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "a1",
          kind: "audio",
          clips: [
            {
              id: "c1",
              media_ref: ref,
              source_in: 0,
              source_out: 300,
              timeline_in: 0,
              timeline_out: 300,
            },
          ],
        },
      ],
    });

  it("inspect_media: the reason, the sentence and the advice, nothing in progress, nothing reported", async () => {
    const rig = speechRig();
    const src = freshSource();
    const look = buildTranscript(rig.ctx(), src, {
      start: null,
      end: 30,
      duration: 30,
      wordTimestamps: false,
      language: "",
      waitMs: 15_000,
    });
    await until(() => whisperJobs().length === 1);
    cancelSpeechJob(whisperJobs()[0].id);
    const got = (await look) as Any;
    expect(got).toMatchObject({ status: "failed", reason: "cancelled" });
    expect(String(got.note)).toMatch(ADVICE);
    expect(got.status).not.toBe("in_progress");
    expect(JSON.stringify(got)).not.toMatch(/call .* again|ask again|try again later/i);
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("get_transcript: ok false with the reason cancelled and the advice, not an in-progress note and not a tool failure", async () => {
    const rig = speechRig();
    const ref = freshSource();
    rig.texts.set(`${DIR}/internals/timeline.json`, timeline(ref));
    rig.files.add(`${DIR}/internals/timeline.json`);
    const call = getTranscriptTool({}, rig.ctx()) as Promise<Any>;
    await until(() => whisperJobs().length === 1);
    cancelSpeechJob(whisperJobs()[0].id);
    const got = await call;
    expect(got).toMatchObject({ ok: false, reason: "cancelled" });
    expect(String(got.error)).toMatch(ADVICE);
    expect(String(got.error)).not.toMatch(/tool failure/i);
    expect(got.in_progress).toBeUndefined();
    expect(got.note).toBeUndefined();
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("get_transcript: asked again for the same stretch it runs that stretch again, because somebody asked", async () => {
    const rig = speechRig();
    const ref = freshSource();
    rig.texts.set(`${DIR}/internals/timeline.json`, timeline(ref));
    rig.files.add(`${DIR}/internals/timeline.json`);
    const first = getTranscriptTool({}, rig.ctx()) as Promise<Any>;
    await until(() => whisperJobs().length === 1);
    cancelSpeechJob(whisperJobs()[0].id);
    await first;
    const again = getTranscriptTool({}, rig.ctx()) as Promise<Any>;
    await until(() => whisperJobs().length === 2);
    await finish(rig, whisperJobs()[1], "back");
    const got = await again;
    expect(got.ok).toBe(true);
    expect(got.clips[0].words.map((w: Any[]) => w[1])).toEqual(["back"]);
  });

  // The person pressed Cancel on the run of the first window (F6a): the next window is not started at once, in
  // the face of their click, and the answer is the cancel's for every clip, so the assistant does not start it.
  it("get_transcript: after the person stopped the first of three windows the other two are not started, and every clip is answered as stopped", async () => {
    const rig = speechRig();
    const refs = [freshSource(), freshSource(), freshSource()];
    const clip = (id: string, ref: string, at: number) => ({
      id,
      media_ref: ref,
      source_in: 0,
      source_out: 300,
      timeline_in: at,
      timeline_out: at + 300,
    });
    rig.texts.set(
      `${DIR}/internals/timeline.json`,
      JSON.stringify({
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          {
            id: "a1",
            kind: "audio",
            clips: refs.map((ref, i) => clip(`c${i + 1}`, ref, i * 300)),
          },
        ],
      }),
    );
    rig.files.add(`${DIR}/internals/timeline.json`);
    let settled = false;
    const call = (getTranscriptTool({}, rig.ctx()) as Promise<Any>).finally(() => {
      settled = true;
    });
    // Cancel every run the moment it exists, as a person pressing Cancel on whatever the chip shows would
    const pressed = new Set<string>();
    for (let i = 0; i < 1000 && !settled; i++) {
      for (const spec of whisperJobs())
        if (!pressed.has(spec.id)) {
          pressed.add(spec.id);
          cancelSpeechJob(spec.id);
        }
      await new Promise((r) => setTimeout(r, 2));
    }
    const got = await call;
    expect(whisperJobs(), "only the first window was ever started").toHaveLength(1);
    expect(got).toMatchObject({ ok: false, reason: "cancelled" });
    expect(String(got.error)).toMatch(ADVICE);
    expect(got.failed.map((f: Any) => f.clip_id)).toEqual(["c1", "c2", "c3"]);
    expect(got.in_progress).toBeUndefined();
    expect(reportAppError).not.toHaveBeenCalled();
  });
});
