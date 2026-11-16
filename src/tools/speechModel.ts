// Which speech model file a run uses, and the rule that a file only ever runs on a path it was cleared for.
//
// The invariant: the file the manifest restricts to the processor (the 8-bit one) is launched only on the processor
// path, the launch with `-ng`, never on the graphics chip; and a language the gate did not clear on the processor
// uses the baseline file on every path. A PC with a graphics chip is planned exactly as it was before this existed.
//
// Two authorities, and nothing copied from them: the manifest (`backends` of an entry says which paths a FILE may
// be launched on) and the accuracy gate (speechGate.json says which LANGUAGE a variant is cleared for, on which path,
// at which beam). No language and no file name is written in this module. The gate's chip measurements are not read
// here: the two paths give different results for one file (speechDecoding.ts, `measuredOn`).
//
// Four places read it, each at the deepest point it can: `planModel` before a run, `acceptableRun` at the commit point
// (the language the engine detected, against the file and beam that were really used), `launchPlan` where the
// engine's arguments are made, and `assertLaunchArgv` on the final arguments just before the engine is spawned.
import { backendsOf, DEFAULT_MODEL_KEY, MODEL_MANIFEST, type ModelEntry } from "./modelManifest";
import {
  acceptableBeam,
  beamFor,
  clearedOn,
  DEFAULT_BEAM,
  GREEDY_BEAM,
  SHIPPED_EVIDENCE,
  type GateEvidence,
  type ModelVariant,
} from "./speechDecoding";
import type { SpeechBackend } from "./speechPace";
import { whisperCode } from "./whisperLanguages";

/** The one switch of the owner's decision on a PC that already has the larger file: false leaves it alone, so the
 *  smaller file is only ever downloaded by a PC that has neither; true offers it to such a PC too. */
export const OFFER_SMALLER_TO_INSTALLED = false;

export interface ModelPlan {
  /** A key of the manifest. */
  key: string;
  variant: ModelVariant;
  beam: number;
}

export interface PlanInput {
  /** The path a run started now would use. Anything but "cpu" is planned as the graphics chip. */
  backend: SpeechBackend;
  /** A named or predicted language, in any spelling whisperCode knows; null, or a spelling it does not know, is
   *  nothing known. */
  language: string | null;
  /** The manifest keys whose file is whole on disk. Keys the manifest does not have are ignored. */
  installed: readonly string[];
}

/** A launch the manifest does not allow: a file it does not name, or a file on a path it was not cleared for. The
 *  message never holds the path, which names the person's folders. */
export class ModelPairingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelPairingError";
  }
}

export interface ModelRules {
  planModel(input: PlanInput, offerSmallerToInstalled?: boolean): ModelPlan;
  processorBeam(language: string): 1 | 5 | null;
  acceptableRun(used: { variant: ModelVariant; beam: number }, detected: string): boolean;
  launchPlan(args: readonly string[], cpuOnly: boolean): { cpuOnly: boolean; key: string };
  assertLaunchArgv(argv: readonly string[]): void;
  modelKeyOfPath(path: string): string | null;
}

/** The rules over a given manifest and gate. The functions this module exports are these applied to the shipped
 *  ones; this is exported so a test can ask what the rules do over a manifest that is not the shipped one. */
