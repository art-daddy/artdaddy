// What the speech sample says about HOW a run was made, so that the reach of a speech change and of a graphics chip that
// returns wrong word times can be SEEN (the sample is `reportTranscription`, appEvents.ts). This file is the one place that
// says which facts may leave the PC, and in which words: every value is a flag, a number or a word of a list written here
// or in a table that is already the app's (the model manifest, the engine's languages, the makers of whisperFacts.ts), and
// whatever else a caller hands over is dropped, never sent. Nothing of what was said, no file name, no device name, driver or
// id is ever among them.
//
// The tokens, in the order they are written after the sample's older figures (each is left out when it does not apply):
//   ng=1       the launch carried `-ng`: the processor was forced (the hold after a crash, a model file that may only run there,
//              or the run after a chip crash). On a PC where the engine finds no chip it runs on its processor without it
//   held=1     the graphics chip was being kept off when the run launched (the hold after a crash)
//   mf=<key>   which model file ran, by its key in the manifest (`small`, `small_q8_0`): the engine's own `model=` word is
//              `small` for both
//   net=1      the run is the net: the full-size file after the smaller one failed on this PC
//   dtw=1|r    the first-word arguments: 1 the launch carried them, r it carried them, failed and the plain retry ran
//   lead=      where the voice started in the one file the launch heard, as the rule measured it: le1 (a second or less),
//              gt1 (more than a second), unk (not known). Only a launch the rule could apply to measures it.
//   gpu=<maker> who made the graphics chip the run used: amd, nvidia, intel, apple or other (never the device)
//   lang=      the language the run was asked for: one of the engine's codes, or auto
//
// Whether a build tells any of this is SPEECH_FACTS_SHIPPED. It is off until the owner has said yes to the change in what the
// sample carries AND both privacy documents (the app's PRIVACY.txt and the website's privacy page) say it in the same words;
// the flip is then one commit that turns the constant on and changes both documents.
import { MODEL_MANIFEST } from "./modelManifest";
import { LEADING_QUIET_MS, type VoiceStart } from "./speechLeadingQuiet";
import { GPU_MAKERS } from "./whisperFacts";
import { WHISPER_LANGUAGES } from "./whisperLanguages";

/** Whether this build tells these facts. Off in every commit but the one that turns it on, with the privacy documents. */
export const SPEECH_FACTS_SHIPPED = false;

let shipped: boolean = SPEECH_FACTS_SHIPPED;

/** Whether the facts are told by this build right now. The one question both the launch (which writes them on the run) and
 *  the sample (which sends them) ask, so a build that keeps them dark does nothing for them. */
export function speechFactsOn(): boolean {
  return shipped;
}

/** Tests only. */
export function __setSpeechFactsShipped(value: boolean): void {
  shipped = value;
}

/** Tests only: back to what the build says. */
export function __resetSpeechFactsShipped(): void {
  shipped = SPEECH_FACTS_SHIPPED;
}

export const LEAD_CLASSES = ["le1", "gt1", "unk"] as const;
export type LeadClass = (typeof LEAD_CLASSES)[number];

export const DTW_STATES = ["1", "r"] as const;
export type DtwState = (typeof DTW_STATES)[number];

/** How a run was made, as its launch knew it. Written on the run's own record at the launch (transcribe.ts), so a page that
 *  takes the run over after a crash reports it the same way; LOCAL until the sample is sent, and what is sent is only what
 *  {@link speechFactTokens} lets through. */
export interface SpeechRunNotes {
  ng?: true;
  held?: true;
  /** The manifest key of the model file that ran. */
  mf?: string;
  net?: true;
  dtw?: DtwState;
  lead?: LeadClass;
  /** The language argument of the run: a code of the engine's table, or "auto". */
  lang?: string;
}

const MODEL_FILES: ReadonlySet<string> = new Set(Object.keys(MODEL_MANIFEST));
const LANGUAGES: ReadonlySet<string> = new Set([...Object.keys(WHISPER_LANGUAGES), "auto"]);
const LEADS: ReadonlySet<unknown> = new Set(LEAD_CLASSES);
const DTWS: ReadonlySet<unknown> = new Set(DTW_STATES);
const MAKERS: ReadonlySet<unknown> = new Set(GPU_MAKERS);

/** Where the voice started, as one of the three words the sample knows. `none` (nothing stood out: silence, a very quiet
 *  recording, a voice after the scanned seconds) is not a start the detector found, so it is "not known", never "a second or
 *  less". */
export function leadOf(voice: VoiceStart): LeadClass {
  if (voice.kind !== "at") return "unk";
  return voice.ms > LEADING_QUIET_MS ? "gt1" : "le1";
}

/** The tokens the sample appends to its `reason`, in their order: nothing while the build keeps the facts dark, and for
 *  anything not in the lists above (a wrong type, a word nobody listed, an object from a record that was damaged) nothing.
 *  `gpu` is the maker that whisperFacts.ts read from the run's own log. */
export function speechFactTokens(notes: SpeechRunNotes | undefined, gpu?: unknown): string[] {
  if (!shipped) return [];
  const n = (notes ?? {}) as Record<string, unknown>;
  const tokens: string[] = [];
  if (n.ng === true) tokens.push("ng=1");
  if (n.held === true) tokens.push("held=1");
  if (typeof n.mf === "string" && MODEL_FILES.has(n.mf)) tokens.push(`mf=${n.mf}`);
  if (n.net === true) tokens.push("net=1");
  if (DTWS.has(n.dtw)) tokens.push(`dtw=${String(n.dtw)}`);
  if (LEADS.has(n.lead)) tokens.push(`lead=${String(n.lead)}`);
  if (MAKERS.has(gpu)) tokens.push(`gpu=${String(gpu)}`);
  if (typeof n.lang === "string" && LANGUAGES.has(n.lang)) tokens.push(`lang=${n.lang}`);
  return tokens;
}
