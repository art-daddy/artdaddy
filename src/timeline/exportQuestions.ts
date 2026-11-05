// What the person is asked before an export starts, and in which words. Pure: it takes the picture the
// pre-start check painted (what the PC has, what the export needs) and says which question to ask, if
// any. Nothing here shows a dialog, reads the PC or starts anything, so every rule is testable without
// an export.
//
// One source for every surface. The in-app dialog, the question on the chat card and the native message
// box that stands in when no dialog is mounted all render the SAME `ExportQuestion`, and the trace's
// codes come from it, so a question cannot be worded one way on screen and reported another.
//
// What asks is today's rule, unchanged (a known problem, or a long or slow estimate), with one
// exception the plan decided (section 10.2): a person who pressed Export in the dialog has just been
// shown the estimate there, so a time notice alone is not asked again. An assistant's export has no
// such dialog, so it keeps the notice.
import type { ExportTraceValue } from "../api/exportVocabulary";
import {
  describeExportTime,
  isKnownProblem,
  type ExportPreflightReason as Reason,
} from "./exportOptions";
import { CONFIRM_REASON_BITS } from "./exportTrace";

export type ExportQuestionKind = "memory" | "output_space" | "working_space" | "notice";
export type ExportAnswer = "continue" | "start_anyway" | "cancel";
/** Who asked for the export: the Export menu, the in-app chat, an outside assistant over MCP, or
 *  something that did not say (treated like an assistant: only the menu has just shown the estimate). */
export type ExportVia = "menu" | "chat" | "mcp" | "other";

export interface QuestionFact {
  readonly label: string;
  readonly value: string;
}

export interface ExportQuestion {
  readonly kind: ExportQuestionKind;
  /** The trace's code for the screen (a value of the report vocabulary). */
  readonly code: Extract<ExportTraceValue, "b1" | "b2" | "b3" | "confirm">;
  readonly title: string;
  /** What is wrong, one plain sentence each. */
  readonly lines: readonly string[];
  /** The numbers that decided it. They never contradict the verdict: the need is rounded up and what the
   *  PC has is rounded down, so a shortage never reads as a tie. */
  readonly facts: readonly QuestionFact[];
  /** What the person can do about it. */
  readonly advice: string;
  /** The same, for the native message box that stands in when no dialog is mounted: that box has no loop,
   *  so it cannot promise to look again; it says to cancel, make room and export again. */
  readonly nativeAdvice: string;
  /** Said beside the quiet "Start anyway" link (memory and space questions only). */
  readonly startAnywayNote: string;
  /** The answers offered, in button order. */
  readonly answers: readonly ExportAnswer[];
  /** A known problem, not just a heads-up: the native box says "Continue anyway?". */
  readonly warning: boolean;
  /** What the trace records when it is shown: for a memory or space question the need and what the PC has,
   *  in 128 MiB steps; for a notice how many reasons it lists and which (one bit each). */
  readonly bands: { readonly n: number; readonly m: number };
  /** The question takes a folder as part of its answer: the exported file's room can be had by saving the
   *  video somewhere else. A flag, not a path: the folder the file is going to and the one the person
   *  picks live with the question on screen (store/exportQuestionHost.ts), so this record, which is also
   *  what the report is told from, never carries one. */
  readonly folderBox: "save_to" | null;
}

/** What the pre-start check found. Built by the queue from its measurements; carries no names or paths. */
export interface PreflightPicture {
  readonly via: ExportVia;
  /** How many exports the request holds (a batch is asked about once). */
  readonly count: number;
  readonly reasons: ReadonlySet<Reason>;
  readonly memoryNeededBytes: number | null;
  /** What an export may use right now: the smaller of the PC's free memory and the app's own limit. */
  readonly memoryUsableBytes: number | null;
  /** The files and their temporary data together, the number the check compared with each drive. */
  readonly spaceNeededBytes: number | null;
  readonly destinationFreeBytes: number | null;
  readonly scratchFreeBytes: number | null;
  readonly destinationShort: boolean;
  readonly scratchShort: boolean;
  /** The destination's drive ("D:") when the path names one. */
  readonly drive: string | null;
  /** The request owns where its file goes (one export whose tool chose the destination), so it can be started
   *  again at another folder. False for a batch of files, which each have a name in one chosen folder. */
  readonly movable: boolean;
  readonly seconds: number | null;
  readonly secondsGuessed: boolean;
  readonly executionLimitSeconds: number | null;
}

