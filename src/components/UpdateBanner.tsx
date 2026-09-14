import { useEffect, useState } from "react";

import { checkForUpdate, installUpdate, type UpdateInfo } from "../update/updater";

/** Unobtrusive "an update is ready" bar. Installing relaunches the app, so it is
 *  always the user's choice — never automatic mid-edit. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    void checkForUpdate().then((u) => {
      if (alive) setUpdate(u);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!update || dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-edge bg-accent/15 px-3 py-1.5 text-xs">
      <span className="truncate">
        Version {update.version} is available
        {error ? <span className="ml-2 text-red-400">— {error}</span> : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            installUpdate().catch((e: unknown) => {
              setError(String(e));
              setBusy(false);
            });
          }}
          className="rounded border border-accent/60 px-2 py-0.5 hover:bg-accent/30 disabled:opacity-50"
        >
          {busy ? "Installing…" : "Restart & update"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded px-2 py-0.5 text-neutral-400 hover:text-neutral-100"
        >
          Later
        </button>
      </div>
    </div>
  );
}
