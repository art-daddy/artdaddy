// The speech-model manifest, and the rules for the extra places the model may be fetched from. A
// remote answer can only ADD places, so the rules are tested in both directions: nothing hostile
// may get through, and nothing legitimate may be lost.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import sourceCases from "./__fixtures__/modelSourceCases.json";
import {
  acceptModelSources,
  DEFAULT_MODEL_KEY,
  MAX_EXTRA_SOURCES,
  MAX_SOURCE_URL_LENGTH,
  MODEL_HOSTS,
  MODEL_MANIFEST,
  modelOrigins,
  primaryUrl,
  type ModelEntry,
} from "./modelManifest";
import type { ModelVariant } from "./speechDecoding";
import gate from "./speechGate.json";

// The 0.27.0 pin, frozen. These are the literals WHISPER_MODELS.small held in transcribe.ts in
// 0.27.0 (revision, bytes, sha256), the file name that code built as `ggml-${size}.bin`, and the f16
// baseline of speechGate.json. Moving to another model is deliberate and edits this test with it.
const SMALL_0_27_0: ModelEntry = {
  file: "ggml-small.bin",
  bytes: 487_601_967,
  sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
  variant: "f16",
};
const SMALL_0_27_0_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin";

describe("the pinned model", () => {
  it("is exactly what 0.27.0 downloaded", () => {
    expect(MODEL_MANIFEST.small).toEqual(SMALL_0_27_0);
    expect(primaryUrl(MODEL_MANIFEST.small)).toBe(SMALL_0_27_0_URL);
  });

  it("is the default model", () => {
    expect(DEFAULT_MODEL_KEY).toBe("small");
    expect(MODEL_MANIFEST[DEFAULT_MODEL_KEY]).toBeDefined();
  });
});

// Anchored to the type: a variant ModelVariant lacks, or one left out, does not compile.
const VARIANTS: Record<ModelVariant, true> = { f16: true, q8_0: true, q5_1: true };

/** Whether speechGate.json holds measurements of this file at this variant. */
const measuredByGate = (entry: ModelEntry): boolean =>
  [gate.baseline, ...Object.values(gate.settings)].some(
    (m) => m.model === entry.file && m.variant === entry.variant,
  );

/** The rules every entry keeps, as the names of the ones it breaks. */
function problems(entry: ModelEntry, address: string = primaryUrl(entry)): string[] {
  const broken: string[] = [];
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) broken.push("bytes");
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) broken.push("sha256");
  if (!/^[0-9a-f]{40}$/.test(entry.revision)) broken.push("revision");
  if (!/^ggml-[a-z0-9._-]+\.bin$/.test(entry.file) || entry.file.includes(".."))
    broken.push("file");
  if (!Object.hasOwn(VARIANTS, entry.variant)) broken.push("variant");
  if (!measuredByGate(entry)) broken.push("gate");
  try {
    const url = new URL(address);
    const ok =
      url.protocol === "https:" &&
      MODEL_HOSTS.includes(url.hostname) &&
      url.pathname.endsWith(`/${entry.file}`);
    if (!ok) broken.push("address");
  } catch {
    broken.push("address");
  }
  // The compiled-in place must pass the very rules a remote-supplied one does, unchanged.
  if (acceptModelSources([address]).join() !== address) broken.push("address_rules");
  return broken;
}

