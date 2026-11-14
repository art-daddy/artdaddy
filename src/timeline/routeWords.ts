// The words of the Quick route: the Export dialog's two choices, the slow-export banner and the chat card's two questions. Pure, so the
// dialog, the card and the assistant's list say one thing, and a number that is not a number never reaches a sentence.
//
// Every sentence here is the owner's copy, word for word, with its numbers filled in. A sentence that would claim something the facts do
// not support (a smaller picture where the picture was not made smaller) has its own wording below; none promises the same pixels or a
// speed multiple. Times and sizes go through the baseline's describeExportTime and describeExportSize so the style matches the card's.
import { describeExportSize, describeExportTime, type ExportQuality } from "./exportOptions";
import { isWeakPc } from "./exportRoute";
import type { PcClass, QuickOffer, RouteKind } from "./exportTypes3c";

const SEP = " · ";

const joined = (parts: readonly (string | null | undefined | false)[], separator = SEP): string =>
  parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(separator);

const timeOf = (seconds: unknown): string =>
  typeof seconds === "number" ? describeExportTime(seconds) : "";

/** "a file of about 600 MB", or "" when this PC has not measured one. */
const measuredFile = (bytes: unknown): string => {
  const size = typeof bytes === "number" ? describeExportSize(bytes) : "";
  return size ? `a file of ${size}` : "";
};

const fpsText = (fps: unknown): string => {
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) return "";
  return `${Number.isInteger(fps) ? fps : Number(fps.toFixed(2))} fps`;
};

const pictureText = (picture: unknown): string =>
  typeof picture === "string" ? picture.trim() : "";

const qualityText = (quality: unknown): string =>
  quality === "high" || quality === "medium" || quality === "low"
    ? `${quality.charAt(0).toUpperCase()}${quality.slice(1)}`
    : "";

/** The label of a delivered picture: its short side, as the Export dialog's own resolutions are named ("720p"). */
export function describePicture(width: number, height: number): string {
  const valid = (side: number): boolean => Number.isFinite(side) && side > 0;
  return valid(width) && valid(height) ? `${Math.round(Math.min(width, height))}p` : "";
}

/** How many times its length a plain video takes on this PC, as the sentence says it: a whole number of at least 1, or null. */
const plainTimesText = (plainTimes: unknown): string | null =>
  typeof plainTimes === "number" && Number.isFinite(plainTimes) && plainTimes > 0
    ? String(Math.max(1, Math.round(plainTimes)))
    : null;

/** What Full quality will really run: the processor's normal setting, the graphics chip, or the processor's faster setting. */
export type FullRoute = "processor" | "chip" | "faster";
/** What Quick runs: the chip, the faster setting, or (where neither is there) the processor's normal setting. */
export type QuickEncoder = "chip" | "faster" | "processor";

export interface FullRowInput {
  route: FullRoute;
  seconds: number | null;
  /** The size of a file this PC has measured for this export, else null. */
  bytes: number | null;
  /** The delivered picture's label ("1080p"), the rate and the tier the dialog shows above the choices. */
  picture: string;
  fps: number | null;
  quality: ExportQuality;
}

/** Full quality's row in the Export dialog: the settings above, what it uses, what the file is like, and how long it takes. */
export function describeFullRow(input: FullRowInput): string {
  try {
    const settings = joined([
      pictureText(input.picture),
      fpsText(input.fps),
      qualityText(input.quality),
    ]);
    const measured = measuredFile(input.bytes);
    const parts: (string | false)[] = [`Your settings above (${settings})`];
    if (input.route === "chip")
      parts.push("uses your graphics chip", measured || "the file is usually larger");
    else if (input.route === "faster")
      parts.push("a faster setting", "the picture may be slightly softer", measured);
    else parts.push(measured || "the smallest file for this quality");
    parts.push(timeOf(input.seconds));
    return joined(parts);
  } catch {
    return "";
  }
}

export interface QuickRowInput {
  seconds: number | null;
  bytes: number | null;
  /** The picture and rate Quick delivers, as the dialog names them. */
  picture: string;
  fps: number | null;
  encoder: QuickEncoder;
  /** Whether Quick made the picture smaller, and the rate lower, than the request had it. */
  changedSize: boolean;
  changedFps: boolean;
}

/** What Quick's file is like: a measured size, else "smaller" where the picture or the rate came down, else what its encoder does. */
function quickFileWords(input: QuickRowInput, surface: "dialog" | "card"): string {
  const measured = measuredFile(input.bytes);
  if (measured) return measured;
  if (input.changedSize || input.changedFps) return "a smaller file";
  if (input.encoder === "chip")
    return surface === "dialog" ? "the file is usually larger" : "usually a larger file";
  if (input.encoder === "faster") return "the picture may be slightly softer";
  return "";
}

