// React binding for the Transport clock: runs a requestAnimationFrame loop while
// playing and re-renders each frame. Browser-only glue (rAF); the clock logic
// itself is the unit-tested Transport. Excluded from unit coverage.
import { useCallback, useEffect, useReducer, useRef } from "react";

import { Transport } from "./transport";

export interface Playback {
  time: number;
  playing: boolean;
  duration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
}

export function usePlayback(duration: number): Playback {
  const [, bump] = useReducer((n: number) => (n + 1) % 1_000_000, 0);
  const ref = useRef<Transport | null>(null);
  if (ref.current === null) ref.current = new Transport(duration);
  const t = ref.current;

  useEffect(() => {
    t.setDuration(duration);
    bump();
  }, [duration, t]);

  useEffect(() => {
    if (!t.playing) return;
    let raf = 0;
    let last = 0;
    const loop = (ts: number): void => {
      if (last) t.tick(ts - last);
      last = ts;
      bump();
      if (t.playing) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [t, t.playing]);

  const play = useCallback(() => {
    t.play();
    bump();
  }, [t]);
  const pause = useCallback(() => {
    t.pause();
    bump();
  }, [t]);
  const toggle = useCallback(() => {
    t.toggle();
    bump();
  }, [t]);
  const seek = useCallback(
    (v: number) => {
      t.seek(v);
      bump();
    },
    [t],
  );

  return { time: t.time, playing: t.playing, duration: t.duration, play, pause, toggle, seek };
}