describe("every manifest entry (a future entry is checked here automatically)", () => {
  const entries = Object.entries(MODEL_MANIFEST);

  it("walks at least one entry, or the walk below would pass for nothing", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s breaks no rule", (_key, entry) => {
    expect(problems(entry)).toEqual([]);
  });

  it("gives each entry its own file name, since the file name is its place on disk", () => {
    const files = entries.map(([, entry]) => entry.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("lists hosts that are bare lower-case names", () => {
    for (const host of MODEL_HOSTS) expect(host).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    expect(MODEL_HOSTS.length).toBeGreaterThan(0);
  });

  // A walk that cannot fail proves nothing: each rule is shown to fire on an entry that breaks it.
  describe("the checker itself", () => {
    const good = MODEL_MANIFEST[DEFAULT_MODEL_KEY];
    const broken: Array<[string, string, ModelEntry]> = [
      ["bytes", "zero bytes", { ...good, bytes: 0 }],
      ["bytes", "a negative size", { ...good, bytes: -5 }],
      ["bytes", "a fractional size", { ...good, bytes: 1.5 }],
      ["bytes", "a size past the safe integers", { ...good, bytes: 2 ** 53 }],
      ["bytes", "a size that is not a number", { ...good, bytes: NaN }],
      ["sha256", "capital hex", { ...good, sha256: good.sha256.toUpperCase() }],
      ["sha256", "63 characters", { ...good, sha256: good.sha256.slice(1) }],
      ["sha256", "characters that are not hex", { ...good, sha256: "g".repeat(64) }],
      ["revision", "a branch name", { ...good, revision: "main" }],
      ["revision", "39 characters", { ...good, revision: good.revision.slice(1) }],
      ["file", "a parent directory", { ...good, file: "../ggml-small.bin" }],
      ["file", "a subdirectory", { ...good, file: "dir/ggml-small.bin" }],
      ["file", "a backslash", { ...good, file: "dir\\ggml-small.bin" }],
      ["file", "two dots inside the name", { ...good, file: "ggml-small..bin" }],
      ["file", "capital letters", { ...good, file: "ggml-Small.bin" }],
      ["file", "no ggml prefix", { ...good, file: "small.bin" }],
      ["variant", "a variant the type lacks", { ...good, variant: "f32" as ModelVariant }],
      [
        "variant",
        "an inherited property name",
        { ...good, variant: "constructor" as ModelVariant },
      ],
      ["gate", "a variant the gate never measured for this file", { ...good, variant: "q8_0" }],
      ["gate", "a file the gate never measured", { ...good, file: "ggml-medium.bin" }],
    ];

    it.each(broken)("flags %s: %s", (rule, _what, entry) => {
      expect(problems(entry)).toContain(rule);
    });

    it("accepts a file and variant the gate did measure, which is what a future variant entry needs", () => {
      const quantised: ModelEntry = { ...good, file: "ggml-small-q8_0.bin", variant: "q8_0" };
      expect(measuredByGate(quantised)).toBe(true);
      expect(measuredByGate({ ...quantised, variant: "f16" })).toBe(false);
    });

    // What each wrong compiled-in address must trip. A path that does not end in the file is still
    // an acceptable place to ask, so only the address rule sees it.
    it.each<[string, string, string[]]>([
      [
        "a plain http address",
        "http://huggingface.co/a/ggml-small.bin",
        ["address", "address_rules"],
      ],
      ["another host", "https://example.org/a/ggml-small.bin", ["address", "address_rules"]],
      [
        "a path that does not end in the file",
        "https://huggingface.co/a/ggml-small.bin/x",
        ["address"],
      ],
      [
        "an address that is not an address",
        "huggingface.co/a/ggml-small.bin",
        ["address", "address_rules"],
      ],
    ])("flags the compiled-in place when it is %s", (_what, address, rules) => {
      expect(problems(good, address)).toEqual(expect.arrayContaining(rules));
    });
  });

  it("puts the revision and the file name at the end of every compiled-in address", () => {
    const revision = fc.stringMatching(/^[0-9a-f]{40}$/);
    const file = fc.stringMatching(/^ggml-[a-z0-9]{1,8}\.bin$/);
    fc.assert(
      fc.property(revision, file, (rev, name) => {
        const segments = new URL(
          primaryUrl({ ...SMALL_0_27_0, revision: rev, file: name }),
        ).pathname
          .split("/")
          .slice(-2);
        expect(segments).toEqual([rev, name]);
      }),
    );
  });
});

// The same shapes for every property below. A "legitimate" address is already in the parser's own
// normal form, so a legitimate list must come back unchanged.
const label = fc.stringMatching(/^[a-z0-9]{1,6}(-[a-z0-9]{1,6}){0,2}$/);
const allowedHost = fc
  .array(label, { maxLength: 2 })
  .map((parts) => [...parts, "huggingface.co"].join("."));
const segment = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,9}$/);
const safePath = fc.array(segment, { maxLength: 4 }).map((parts) => `/${parts.join("/")}`);
const safeQuery = fc.option(fc.stringMatching(/^[a-z]{1,5}=[a-z0-9]{1,5}$/), { nil: undefined });
const legitUrl = fc
  .tuple(allowedHost, safePath, safeQuery)
  .map(([host, path, query]) => `https://${host}${path}${query ? `?${query}` : ""}`);

