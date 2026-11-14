import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetJobNotes,
  flushJobNotes,
  notifyJobSettled,
  pendingJobNotes,
  registerJobSink,
  SETTLE_WINDOW_MS,
  unregisterJobSink,
  type SettledJob,
} from "./jobNotes";

const A = "C:/proj/a";
const B = "C:/proj/b";

const job = (id: string, over: Partial<SettledJob> = {}): SettledJob => ({
  id,
  tool: "generate_image",
  label: "an image",
  status: "done",
  startedBy: "chat",
  ...over,
});

function sink(idle = true) {
  const deliveries: SettledJob[][] = [];
  const s = {
    idle,
    isIdle: () => s.idle,
    deliver: (jobs: SettledJob[]) => deliveries.push(jobs),
    deliveries,
  };
  return s;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  __resetJobNotes();
  vi.useRealTimers();
});

describe("job completion notes", () => {
  it("wakes the chat once the settling window closes", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1"));
    expect(s.deliveries).toHaveLength(0); // not immediately

    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[job("j1")]]);
  });

  // The reason coalescing exists: the model is told to parallelize independent gens.
  it("wakes ONCE for several jobs finishing together", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(400);
    notifyJobSettled(A, job("j2"));
    vi.advanceTimersByTime(400);
    notifyJobSettled(A, job("j3"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveries[0].map((j) => j.id)).toEqual(["j1", "j2", "j3"]);
  });

  // A sliding window would let a steady stream postpone the wake forever.
  it("measures the window from the FIRST completion, not the last", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1"));
    for (let t = 0; t < SETTLE_WINDOW_MS; t += 300) {
      vi.advanceTimersByTime(300);
      notifyJobSettled(A, job(`x${t}`));
    }

    expect(s.deliveries).toHaveLength(1);
  });

  it("holds a completion that lands mid-turn, and delivers it when the turn ends", () => {
    const s = sink(false); // a turn is running
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toHaveLength(0);
    expect(pendingJobNotes(A)).toHaveLength(1);

    s.idle = true;
    flushJobNotes(A);
    expect(s.deliveries).toEqual([[job("j1")]]);
  });

  it("keeps a completion that lands with no chat attached, and delivers it on reopen", () => {
    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(pendingJobNotes(A)).toHaveLength(1);

    const s = sink();
    registerJobSink(A, s);

    expect(s.deliveries).toEqual([[job("j1")]]);
  });

  it("survives the project being detached and re-attached", () => {
    const first = sink();
    registerJobSink(A, first);
    unregisterJobSink(A);

    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    const second = sink();
    registerJobSink(A, second);
    expect(first.deliveries).toHaveLength(0);
    expect(second.deliveries).toEqual([[job("j1")]]);
  });

  it("delivers each completion exactly once", () => {
    const s = sink();
    registerJobSink(A, s);
    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    flushJobNotes(A);
    flushJobNotes(A);

    expect(s.deliveries).toHaveLength(1);
  });

  // deliver() starts a turn; anything landing during it must wait for the next wake.
  it("queues a completion that arrives DURING delivery instead of losing it", () => {
    const deliveries: SettledJob[][] = [];
    const s = {
      isIdle: () => true,
      deliver: (jobs: SettledJob[]) => {
        deliveries.push(jobs);
        if (deliveries.length === 1) notifyJobSettled(A, job("late"));
      },
    };
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(deliveries[0].map((j) => j.id)).toEqual(["j1"]);

    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(deliveries[1].map((j) => j.id)).toEqual(["late"]);
  });

  it("wakes the agent for a FAILURE too", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("j1", { status: "failed", error: "content filter" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(s.deliveries[0][0]).toMatchObject({ status: "failed", error: "content filter" });
  });

  it("never delivers one project's completions to another", () => {
    const sa = sink();
    const sb = sink();
    registerJobSink(A, sa);
    registerJobSink(B, sb);

    notifyJobSettled(A, job("ja"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(sa.deliveries[0].map((j) => j.id)).toEqual(["ja"]);
    expect(sb.deliveries).toHaveLength(0);
  });
});

// The Export menu and an external MCP agent both run the SAME tools this chat calls, so the queue
// could not tell them apart and every one of their completions resumed the chat with "background
// work YOU started has finished ... continue what you were doing". Measured on one real project:
// 12 exports nobody in the chat asked for, 8 unattended billed rounds, and the woken model editing
// a timeline the other driver was editing at that moment.
describe("only work THIS chat started may resume it", () => {
  it("does not wake the chat for a job another driver started", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("menu-export", { tool: "export", startedBy: "elsewhere" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(s.deliveries).toHaveLength(0);
    expect(pendingJobNotes(A)).toHaveLength(0); // dropped, not merely withheld
  });

  it("does not let another driver's job open the window a chat job then waits behind", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(A, job("mcp-export", { startedBy: "elsewhere" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS - 100);
    notifyJobSettled(A, job("chat-gen"));
    // The chat job opens its OWN window; it must not inherit the 100ms left of a window it
    // never shared, nor deliver early.
    vi.advanceTimersByTime(100);
    expect(s.deliveries).toHaveLength(0);

    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[job("chat-gen")]]);
  });

  it("stays quiet for another driver's FAILURE too — whoever started it already knows", () => {
    const s = sink();
    registerJobSink(A, s);

    notifyJobSettled(
      A,
      job("j1", { status: "failed", error: "disk full", startedBy: "elsewhere" }),
    );
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(s.deliveries).toHaveLength(0);
  });
});

// The transcript wake asks the sink when it is about to deliver, because a draft, the balance and the hourly cap
// can all change between queueing and delivery. Exports and generations are never asked and never held.
describe("a job with its own delivery rules is asked at the moment of delivery", () => {
  type Verdict = "deliver" | "hold" | "drop";
  const words = (id: string): SettledJob =>
    job(id, { tool: "inspect_media", label: "the words of 2 files", kind: "words" });

  function guardedSink(verdict: () => Verdict) {
    const deliveries: SettledJob[][] = [];
    const asked: string[] = [];
    const s = {
      idle: true,
      isIdle: () => s.idle,
      deliver: (jobs: SettledJob[]) => deliveries.push(jobs),
      admit: (j: SettledJob): Verdict => {
        asked.push(j.id);
        return verdict();
      },
      deliveries,
      asked,
    };
    return s;
  }

  it("delivers a words job the sink admits", () => {
    const s = guardedSink(() => "deliver");
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[words("w1")]]);
    expect(s.asked).toEqual(["w1"]);
  });

  it("keeps a held words job queued and delivers it once a later flush finds it admissible", () => {
    let verdict: Verdict = "hold";
    const s = guardedSink(() => verdict);
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toHaveLength(0);
    expect(pendingJobNotes(A)).toEqual([words("w1")]);

    flushJobNotes(A); // still held
    expect(s.deliveries).toHaveLength(0);
    verdict = "deliver";
    flushJobNotes(A);
    expect(s.deliveries).toEqual([[words("w1")]]);
    expect(pendingJobNotes(A)).toHaveLength(0);
  });

  it("forgets a words job the sink drops: nothing is delivered now or later", () => {
    const s = guardedSink(() => "drop");
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toHaveLength(0);
    expect(pendingJobNotes(A)).toHaveLength(0);
    flushJobNotes(A);
    expect(s.deliveries).toHaveLength(0);
  });

  it("never asks about, and never holds back, an export or a generation", () => {
    const s = guardedSink(() => "drop");
    registerJobSink(A, s);
    notifyJobSettled(A, job("export-1", { tool: "export" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[job("export-1", { tool: "export" })]]);
    expect(s.asked).toEqual([]);
  });

  it("delivers what is admissible and keeps what is held, in one flush", () => {
    const s = guardedSink(() => "hold");
    registerJobSink(A, s);
    notifyJobSettled(A, job("export-1", { tool: "export" }));
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[job("export-1", { tool: "export" })]]);
    expect(pendingJobNotes(A)).toEqual([words("w1")]);
  });

  it("does not ask while the chat is busy, and asks when it is idle again", () => {
    const s = guardedSink(() => "deliver");
    s.idle = false;
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.asked).toEqual([]);
    expect(s.deliveries).toHaveLength(0);
    s.idle = true;
    flushJobNotes(A);
    expect(s.asked).toEqual(["w1"]);
    expect(s.deliveries).toEqual([[words("w1")]]);
  });

  it("delivers a words job like any other when the sink has no rule for it", () => {
    const s = sink();
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    expect(s.deliveries).toEqual([[words("w1")]]);
  });

  it("queues a job that arrives during delivery for the next flush, held jobs included", () => {
    const verdicts: Verdict[] = ["hold", "deliver"];
    const s = guardedSink(() => verdicts.shift() ?? "deliver");
    registerJobSink(A, s);
    notifyJobSettled(A, words("w1"));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS); // w1 held
    notifyJobSettled(A, job("export-2", { tool: "export" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);
    // the export goes now; w1 is asked again in the same flush and is admitted
    expect(
      s.deliveries
        .flat()
        .map((j) => j.id)
        .sort(),
    ).toEqual(["export-2", "w1"]);
    expect(pendingJobNotes(A)).toHaveLength(0);
  });
});
