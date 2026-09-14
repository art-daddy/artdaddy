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

    notifyJobSettled(A, job("j1", { status: "failed", error: "disk full", startedBy: "elsewhere" }));
    vi.advanceTimersByTime(SETTLE_WINDOW_MS);

    expect(s.deliveries).toHaveLength(0);
  });
});
