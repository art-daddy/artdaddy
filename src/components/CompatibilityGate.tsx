import { useEffect, useRef, useState, type ReactNode } from "react";
import { platform } from "../platform";
import { useAuth } from "../store/auth";
import { useCloseCoordinator } from "../store/closeCoordinator";
import { downloadUpdate } from "../update/updater";
import { compatibilityAllowsWork, useCompatibility } from "../update/compatibility";

export default function CompatibilityGate({ children }: { children: ReactNode }) {
  const status = useCompatibility((state) => state.status);
  const error = useCompatibility((state) => state.error);
  const check = useCompatibility((state) => state.check);
  const auth = useAuth((state) => state.status);
  const requestExit = useCloseCoordinator((state) => state.requestExit);
  const exitError = useCloseCoordinator((state) => state.exitError);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const activated = useRef(false);
  const allowed = platform.name !== "tauri" || status === "allowed";
  if (allowed) activated.current = true;
  useEffect(() => {
    if (platform.name === "tauri" && auth !== "checking" && auth !== "locked") void check();
  }, [auth, check]);
  useEffect(() => {
    const events = [
      "keydown",
      "keyup",
      "pointerdown",
      "click",
      "dblclick",
      "paste",
      "drop",
      "input",
      "change",
    ];
    const guard = (event: Event) => {
      if (compatibilityAllowsWork()) return;
      const target = event.target;
      const permitted =
        target instanceof Element &&
        target.closest("[data-compatibility-actions], [data-close-recovery]");
      if (!permitted) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (event instanceof KeyboardEvent) {
        event.stopImmediatePropagation();
      }
    };
    for (const event of events) window.addEventListener(event, guard, true);
    return () => {
      for (const event of events) window.removeEventListener(event, guard, true);
    };
  }, []);
  const required = status === "required";
  return (
    <>
      {activated.current && (
        <div className="h-full" hidden={!allowed} aria-hidden={!allowed}>
          {children}
        </div>
      )}
      {!allowed && (
        <div
          data-compatibility-actions
          className="flex h-full flex-col items-center justify-center gap-4 bg-panel p-6 text-sm"
          role="alert"
        >
          <h1 className="text-lg font-semibold">
            {required ? "ArtDaddy update required" : "Verifying ArtDaddy"}
          </h1>
          <p className="max-w-md text-center text-neutral-300">
            {required
              ? "This build can no longer be used. Update ArtDaddy to continue."
              : status === "checking"
                ? "Checking this build with the service."
                : "This build has not been verified. Connect and retry before continuing."}
          </p>
          {(failure || exitError || error) && (
            <p className="max-w-md break-words text-center text-red-400">
              {failure || exitError || error}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            {required && (
              <button
                className="rounded border border-accent px-4 py-2 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setFailure(null);
                  downloadUpdate()
                    .then(() => requestExit("update"))
                    .catch((cause: unknown) => setFailure(String(cause)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Downloading update..." : "Update"}
              </button>
            )}
            <button
              className="rounded border border-edge px-4 py-2 disabled:opacity-50"
              disabled={busy || status === "checking"}
              onClick={() => void check()}
            >
              Retry Check
            </button>
            <button
              className="rounded border border-edge px-4 py-2"
              disabled={busy}
              onClick={() => requestExit("quit")}
            >
              Quit
            </button>
          </div>
        </div>
      )}
    </>
  );
}
