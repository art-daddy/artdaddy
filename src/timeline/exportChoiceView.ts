// The pure model of the Export dialog's Quality / Fast view (design D2): what each choice starts on, which sizes and rates the lists may offer, what is shown and what is sent
// (the same values: `leversShown` is the one authority), when the figure may stand on the Fast label and when "Are you sure?" is asked. No React, no store, no switch, no clock.
//
// The rules of Fast itself (the size one rung down, the rate cap, the figure, the question) are `exportRoute.ts`'s; this file only asks them the dialog's questions and never
// holds a number of its own, so the lab's bundle is the one place a figure lives. A person's pick is an override of the choice's own value; an override the project no longer
// holds (it shrank under the dialog) is dropped, never sent.
import type { ExportSettings } from "../components/ExportDialog";
import {
  figureNumber,
  QUALITY_WORDS,
  RESOLUTION_WORDS,
  sameAsProjectRate,
  sameAsProjectSize,
  rateEntry,
  summaryWords,
} from "./exportChoiceWords";
import type { ExportQuality, ExportResolution } from "./exportOptions";
import {
  fastSpeedupLabel,
  needsSlowConfirm,
  quickDefaultSize,
  quickSettings,
  quickSizeChoices,
  QUICK_BUNDLE,
  type ProjectFacts,
  type QuickBundle,
} from "./exportRoute";
import type { ExplicitSettings, RouteKind } from "./exportTypes3c";

export { describeFigure } from "./exportChoiceWords";

/** The two choices as a person reads them. Code maps them to the export's own route kinds (`routeOf`). */
export type Choice = "quality" | "fast";

/** Whether the dialog draws the Quality | Fast row and the line under the door. The one switch for it: false is the dialog without a choice (the settings view as it was before Fast was wired: Quality
 *  alone, no line under the door), and nothing else in the dialog changes. */
export const FAST_CHOICE_OFFERED: boolean = true;

/** The three values the settings carry: the Resolution list's, the Frame rate list's (`null` is the project's own rate) and the Quality list's. */
export interface Levers {
  resolution: ExportResolution;
  fps: number | null;
  quality: ExportQuality;
}

/** What the person changed since the last pick of a choice: only those levers are present (`fps: null` is "Same as project" picked on purpose). */
export interface Overrides {
  resolution?: ExportResolution;
  fps?: number | null;
  quality?: ExportQuality;
}

/** The question before a heavy export: (a) is asked of Quality, (b) of Fast with settings heavier than its own. `figure` is the speed-up the sentence of (a) may state, or null where it
 *  may not (a size or a rate was changed, so the figure would be untrue for what will run); (b) never states one. */
export interface Ask {
  kind: "a" | "b";
  figure: number | null;
}

/** The quality Quality starts on (0.28.0's own start). Fast starts on the bundle's. */
export const QUALITY_START: ExportQuality = "medium";

/** The rates the Frame rate list offers below the project's own, highest first. */
export const RATE_LADDER: readonly number[] = Object.freeze([60, 50, 30, 25, 24]);

const QUALITIES: readonly ExportQuality[] = ["high", "medium", "low"];
const isQuality = (value: unknown): value is ExportQuality =>
  QUALITIES.includes(value as ExportQuality);
const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The route kind the export tool is told for a choice. */
export const routeOf = (choice: Choice): RouteKind => (choice === "fast" ? "quick" : "standard");

/** The project's facts from what the dialog can read: a width, a height and a rate that are each a number above 0, else null (nothing can be checked, so no list is offered beyond the
 *  project's own size and rate). A length that is not a number of at least 0 reads as 0. */
export function projectFacts(
  canvas: { width?: unknown; height?: unknown; fps?: unknown } | null | undefined,
  durationSeconds?: unknown,
): ProjectFacts | null {
  if (!canvas || !isPositive(canvas.width) || !isPositive(canvas.height) || !isPositive(canvas.fps))
    return null;
  const length =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : 0;
  return { width: canvas.width, height: canvas.height, fps: canvas.fps, durationSeconds: length };
}

/** What each choice starts on. Quality is the project as it is at Medium quality. Fast is what the export tool composes for a request that sets nothing (`quickSettings`, the one authority: the
 *  size one rung down, the rate at 30 at most, the bundle's quality), and the project's own size and rate where it has no smaller. */
export function ownLevers(
  choice: Choice,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): Levers {
  if (choice === "quality") return { resolution: "source", fps: null, quality: QUALITY_START };
  if (facts === null) return { resolution: "source", fps: null, quality: bundle.quality };
  const fast = quickSettings({
    canvas: facts,
    requested: {},
    explicit: { size: false, fps: false, quality: false },
    bundle,
  });
  return {
    resolution: fast.resolution,
    fps: fast.fps ?? null,
    quality: fast.quality ?? bundle.quality,
  };
}

