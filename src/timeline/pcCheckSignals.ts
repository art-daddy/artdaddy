// What the PC check needs to know about the person's hands and about playback, read from the page itself. The editor keeps no global answer for either (the stage's play
// button is a component's own state), so these watch the page: any key, click, scroll or touch is an input; a media element that is playing, or a playhead that keeps moving,
// is playback. Both fail soft: a signal that cannot be read says the editor is busy, which only keeps a check from starting.

export interface InputObserver {
  /** When the person last touched the page, on the clock the observer was given. Starts at the moment it was made: opening the app is an input. */
  lastInputAtMs(): number;
  dispose(): void;
}

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;
/** Pointer movement is the one frequent event: it is announced at most this often (the next announcement of anything reads the latest time). */
export const MOVE_ANNOUNCE_MS = 250;

/** Listens, passively and before the page's own handlers, on `target` (the window). `announce` is called when an input arrives (a pointer move at most every
 *  {@link MOVE_ANNOUNCE_MS}), so the check can stop at once; a failure in it is never the page's. */
export function observeInput(
  target: EventTarget | null | undefined,
  now: () => number,
  announce: () => void,
): InputObserver {
  let last = now();
  let announcedMove = Number.NEGATIVE_INFINITY;
  const heard = (event: Event): void => {
    try {
      const at = now();
      last = at;
      if (event.type === "pointermove") {
        if (at - announcedMove < MOVE_ANNOUNCE_MS) return;
        announcedMove = at;
      }
      announce();
    } catch {
      // The page's own handlers must never be disturbed by the check's.
    }
  };
  const options = { capture: true, passive: true } as const;
  try {
    for (const name of INPUT_EVENTS) target?.addEventListener(name, heard, options);
  } catch {
    // No page to listen on: nothing is ever heard, and the check waits for the one signal it has.
  }
  return {
    lastInputAtMs: () => last,
    dispose: () => {
      try {
        for (const name of INPUT_EVENTS) target?.removeEventListener(name, heard, options);
      } catch {
        // Nothing to take back.
      }
    },
  };
}

export interface PlaybackObserver {
  /** Whether a media element is playing, or the playhead moved lately. Reading it is also how the playhead is sampled, so it is read on every beat of the check's heartbeat. */
  playing(): boolean;
  dispose(): void;
}

/** A playhead that moved this recently is playing (or being dragged: the check waits for that too). A little over the heartbeat, so playback that is going on is seen on every beat. */
export const PLAYHEAD_ACTIVE_MS = 1_500;

const STARTS = ["play", "playing"] as const;
const STOPS = ["pause", "ended", "emptied", "abort", "error"] as const;

interface MediaLike {
  paused?: unknown;
  ended?: unknown;
  isConnected?: unknown;
}

/** Playback is the media elements of the page that are playing (a `play` event does not bubble, so it is heard in the capture phase on `target`, the document) and the editor's
 *  playhead moving on its own (the stage plays on a canvas and an audio engine, with no media element to hear). */
export function observePlayback(options: {
  target: EventTarget | null | undefined;
  /** The open project's playhead in seconds, or null when none is open. */
  playhead: () => number | null;
  now: () => number;
}): PlaybackObserver {
  const { target, playhead, now } = options;
  const playingNow = new Set<MediaLike>();
  let lastHead: number | null = null;
  let movedAt = Number.NEGATIVE_INFINITY;
  const started = (event: Event): void => {
    const element = event.target as MediaLike | null;
    if (element && typeof element === "object") playingNow.add(element);
  };
  const stopped = (event: Event): void => {
    const element = event.target as MediaLike | null;
    if (element) playingNow.delete(element);
  };
  const capture = { capture: true } as const;
  try {
    for (const name of STARTS) target?.addEventListener(name, started, capture);
    for (const name of STOPS) target?.addEventListener(name, stopped, capture);
  } catch {
    // No page to listen on: only the playhead tells.
  }
  return {
    playing: () => {
      try {
        for (const element of [...playingNow]) {
          // An element that was taken out of the page, or stopped without saying so, is not playing.
          if (element.paused === true || element.ended === true || element.isConnected === false)
            playingNow.delete(element);
        }
        if (playingNow.size > 0) return true;
        const head = playhead();
        if (typeof head !== "number" || !Number.isFinite(head)) {
          lastHead = null;
          return false;
        }
        const at = now();
        if (lastHead !== null && head !== lastHead) movedAt = at;
        lastHead = head;
        return at - movedAt <= PLAYHEAD_ACTIVE_MS;
      } catch {
        return true;
      }
    },
    dispose: () => {
      try {
        for (const name of STARTS) target?.removeEventListener(name, started, capture);
        for (const name of STOPS) target?.removeEventListener(name, stopped, capture);
      } catch {
        // Nothing to take back.
      }
      playingNow.clear();
    },
  };
}
