// What a running turn is waiting on right now, for the status line in the chat.
//
// Transient on purpose: none of it is saved with the conversation, and it describes the live turn
// only. The chat store feeds it at the three places a wait begins and ends (a model round, a tool
// call, an approval), and a tool that waits for speech says so itself (trackSpeechWait); the status
// line reads it and works out the words (components/waitStatus.ts).
import { create } from "zustand";

/** Where a model round is: building its request, sent and waiting for the first word, or writing. */
export type RoundPhase = "preparing" | "waiting" | "writing";

/** Why a sent round has not started answering when the model is not what it waits on: the connection is being re-made,
 *  or the server is still finishing the person's last request. */
export type RoundNote = "reconnecting" | "busy";

export interface LiveRound {
  phase: RoundPhase;
  startedAt: number;
  note?: RoundNote;
}

export interface LiveCall {
  id: string;
  name: string;
  startedAt: number;
}

/** A tool call that is waiting for speech to be transcribed, or for the speech model to download. */
export interface SpeechWait {
  id: number;
  tool: string;
}

interface LiveWaitState {
  round: LiveRound | null;
  /** Tool calls running now, in the order they began (an array: call ids are not ours to trust as keys). */
  calls: LiveCall[];
  /** Tools waiting on speech right now; a tool in here is waiting on transcription, not working. */
  speechWaits: SpeechWait[];
  /** When the turn began waiting for the person's answer to an approval, else null. */
  approvalSince: number | null;
  roundStarted: (now?: number) => void;
  roundSent: () => void;
  roundWriting: () => void;
  /** The request itself is waiting (or has stopped waiting: null). Ignored when no round is live. */
  roundNoted: (note: RoundNote | null) => void;
  roundEnded: () => void;
  callStarted: (id: string, name: string, now?: number) => void;
  callEnded: (id: string) => void;
  speechWaitStarted: (id: number, tool: string) => void;
  speechWaitEnded: (id: number) => void;
  approvalAsked: (now?: number) => void;
  /** The turn stopped to ask the person (an approval, or the continue cap): nothing is running. */
  pausedForInput: () => void;
  /** The turn is over, or retired. */
  clear: () => void;
}

const empty = (): Pick<LiveWaitState, "round" | "calls" | "speechWaits" | "approvalSince"> => ({
  round: null,
  calls: [],
  speechWaits: [],
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
      s.round && s.round.phase !== "writing"
        ? { round: { phase: "writing", startedAt: s.round.startedAt } } // words are arriving: nothing is being re-made
        : s,
    ),
  roundNoted: (note) =>
    set((s) => {
      if (!s.round || (s.round.note ?? null) === note) return s;
      const round: LiveRound = { phase: s.round.phase, startedAt: s.round.startedAt };
      if (note) round.note = note;
      return { round };
    }),
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
  speechWaitStarted: (id, tool) =>
    set((s) => ({ speechWaits: [...s.speechWaits.filter((w) => w.id !== id), { id, tool }] })),
  speechWaitEnded: (id) =>
    set((s) =>
      s.speechWaits.some((w) => w.id === id)
        ? { speechWaits: s.speechWaits.filter((w) => w.id !== id) }
        : s,
    ),
  approvalAsked: (now = Date.now()) => set({ approvalSince: now }),
  pausedForInput: () => set({ round: null, calls: [] }),
  clear: () => set(empty()),
}));

let lastSpeechWait = 0;

/** Marks `tool` as waiting on speech for as long as `wait` is pending, so the chat says
 *  "Transcribing the audio" rather than what the tool usually does. Hands `wait` back as it came.
 *  Each wait ends only itself: a wait cleared with its turn cannot end a later one. */
export function trackSpeechWait<T>(tool: string, wait: Promise<T>): Promise<T> {
  const id = ++lastSpeechWait;
  useLiveWait.getState().speechWaitStarted(id, tool);
  const end = (): void => useLiveWait.getState().speechWaitEnded(id);
  wait.then(end, end);
  return wait;
}

/** Tests only: back to nothing running. */
export function resetLiveWait(): void {
  useLiveWait.getState().clear();
}
