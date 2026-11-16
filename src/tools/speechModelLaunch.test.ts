// launchPlan, assertLaunchArgv and modelKeyOfPath: the last two places the invariant is held. launchPlan is where the
// engine's arguments are made (a file the manifest allows only on the processor is launched there whatever was asked);
// assertLaunchArgv is the check on the FINAL arguments just before the engine is spawned. Both are tested in both
// directions, over many spellings of a path: nothing that pairs the 8-bit file with the graphics chip passes, and
// nothing legitimate is refused. The oracles are the generator's own knowledge of which file it spelled, the
// manifest's `backends`, and, for the owner's decision itself, a literal.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { backendsOf, MODEL_MANIFEST } from "./modelManifest";
import { decodeArgs } from "./speechDecoding";
import { assertLaunchArgv, launchPlan, modelKeyOfPath, ModelPairingError } from "./speechModel";

// Written out on purpose: the module may not know a file or a key.
const BASELINE_KEY = "small";
const SMALLER_KEY = "small_q8_0";
const BASELINE_FILE = "ggml-small.bin";
const SMALLER_FILE = "ggml-small-q8_0.bin";

const KEYS = Object.keys(MODEL_MANIFEST);
const FILES = Object.values(MODEL_MANIFEST).map((e) => e.file);

/** The engine's arguments as transcribe.ts builds them for one run, with the model path as given. */
const appArgv = (model: string, beam = 5): string[] => [
  "-m",
  model,
  "-f",
  "C:\\work\\a clip.wav",
  "-ojf",
  "-of",
  "C:\\work\\out\\scratch",
  "-t",
  "8",
  "-l",
  "en",
  "-mc",
  "0",
  ...decodeArgs(beam),
];
/** What engineFor's launch does with the plan: -ng goes on when the launch is the processor's. */
const spawned = (args: string[], plan: { cpuOnly: boolean }): string[] =>
  plan.cpuOnly ? [...args, "-ng"] : args;

describe("the model file a path names", () => {
  it.each([
    ["C:\\Users\\Some One\\AppData\\Roaming\\My App\\models\\ggml-small.bin", BASELINE_KEY],
    ["C:/models/ggml-small.bin", BASELINE_KEY],
    ["/home/me/.local/share/app/models/ggml-small-q8_0.bin", SMALLER_KEY],
    ["\\\\server\\share\\models\\ggml-small-q8_0.bin", SMALLER_KEY],
    ["\\\\?\\C:\\models\\ggml-small-q8_0.bin", SMALLER_KEY],
    ["ggml-small.bin", BASELINE_KEY],
    ["GGML-SMALL-Q8_0.BIN", SMALLER_KEY],
    ["C:\\models\\Ggml-Small.Bin", BASELINE_KEY],
    ["C:\\a b\\..\\models\\ggml-small.bin", BASELINE_KEY],
    ["/models/ggml-small.bin/../ggml-small-q8_0.bin", SMALLER_KEY],
    ["C:\\ggml-small.bin\\ggml-small-q8_0.bin", SMALLER_KEY],
  ])("%s is the file %s", (path, key) => {
    expect(modelKeyOfPath(path)).toBe(key);
  });

  it.each([
    "xggml-small.bin",
    "ggml-small.binx",
    "ggml-small.bin.part",
    "ggml-small-q8_0.bin.49c8fb02b65e.part",
    "ggml-small.bin.verified.json",
    "ggml-small-q8_0.bin ",
    " ggml-small-q8_0.bin",
    "ggml-small-q8_0.bin.",
    "ggml-small-q8_0.bin\\",
    "ggml-small-q8_0.bin/",
    "ggml-small-q8_0.bin:stream",
    "ggml-small-q8_0.bin::$DATA",
    "ggml-small-q8_0.bin\u0000",
    "ggml-small-q8_0.bin\n",
    "C:ggml-small-q8_0.bin",
    "ggml-small-q5_1.bin",
    "ggml-medium.bin",
    "ggml-small-q8_0",
    "ggml-small_q8_0.bin",
    "ggml-small.bi",
    "small.bin",
    "ggml\u2013small.bin",
    "ggml-sma11.bin",
    "",
    "/",
    "\\",
    ".",
    "..",
    "C:\\models\\",
    "C:\\models\\ggml-small.bin\\",
  ])("%j names no file the manifest has", (path) => {
    expect(modelKeyOfPath(path)).toBeNull();
  });

  it("names nothing for what is not a string", () => {
    for (const path of [
      undefined,
      null,
      0,
      {},
      [],
      [SMALLER_FILE],
      { toString: () => SMALLER_FILE },
    ])
      expect(modelKeyOfPath(path as never)).toBeNull();
  });

  it("answers a 10,000-character path by its file name alone", () => {
    expect(modelKeyOfPath(`${"d".repeat(10_000)}\\${SMALLER_FILE}`)).toBe(SMALLER_KEY);
    expect(modelKeyOfPath(`${SMALLER_FILE}${"x".repeat(10_000)}`)).toBeNull();
  });
});

