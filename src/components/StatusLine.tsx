import { useEffect, useState } from "react";

import { useLiveWait } from "../store/liveWait";
import { Spinner } from "./ui";
import { clockText, waitStatus } from "./waitStatus";

/** Re-reads the clock every second while mounted, so an elapsed time advances without the turn
 *  having to say anything. */
function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The line under a running turn: what it is waiting on, for how long, and after half a minute that
 *  it is still going and Stop is there. */
export default function StatusLine() {
  const round = useLiveWait((s) => s.round);
  const calls = useLiveWait((s) => s.calls);
  const approvalSince = useLiveWait((s) => s.approvalSince);
  const now = useNow();
  const status = waitStatus({ round, calls, approvalSince, now });

  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="status-line">
      <div className="flex items-center gap-2">
        {status?.kind === "approval" ? null : <Spinner />}
        <span role="status" className={status?.kind === "approval" ? "text-amber-300" : "shimmer"}>
          {status ? `${status.label}…` : "working…"}
        </span>
        {status?.showElapsed && (
          <span aria-hidden className="tabular-nums text-neutral-500">
            {clockText(status.elapsedS)}
          </span>
        )}
      </div>
      {status?.hint && <p className="pl-6 text-[11px] text-neutral-500">{status.hint}</p>}
    </div>
  );
}