/** Quick's row in the Export dialog: its picture and rate, what it encodes with, its file, and how long it takes. */
export function describeQuickRow(input: QuickRowInput): string {
  try {
    return joined([
      pictureText(input.picture),
      fpsText(input.fps),
      input.encoder === "chip"
        ? "graphics chip"
        : input.encoder === "faster"
          ? "faster setting"
          : "",
      quickFileWords(input, "dialog"),
      timeOf(input.seconds),
    ]);
  } catch {
    return "";
  }
}

export interface QuickSelectedInput {
  pcClass: PcClass;
  /** How many times its length a plain video takes on this PC (from the speed check), or null when it is not known. */
  plainTimes: number | null;
  picture: string;
  /** Whether Quick made the picture smaller than the request had it. */
  changedSize: boolean;
}

/** The amber line under the choices when Quick starts selected: why, what it costs, and the way back. Null where Quick is not preselected. */
export function describeQuickSelected(input: QuickSelectedInput): string | null {
  try {
    if (!isWeakPc(input.pcClass)) return null;
    const plain = plainTimesText(input.plainTimes);
    const why =
      input.pcClass === "unfinished"
        ? "Quick is selected because this PC could not finish its speed check, so ArtDaddy treats it as slower than most."
        : `Quick is selected because this PC is slower than most${plain ? ` (a plain video takes about ${plain} times its length here)` : ""}.`;
    const picture = pictureText(input.picture);
    const cost =
      input.changedSize && picture
        ? `The picture is smaller (${picture}) and can look slightly softer.`
        : "The picture can look slightly softer.";
    return `${why} ${cost} Choose Full quality to keep your settings.`;
  } catch {
    return null;
  }
}

/** The one line that says why Quick is not on offer, and what to lower, where there is something true to say; null where there is not
 *  (the remote switch is off, or the export is a minute or less: nothing is shown). */
export function describeQuickNotOffered(reason: QuickOffer): string | null {
  if (reason === "small_gain")
    return "Quick export would not be much faster for this project: most of the time goes to reading and drawing your clips. To go faster, shorten the video or use fewer layers or clips.";
  if (reason === "explicit")
    return "Quick export keeps the size and frame rate you chose, so it would not be much faster here.";
  return null;
}

/** Where the dialog's times come from, with the day the speed check was made ("today"). */
export function describeTimesFrom(day: string): string {
  const when = typeof day === "string" ? day.trim() : "";
  return `Times are from a quick check of this PC's speed${when ? `, made ${when}` : ""}.`;
}

export interface QuickCardLineInput {
  picture: string;
  fps: number | null;
  changedSize: boolean;
}

/** The card's line while a Quick export runs. */
export function describeQuickCardLine(input: QuickCardLineInput): string {
  try {
    return joined([
      "Quick export",
      pictureText(input.picture),
      fpsText(input.fps),
      input.changedSize
        ? "the picture is smaller and may look slightly softer"
        : "the picture may look slightly softer",
    ]);
  } catch {
    return "";
  }
}

export type BannerButton = "switch_to_quick" | "keep_going" | "cancel";

export const BANNER_BUTTON_LABELS: Readonly<Record<BannerButton, string>> = {
  switch_to_quick: "Switch to Quick export",
  keep_going: "Keep going",
  cancel: "Cancel",
};

/** What Quick would do for an export that is under way: finish at least 40 % sooner than what is left (`helps`), not (`no_help`), or
 *  there is no Quick to say anything about (`none`: the export cannot be switched, or Quick has no estimate). */
export type QuickHelp = "helps" | "no_help" | "none";

export const KEEP_GOING_NOTE =
  "Keeping going. ArtDaddy will tell you again if it gets much slower.";
export const SWITCHING_NOTE = "Switching to Quick export. The export starts again.";
export const ASSISTANT_SLOW_NOTE =
  "This export is running slower than expected. Tell the person how long is left and, if quick_available is true, that Switch to Quick export is on the card. Do not cancel it and start another.";
/** The same guidance while Quick is not on offer: nothing about a button that is not there. */
export const ASSISTANT_SLOW_NOTE_NO_QUICK =
  "This export is running slower than expected. Tell the person how long is left. Do not cancel it and start another.";
