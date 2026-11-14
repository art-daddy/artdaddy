// The Export dialog's "Graphics chip: Auto / Off" row: what this PC's chip is doing for exports (it is tested, it passed, it did not, it stopped
// an export and is set aside for a day), one switch, and where it applies a hint a person can act on. Drawn only where the app finds a chip of a
// known maker. Off is the person's own switch (artdaddy.chipPref.v1): the chip is then never tested, offered or used (`findChip` reads it).
import { useEffect, useState } from "react";

import { exportFlag } from "../api/exportFlags";
import { processorName } from "../platform/host";
import { chipAdvice } from "../timeline/chipAdvice";
import { readChipPref, writeChipPref, type ChipPref } from "../timeline/chipPref";
import { chipRowModel } from "../timeline/chipRow";
import { chipStatusOf, findChip, liftChipSetAside, type ChipStatus } from "../timeline/chipTest";
import { sizeClassOf, type SizeClass } from "../timeline/exportEncoder";
import { deliveredPicture, type ExportResolution } from "../timeline/exportOptions";

const TRY_AGAIN = "Try it again now";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The size class the picture will be delivered in, which is the one the chip is tested at; a picture outside both classes is the
 *  processor's, and the row then speaks for the 1080p class, the one the switch is about. */
function sizeClassFor(
  workload: { width: number; height: number; fps: number } | null,
  resolution: ExportResolution,
  fps: number | null,
): SizeClass {
  if (!workload) return "hd";
  try {
    const picture = deliveredPicture(workload, { resolution, fps });
    return sizeClassOf(picture.width, picture.height, picture.fps) ?? "hd";
  } catch {
    return "hd";
  }
}

export default function ChipRow({
  workload = null,
  resolution = "source",
  fps = null,
  onChange,
}: {
  /** The project's picture, which with the settings below says the size the chip is tested at. Absent: 1080p. */
  workload?: { width: number; height: number; fps: number } | null;
  resolution?: ExportResolution;
  fps?: number | null;
  /** The person changed what the app will do about the chip (the switch, or Try it again now): whatever decided the encoder from it
   *  asks again. */
  onChange?: () => void;
}): JSX.Element | null {
  const sizeClass = sizeClassFor(workload, resolution, fps);
  const [pref, setPref] = useState<ChipPref>(() => readChipPref(storage()));
  const [status, setStatus] = useState<ChipStatus | null>(null);
  const [processor, setProcessor] = useState<string | null>(null);
  const [testing, setTesting] = useState(true);
  const [again, setAgain] = useState(0);

  // Looked at when the dialog opens, when the size class or the switch changes and when a chip is tried again: what is remembered
  // first (so a row appears at once where there is a chip), then the test if it has not been made for this size (the dialog's own look
  // joins the same one), then what is remembered again. Nothing here can fail an export or the dialog.
  useEffect(() => {
    let stale = false;
    const stop = new AbortController();
    setTesting(true);
    void (async () => {
      try {
        const first = await chipStatusOf(sizeClass);
        if (stale) return;
        setStatus(first);
        if (first.found && first.pref === "auto")
          await findChip(sizeClass, { allowRun: true, signal: stop.signal });
        if (stale) return;
        const last = await chipStatusOf(sizeClass);
        if (stale) return;
        setStatus(last);
        // The processor's name is asked only where the Intel hint could use it: every chip the app sees is another maker's.
        const named =
          last.found &&
          last.pref === "auto" &&
          last.adapters.every((entry) => entry.adapter.maker !== "intel")
            ? await processorName()
            : null;
        if (!stale) setProcessor(named);
      } catch {
        /* the row says what it knew */
      } finally {
        if (!stale) setTesting(false);
      }
    })();
    return () => {
      stale = true;
      stop.abort();
    };
  }, [sizeClass, pref, again]);

  const model = chipRowModel({
    found: status?.found === true,
    pref,
    testing,
    verdict: status?.verdict ?? "unknown",
    setAside: status?.setAside === true,
    flagsOn: status?.flagsOn === true,
    quickFlagOn: exportFlag("quick_export"),
  });
  if (!model.visible || model.note === null) return null;

  const choose = (next: ChipPref): void => {
    if (next === pref) return;
    writeChipPref(storage(), next);
    setPref(next);
    onChange?.();
  };
  const tryAgain = (): void => {
    void liftChipSetAside().then(() => {
      onChange?.();
      setAgain((count) => count + 1);
    });
  };

  // Words that are the person's to act on, only where the row has settled on an answer (and never beside "Off").
  const hint =
    model.state === "auto_passed" || model.state === "auto_not_passed"
      ? chipAdvice({
          adapters: (status?.adapters ?? []).map(({ adapter, result }) => ({
            maker: adapter.maker,
            driver: adapter.driver,
            result,
          })),
          processor,
        })
      : null;
  const link = model.action === "try_again_now" && model.note.endsWith(TRY_AGAIN);

  return (
    <div className="text-xs text-neutral-400" data-testid="chip-row">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0">Graphics chip</span>
        <div
          role="radiogroup"
          aria-label="Graphics chip"
          className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-100"
        >
          {(["auto", "off"] as const).map((value) => (
            <label key={value} className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="chip-pref"
                value={value}
                checked={pref === value}
                onChange={() => choose(value)}
                className="accent-accent"
              />
              {value === "auto" ? "Auto" : "Off"}
            </label>
          ))}
        </div>
      </div>
      <p data-testid="chip-row-note" className="mt-0.5 pl-[5.75rem] leading-snug">
        {link ? (
          <>
            {model.note.slice(0, model.note.length - TRY_AGAIN.length)}
            <button
              type="button"
              onClick={tryAgain}
              className="underline underline-offset-2 hover:text-neutral-200"
            >
              {TRY_AGAIN}
            </button>
          </>
        ) : (
          model.note
        )}
      </p>
      {hint && (
        <p data-testid="chip-row-hint" className="mt-1 pl-[5.75rem] leading-snug text-neutral-300">
          {hint.text}
        </p>
      )}
    </div>
  );
}
