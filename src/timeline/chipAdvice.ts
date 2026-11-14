// The two hints under the Graphics chip row: an NVIDIA driver older than the encoder needs, and Intel graphics that may be switched off in the
// BIOS. A pure function of what the app reads (the adapters, their drivers, what the chip test said, the processor's name) and fixed words:
// no sentence names a driver number other than the person's own and the one the pinned encoder needs, a card generation, a site, or the
// existence of an update. They stay on this PC: nothing here is sent, and the processor's name is never given to anything that is.
import type { ChipTestResult } from "./chipTest";
import type { ChipMaker } from "./exportEncoder";

/** The oldest NVIDIA driver the pinned ffmpeg's encoder accepts ("The minimum required Nvidia driver for nvenc is 610.00 or newer", in the
 *  build `scripts/sidecarStaging.mjs` pins). A different pinned build needs this looked at again. */
export const NVIDIA_MIN_DRIVER = 610;

export interface ChipAdviceFacts {
  /** The PC's graphics chips of the makers the exporter knows: the driver as Windows spells it, and what the chip test last said of the
   *  chip at the delivered size (null: nothing, or too long ago). */
  readonly adapters: ReadonlyArray<{
    readonly maker: ChipMaker;
    readonly driver: string;
    readonly result: ChipTestResult | null;
  }>;
  /** The processor's model string as Windows keeps it, or null when it could not be read. */
  readonly processor: string | null;
}

export interface ChipAdvice {
  readonly kind: "nvidia_driver" | "intel_graphics";
  readonly text: string;
}

/** NVIDIA's own driver number in hundredths (560.94 is 56094), from the four parts of the version Windows keeps ("32.0.15.6094"): the
 *  last digit of the third part and the four digits of the fourth are its last five digits. Null for anything that is not that shape. */
export function nvidiaDriverUnits(driver: string): number | null {
  const parts = typeof driver === "string" ? /^\d+\.\d+\.(\d+)\.(\d{4})$/.exec(driver) : null;
  if (!parts) return null;
  return Number(parts[1].slice(-1)) * 10_000 + Number(parts[2]);
}

const spelled = (units: number): string =>
  `${Math.floor(units / 100)}.${String(units % 100).padStart(2, "0")}`;

/** The same number as NVIDIA writes it ("560.94"), or null. */
export function nvidiaDriverNumber(driver: string): string | null {
  const units = nvidiaDriverUnits(driver);
  return units === null ? null : spelled(units);
}

/** The suffixes of an Intel Core model number, by whether that processor has graphics on the chip. A suffix in neither list is not
 *  known, and the model gets no hint. (F and KF are the parts with the graphics left off; X and XE are the high-end desktop parts, which
 *  never had any. G followed by a digit is a mobile part's graphics level.) */
export const INTEL_SUFFIXES: {
  readonly withGraphics: readonly string[];
  readonly none: readonly string[];
} = {
  withGraphics: [
    "",
    "K",
    "S",
    "T",
    "TE",
    "C",
    "R",
    "U",
    "Y",
    "H",
    "HK",
    "HQ",
    "HX",
    "M",
    "MQ",
    "QM",
    "QE",
    "P",
    "G1",
    "G4",
    "G7",
  ],
  none: ["F", "KF", "X", "XE"],
};

/** The desktop parts of the X79 and X99 platforms whose suffix does not say it: they have no graphics either. */
export const NO_GRAPHICS_MODELS: readonly string[] = [
  "i7-3820",
  "i7-3930K",
  "i7-4820K",
  "i7-4930K",
  "i7-5820K",
  "i7-5930K",
  "i7-6800K",
  "i7-6850K",
  "i7-6900K",
];

/** Whether the processor is an Intel Core model known to have graphics on the chip: it names Intel, has a model number of the Core i3, i5,
 *  i7 or i9 kind (four or five digits) and a suffix the table lists with graphics. Anything else (a Xeon, a Pentium, a Core Ultra, another
 *  maker, a name that cannot be read) is not known to, and no hint is given. */
export function hasIntelGraphics(processor: string | null): boolean {
  if (typeof processor !== "string" || !/\bIntel\b/i.test(processor)) return false;
  const model = /\bi([3579])-(\d{4,5})([A-Z]{0,3}\d?)(?![A-Za-z0-9])/.exec(processor);
  if (!model) return false;
  const [, tier, digits, suffix] = model;
  if (NO_GRAPHICS_MODELS.includes(`i${tier}-${digits}${suffix}`)) return false;
  return INTEL_SUFFIXES.withGraphics.includes(suffix) && !INTEL_SUFFIXES.none.includes(suffix);
}

const MAKER_WORDS = { amd: "AMD", nvidia: "NVIDIA" } as const;

/** The one line for the chip row, or null. The NVIDIA line comes first: it is about a chip that was tested and did not pass. */
export function chipAdvice(facts: ChipAdviceFacts): ChipAdvice | null {
  try {
    const adapters = Array.isArray(facts?.adapters) ? facts.adapters : [];
    // An NVIDIA chip whose encode failed (a picture that came out wrong needs a driver that works, so it is not this) with a driver
    // under the floor; the oldest of them is the one named.
    const old = adapters
      .filter(
        (adapter) =>
          adapter?.maker === "nvidia" &&
          (adapter.result === "encode_failed" || adapter.result === "cached_fail"),
      )
      .map((adapter) => nvidiaDriverUnits(adapter.driver))
      .filter((units): units is number => units !== null && units < NVIDIA_MIN_DRIVER * 100);
    if (old.length > 0)
      return {
        kind: "nvidia_driver",
        text: `Your NVIDIA graphics driver is ${spelled(Math.min(...old))}. ArtDaddy's graphics-chip path needs ${NVIDIA_MIN_DRIVER} or newer. If a newer driver exists for your card, updating it can make exports faster. If not, ArtDaddy keeps using the processor.`,
      };
    // Intel graphics the processor has but the app cannot see: every adapter it sees is of another maker.
    const makers = new Set(adapters.map((adapter) => adapter?.maker));
    if (hasIntelGraphics(facts.processor) && !makers.has("intel")) {
      const seen = (["amd", "nvidia"] as const)
        .filter((maker) => makers.has(maker))
        .map((maker) => MAKER_WORDS[maker]);
      if (seen.length > 0)
        return {
          kind: "intel_graphics",
          text: `Your processor has Intel graphics, but ArtDaddy can only see ${seen.join(" and ")} graphics. The Intel graphics may be switched off in your PC's BIOS. If it is switched on, ArtDaddy can test it and use it to make exports faster when it passes.`,
        };
    }
    return null;
  } catch {
    return null;
  }
}