/** What Keep going says when it was pressed as the export ended: the export has ended, or its render is over and it is being checked and saved. */
export const KEEP_GOING_ENDED = "This export has already ended.";
export const KEEP_GOING_FINISHING = "This export is already finishing.";
export const ASSISTANT_SWITCHED_NOTE =
  "The person switched this export to Quick export (a smaller picture and a lower frame rate), so it started again. It is the same export (same job_id): do not start another.";
const GO_FASTER = "To go faster, cancel, use fewer layers or clips, and export again.";

export interface SlowBannerInput {
  /** What the projection says is left. */
  leftSeconds: number;
  /** The estimate that was shown before the start, or null when none was. */
  expectedSeconds: number | null;
  quickSeconds: number | null;
  quick: QuickHelp;
}

/** The slow banner: the headline first, then what was expected and what Quick would do. */
export function describeSlowBanner(input: SlowBannerInput): string[] {
  try {
    const left = timeOf(input.leftSeconds);
    const expected = timeOf(input.expectedSeconds);
    const quick = timeOf(input.quickSeconds);
    const lines = [
      left ? `This PC is slower than expected: ${left} left` : "This PC is slower than expected",
    ];
    if (expected) lines.push(`It was expected to take ${expected}.`);
    if (input.quick === "helps" && quick)
      lines.push(`Quick export would take ${quick}, starting over.`);
    else if (input.quick === "no_help")
      lines.push(`Quick export would not be much faster than what is left. ${GO_FASTER}`);
    else lines.push(GO_FASTER);
    return lines;
  } catch {
    return ["This PC is slower than expected"];
  }
}

export interface QuietBannerInput {
  quietSeconds: number;
  quickSeconds: number | null;
  quick: QuickHelp;
  /** The processor is doing nothing either: ArtDaddy will stop the export itself. */
  idle: boolean;
}

/** "75 s" under two minutes, "3 min" after: the way the card counts a silence. */
function describeQuiet(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  return whole < 120 ? `${whole} s` : `${Math.floor(whole / 60)} min`;
}

/** The stopped-moving banner. It speaks of Quick only where Quick would help; the way out, Cancel, is always there. */
export function describeQuietBanner(input: QuietBannerInput): string[] {
  try {
    const lines = [
      "This export has stopped moving",
      `No progress for ${describeQuiet(input.quietSeconds)}.`,
    ];
    const quick = timeOf(input.quickSeconds);
    if (input.quick === "helps" && quick)
      lines.push(`Quick export would take ${quick}, starting over.`);
    if (input.idle) lines.push("ArtDaddy stops it if nothing moves for 3 minutes.");
    return lines;
  } catch {
    return ["This export has stopped moving"];
  }
}

/** The card's line once the export has started again as a Quick export. */
export function describeSwitchedToQuick(seconds: number | null): string {
  const time = timeOf(seconds);
  return `Started again as a Quick export because this PC is slower than expected.${time ? ` It will take ${time}.` : ""}`;
}

export interface QuestionButton<Answer extends string> {
  /** The answer the button gives. `continue` and `start_anyway` are the existing answers of the question host. */
  answer: Answer;
  label: string;
  primary: boolean;
}

export type RouteAnswer = "quick" | "continue" | "cancel";

export interface RouteQuestion {
  /** The trace's code for the screen. */
  code: "b5";
  title: string;
  /** The card's body, in order: why it is asked, the two ways joined with a dot, and what Quick changes. */
  lines: string[];
  /** The two ways on their own, for a surface that shows them as two rows. */
  ways: { full: string; quick: string };
  /** In button order. The selected way is the primary button. */
  buttons: QuestionButton<RouteAnswer>[];
}

export interface RouteQuestionInput {
  pcClass: PcClass;
  plainTimes: number | null;
  /** The way the decision selected; its button is the primary one. */
  selected: RouteKind;
  full: { seconds: number | null; bytes: number | null; route: FullRoute };
  quick: QuickRowInput;
}

const FULL_FILE_WORDS: Record<FullRoute, string> = {
  processor: "the smallest file",
  chip: "usually a larger file",
  faster: "the picture may be slightly softer",
};

const ROUTE_TITLE = "Export at full quality or Quick?";