/** Ways to write a legitimate address that the parser would write otherwise. Each one is the same place
 *  to the parser and is right by every other rule, so the only thing wrong with it is how it is written:
 *  a place is taken exactly as given or not at all, and is never cleaned up. */
const WAYS: Array<[string, (origin: string, rest: string) => string]> = [
  ["capitals in the scheme", (o, r) => `HTTPS${o.slice(5)}${r}`],
  ["capitals in the host", (o, r) => `${o.slice(0, 8)}${o.slice(8).toUpperCase()}${r}`],
  ["an explicit port 443", (o, r) => `${o}:443${r}`],
  ["an empty port", (o, r) => `${o}:${r}`],
  ["no path at all", (o) => o],
  ["a dot segment", (o, r) => `${o}/x/..${r}`],
  ["a single-dot segment", (o, r) => `${o}/.${r}`],
  ["an escaped dot segment", (o, r) => `${o}/%2e%2E${r}`],
  ["a space in the path", (o, r) => `${o}/a b${r}`],
  ["a tab in the path", (o, r) => `${o}/a\tb${r}`],
  ["a newline after the address", (o, r) => `${o}${r}\n`],
  ["spaces around the address", (o, r) => `  ${o}${r}  `],
  ["a backslash for the slash after the host", (o, r) => `${o}\\${r.slice(1)}`],
  ["a backslash inside the path", (o, r) => `${o}/a\\b${r}`],
  ["one slash after the scheme", (o, r) => `${o.replace("https://", "https:/")}${r}`],
  ["no slash after the scheme", (o, r) => `${o.replace("https://", "https:")}${r}`],
  ["an accented letter in the path", (o, r) => `${o}/caf\u00e9${r}`],
  ["an apostrophe in the query", (o, r) => `${o}${r}${r.includes("?") ? "&" : "?"}x='y'`],
];

/** `url` written another way: it is cut after its host (what a way may change) and the rest, which
 *  starts at its slash. */
function writeDifferently(url: string, write: (origin: string, rest: string) => string): string {
  const at = url.indexOf("/", "https://".length);
  return write(url.slice(0, at), url.slice(at));
}

/** Whether the parser writes `text` exactly as it is given. */
function writtenByParser(text: string): boolean {
  try {
    return new URL(text).href === text;
  } catch {
    return false;
  }
}

const maxPort = 65_535;
const maxIpv4 = 2 ** 32 - 1;
const word = (max: number) => fc.stringMatching(new RegExp(`^[a-z0-9]{1,${max}}$`));
/** One entry that breaks exactly one rule, whatever else is right about it. */
const hostileEntry: fc.Arbitrary<unknown> = fc.oneof(
  fc
    .tuple(fc.constantFrom("http", "HTTP", "ftp", "ws", "wss", "file"), allowedHost, safePath)
    .map(([scheme, host, path]) => `${scheme}://${host}${path}`),
  fc
    .tuple(fc.stringMatching(/^[a-z0-9]{1,6}(:[a-z0-9]{1,6})?$/), allowedHost, safePath)
    .map(([info, host, path]) => `https://${info}@${host}${path}`),
  fc.tuple(word(6), safePath).map(([glued, path]) => `https://${glued}huggingface.co${path}`),
  fc.tuple(label, safePath).map(([name, path]) => `https://huggingface.co.${name}.example${path}`),
  fc
    .tuple(
      fc.integer({ min: 0, max: maxPort }).filter((port) => port !== 443),
      allowedHost,
      safePath,
    )
    .map(([port, host, path]) => `https://${host}:${port}${path}`),
  fc.tuple(legitUrl, fc.stringMatching(/^[a-z0-9]{0,6}$/)).map(([url, frag]) => `${url}#${frag}`),
  fc.ipV4().map((ip) => `https://${ip}/a`),
  fc.nat({ max: maxIpv4 }).map((n) => `https://${n}/a`),
  fc.nat({ max: maxIpv4 }).map((n) => `https://0x${n.toString(16)}/a`),
  fc.ipV6().map((ip) => `https://[${ip}]/a`),
  allowedHost.map((host) => `https://${host}./a`),
  allowedHost.map((host) => `https://.${host}/a`),
  fc
    .tuple(legitUrl, fc.constantFrom(...WAYS))
    .map(([url, [, write]]) => writeDifferently(url, write)),
  fc.integer({ min: 0, max: 200 }).map((n) => `https://huggingface.co/${"a".repeat(278 + n)}`),
  fc.constantFrom(
    "javascript:alert(1)",
    "data:text/plain,hello",
    "file:///etc/hosts",
    "",
    "   ",
    "huggingface.co/a",
    "//huggingface.co/a",
    "/a",
  ),
  fc.anything().filter((value) => typeof value !== "string"),
);

