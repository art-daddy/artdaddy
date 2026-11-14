// The assistant in the wake harness: a function of the request, written out, with no randomness and no network.
// It takes the person's message, or the tool results of the round before, and answers with tool calls or a
// short text. It knows the project's own files (their ids and names) and nothing else, so what it does after a
// wake depends only on the app: the files it looks at are the ones the wake names.
import type { InferBody } from "../agent/api";
import type { PendingCall, RoundResultDTO, ToolResultItem } from "../agent/types";
import { JOB_WAKE_LEAD } from "../store/jobNotes";
import type { WakeFile } from "./wakeFs";
import { wiring } from "./wakeWiring";

export type WakeTask = "look_at_every_file" | "add_captions";
export type LookAnswer = "not_ready" | "words" | "failed";
export type CaptionsAnswer = "pending" | "added" | "failed";

export interface ModelRecorder {
  /** The model was asked a round, and answered with this. */
  round(info: { kind: "tool_calls" | "text"; calls: number; wake: boolean }): void;
  /** What a look told the model about one file: for words, the words. */
  look(file: WakeFile, answer: LookAnswer, said: string): void;
  captions(answer: CaptionsAnswer, said: string): void;
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** What an `inspect_media` result tells the model about the words of the file. */
export function lookAnswerOf(result: Record<string, unknown>): {
  answer: LookAnswer;
  said: string;
} {
  if (result.ok === false) return { answer: "failed", said: String(result.error ?? "") };
  const transcript = rec(result.transcript);
  if (transcript.status === "in_progress")
    return { answer: "not_ready", said: String(transcript.note ?? "") };
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (segments.length > 0)
    return {
      answer: "words",
      said: segments.map((row) => (Array.isArray(row) ? String(row[0]) : "")).join(" "),
    };
  return {
    answer: "failed",
    said: String(transcript.note ?? transcript.error ?? "the look carried no words"),
  };
}

/** What an `add_captions` result tells the model. */
export function captionsAnswerOf(result: Record<string, unknown>): {
  answer: CaptionsAnswer;
  said: string;
} {
  if (result.ok === true)
    return { answer: "added", said: `${String(result.count ?? "")} captions` };
  if (result.pending === true) return { answer: "pending", said: String(result.error ?? "") };
  return { answer: "failed", said: String(result.error ?? "") };
}

const TEXT = {
  handBackLooks:
    "The words of these clips are not ready yet, so I have not looked at what is said. Ask me again in a few minutes.",
  handBackCaptions:
    "The speech in these clips is still being transcribed, so the captions are not on the timeline yet. Ask me again in a few minutes.",
  failed: "I could not read what is said in some of these clips.",
  captionsFailed: "The captions could not be added.",
  captionsAdded: "The captions are on the timeline.",
  workFinished: "The background work has finished.",
  words: (n: number): string =>
    `I have the words of all ${n} clips. Here is how I would cut the highlight reel from them.`,
};

const abortError = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });

export class ScriptedModel {
  private callSeq = 0;
  private wakeTurn = false;
  private readonly fileOfCall = new Map<string, WakeFile>();

  constructor(
    private readonly task: WakeTask,
    private readonly files: readonly WakeFile[],
    private readonly recorder: ModelRecorder,
    /** How long a round takes, in virtual ms. */
    private readonly roundMs: number,
  ) {}

  async infer(body: InferBody, signal?: AbortSignal): Promise<RoundResultDTO> {
    if (this.roundMs > 0) await this.think(this.roundMs, signal);
    if (signal?.aborted) throw abortError();
    const input = body.round_input;
    const message = [input.user_text, ...(input.extra_texts ?? [])]
      .filter((t): t is string => Boolean(t))
      .join("\n");
    return message ? this.answerMessage(message) : this.answerResults(input.tool_results ?? []);
  }

  private think(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private callsFor(
    name: string,
    args: Array<Record<string, unknown>>,
    files: WakeFile[] = [],
  ): RoundResultDTO {
    const pending: PendingCall[] = args.map((callArgs, i) => {
      const call: PendingCall = { call_id: `call_${++this.callSeq}`, name, arguments: callArgs };
      if (files[i]) this.fileOfCall.set(call.call_id, files[i]);
      return call;
    });
    this.recorder.round({ kind: "tool_calls", calls: pending.length, wake: this.wakeTurn });
    return this.round({ kind: "tool_calls", pending_calls: pending, finish_reason: "tool_calls" });
  }

  private say(text: string): RoundResultDTO {
    this.recorder.round({ kind: "text", calls: 0, wake: this.wakeTurn });
    return this.round({ kind: "text", final_text: text, finish_reason: "stop" });
  }

  private round(part: Partial<RoundResultDTO>): RoundResultDTO {
    return {
      kind: "text",
      pending_calls: [],
      final_text: "",
      error: "",
      finish_reason: "stop",
      usage: {},
      provider_snapshot: {},
      history_mode: "client",
      ...part,
    };
  }

  /** The person's message, or the app's wake. After a wake the model looks at the files the wake names (their
   *  ids or their file names, found in its text) and nothing it was not told about. */
  private answerMessage(message: string): RoundResultDTO {
    this.wakeTurn = message.includes(JOB_WAKE_LEAD);
    if (this.task === "add_captions") return this.callsFor("add_captions", [{}]);
    const files = this.wakeTurn
      ? this.files.filter(
          (f) =>
            message.includes(f.ref) || message.includes(f.filename) || message.includes(f.label),
        )
      : [...this.files];
    if (!files.length) return this.say(this.wakeTurn ? TEXT.workFinished : TEXT.failed);
    // wait_seconds 0: look at what is ready now, do not wait for the rest.
    return this.callsFor(
      "inspect_media",
      files.map((f) => ({ media_ref: f.ref, wait_seconds: 0 })),
      files,
    );
  }

  private answerResults(results: readonly ToolResultItem[]): RoundResultDTO {
    if (this.task === "add_captions") {
      const answers = results.map((r) => captionsAnswerOf(r.result));
      for (const a of answers) this.recorder.captions(a.answer, a.said);
      if (answers.some((a) => a.answer === "pending")) return this.say(TEXT.handBackCaptions);
      if (answers.every((a) => a.answer === "added")) return this.say(TEXT.captionsAdded);
      return this.say(TEXT.captionsFailed);
    }
    const answers = results.map((r) => ({
      file: this.fileOfCall.get(r.call_id),
      ...lookAnswerOf(r.result),
    }));
    for (const a of answers) if (a.file) this.recorder.look(a.file, a.answer, a.said);
    if (answers.some((a) => a.answer === "not_ready")) return this.say(TEXT.handBackLooks);
    if (answers.some((a) => a.answer === "failed")) return this.say(TEXT.failed);
    return this.say(TEXT.words(answers.length));
  }
}

/** The module the chat gets for `../agent/api`: both ways of asking for a round reach the scripted model. */
export function modelModule() {
  const model = (): ScriptedModel => {
    if (!wiring.model) throw new Error("no wake harness is running: the model has no script");
    return wiring.model;
  };
  return {
    inferRoundStreaming: (body: InferBody, _onDelta: unknown, signal?: AbortSignal) =>
      model().infer(body, signal),
    inferRound: (body: InferBody, signal?: AbortSignal) => model().infer(body, signal),
  };
}