function routeQuestionBody(input: RouteQuestionInput): Pick<RouteQuestion, "lines" | "ways"> {
  const plain = plainTimesText(input.plainTimes);
  const time = timeOf(input.full.seconds);
  const why = isWeakPc(input.pcClass)
    ? input.pcClass === "unfinished"
      ? "This PC could not finish its speed check, so ArtDaddy treats it as slower than most."
      : `This PC is slower than most${plain ? `: a plain video takes about ${plain} times its length here` : ""}.`
    : time
      ? `This export is expected to take ${time}.`
      : "";
  const fullWords = FULL_FILE_WORDS[input.full.route] ?? FULL_FILE_WORDS.processor;
  const full = joined(
    [
      `Full quality${time ? ` ${time}` : ""}`,
      input.full.route === "faster" ? fullWords : measuredFile(input.full.bytes) || fullWords,
      input.full.route === "faster" ? measuredFile(input.full.bytes) : "",
    ],
    ", ",
  );
  const quickTime = timeOf(input.quick.seconds);
  const quick = joined(
    [
      `Quick${quickTime ? ` ${quickTime}` : ""}`,
      pictureText(input.quick.picture),
      fpsText(input.quick.fps),
      quickFileWords(input.quick, "card"),
    ],
    ", ",
  );
  const changes =
    input.quick.changedSize && input.quick.changedFps
      ? "Quick makes the picture smaller and the frame rate lower. Full quality keeps your settings."
      : input.quick.changedSize
        ? "Quick makes the picture smaller. Full quality keeps your settings."
        : input.quick.changedFps
          ? "Quick makes the frame rate lower. Full quality keeps your settings."
          : "Quick keeps your size and frame rate and uses a faster way to encode.";
  return {
    lines: [why, `${full}${SEP}${quick}`, changes].filter((line) => line.length > 0),
    ways: { full, quick },
  };
}

/** The question the chat card asks before an assistant's export runs: Full quality or Quick, with both times and files. */
export function describeRouteQuestion(input: RouteQuestionInput): RouteQuestion {
  const quickSelected = input?.selected === "quick";
  const buttons: QuestionButton<RouteAnswer>[] = [
    { answer: "quick", label: "Quick export", primary: quickSelected },
    { answer: "continue", label: "Full quality", primary: !quickSelected },
    { answer: "cancel", label: "Cancel", primary: false },
  ];
  try {
    return { code: "b5", title: ROUTE_TITLE, ...routeQuestionBody(input), buttons };
  } catch {
    return { code: "b5", title: ROUTE_TITLE, lines: [], ways: { full: "", quick: "" }, buttons };
  }
}

export type CheckAnswer = "cancel" | "continue" | "start_anyway";

export interface CheckQuestion {
  code: "b4";
  title: string;
  /** The card shows these. */
  cardLines: string[];
  /** The dialog shows these: the card's, and the two sentences only the dialog has room for. */
  dialogLines: string[];
  /** In button order; "Check this PC" is the primary one. */
  buttons: QuestionButton<CheckAnswer>[];
  /** The quiet link under the buttons. */
  quietLink: QuestionButton<CheckAnswer>;
}

export interface CheckQuestionInput {
  /** What makes the project big, in the person's own terms ("10 minutes with 41 stills"). */
  what: string;
  /** The rough guess the export would otherwise show, or null. */
  roughSeconds: number | null;
}

const CHECK_TITLE = "Check this PC's speed first?";

/** The question asked before a big project that nothing on this PC resembles: check first, or start on a rough guess. */
export function describeCheckQuestion(input: CheckQuestionInput): CheckQuestion {
  const buttons: QuestionButton<CheckAnswer>[] = [
    { answer: "cancel", label: "Cancel", primary: false },
    { answer: "continue", label: "Check this PC", primary: true },
  ];
  const quietLink: QuestionButton<CheckAnswer> = {
    answer: "start_anyway",
    label: "Rather not wait? Start without checking",
    primary: false,
  };
  try {
    const what = typeof input.what === "string" ? input.what.trim() : "";
    const rough = timeOf(input.roughSeconds);
    const big = what
      ? `This project is big (${what}) and nothing like it has been exported on this PC yet.`
      : "This project is big and nothing like it has been exported on this PC yet.";
    const without = `Without the check a rough guess${rough ? `: ${rough}` : ""}, which can be far off`;
    const withCheck = "With the check a measured time, in about 10 seconds";
    const cardLines = [big, without, withCheck];
    const dialogLines = [
      big,
      "A 10-second check tells ArtDaddy how fast this PC is, so the time it shows is not a guess.",
      without,
      withCheck,
      "Your PC may feel slow for those 10 seconds. Nothing starts until you answer.",
    ];
    return { code: "b4", title: CHECK_TITLE, cardLines, dialogLines, buttons, quietLink };
  } catch {
    return { code: "b4", title: CHECK_TITLE, cardLines: [], dialogLines: [], buttons, quietLink };
  }
}