const mixedEntry: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: legitUrl },
  { weight: 2, arbitrary: hostileEntry },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.webUrl() },
  { weight: 1, arbitrary: fc.anything() },
);

const anything = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
});

/** The rule from the brief, written out: an allowed host, or a name under one. */
const onAllowedHost = (host: string): boolean =>
  MODEL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

// Characters that the parser drops, rewrites, encodes or treats as a separator, and some that it leaves alone.
const ODD_CHARACTERS = [
  ..."\t\n\r \\%#?@:./'\"<>{}`|~[]AZ\u00e9\u3002\uff48\u0000\u007f\ud83d\ude00",
];

/** A legitimate address with one character put in, or put in place of another, at any position. */
const editedUrl = fc
  .tuple(legitUrl, fc.nat(), fc.constantFrom(...ODD_CHARACTERS), fc.boolean())
  .map(([url, at, character, replace]) => {
    const i = at % (url.length + 1);
    return url.slice(0, i) + character + url.slice(i + (replace ? 1 : 0));
  });

/** Strings next to an acceptable address, one edit away from it or written another way, and any string at all. */
const nearAddress: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: legitUrl },
  { weight: 3, arbitrary: editedUrl },
  {
    weight: 3,
    arbitrary: fc
      .tuple(legitUrl, fc.constantFrom(...WAYS))
      .map(([url, [, write]]) => writeDifferently(url, write)),
  },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.webUrl() },
);