export function modelRules(
  manifest: Readonly<Record<string, ModelEntry>>,
  baselineKey: string,
  gate: GateEvidence,
): ModelRules {
  const baseline = Object.hasOwn(manifest, baselineKey) ? manifest[baselineKey] : undefined;
  if (!baseline) throw new Error(`the baseline model "${baselineKey}" is not in the manifest`);
  const entries = Object.entries(manifest);

  // The file for a PC with no usable graphics chip: the one the manifest allows on the processor and nowhere else,
  // and only while the gate has cleared a language for it there. A file nothing was cleared for is never planned.
  const processorOnly = entries.find(([, e]) => {
    const paths = backendsOf(e);
    return paths.includes("cpu") && !paths.includes("gpu");
  });
  const cleared = processorOnly ? clearedOn(gate, "cpu").get(processorOnly[1].variant) : undefined;
  const smaller = [...(cleared?.values() ?? [])].some((set) => set.size > 0)
    ? processorOnly
    : undefined;

  const beamOnProcessor = (code: string): 1 | 5 | null => {
    if (code === "") return null;
    if (cleared?.get(GREEDY_BEAM)?.has(code)) return GREEDY_BEAM;
    if (cleared?.get(DEFAULT_BEAM)?.has(code)) return DEFAULT_BEAM;
    return null;
  };
  const processorBeam = (language: string): 1 | 5 | null => beamOnProcessor(whisperCode(language));

  const planOf = (key: string, entry: ModelEntry, beam: number): ModelPlan => ({
    key,
    variant: entry.variant,
    beam,
  });

  const planModel = (
    input: PlanInput,
    offerSmallerToInstalled: boolean = OFFER_SMALLER_TO_INSTALLED,
  ): ModelPlan => {
    const language = input?.language ?? null;
    // Today's plan, byte for byte: the baseline file, at the beam the chip's gate gives the language.
    const today = (): ModelPlan =>
      planOf(baselineKey, baseline, beamFor(baseline.variant, language ?? ""));
    if (input?.backend !== "cpu" || !smaller) return today();

    const [smallerKey, smallerEntry] = smaller;
    const have = new Set(Array.isArray(input.installed) ? input.installed : []);
    const code = whisperCode(language);
    if (code === "") {
      // Nothing is known yet, so a beam that suits every language: the baseline file when it is here, else the
      // smaller one, and the commit point sends a language it was not cleared for back to the baseline.
      return have.has(baselineKey)
        ? planOf(baselineKey, baseline, DEFAULT_BEAM)
        : planOf(smallerKey, smallerEntry, DEFAULT_BEAM);
    }
    const beam = beamOnProcessor(code);
    if (beam === null) return today();
    // Cleared: the smaller file when it is here; else the baseline when that is here and the owner's switch leaves
    // an installed PC alone (no surprise download); else the smaller file, the halved download.
    return have.has(smallerKey) || !have.has(baselineKey) || offerSmallerToInstalled
      ? planOf(smallerKey, smallerEntry, beam)
      : today();
  };

  const acceptableRun = (
    used: { variant: ModelVariant; beam: number },
    detected: string,
  ): boolean => {
    if (used?.variant === baseline.variant)
      return acceptableBeam(used.beam, baseline.variant, detected);
    if (smaller && used?.variant === smaller[1].variant) {
      const beam = beamOnProcessor(whisperCode(detected));
      return beam !== null && used.beam >= beam;
    }
    return false;
  };

  // By file name: either path separator, any letter case. The whole name is compared, never its end, and a name two
  // entries share (in another case) is no one's.
  const keyOfName = new Map<string, string | null>();
  for (const [key, e] of entries) {
    const name = e.file.toLowerCase();
    keyOfName.set(name, keyOfName.has(name) ? null : key);
  }
  const modelKeyOfPath = (path: string): string | null => {
    if (typeof path !== "string") return null;
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    return keyOfName.get(name.toLowerCase()) ?? null;
  };

  /** The model file the arguments name and whether they turn the graphics chip off, read as whisper-cli reads
   *  them: `-m` (or `--model`) takes the next argument whatever it looks like, and `-ng` (or `--no-gpu`) is a flag.
   *  The value of any other option is not interpreted, so a value spelled exactly `-ng` would be taken for the
   *  flag; the app's own values (paths, numbers, language codes) are never spelled so. */
  const readArgv = (argv: readonly string[]): { key: string; noGpu: boolean } => {
    if (!Array.isArray(argv)) throw new ModelPairingError("the engine's arguments are not a list");
    let named = 0;
    let file: unknown;
    let noGpu = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "-m" || arg === "--model") {
        named++;
        if (i + 1 >= argv.length) throw new ModelPairingError("-m has no model file after it");
        file = argv[++i];
      } else if (arg === "-ng" || arg === "--no-gpu") {
        noGpu = true;
      }
    }
    if (named === 0) throw new ModelPairingError("the engine's arguments name no model file (-m)");
    if (named > 1)
      throw new ModelPairingError("the engine's arguments name more than one model file");
    const key = modelKeyOfPath(file as string);
    if (key === null) throw new ModelPairingError("the model file is not one the manifest names");
    return { key, noGpu };
  };

  const launchPlan = (
    args: readonly string[],
    cpuOnly: boolean,
  ): { cpuOnly: boolean; key: string } => {
    const { key } = readArgv(args);
    const paths = backendsOf(manifest[key]);
    const onChip = paths.includes("gpu");
    const onProcessor = paths.includes("cpu");
    if (!onChip && !onProcessor)
      throw new ModelPairingError(`model "${key}" may not be launched on any path`);
    if (cpuOnly) {
      if (!onProcessor)
        throw new ModelPairingError(`model "${key}" may not be launched on the processor`);
      return { cpuOnly: true, key };
    }
    // A file that may not run on the chip is converted, not refused: the plan and the launch can disagree for a few
    // seconds, and the processor is the path the file was cleared for.
    return { cpuOnly: !onChip, key };
  };

  const assertLaunchArgv = (argv: readonly string[]): void => {
    const { key, noGpu } = readArgv(argv);
    const path: SpeechBackend = noGpu ? "cpu" : "gpu";
    if (!backendsOf(manifest[key]).includes(path))
      throw new ModelPairingError(
        `model "${key}" may not be launched on the ${path === "cpu" ? "processor" : "graphics chip"}`,
      );
  };

  return { planModel, processorBeam, acceptableRun, launchPlan, assertLaunchArgv, modelKeyOfPath };
}