const M = `C:\\models\\${SMALLER_FILE}`;
const B = `C:\\models\\${BASELINE_FILE}`;
const SPACED = `C:\\Users\\Some One\\AppData\\Roaming\\My App\\models\\${SMALLER_FILE}`;

// [what the arguments are, the arguments, whether the final-argv check lets them through]
const CASES: Array<[string, string[], "ok" | "refused"]> = [
  ["the app's own arguments for the 8-bit file on the processor", [...appArgv(M, 1), "-ng"], "ok"],
  ["the app's own arguments for the 8-bit file on the chip", appArgv(M, 1), "refused"],
  ["the app's own arguments for today's file on the chip", appArgv(B), "ok"],
  ["the app's own arguments for today's file on the processor", [...appArgv(B), "-ng"], "ok"],
  ["a path with spaces, 8-bit file, processor", ["-m", SPACED, "-ng"], "ok"],
  ["a path with spaces, 8-bit file, chip", ["-m", SPACED], "refused"],
  ["the long spellings --model and --no-gpu", ["--model", M, "--no-gpu"], "ok"],
  ["--model without --no-gpu", ["--model", M], "refused"],
  ["-ng before -m", ["-ng", "-m", M], "ok"],
  ["-ng twice", ["-m", M, "-ng", "-ng"], "ok"],
  ["a file name in capitals, chip", ["-m", "C:\\MODELS\\GGML-SMALL-Q8_0.BIN"], "refused"],
  ["a file name in capitals, processor", ["-m", "C:\\MODELS\\GGML-SMALL-Q8_0.BIN", "-ng"], "ok"],
  ["no -m", ["-f", "a.wav", "-ng"], "refused"],
  ["-m as the last argument, with no value", ["-f", "a.wav", "-ng", "-m"], "refused"],
  ["two -m naming the same file", ["-m", M, "-m", M, "-ng"], "refused"],
  ["two -m naming one file each", ["-m", B, "-m", M, "-ng"], "refused"],
  [
    "the flag -ng taken as the model's value, which is what the engine does",
    ["-m", "-ng"],
    "refused",
  ],
  ["the flag -ng taken as the model's value, the real file after it", ["-m", "-ng", M], "refused"],
  ["an empty value", ["-m", ""], "refused"],
  ["a file the manifest does not name", ["-m", "C:\\models\\ggml-medium.bin", "-ng"], "refused"],
  [
    "a file that only ends like one it names",
    ["-m", "C:\\models\\xggml-small.bin", "-ng"],
    "refused",
  ],
  [
    "the model given as --model=value, which the engine does not read",
    [`--model=${M}`, "-ng"],
    "refused",
  ],
  ["nothing at all", [], "refused"],
];

describe("assertLaunchArgv, on the arguments about to be spawned", () => {
  it.each(CASES)("%s", (_what, argv, verdict) => {
    if (verdict === "ok") expect(() => assertLaunchArgv(argv)).not.toThrow();
    else expect(() => assertLaunchArgv(argv)).toThrow(ModelPairingError);
  });

  it("refuses what is not a list of arguments, and a list that holds something that is not an argument", () => {
    for (const argv of [undefined, null, "-m ggml-small.bin", {}, 7, { 0: "-m", 1: M, length: 2 }])
      expect(() => assertLaunchArgv(argv as never)).toThrow(ModelPairingError);
    expect(() => assertLaunchArgv(["-m", 5 as never])).toThrow(ModelPairingError);
    expect(() => assertLaunchArgv(["-m", undefined as never, "-ng"])).toThrow(ModelPairingError);
    // A value that is not text is just not the flag: the rest is read as it is.
    expect(() => assertLaunchArgv(["-m", M, 7 as never, "-ng"])).not.toThrow();
  });

  it("never says where the person's files are in what it throws", () => {
    const secret = "C:\\Users\\Pat Example\\AppData\\Roaming\\models";
    for (const argv of [
      ["-m", `${secret}\\ggml-medium.bin`],
      ["-m", `${secret}\\${SMALLER_FILE}`],
      ["-m"],
      [],
    ]) {
      let thrown: unknown;
      try {
        assertLaunchArgv(argv);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ModelPairingError);
      const message = (thrown as Error).message;
      expect(message).not.toContain("Pat Example");
      expect(message).not.toContain("ggml-medium");
      expect(message.length).toBeLessThan(200);
      expect((thrown as Error).name).toBe("ModelPairingError");
    }
  });
});