/** Does this combination of findings ask the person anything? Today's rule: a known problem asks; a
 *  long or slow estimate asks too, except for the Export menu, whose dialog has just shown the estimate. */
export function asksAboutIt(reasons: ReadonlySet<Reason>, via: ExportVia): boolean {
  for (const reason of reasons) {
    if (isKnownProblem(reason)) return true;
    if ((reason === "slow" || reason === "long") && via !== "menu") return true;
  }
  return false;
}

const MIB = 1024 ** 2;
/** A size in 128 MiB steps, for the trace. */
export const bandOf = (bytes: number | null): number =>
  bytes !== null && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / (128 * MIB)) : 0;

/** "about 3.2 GB" or "about 640 MB", rounded UP for what is needed and DOWN for what the PC has, so a
 *  shortage never reads as a tie and the numbers never contradict the verdict. */
function sized(bytes: number | null, direction: "up" | "down"): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1e9) {
    const tens = direction === "up" ? Math.max(1, Math.ceil(bytes / 1e7)) : Math.floor(bytes / 1e7);
    return `about ${tens * 10} MB`;
  }
  const tenths = direction === "up" ? Math.ceil(bytes / 1e8) : Math.floor(bytes / 1e8);
  return `about ${(tenths / 10).toFixed(1)} GB`;
}

/** The drive letter of a Windows path ("D:"), or null for any other kind of path. */
export function driveOf(path: string): string | null {
  const match = /^([A-Za-z]):[\\/]/.exec(path);
  return match ? `${match[1].toUpperCase()}:` : null;
}

/** A folder spelled one way, so two spellings of the same place compare equal: one kind of slash, no doubled or
 *  trailing ones (a drive's root keeps its own, and a share keeps its two leading slashes). */
function folderKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  const share = /^\/\/[^/]/.test(slashed);
  const joined = slashed.replace(/\/{2,}/g, "/");
  const key = (share ? `/${joined}` : joined).replace(/(.)\/+$/, "$1");
  return /^[A-Za-z]:$/.test(key) ? `${key}/` : key;
}

/** Whether two spellings name the same folder. A Windows path (a drive or a share) is compared without regard to
 *  case, as Windows does; any other path as it is written. */
export function sameFolder(a: string, b: string): boolean {
  const left = folderKey(a);
  const right = folderKey(b);
  const windows = /^([A-Za-z]:|\/\/[^/])/.test(left) || /^([A-Za-z]:|\/\/[^/])/.test(right);
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The folder a file path is in ("C:/out/movie.mp4" is "C:/out"), or "" for a bare name. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  const head = path.slice(0, cut);
  if (head === "") return "/";
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
}