/** The Resolution list: the project's own size, then every size preset below it, largest first (`quickSizeChoices`). Never a size at or above the project's. */
export function sizeOptions(facts: ProjectFacts | null): ExportResolution[] {
  return facts === null ? ["source"] : quickSizeChoices(facts);
}

/** The Frame rate list as the dialog draws it: the project's own rate and the lower rates of the ladder, and Fast's own rate too where the ladder has not got it (72 gives 18, 32 gives 16),
 *  so that what Fast shows is always an entry of the list. Only a dialog that offers Fast passes `fastOffered`. */
export function rateEntriesFor(
  facts: ProjectFacts | null,
  fastOffered: boolean,
  bundle: QuickBundle = QUICK_BUNDLE,
): { value: number | null; label: string }[] {
  return rateEntries(facts, fastOffered ? ownLevers("fast", facts, bundle).fps : null);
}

/** The Frame rate list: `null` (the project's own rate), then every rate of the ladder strictly below the project's, then `extra` where the ladder has not got it, highest first. Never a rate at or
 *  above the project's. `extra` is Fast's own rate (72 gives 18, 32 gives 16) and is passed only by a view that offers Fast; a view without it passes nothing. */
export function rateOptions(
  facts: ProjectFacts | null,
  extra: number | null = null,
): (number | null)[] {
  if (facts === null) return [null];
  const rates = RATE_LADDER.filter((rate) => rate < facts.fps);
  if (extra !== null && extra < facts.fps && extra >= 1 && !rates.includes(extra))
    rates.push(extra);
  return [null, ...rates.sort((a, b) => b - a)];
}

/** What the Resolution list says of each entry: the project's own size is written as the picture the export makes of it (even sides, as the render composites), the others by their preset. */
export function sizeEntries(
  facts: ProjectFacts | null,
): { value: ExportResolution; label: string }[] {
  const own =
    facts === null
      ? null
      : quickSettings({
          canvas: facts,
          requested: { resolution: "source" },
          explicit: { size: true, fps: true, quality: true },
        }).delivered;
  return sizeOptions(facts).map((value) => ({
    value,
    label:
      value === "source"
        ? own
          ? sameAsProjectSize(own.width, own.height)
          : ""
        : RESOLUTION_WORDS[value],
  }));
}

/** What the Frame rate list says of each entry (`extra` as in `rateOptions`). */
export function rateEntries(
  facts: ProjectFacts | null,
  extra: number | null = null,
): { value: number | null; label: string }[] {
  return rateOptions(facts, extra).map((value) => ({
    value,
    label: value === null ? (facts ? sameAsProjectRate(facts.fps) : "") : rateEntry(value),
  }));
}

/** The Quality list: names only, highest first. */
export function qualityEntries(): { value: ExportQuality; label: string }[] {
  return QUALITIES.map((value) => ({ value, label: QUALITY_WORDS[value] }));
}

/** Drops every override the project does not hold: a size that is not in the Resolution list, a rate that is not `null` or a number from 1 up to (not including) the project's rate, a quality that
 *  is not one of the three. With no readable project numbers cannot be checked, so a size other than the project's and any rate other than `null` go; `null` and a quality stay. Returns the SAME object
 *  where nothing was dropped (so a state that writes it back cannot loop). */
export function clampOverrides(o: Overrides, facts: ProjectFacts | null): Overrides {
  const kept: Overrides = {};
  let dropped = false;
  if (o.resolution !== undefined) {
    if (sizeOptions(facts).includes(o.resolution)) kept.resolution = o.resolution;
    else dropped = true;
  }
  if (o.fps !== undefined) {
    if (
      o.fps === null ||
      (facts !== null &&
        typeof o.fps === "number" &&
        Number.isFinite(o.fps) &&
        o.fps >= 1 &&
        o.fps < facts.fps)
    )
      kept.fps = o.fps;
    else dropped = true;
  }
  if (o.quality !== undefined) {
    if (isQuality(o.quality)) kept.quality = o.quality;
    else dropped = true;
  }
  return dropped ? kept : o;
}

/** The three values the rows show, and so the ones that are sent: the choice's own, except where the person changed one (and the project still holds it). */
export function leversShown(
  choice: Choice,
  overrides: Overrides,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): Levers {
  const own = ownLevers(choice, facts, bundle);
  const kept = clampOverrides(overrides, facts);
  return {
    resolution: kept.resolution ?? own.resolution,
    fps: kept.fps !== undefined ? kept.fps : own.fps,
    quality: kept.quality ?? own.quality,
  };
}

