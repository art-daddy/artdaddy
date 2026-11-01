// What a running turn is waiting on right now, for the status line in the chat.
//
// Transient on purpose: none of it is saved with the conversation, and it describes the live turn
// only. The chat store feeds it at the three places a wait begins and ends (a model round, a tool
// call, an approval); the status line reads it and works out the words (components/waitStatus.ts).
import { create } from "zustand";

/** Where a model round is: building its request, sent and waiting for the first word, or writing. */
export type RoundPhase = "preparing" | "waiting" | "writing";

export interface LiveRound {
  phase: RoundPhase;
  startedAt: number;
}

export interface LiveCall {
  id: string;
  name: string;
  startedAt: number;
}

interface LiveWaitState {
  round: LiveRound | null;
  /** Tool calls running now, in the order they began (an array: call ids are not ours to trust as keys). */
  calls: LiveCall[];
  /** When the turn began waiting for the person's answer to an approval, else null. */
  approvalSince: number | null;
  roundStarted: (now?: number) => void;
  roundSent: () => void;
  roundWriting: () => void;
  roundEnded: () => void;
  callStarted: (id: string, name: string, now?: number) => void;
  callEnded: (id: string) => void;
  approvalAsked: (now?: number) => void;
  /** The turn stopped to ask the person (an approval, or the continue cap): nothing is running. */
  pausedForInput: () => void;
  /** The turn is over, or retired. */
  clear: () => void;
}

const empty = (): Pick<LiveWaitState, "round" | "calls" | "approvalSince"> => ({
  round: null,
  calls: [],
  approvalSince: null,
});

export const useLiveWait = create<LiveWaitState>((set) => ({
  ...empty(),
  roundStarted: (now = Date.now()) =>
    set({ round: { phase: "preparing", startedAt: now }, approvalSince: null }),
  roundSent: () =>
    set((s) => (s.round?.phase === "preparing" ? { round: { ...s.round, phase: "waiting" } } : s)),
  roundWriting: () =>
    set((s) =>
      s.round && s.round.phase !== "writing" ? { round: { ...s.round, phase: "writing" } } : s,
    ),
  roundEnded: () => set((s) => (s.round ? { round: null } : s)),
  callStarted: (id, name, now = Date.now()) =>
    set((s) => ({
      calls: [...s.calls.filter((c) => c.id !== id), { id, name, startedAt: now }],
      approvalSince: null,
    })),
  callEnded: (id) =>
    set((s) =>
      s.calls.some((c) => c.id === id) ? { calls: s.calls.filter((c) => c.id !== id) } : s,
    ),
  approvalAsked: (now = Date.now()) => set({ approvalSince: now }),
  pausedForInput: () => set({ round: null, calls: [] }),
  clear: () => set(empty()),
}));

/** Tests only: back to nothing running. */
export function resetLiveWait(): void {
  useLiveWait.getState().clear();
}