describe("acceptModelSources: properties", () => {
  it("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anything,
          fc.jsonValue(),
          fc.array(fc.oneof(anything, fc.string({ unit: "binary" })), { maxLength: 5 }),
          fc.array(mixedEntry, { maxLength: 5 }),
        ),
        (value) => {
          expect(() => acceptModelSources(value)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("only ever returns https places on an allowed host, exactly as given: at most three, each once", () => {
    let reachedAcceptance = 0;
    fc.assert(
      fc.property(fc.array(mixedEntry, { maxLength: 5 }), (list) => {
        const result = acceptModelSources(list);
        expect(result.length).toBeLessThanOrEqual(MAX_EXTRA_SOURCES);
        expect(new Set(result).size).toBe(result.length);
        // Given, not rewritten: every place is one of the entries, and they keep the order they came in.
        const at = result.map((place) => list.indexOf(place));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect(at).toEqual([...at].sort((x, y) => x - y));
        for (const place of result) {
          expect(typeof place).toBe("string");
          expect(place.length).toBeLessThanOrEqual(MAX_SOURCE_URL_LENGTH);
          const url = new URL(place);
          expect(url.protocol).toBe("https:");
          expect(onAllowedHost(url.hostname)).toBe(true);
          expect(url.username + url.password).toBe("");
          expect(url.port).toBe("");
          expect(place.includes("#")).toBe(false);
          expect(url.href).toBe(place);
        }
        if (result.length > 0) reachedAcceptance++;
      }),
      { numRuns: 300 },
    );
    expect(reachedAcceptance, "the generator must reach the accepting side").toBeGreaterThan(0);
  });

  it("takes a string only when the parser writes it exactly as given: whenever the answer is not empty, new URL(s).href === s", () => {
    let taken = 0;
    let refused = 0;
    fc.assert(
      fc.property(nearAddress, (s) => {
        const result = acceptModelSources([s]);
        if (result.length === 0) {
          refused++;
          return;
        }
        taken++;
        expect(result).toEqual([s]);
        expect(new URL(s).href).toBe(s);
      }),
      { numRuns: 1000 },
    );
    expect(taken, "the generator must reach the accepting side").toBeGreaterThan(0);
    expect(refused, "and the refusing side").toBeGreaterThan(0);
  });

  it("refuses a legitimate address written any way the parser would write otherwise, and takes it written the parser's way", () => {
    fc.assert(
      fc.property(legitUrl, fc.constantFrom(...WAYS), (url, [, write]) => {
        const odd = writeDifferently(url, write);
        const written = new URL(odd).href;
        expect(written, "the way must really differ from the parser's").not.toBe(odd);
        expect(acceptModelSources([odd])).toEqual([]);
        expect(acceptModelSources([written])).toEqual([written]);
      }),
      { numRuns: 300 },
    );
  });

  it("is all or nothing: a list is taken exactly when every entry is acceptable on its own", () => {
    fc.assert(
      fc.property(fc.array(mixedEntry, { maxLength: 5 }), (list) => {
        const alone = list.map((entry) => acceptModelSources([entry]));
        const wholeList =
          list.length <= MAX_EXTRA_SOURCES && alone.every((one) => one.length === 1);
        expect(acceptModelSources(list)).toEqual(wholeList ? [...new Set(alone.flat())] : []);
      }),
      { numRuns: 300 },
    );
  });

  it("returns a legitimate list complete and in the order given", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(legitUrl, { minLength: 1, maxLength: MAX_EXTRA_SOURCES }),
        (list) => {
          expect(acceptModelSources(list)).toEqual(list);
        },
      ),
    );
  });

  it("refuses the whole list when ONE entry is hostile, wherever it sits", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(legitUrl, { maxLength: MAX_EXTRA_SOURCES - 1 }),
        hostileEntry,
        fc.nat(),
        (list, bad, where) => {
          const at = where % (list.length + 1);
          const poisoned = [...list.slice(0, at), bad, ...list.slice(at)];
          // Within the count, so it is the entry that is refused and not the length of the list.
          expect(poisoned.length).toBeLessThanOrEqual(MAX_EXTRA_SOURCES);
          expect(acceptModelSources(list)).toEqual(list);
          expect(acceptModelSources(poisoned)).toEqual([]);
        },
      ),
    );
  });

  it("refuses each kind of hostile entry on its own", () => {
    fc.assert(
      fc.property(hostileEntry, (bad) => {
        expect(acceptModelSources([bad])).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses more than three entries however legitimate, and takes any three of them", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(legitUrl, {
          minLength: MAX_EXTRA_SOURCES + 1,
          maxLength: MAX_EXTRA_SOURCES + 3,
        }),
        (list) => {
          expect(acceptModelSources(list)).toEqual([]);
          const three = list.slice(0, MAX_EXTRA_SOURCES);
          expect(acceptModelSources(three)).toEqual(three);
        },
      ),
    );
  });
});

// The cases of acceptModelSources are DATA, in one language-neutral file that the server's Python twin
// is held to as well (its `about` states the rules and how a reader uses each list). The tables below
// are built from it, so what is tested here and what the twin is tested against cannot drift apart.
interface SourceCases {
  about: string;
  allowed_hosts: string[];
  max_sources: number;
  max_length: number;
  legit_entry: string;
  refuse_entry: Array<{ what: string; entry: string }>;
  accept_entry: Array<{ what: string; entry: string }>;
  lists: Array<{ what: string; raw: unknown; expect: string[] }>;
}
// Assigned, not cast: a key the file lacks, or one of the wrong type, does not compile.
const cases: SourceCases = sourceCases;

const LEGIT = "https://huggingface.co/someone/some-model/resolve/main/ggml-small.bin";

// Each of these is one thing a hostile or careless answer could contain, and the ones the parser would
// write another way are in it too. Every one must give [].
const HOSTILE: ReadonlyArray<[string, string]> = cases.refuse_entry.map((c) => [c.what, c.entry]);

// Each of these is acceptable, and is already written the way the parser writes it.
const LEGITIMATE: ReadonlyArray<[string, string]> = cases.accept_entry.map((c) => [
  c.what,
  c.entry,
]);