describe("launchPlan, where the engine's arguments are made", () => {
  it("launches the 8-bit file on the processor whatever was asked, and says so", () => {
    for (const asked of [true, false])
      expect(launchPlan(appArgv(M, 1), asked)).toEqual({ cpuOnly: true, key: SMALLER_KEY });
  });

  it("leaves today's file on the path that was asked", () => {
    expect(launchPlan(appArgv(B), false)).toEqual({ cpuOnly: false, key: BASELINE_KEY });
    expect(launchPlan(appArgv(B), true)).toEqual({ cpuOnly: true, key: BASELINE_KEY });
  });

  it("refuses the same arguments assertLaunchArgv cannot read, whichever path was asked", () => {
    for (const [what, argv] of CASES) {
      // Readable means one -m naming a manifest file: with -ng added, the final check has nothing left to object to.
      const readable = (() => {
        try {
          assertLaunchArgv([...argv, "-ng"]);
          return true;
        } catch {
          return false;
        }
      })();
      for (const asked of [true, false]) {
        if (readable) expect(() => launchPlan(argv, asked), what).not.toThrow();
        else expect(() => launchPlan(argv, asked), what).toThrow(ModelPairingError);
      }
    }
  });

  it("walks every manifest file on both paths: converted where the file has no chip path, refused where it has no path asked", () => {
    for (const [key, entry] of Object.entries(MODEL_MANIFEST)) {
      const paths = new Set(backendsOf(entry));
      for (const asked of [true, false]) {
        const argv = appArgv(`C:\\models\\${entry.file}`);
        if (asked && !paths.has("cpu"))
          expect(() => launchPlan(argv, asked), `${key} ${asked}`).toThrow(ModelPairingError);
        else if (!asked && !paths.has("gpu") && !paths.has("cpu"))
          expect(() => launchPlan(argv, asked)).toThrow(ModelPairingError);
        else
          expect(launchPlan(argv, asked), `${key} ${asked}`).toEqual({
            cpuOnly: asked || !paths.has("gpu"),
            key,
          });
      }
    }
  });

  it("accepts the manifest's files and no others", () => {
    expect(new Set(FILES)).toEqual(new Set([BASELINE_FILE, SMALLER_FILE]));
    expect(FILES).toHaveLength(2);
    for (const file of [
      "ggml-small.bin.part",
      "ggml-small-q5_1.bin",
      "ggml-large-v3.bin",
      "ggml-tiny.bin",
    ])
      for (const asked of [true, false])
        expect(() => launchPlan(appArgv(`C:\\models\\${file}`), asked), file).toThrow(
          ModelPairingError,
        );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fuzz: random spellings of the path, random placement of the flags, both directions
// ---------------------------------------------------------------------------------------------------------------

const roots = fc.constantFrom(
  "C:\\",
  "D:\\",
  "\\\\server\\share\\",
  "\\\\?\\C:\\",
  "/",
  "",
  "./",
  "C:/",
  "~/",
  "/mnt/c/",
);
const segments = fc.oneof(
  fc.constantFrom(
    "models",
    "Some One",
    "App Data",
    "AppData",
    "Local",
    "x.y",
    "é",
    "日本語",
    "a b c",
    "..",
    ".",
    "ggml-small.bin",
    "-m",
    "-ng",
  ),
  fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/),
);
const separators = fc.array(fc.constantFrom("\\", "/"), { minLength: 1, maxLength: 4 });
const caseBits = fc.array(fc.boolean(), { maxLength: 24 });
const flagNoise = fc
  .array(
    fc.constantFrom(
      ["-f", "C:\\work\\a clip.wav"],
      ["-ojf"],
      ["-of", "C:\\work\\out"],
      ["-t", "8"],
      ["-l", "en"],
      ["-mc", "0"],
      ["-bs", "1", "-bo", "1"],
    ),
    { maxLength: 4 },
  )
  .map((parts) => parts.flat());

/** A path that ends in `file`, spelled with random roots, separators, folders and letter case. */
const spell = (
  root: string,
  dirs: string[],
  seps: string[],
  file: string,
  bits: boolean[],
): string => {
  const cased = [...file]
    .map((c, i) => (bits.length > 0 && bits[i % bits.length] ? c.toUpperCase() : c.toLowerCase()))
    .join("");
  return `${root}${dirs.map((d, i) => d + seps[i % seps.length]).join("")}${cased}`;
};
const pathOf = (file: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc
    .tuple(roots, fc.array(segments, { maxLength: 4 }), separators, file, caseBits)
    .map(([r, d, s, f, b]) => spell(r, d, s, f, b));

type NgMode = "none" | "before" | "after";
const ngMode = fc.constantFrom<NgMode>("none", "before", "after");

/** Arguments with the model somewhere among other options, and the graphics chip turned off or not. */
function build(
  path: string,
  mode: NgMode,
  longM: boolean,
  longNg: boolean,
  before: string[],
  after: string[],
): string[] {
  const ng = longNg ? "--no-gpu" : "-ng";
  return [
    ...before,
    ...(mode === "before" ? [ng] : []),
    longM ? "--model" : "-m",
    path,
    ...(mode === "after" ? [ng] : []),
    ...after,
  ];
}

describe("fuzz: a file the manifest names, spelled any way, on either path", () => {
  // The generator knows which file it spelled, so the oracle is not the module's own reading of the path.
  const target = fc
    .constantFrom(...KEYS)
    .chain((key) => pathOf(fc.constant(MODEL_MANIFEST[key].file)).map((path) => ({ key, path })));
  const legit = fc.record({
    mode: ngMode,
    longM: fc.boolean(),
    longNg: fc.boolean(),
    before: flagNoise,
    after: flagNoise,
    asked: fc.boolean(),
  });
  const run = { numRuns: 400 };

  it("the final-argv check lets a launch through exactly when the file's entry allows the path the arguments imply", () => {
    fc.assert(
      fc.property(legit, target, ({ mode, longM, longNg, before, after }, { key, path }) => {
        const argv = build(path, mode, longM, longNg, before, after);
        const allowed = new Set(backendsOf(MODEL_MANIFEST[key]));
        const implied = mode === "none" ? "gpu" : "cpu";
        expect(modelKeyOfPath(path)).toBe(key);
        if (allowed.has(implied)) expect(() => assertLaunchArgv(argv)).not.toThrow();
        else expect(() => assertLaunchArgv(argv)).toThrow(ModelPairingError);
      }),
      run,
    );
  });

  it("nothing that pairs the 8-bit file with the graphics chip passes, and its processor launch never fails (the owner's decision, as a literal)", () => {
    fc.assert(
      fc.property(
        legit,
        pathOf(fc.constant(SMALLER_FILE)),
        ({ mode, longM, longNg, before, after, asked }, path) => {
          const argv = build(path, mode, longM, longNg, before, after);
          expect(modelKeyOfPath(path)).toBe(SMALLER_KEY);
          if (mode === "none") expect(() => assertLaunchArgv(argv)).toThrow(ModelPairingError);
          else expect(() => assertLaunchArgv(argv)).not.toThrow();
          // Whatever the caller asked, the launch the plan describes is the processor's.
          expect(launchPlan(argv, asked)).toEqual({ cpuOnly: true, key: SMALLER_KEY });
        },
      ),
      run,
    );
  });

  it("today's file is launched on whichever path was asked, and the final check agrees with the arguments", () => {
    fc.assert(
      fc.property(
        legit,
        pathOf(fc.constant(BASELINE_FILE)),
        ({ mode, longM, longNg, before, after, asked }, path) => {
          const argv = build(path, mode, longM, longNg, before, after);
          expect(launchPlan(argv, asked)).toEqual({ cpuOnly: asked, key: BASELINE_KEY });
          expect(() => assertLaunchArgv(argv)).not.toThrow();
        },
      ),
      run,
    );
  });

  it("what the plan says and what is spawned agree: the arguments launchPlan describes always pass the final check", () => {
    fc.assert(
      fc.property(legit, target, ({ before, after, asked }, { key, path }) => {
        const args = [...before, "-m", path, ...after];
        const plan = launchPlan(args, asked);
        expect(plan.key).toBe(key);
        expect(() => assertLaunchArgv(spawned(args, plan))).not.toThrow();
        // A launch the plan did not describe as the processor's is not given -ng, so the 8-bit file could only
        // have got there through a plan that said so.
        if (!plan.cpuOnly) expect(key).toBe(BASELINE_KEY);
      }),
      run,
    );
  });
});

describe("fuzz: a name that is not one of the manifest's files is refused on either path", () => {
  const mutated = fc.record({
    file: fc.constantFrom(...FILES),
    kind: fc.integer({ min: 0, max: 7 }),
    at: fc.nat(),
    ch: fc.constantFrom("x", "-", "_", ".", " ", "0", "é", "\u0000", ":", "/", "\\", "$"),
  });
  const mutate = ({
    file,
    kind,
    at,
    ch,
  }: {
    file: string;
    kind: number;
    at: number;
    ch: string;
  }): string => {
    const i = at % (file.length + 1);
    switch (kind) {
      case 0:
        return file.slice(0, i) + ch + file.slice(i);
      case 1:
        return file.slice(0, i % file.length) + file.slice((i % file.length) + 1);
      case 2:
        return file.slice(0, i % file.length) + ch + file.slice((i % file.length) + 1);
      case 3:
        return file + ch.repeat(1 + (at % 3));
      case 4:
        return ch + file;
      case 5:
        return file.slice(0, i % file.length);
      case 6: {
        const j = i % (file.length - 1);
        return file.slice(0, j) + file[j + 1] + file[j] + file.slice(j + 2);
      }
      default:
        return `${file}.part`;
    }
  };

  it("any small change to a manifest file's name is no manifest file, so nothing is launched with it", () => {
    fc.assert(
      fc.property(
        mutated,
        fc.constantFrom("", "C:\\models\\", "/m/", "\\\\h\\s\\"),
        fc.boolean(),
        fc.boolean(),
        (m, dir, asked, withNg) => {
          const name = mutate(m);
          const base = name.split(/[\\/]/).pop()!;
          // The change may have made another manifest file's name, or moved the end of the path onto a real one.
          fc.pre(!FILES.some((f) => f.toLowerCase() === base.toLowerCase()));
          const path = dir + name;
          expect(modelKeyOfPath(path)).toBeNull();
          const argv = ["-m", path, ...(withNg ? ["-ng"] : [])];
          expect(() => assertLaunchArgv(argv)).toThrow(ModelPairingError);
          expect(() => launchPlan(argv, asked)).toThrow(ModelPairingError);
        },
      ),
      { numRuns: 600 },
    );
  });
});

describe("fuzz: arguments in any shape", () => {
  const token = fc.oneof(
    fc.constantFrom(
      "-m",
      "--model",
      "-ng",
      "--no-gpu",
      "-f",
      "-of",
      "x.wav",
      BASELINE_FILE,
      SMALLER_FILE,
      `/m/${SMALLER_FILE}`,
      `/m/${BASELINE_FILE}`,
      "",
      "-",
    ),
    fc.string({ maxLength: 12 }),
  );
  const argvs = fc.array(token, { maxLength: 8 });

  it("only ever throws its own error, and what it lets through really is a model file on a path its entry allows", () => {
    fc.assert(
      fc.property(argvs, fc.boolean(), (argv, asked) => {
        for (const check of [() => assertLaunchArgv(argv), () => launchPlan(argv, asked)]) {
          try {
            check();
          } catch (e) {
            expect(e).toBeInstanceOf(ModelPairingError);
          }
        }
        let passed = true;
        try {
          assertLaunchArgv(argv);
        } catch {
          passed = false;
        }
        if (!passed) return;
        // Soundness, read with plain scans: one -m, its value a manifest file, and the 8-bit file only with -ng.
        const flagAt = argv
          .map((a, i) => (a === "-m" || a === "--model" ? i : -1))
          .filter((i) => i >= 0);
        expect(flagAt.length).toBeGreaterThanOrEqual(1);
        const file = argv[flagAt[0] + 1]!;
        const key = modelKeyOfPath(file);
        expect(key).not.toBeNull();
        if (key === SMALLER_KEY)
          expect(argv.includes("-ng") || argv.includes("--no-gpu")).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});
