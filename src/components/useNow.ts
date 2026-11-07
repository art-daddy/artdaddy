import { useEffect, useState } from "react";

/** The time, refreshed every `everyMs` while `enabled`, so a "5 s ago" keeps moving without anything else changing. */
export function useNow(everyMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs, enabled]);
  return now;
}