describe("acceptModelSources: hostile and tricky entries", () => {
  it.each(HOSTILE)("refuses %s", (_what, url) => {
    expect(acceptModelSources([url])).toEqual([]);
  });

  it.each(HOSTILE)("refuses a whole list that holds %s", (_what, url) => {
    expect(acceptModelSources([LEGIT, url])).toEqual([]);
    expect(acceptModelSources([url, LEGIT])).toEqual([]);
  });

  it("refuses a list of four, even when all four are the same legitimate place", () => {
    expect(acceptModelSources([LEGIT, LEGIT, LEGIT, LEGIT])).toEqual([]);
  });

  it("holds the length limit exactly at 300 characters, counted on the address as given", () => {
    const start = "https://huggingface.co/";
    const exactly = (n: number) => start + "a".repeat(n - start.length);
    expect(acceptModelSources([exactly(300)])).toEqual([exactly(300)]);
    expect(acceptModelSources([exactly(301)])).toEqual([]);
    // An accented letter is the six characters %C3%A9 as the parser writes it: 46 make 299, 47 make 305.
    const accented = (n: number) => start + "%C3%A9".repeat(n);
    expect(acceptModelSources([accented(46)])).toEqual([accented(46)]);
    expect(acceptModelSources([accented(47)])).toEqual([]);
  });
});

describe("acceptModelSources: an address written another way than the parser writes it", () => {
  // Nothing is repaired: the sender has to write an address the way the parser writes it. Both halves
  // matter: the odd form is refused, and the parser's own form of the same address is taken.
  it.each(WAYS)(
    "refuses %s, and takes the same address written the parser's way",
    (_what, write) => {
      const odd = writeDifferently(LEGIT, write);
      const written = new URL(odd).href;
      expect(written, "the way must really differ from the parser's").not.toBe(odd);
      expect(acceptModelSources([odd])).toEqual([]);
      expect(acceptModelSources([LEGIT, odd])).toEqual([]);
      expect(acceptModelSources([written])).toEqual([written]);
    },
  );
});

describe("acceptModelSources: legitimate entries", () => {
  it.each(LEGITIMATE)("keeps %s exactly as given", (_what, given) => {
    expect(acceptModelSources([given])).toEqual([given]);
  });

  it("returns a legitimate list in the order given, not sorted", () => {
    const a = "https://huggingface.co/a";
    const b = "https://cdn.huggingface.co/b";
    const c = "https://huggingface.co/c";
    expect(acceptModelSources([c, a, b])).toEqual([c, a, b]);
  });

  it("removes a repeat, keeping the first", () => {
    const a = "https://huggingface.co/a";
    const b = "https://huggingface.co/b";
    expect(acceptModelSources([a, b, a])).toEqual([a, b]);
    expect(acceptModelSources([b, a, b])).toEqual([b, a]);
  });

  it("does not repair a repeat written another way: the whole list is refused", () => {
    const a = "https://huggingface.co/a";
    const b = "https://huggingface.co/b";
    const again = "https://HUGGINGFACE.co:443/b";
    expect(acceptModelSources([again, a, b])).toEqual([]);
    expect(acceptModelSources([a, b, again])).toEqual([]);
  });

  it("gives [] for an empty list", () => {
    expect(acceptModelSources([])).toEqual([]);
  });
});

