import { useEffect, useState } from "react";

import { useCloseCoordinator } from "../store/closeCoordinator";
import { checkForUpdate, downloadUpdate, type UpdateInfo } from "../update/updater";

/** Unobtrusive "an update is ready" bar. Installing relaunches the app, so it is
 *  always the user's choice — never automatic mid-edit. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const restarting = useCloseCoordinator((s) => s.exitIntent === "update");
  const exitError = useCloseCoordinator((s) => s.exitError);
  const requestExit = useCloseCoordinator((s) => s.requestExit);
  const busy = downloading || restarting;
  const shown = error ?? exitError;

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
        {shown ? <span className="ml-2 text-red-400">— {shown}</span> : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            setDownloading(true);
            // Download while the project stays open; only then leave through the exit door, which
            // asks about unsaved edits and closes the project before the installer runs.
            downloadUpdate()
              .then(() => requestExit("update"))
              .catch((e: unknown) => setError(String(e)))
              .finally(() => setDownloading(false));
          }}
          className="rounded border border-accent/60 px-2 py-0.5 hover:bg-accent/30 disabled:opacity-50"
        >
          {downloading ? "Downloading…" : restarting ? "Restarting…" : "Restart & update"}
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
