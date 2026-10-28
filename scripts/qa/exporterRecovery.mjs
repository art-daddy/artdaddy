// Starting the recovery instance after the first instance of the owned app was killed (see exporterNative.mjs).
//
// The app is single-instance. taskkill returns before the killed process is fully torn down (an export leaves ffmpeg and web-view
// children to unwind), and a recovery instance that starts in that window sees the old one, hands over to it and exits 0 within seconds:
// two of sixteen back-to-back pilots on 2026-10-23 ended that way with "Owned native QA exited before its outcome: code=0". That is the
// OS finishing a kill, not a product outcome, so the recovery instance is started again, three tries in all. Any other exit, an exit
// after the window, or a last quick exit 0 is reported exactly as before, and every handover is recorded in the proof steps.
export const RECOVERY_HANDOVER_WINDOW_MS = 30_000;
export const RECOVERY_TRIES = 3;
export const RECOVERY_RETRY_DELAY_MS = 3_000;

/** `start(label)` spawns one recovery instance and returns its child process; `steps` collects a record per handover. */
export async function startRecovery(start, steps, { windowMs = RECOVERY_HANDOVER_WINDOW_MS, tries = RECOVERY_TRIES, delayMs = RECOVERY_RETRY_DELAY_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    const child = start(attempt === 1 ? "2" : `2-retry${attempt - 1}`);
    const startedAt = Date.now();
    const early = await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode }); return; }
      const onExit = (code, signal) => { clearTimeout(timer); resolve({ code, signal }); };
      const timer = setTimeout(() => { child.off("exit", onExit); resolve(null); }, windowMs);
      child.once("exit", onExit);
    });
    if (early === null || early.code !== 0 || attempt >= tries) return child;
    steps.push({ phase: "recovery-instance-handed-over-to-the-dying-one", attempt, exitCode: early.code, afterMs: Date.now() - startedAt });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