/** A folder as the person's own system writes it: backslashes for a path on a drive or on a share. */
export function displayFolder(path: string): string {
  return /^([A-Za-z]:|\/\/[^/])/.test(path) ? path.replace(/\//g, "\\") : path;
}

const ADVICE_FIT =
  "Close other programs (web browsers, games, other editors), then press Continue. We'll check again.";
const NATIVE_ADVICE_FIT =
  "To make room, choose Cancel, close other programs (web browsers, games, other editors) and export again. Or continue now: your PC may be slow while it exports.";
const NATIVE_RISK =
  "Or continue now: if the drive fills up, the export stops and your project is unchanged.";

function memoryQuestion(p: PreflightPicture): ExportQuestion {
  return {
    kind: "memory",
    code: "b1",
    title: "Not enough free memory",
    lines: ["This export needs more memory than your PC can give it right now."],
    facts: [
      { label: "Needed", value: sized(p.memoryNeededBytes, "up") },
      { label: "Available now", value: sized(p.memoryUsableBytes, "down") },
    ],
    advice: ADVICE_FIT,
    nativeAdvice: NATIVE_ADVICE_FIT,
    startAnywayNote: "Can't close anything? Your PC may be slow while it exports.",
    answers: ["cancel", "continue", "start_anyway"],
    warning: true,
    bands: { n: bandOf(p.memoryNeededBytes), m: bandOf(p.memoryUsableBytes) },
    folderBox: null,
  };
}

function spaceQuestion(
  p: PreflightPicture,
  kind: "output_space" | "working_space",
): ExportQuestion {
  const output = kind === "output_space";
  const drive = output ? p.drive : null;
  // Only the exported file can go somewhere else: ArtDaddy's own working files stay where it keeps them.
  const folderBox = output && p.movable ? ("save_to" as const) : null;
  const what =
    p.count > 1
      ? "the exported videos and their temporary files together"
      : "the exported video and its temporary files";
  return {
    kind,
    code: output ? "b2" : "b3",
    title: output ? "Not enough space for the exported file" : "Not enough working space",
    lines: output
      ? [
          `There may not be enough room ${drive ? `on drive ${drive}` : "where you are saving"} for ${what}.`,
        ]
      : [
          "ArtDaddy keeps temporary files while it exports and removes them when it is done.",
          "There may not be enough room for them on the drive it keeps them on.",
        ],
    facts: [
      { label: "Needed", value: sized(p.spaceNeededBytes, "up") },
      {
        label: output ? (drive ? `Free on ${drive}` : "Free") : "Free for temporary files",
        value: sized(output ? p.destinationFreeBytes : p.scratchFreeBytes, "down"),
      },
    ],
    advice: output
      ? `Free up some space${drive ? ` on ${drive}` : ""}${folderBox ? ", or save the video somewhere else" : ""}, then press Continue. We'll check again.`
      : "Free up some space on the drive where ArtDaddy keeps its working files (usually the one Windows is on), then press Continue. We'll check again.",
    nativeAdvice: output
      ? `To make room, choose Cancel, free up some space${drive ? ` on ${drive}` : ""} and export again. ${NATIVE_RISK}`
      : `To make room, choose Cancel, free up some space on the drive where ArtDaddy keeps its working files (usually the one Windows is on) and export again. ${NATIVE_RISK}`,
    startAnywayNote:
      "Think there is enough room? If the drive fills up, the export stops and your project is unchanged.",
    answers: ["cancel", "continue", "start_anyway"],
    warning: true,
    bands: {
      n: bandOf(p.spaceNeededBytes),
      m: bandOf(output ? p.destinationFreeBytes : p.scratchFreeBytes),
    },
    folderBox,
  };
}

type NoticeReason = "execution_limit" | "outside_promise" | "temporary_limit" | "long" | "slow";
/** The reasons a notice can list, in the order they are told. */
const NOTICE_ORDER: readonly NoticeReason[] = [
  "execution_limit",
  "outside_promise",
  "temporary_limit",
  "long",
  "slow",
];

const NOTICE_TITLE: Record<NoticeReason, string> = {
  execution_limit: "This export may be stopped before it finishes",
  outside_promise: "This project is larger than usual",
  temporary_limit: "Temporary space is nearly full",
  long: "This export will take a long time",
  slow: "This export will take a while",
};

function noticeLine(reason: NoticeReason, p: PreflightPicture): string {
  switch (reason) {
    case "execution_limit": {
      const limit = describeExportTime(p.executionLimitSeconds);
      return `It is estimated to take longer than the longest an export may run${limit ? ` (${limit})` : ""}, so it would be stopped. Try a shorter section or a lower resolution.`;
    }
    case "outside_promise":
      return "This project is bigger than ArtDaddy has been tested with (picture size, frame rate, or the number of clips and layers). It may be slow, or may not finish.";
    case "temporary_limit":
      return "ArtDaddy's temporary space for exports is nearly full, probably because other exports are using it. Waiting for them to finish may help.";
    case "long":
      return "This export is expected to take a long time.";
    case "slow":
      return "This export is estimated to take more than twice as long as the video.";
  }
}

function noticeQuestion(p: PreflightPicture, shown: readonly NoticeReason[]): ExportQuestion {
  const time = describeExportTime(p.seconds);
  return {
    kind: "notice",
    code: "confirm",
    title: NOTICE_TITLE[shown[0]],
    lines: shown.map((reason) => noticeLine(reason, p)),
    facts: time
      ? [
          {
            label: "Estimated time",
            value: p.secondsGuessed
              ? `${time} (a rough guess from the size of the video: nothing like it has been exported on this PC yet)`
              : `${time} (from earlier exports on this PC)`,
          },
        ]
      : [],
    advice:
      "Lowering the resolution or exporting a smaller section makes it faster. Cancel to change the settings.",
    nativeAdvice:
      "Lowering the resolution or exporting a smaller section makes it faster. Cancel to change the settings.",
    startAnywayNote: "",
    answers: ["cancel", "continue"],
    warning: shown.some((reason) => isKnownProblem(reason)),
    bands: {
      n: shown.length,
      m: shown.reduce((bits, reason) => bits | (CONFIRM_REASON_BITS[reason] ?? 0), 0),
    },
    folderBox: null,
  };
}

/** The questions to ask now, in the order they are asked: memory, then the exported file's space, then
 *  the working space, then everything else in one notice. A kind the person already waived with
 *  *Start anyway* is not asked again. The caller asks the FIRST one, and after *Continue* on a memory or
 *  space question measures again and calls this again, so a repeat is the same question with new numbers. */
export function planQuestions(
  p: PreflightPicture,
  waived: ReadonlySet<ExportQuestionKind> = new Set(),
): ExportQuestion[] {
  const out: ExportQuestion[] = [];
  if (p.reasons.has("memory_shortage") && !waived.has("memory")) out.push(memoryQuestion(p));
  if (p.reasons.has("disk_shortage")) {
    // When the check cannot say which drive failed, it is the exported file's drive the person can act on.
    const output = p.destinationShort || !p.scratchShort;
    if (output && !waived.has("output_space")) out.push(spaceQuestion(p, "output_space"));
    if (p.scratchShort && !waived.has("working_space")) out.push(spaceQuestion(p, "working_space"));
  }
  const shown = NOTICE_ORDER.filter(
    (reason) =>
      p.reasons.has(reason) && (p.via !== "menu" || (reason !== "long" && reason !== "slow")),
  );
  if (shown.length > 0 && !waived.has("notice")) out.push(noticeQuestion(p, shown));
  return out;
}

/** The question as one native message, for when no dialog is mounted to ask it. */
export function questionAsText(q: ExportQuestion): { message: string; warning: boolean } {
  const fact = ({ label, value }: QuestionFact): string =>
    `${label}${label.endsWith(":") ? "" : ":"} ${value}`;
  const parts = [
    q.title,
    q.lines.join("\n"),
    q.facts.map(fact).join("\n"),
    q.nativeAdvice,
    q.warning ? "Continue anyway?" : "Continue?",
  ].filter((part) => part.length > 0);
  return { message: parts.join("\n\n"), warning: q.warning };
}

export interface AnswerButton {
  readonly answer: ExportAnswer;
  readonly label: string;
}

/** The buttons of a question, in the one order every surface shows them (the dialog and the card): the
 *  way out first, the way on next, the quiet "Start anyway" last. */
export function answerButtons(q: ExportQuestion): AnswerButton[] {
  return q.answers.map((answer) => ({
    answer,
    label:
      answer === "cancel"
        ? "Cancel"
        : answer === "start_anyway"
          ? "Start anyway"
          : q.kind === "notice" && q.warning
            ? "Continue anyway"
            : "Continue",
  }));
}