describe("acceptModelSources: the shared cases file", () => {
  it("states the limits and the host the function really has, so the data cannot say one thing and the function another", () => {
    expect(cases.max_sources).toBe(MAX_EXTRA_SOURCES);
    expect(cases.max_length).toBe(MAX_SOURCE_URL_LENGTH);
    expect(cases.allowed_hosts).toEqual(MODEL_HOSTS);
  });

  it("pads its lists with the address the tests above use, which is itself kept as it is", () => {
    expect(cases.legit_entry).toBe(LEGIT);
    expect(acceptModelSources([cases.legit_entry])).toEqual([cases.legit_entry]);
  });

  it("holds the compiled-in address among the entries it keeps, unchanged", () => {
    expect(cases.accept_entry).toContainEqual(expect.objectContaining({ entry: SMALL_0_27_0_URL }));
  });

  it("names each case once, and gives every entry as a string", () => {
    for (const group of [cases.refuse_entry, cases.accept_entry, cases.lists]) {
      const names = group.map((c) => c.what);
      expect(new Set(names).size).toBe(names.length);
    }
    for (const c of [...cases.refuse_entry, ...cases.accept_entry])
      expect(typeof c.entry, c.what).toBe("string");
  });

  it("gives an entry case only a what and an entry, so a rewritten form of the entry cannot creep back into the data", () => {
    for (const c of [...cases.refuse_entry, ...cases.accept_entry])
      expect(Object.keys(c).sort(), c.what).toEqual(["entry", "what"]);
  });

  it("writes every entry it says is kept the way the parser writes it, in ASCII only", () => {
    for (const c of cases.accept_entry) {
      expect(new URL(c.entry).href, c.what).toBe(c.entry);
      expect(c.entry, c.what).toMatch(/^[\x21-\x7e]+$/);
    }
  });

  it("answers only with entries it was given: nothing is rewritten on the way out", () => {
    for (const c of cases.lists)
      for (const place of c.expect)
        expect(Array.isArray(c.raw) && c.raw.includes(place), `${c.what}: ${place}`).toBe(true);
  });

  it("has a case on each side of the length limit it states, each one right in every other way", () => {
    const alone = cases.lists.flatMap((c) =>
      Array.isArray(c.raw) &&
      c.raw.length === 1 &&
      typeof c.raw[0] === "string" &&
      writtenByParser(c.raw[0])
        ? [{ length: c.raw[0].length, kept: c.expect.length === 1 }]
        : [],
    );
    expect(alone).toContainEqual({ length: cases.max_length, kept: true });
    expect(alone).toContainEqual({ length: cases.max_length + 1, kept: false });
  });

  it.each(cases.lists.map((c): [string, unknown, string[]] => [c.what, c.raw, c.expect]))(
    "gives the file's answer for %s",
    (_what, raw, expected) => {
      expect(acceptModelSources(raw)).toEqual(expected);
    },
  );
});

describe("acceptModelSources: what is not a list of strings", () => {
  const sparse: unknown[] = [];
  sparse[1] = LEGIT;
  const boom = () => {
    throw new Error("boom");
  };

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a bare string", LEGIT],
    ["a number", 3],
    ["a boolean", true],
    ["a bigint", 10n],
    ["a symbol", Symbol("x")],
    ["a function", () => [LEGIT]],
    ["an empty object", {}],
    ["an object that looks like a list", { 0: LEGIT, length: 1 }],
    ["a set", new Set([LEGIT])],
    ["a typed array", new Uint8Array(2)],
  ])("gives [] for %s", (_what, value) => {
    expect(acceptModelSources(value)).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ["a number", [3]],
    ["null", [null]],
    ["undefined", [undefined]],
    ["a legitimate place and then a number", [LEGIT, 7]],
    ["a nested list", [[LEGIT]]],
    ["a boxed string", [new String(LEGIT)]],
    ["an object that prints as a legitimate place", [{ toString: () => LEGIT }]],
    ["a URL object", [new URL(LEGIT)]],
    ["a list with a hole in it", sparse],
  ])("gives [] for a list holding %s", (_what, value) => {
    expect(acceptModelSources(value)).toEqual([]);
  });

  it("gives [] and does not throw when reading the list itself throws", () => {
    const hostile = new Proxy([], { get: boom, has: boom, getOwnPropertyDescriptor: boom });
    expect(acceptModelSources(hostile)).toEqual([]);
    const getter = [LEGIT];
    Object.defineProperty(getter, 0, { get: boom });
    expect(acceptModelSources(getter)).toEqual([]);
  });

  it("does not walk a huge list: it is refused for its length first", () => {
    const huge = new Array(2 ** 32 - 1);
    expect(acceptModelSources(huge)).toEqual([]);
  });
});