const SHIPPED = modelRules(MODEL_MANIFEST, DEFAULT_MODEL_KEY, SHIPPED_EVIDENCE);

/** The file and beam to start a run with. On the graphics chip: today's plan, the baseline file at the beam the
 *  chip's gate gives the language. On the processor: the smaller file for a language the gate cleared on the
 *  processor, at the beam it cleared; the baseline file for every other language. Nothing known: the baseline file
 *  when it is installed, else the smaller one, at the default beam, and the commit point checks the result.
 *  `offerSmallerToInstalled` is {@link OFFER_SMALLER_TO_INSTALLED}'s switch. */
export function planModel(
  input: PlanInput,
  offerSmallerToInstalled: boolean = OFFER_SMALLER_TO_INSTALLED,
): ModelPlan {
  return SHIPPED.planModel(input, offerSmallerToInstalled);
}

/** The beam the smaller file is cleared for on the processor in this language (greedy where that passed, else the
 *  default), or null: not cleared, so the baseline file is used. Never reads the chip's measurements. */
export function processorBeam(language: string): 1 | 5 | null {
  return SHIPPED.processorBeam(language);
}

/** Whether a run made with `used` may be kept, given the language the engine detected. The baseline file: as
 *  {@link acceptableBeam} says. The smaller file: only for a language it was cleared for, and not at a narrower beam
 *  than it was cleared at. A language that is empty or unknown is acceptable for the baseline file at the default
 *  beam only, and a file that is neither is never acceptable. */
export function acceptableRun(
  used: { variant: ModelVariant; beam: number },
  detected: string,
): boolean {
  return SHIPPED.acceptableRun(used, detected);
}

/** For the engine's arguments `args` and whether the caller wants the processor: the manifest key of the model file
 *  they name, and whether the launch is the processor's. A file the manifest does not allow on the chip is launched
 *  on the processor whatever the caller asked. Throws {@link ModelPairingError} for no `-m`, two, a `-m` with no
 *  value, a file the manifest does not name, a processor launch of a file it does not allow there, and a file it
 *  allows nowhere. */
export function launchPlan(
  args: readonly string[],
  cpuOnly: boolean,
): { cpuOnly: boolean; key: string } {
  return SHIPPED.launchPlan(args, cpuOnly);
}

/** The last check, on the arguments about to be spawned: the model file's entry must allow the path they imply (`-ng`
 *  present is the processor, absent is the chip). Throws {@link ModelPairingError} otherwise. */
export function assertLaunchArgv(argv: readonly string[]): void {
  SHIPPED.assertLaunchArgv(argv);
}

/** The manifest key of the model file a path names, by file name alone (either separator, any letter case, the whole
 *  name), or null. */
export function modelKeyOfPath(path: string): string | null {
  return SHIPPED.modelKeyOfPath(path);
}