/** Which of the size, the rate and the quality the person set: exactly the levers present in the overrides (a "same as the project" that was picked is a setting too). */
export function explicitOf(o: Overrides): Required<ExplicitSettings> {
  return {
    size: o.resolution !== undefined,
    fps: o.fps !== undefined,
    quality: o.quality !== undefined,
  };
}

/** The figure that may follow the word Fast, or null for the plain word. It is the lab's number for this project (`fastSpeedupLabel`: none while the table has no row) and it is claimed only
 *  while the Resolution and Frame rate lists show the SELECTED choice's own values: change either and it no longer describes what will run (the Quality list alone does not count). A figure that
 *  would be written as 1x or less is never claimed. */
export function figureFor(
  choice: Choice,
  shown: Levers,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): number | null {
  if (facts === null) return null;
  const figure = fastSpeedupLabel(facts, bundle);
  if (figure === null || !(Number(figureNumber(figure)) > 1)) return null;
  const own = ownLevers(choice, facts, bundle);
  return shown.resolution === own.resolution && shown.fps === own.fps ? figure : null;
}

/** Whether pressing Export asks "Are you sure?" first, and which of the two questions: Q3's `needsSlowConfirm` over the values that WOULD be sent. Nothing for an ordinary project, for Fast on
 *  its own settings, or while the lab's table has no figure for the project. */
export function askFor(
  choice: Choice,
  shown: Levers,
  overrides: Overrides,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): Ask | null {
  if (facts === null) return null;
  const heavy = needsSlowConfirm(
    {
      route: routeOf(choice),
      resolution: shown.resolution,
      fps: shown.fps,
      explicit: explicitOf(overrides),
    },
    facts,
    bundle,
  );
  if (!heavy) return null;
  return choice === "quality"
    ? { kind: "a", figure: figureFor(choice, shown, facts, bundle) }
    : { kind: "b", figure: null };
}

/** What `onStart` is handed. The shown values are the sent values. Quality sends no route, so its object is the 0.28.0 one key for key (`qualityMode` is what 0.28.0 sends as `mode` where no Mode
 *  row is drawn: "quality" until the app's look has answered, else null so the app decides). Fast sends the route with the explicit flags and leaves `mode` to the app. `overrides` are the clamped ones. */
export function payloadFor(
  choice: Choice,
  shown: Levers,
  overrides: Overrides,
  qualityMode: "quality" | null,
): ExportSettings {
  const base = { resolution: shown.resolution, quality: shown.quality, fps: shown.fps };
  if (choice === "quality") return { ...base, mode: qualityMode };
  return { ...base, mode: null, route: { route: "quick", explicit: explicitOf(overrides) } };
}

/** The line under the door, from the values the dialog will send (`shown`), never from the choice: a pick of a size, a rate or a quality changes what it says. Each clause is written only where it is true of
 *  those values and says nothing of the encoder (the chip or the light compression is decided when the export starts). Empty where the project cannot be read. */
export function summaryFor(
  shown: Levers,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): string {
  if (facts === null) return "";
  const size = quickDefaultSize(facts, bundle);
  // What the export delivers for the shown size and rate: the rate is the project's own where none is shown.
  const delivered = quickSettings({
    canvas: facts,
    requested: { resolution: shown.resolution, fps: shown.fps ?? undefined },
    explicit: { size: true, fps: true, quality: true },
    bundle,
  }).delivered;
  return summaryWords({
    projectSizeAndRate: shown.resolution === "source" && shown.fps === null,
    oneSizeSmaller: size !== null && shown.resolution === size,
    upToFps:
      delivered !== null && facts.fps > bundle.maxFps && delivered.fps <= bundle.maxFps
        ? bundle.maxFps
        : null,
    quality: shown.quality,
  });
}

/** Everything the view reads of one choice and its overrides on one set of facts: what is kept, shown, claimed and asked, computed in one place so that a draw and a click cannot differ. */
export interface Resolved {
  kept: Overrides;
  shown: Levers;
  figure: number | null;
  ask: Ask | null;
}

export function resolveChoice(
  choice: Choice,
  overrides: Overrides,
  facts: ProjectFacts | null,
  bundle: QuickBundle = QUICK_BUNDLE,
): Resolved {
  const kept = clampOverrides(overrides, facts);
  const shown = leversShown(choice, kept, facts, bundle);
  return {
    kept,
    shown,
    figure: figureFor(choice, shown, facts, bundle),
    ask: askFor(choice, shown, kept, facts, bundle),
  };
}