describe("acceptModelSources: the allow-list", () => {
  it("is the one passed in, not a fixed one", () => {
    expect(acceptModelSources(["https://example.org/a"], ["example.org"])).toEqual([
      "https://example.org/a",
    ]);
    expect(acceptModelSources(["https://huggingface.co/a"], ["example.org"])).toEqual([]);
    expect(acceptModelSources([LEGIT], [])).toEqual([]);
  });

  it("takes a host and the names under it, and nothing that merely ends the same way", () => {
    const hosts = ["example.org"];
    expect(acceptModelSources(["https://cdn.example.org/a"], hosts)).toHaveLength(1);
    expect(acceptModelSources(["https://a.b.example.org/a"], hosts)).toHaveLength(1);
    expect(acceptModelSources(["https://badexample.org/a"], hosts)).toEqual([]);
    expect(acceptModelSources(["https://example.org.evil.net/a"], hosts)).toEqual([]);
  });

  it("reads the list's host letters the way the parser reads an address's", () => {
    expect(acceptModelSources(["https://example.org/a"], ["Example.ORG"])).toHaveLength(1);
  });

  it("is never what lets a loopback, local or numeric host through, even when listed by mistake", () => {
    const cases: Array<[string, string]> = [
      ["https://127.0.0.1/a", "127.0.0.1"],
      ["https://2130706433/a", "2130706433"],
      ["https://localhost/a", "localhost"],
      ["https://huggingface.localhost/a", "localhost"],
      ["https://[::1]/a", "[::1]"],
      ["https://10.0.0.1/a", "0.0.1"],
      ["https://huggingface.co./a", "huggingface.co."],
    ];
    for (const [url, host] of cases) expect(acceptModelSources([url], [host]), url).toEqual([]);
  });

  it("ignores an entry that is not a name, so it can open nothing", () => {
    const odd = ["", ".", undefined, null, 7] as unknown as string[];
    expect(acceptModelSources([LEGIT], odd)).toEqual([]);
    expect(acceptModelSources(["https://a.example.org/x"], [...odd, "example.org"])).toHaveLength(
      1,
    );
  });
});

describe("modelOrigins", () => {
  const entry = MODEL_MANIFEST[DEFAULT_MODEL_KEY];
  const primary = primaryUrl(entry);
  const a = "https://cdn.huggingface.co/a";
  const b = "https://huggingface.co/b";

  it("puts the compiled-in place first and the others after it, in the order given", () => {
    expect(modelOrigins(entry, [])).toEqual([primary]);
    expect(modelOrigins(entry, [a, b])).toEqual([primary, a, b]);
    expect(modelOrigins(entry, [b, a])).toEqual([primary, b, a]);
  });

  it("never drops the compiled-in place, wherever an offered one equals it", () => {
    expect(modelOrigins(entry, [primary])).toEqual([primary]);
    expect(modelOrigins(entry, [a, primary, b])).toEqual([primary, a, b]);
    expect(modelOrigins(entry, [a, b, primary])).toEqual([primary, a, b]);
  });

  it("lists each place once, at the position it first appeared", () => {
    expect(modelOrigins(entry, [a, b, a, b])).toEqual([primary, a, b]);
  });

  it("holds for every entry of the manifest and any offered places", () => {
    const offered = fc.array(
      fc.oneof(
        legitUrl,
        fc.string(),
        fc.constantFrom(...Object.values(MODEL_MANIFEST).map(primaryUrl)),
      ),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(fc.constantFrom(...Object.values(MODEL_MANIFEST)), offered, (model, extra) => {
        const first = primaryUrl(model);
        const origins = modelOrigins(model, extra);
        expect(origins[0]).toBe(first);
        expect(new Set(origins).size).toBe(origins.length);
        for (const place of extra) expect(origins).toContain(place);
        // The rest keep the order in which they were first offered.
        const offeredAt = origins.slice(1).map((place) => extra.indexOf(place));
        expect(offeredAt).toEqual([...offeredAt].sort((x, y) => x - y));
        expect(origins.length).toBe(1 + new Set(extra.filter((place) => place !== first)).size);
      }),
    );
  });

  it("leaves only the compiled-in place when the answer that offered others was not trusted", () => {
    const answer = [a, "http://huggingface.co/evil", b];
    expect(modelOrigins(entry, acceptModelSources(answer))).toEqual([primary]);
    expect(modelOrigins(entry, acceptModelSources([a, b]))).toEqual([primary, a, b]);
  });
});
