// The second place of the speech model, and the rules that keep it a PLACE and nothing more.
//
// The invariant: what is installed is decided by the manifest's size and SHA-256, never by where the bytes came
// from; a place only says WHERE to ask. So (1) every place the app compiles in must be as strict as one a remote
// answer names, (2) a place is asked only for the file it names, and (3) nothing a remote answer says can displace,
// reorder or replace a compiled place. Each rule is walked over EVERY manifest entry and EVERY allowed host, in both
// directions: nothing injectable survives, and nothing legitimate is dropped.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import sourceCases from "./__fixtures__/modelSourceCases.json";
import {
  acceptModelSources,
  MAX_EXTRA_SOURCES,
  MODEL_HOSTS,
  MODEL_MANIFEST,
  modelOrigins,
  primaryUrl,
  remotePlacesFor,
  SECOND_PLACE_BASE,
  secondPlaces,
  type ModelEntry,
} from "./modelManifest";

const ENTRIES: ReadonlyArray<[string, ModelEntry]> = Object.entries(MODEL_MANIFEST);
const FILES = ENTRIES.map(([, entry]) => entry.file);

/** Every place compiled in for an entry, in the order the app asks them. */
const compiled = (entry: ModelEntry): readonly string[] => modelOrigins(entry, secondPlaces(entry));

/** Whether `host` is `under` or a name under it. */
const isUnder = (host: string, under: string): boolean =>
  host === under || host.endsWith(`.${under}`);

/** An address a remote answer could carry that names `file` (the hosts only have to be acceptable). */
const naming = (file: string, host = "huggingface.co"): string =>
  `https://${host}/some-org/some-copy/resolve/main/${file}`;

/** The same question as remotePlacesFor, asked another way: by looking at the text, not at a parsed address. */
function namesFile(address: string, file: string): boolean {
  if (!address.startsWith("https://")) return false;
  const path = address.replace(/^https:\/\/[^/?#]*/, "").split(/[?#]/)[0];
  return path.endsWith(`/${file}`);
}

describe("every manifest entry's compiled places (a future entry is checked here automatically)", () => {
  it("walks at least two entries with two places each, or the walk below would pass for nothing", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(2);
    for (const [, entry] of ENTRIES) expect(compiled(entry).length).toBeGreaterThanOrEqual(2);
  });

  it.each(ENTRIES)(
    "%s: the primary place comes first, then the second, each place once",
    (_k, entry) => {
      const places = compiled(entry);
      expect(places).toEqual([primaryUrl(entry), ...secondPlaces(entry)]);
      expect(new Set(places).size).toBe(places.length);
    },
  );

  it.each(ENTRIES)(
    "%s: every compiled place ends with /<revision>/<file> of that entry",
    (_k, entry) => {
      for (const place of compiled(entry)) {
        expect(new URL(place).pathname.split("/").slice(-2), place).toEqual([
          entry.revision,
          entry.file,
        ]);
      }
    },
  );

  it.each(ENTRIES)("%s: the second place is derived from the one compiled base", (_k, entry) => {
    expect(secondPlaces(entry)).toEqual([`${SECOND_PLACE_BASE}/${entry.revision}/${entry.file}`]);
  });

  it.each(ENTRIES)(
    "%s: every compiled place passes the very rules a remote place does, unchanged",
    (_k, entry) => {
      for (const place of compiled(entry)) {
        expect(new URL(place).href, "written the way the parser writes it").toBe(place);
        expect(acceptModelSources([place], MODEL_HOSTS), place).toEqual([place]);
        expect(acceptModelSources([place]), place).toEqual([place]);
      }
    },
  );

  it.each(ENTRIES)(
    "%s: each compiled place sits on a host of the allow-list, and on no other",
    (_k, entry) => {
      for (const place of compiled(entry)) {
        const host = new URL(place).hostname;
        const listed = MODEL_HOSTS.filter((h) => isUnder(host, h));
        expect(listed.length, place).toBeGreaterThan(0);
        // Without the host it sits on, the same address is refused: the list is what lets it through.
        const without = MODEL_HOSTS.filter((h) => !listed.includes(h));
        expect(acceptModelSources([place], without), place).toEqual([]);
        expect(acceptModelSources([place], listed), place).toEqual([place]);
      }
    },
  );

  it.each(ENTRIES)(
    "%s: the second place is on another host than the primary place, so one host failing is not both failing",
    (_k, entry) => {
      const first = new URL(primaryUrl(entry)).hostname;
      for (const place of secondPlaces(entry)) {
        const host = new URL(place).hostname;
        expect(isUnder(host, first), `${host} is under ${first}`).toBe(false);
        expect(isUnder(first, host), `${first} is under ${host}`).toBe(false);
      }
    },
  );

  it("gives no two entries a place in common, since each is a place for ITS file", () => {
    const every = ENTRIES.flatMap(([, entry]) => [...compiled(entry)]);
    expect(new Set(every).size).toBe(every.length);
  });

  it("is derived from the entry alone: any pinned revision and file give a second place that ends with them and is accepted", () => {
    const revision = fc.stringMatching(/^[0-9a-f]{40}$/);
    const file = fc.stringMatching(/^ggml-[a-z0-9]{1,8}(-[a-z0-9_]{1,6})?\.bin$/);
    fc.assert(
      fc.property(revision, file, revision, file, (r1, f1, r2, f2) => {
        const one = secondPlaces({ revision: r1, file: f1 });
        const other = secondPlaces({ revision: r2, file: f2 });
        expect(one).toHaveLength(1);
        expect(one[0].startsWith(`${SECOND_PLACE_BASE}/`)).toBe(true);
        expect(one[0].endsWith(`/${r1}/${f1}`)).toBe(true);
        expect(acceptModelSources([one[0]])).toEqual([one[0]]);
        // Injective: another revision or another file never lands on the same address.
        expect(one[0] === other[0]).toBe(r1 === r2 && f1 === f2);
      }),
    );
  });
});

interface SourceCases {
  allowed_hosts: string[];
  refuse_entry: Array<{ what: string; entry: string }>;
  accept_entry: Array<{ what: string; entry: string }>;
}
const cases: SourceCases = sourceCases;

describe("the shared cases file, which the server's twin is held to, follows the manifest", () => {
  it("lists every compiled place of every entry among the entries it keeps, so a twin must accept what the app asks", () => {
    const kept = new Set(cases.accept_entry.map((c) => c.entry));
    for (const [, entry] of ENTRIES)
      for (const place of compiled(entry)) expect(kept.has(place), place).toBe(true);
  });

  it("holds a refusing case and an accepting case for every host of the allow-list", () => {
    for (const host of MODEL_HOSTS) {
      const mentions = (list: Array<{ entry: string }>): number =>
        list.filter((c) => c.entry.includes(host)).length;
      expect(mentions(cases.accept_entry), `accept cases for ${host}`).toBeGreaterThanOrEqual(3);
      expect(mentions(cases.refuse_entry), `refuse cases for ${host}`).toBeGreaterThanOrEqual(10);
    }
  });

  it("refuses every refusing case, and keeps every accepting case, with the allow-list the app ships", () => {
    for (const c of cases.refuse_entry) expect(acceptModelSources([c.entry]), c.what).toEqual([]);
    for (const c of cases.accept_entry)
      expect(acceptModelSources([c.entry]), c.what).toEqual([c.entry]);
  });
});

// The near misses of one allowed host, as functions of it: every host of MODEL_HOSTS is walked through every one.
const NEAR_MISSES: ReadonlyArray<[string, (h: string) => string]> = [
  ["another domain that starts with the name", (h) => `https://${h}.evil.example/a`],
  ["the name glued to a longer name", (h) => `https://evil${h}/a`],
  ["a hyphen gluing the name to another label", (h) => `https://evil-${h}/a`],
  ["a hyphen gluing the name to another domain", (h) => `https://${h}-evil.example/a`],
  ["the name as user-info before another host", (h) => `https://${h}@evil.example/a`],
  ["a subdomain as user-info before another host", (h) => `https://models.${h}@evil.example/a`],
  ["user-info with a password", (h) => `https://user:pw@${h}/a`],
  ["a port other than 443", (h) => `https://${h}:8443/a`],
  ["a port other than 443 on a subdomain", (h) => `https://models.${h}:8443/a`],
  ["an explicit default port", (h) => `https://${h}:443/a`],
  ["an empty port", (h) => `https://${h}:/a`],
  ["plain http", (h) => `http://${h}/a`],
  ["plain http on a subdomain", (h) => `http://models.${h}/a`],
  ["another scheme", (h) => `ftp://${h}/a`],
  ["a trailing dot", (h) => `https://${h}./a`],
  ["a trailing dot on a subdomain", (h) => `https://models.${h}./a`],
  ["a leading dot", (h) => `https://.${h}/a`],
  ["an empty label", (h) => `https://models..${h}/a`],
  ["capitals", (h) => `https://${h.toUpperCase()}/a`],
  ["capitals in the first label of a subdomain", (h) => `https://Models.${h}/a`],
  ["an internationalised label (valid punycode)", (h) => `https://xn--caf-dma.${h}/a`],
  ["a malformed internationalised label", (h) => `https://xn--a.${h}/a`],
  ["a look-alike letter in the name", (h) => `https://${h.replace("a", "\u0430")}/a`],
  ["a sibling top-level domain", (h) => `https://${h.replace(/\.[a-z0-9-]+$/, ".com")}/a`],
  ["a letter missing from the name", (h) => `https://${h.slice(1)}/a`],
  ["a name under localhost built from it", (h) => `https://${h}.localhost/a`],
  ["an IPv4 address", () => "https://192.0.2.7/a"],
  ["an IPv4 address as one decimal number", () => "https://3221225991/a"],
  ["an IPv6 address", () => "https://[2001:db8::7]/a"],
  ["the name in the path of another host", (h) => `https://evil.example/${h}/a`],
  ["the name in the query of another host", (h) => `https://evil.example/?u=https://${h}/a`],
  ["a backslash that ends the host early", (h) => `https://evil.example\\@${h}/a`],
  ["an encoded dot that builds another host", (h) => `https://${h}%2eevil.example/a`],
  ["a fragment", (h) => `https://${h}/a#part`],
  ["no path at all", (h) => `https://${h}`],
  ["a dot segment", (h) => `https://${h}/x/../a`],
  ["a tab the parser drops", (h) => `https://${h}\t/a`],
];

/** Ways to write an acceptable address on host `h`, each already the way the parser writes it. */
const LEGITIMATE: ReadonlyArray<[string, (h: string) => string]> = [
  ["the name itself", (h) => `https://${h}/a`],
  ["a name under it", (h) => `https://cdn.${h}/a`],
  ["a deep name under it", (h) => `https://a.b.c.${h}/a`],
  ["a hyphenated name under it", (h) => `https://models-2.${h}/a/b`],
  ["a query", (h) => `https://models.${h}/a?download=true`],
  ["capitals in the path, which the parser keeps", (h) => `https://${h}/Some/Path/GGML.bin`],
  ["the host and a slash only", (h) => `https://${h}/`],
];

const crossHosts = <T>(rows: ReadonlyArray<[string, T]>): Array<[string, string, T]> =>
  MODEL_HOSTS.flatMap((host) =>
    rows.map(([what, build]): [string, string, T] => [host, what, build]),
  );

describe("every allowed host, through every near miss (a host added to the list is checked here automatically)", () => {
  it("walks at least two hosts, or the walk below would pass for nothing", () => {
    expect(MODEL_HOSTS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(crossHosts(NEAR_MISSES))("%s: refuses %s", (host, _what, build) => {
    const hostile = build(host);
    const fine = `https://${host}/ok`;
    expect(acceptModelSources([hostile])).toEqual([]);
    // Wherever it sits in a list, it takes the whole list down with it.
    expect(acceptModelSources([fine, hostile])).toEqual([]);
    expect(acceptModelSources([hostile, fine])).toEqual([]);
    // ...and the same address is not saved by listing only the host it imitates.
    expect(acceptModelSources([hostile], [host])).toEqual([]);
  });

  it.each(crossHosts(LEGITIMATE))("%s: keeps %s, exactly as given", (host, _what, build) => {
    const place = build(host);
    expect(new URL(place).href, "the form is the parser's own").toBe(place);
    expect(acceptModelSources([place])).toEqual([place]);
    expect(acceptModelSources([place], [host])).toEqual([place]);
    // Without the host it sits on, the same address is refused: the list is what lets it through.
    const others = MODEL_HOSTS.filter((h) => h !== host);
    expect(acceptModelSources([place], others)).toEqual([]);
  });

  it("the near misses are real ones: a sloppy check that only looks for the host's name in the text would take most of them", () => {
    for (const host of MODEL_HOSTS) {
      const sloppy = NEAR_MISSES.filter(([, build]) => build(host).includes(host));
      expect(sloppy.length, host).toBeGreaterThanOrEqual(20);
      for (const [what, build] of sloppy)
        expect(acceptModelSources([build(host)]), what).toEqual([]);
    }
  });

  it("keeps any name under any allowed host, and refuses that name glued to another, for random names and paths", () => {
    const label = fc.stringMatching(/^[a-z0-9]{1,6}(-[a-z0-9]{1,6}){0,2}$/);
    const segment = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,9}$/);
    const path = fc.array(segment, { maxLength: 3 }).map((parts) => `/${parts.join("/")}`);
    fc.assert(
      fc.property(
        fc.constantFrom(...MODEL_HOSTS),
        fc.array(label, { maxLength: 3 }),
        path,
        label,
        (host, names, tail, glue) => {
          const under = `https://${[...names, host].join(".")}${tail}`;
          expect(acceptModelSources([under])).toEqual([under]);
          // Letters glued on in front of the allowed name make another domain, and so does a domain hung after it.
          const glued = `https://${[...names, `${glue}${host}`].join(".")}${tail}`;
          const hung = `https://${[...names, host, glue, "example"].join(".")}${tail}`;
          expect(acceptModelSources([glued])).toEqual([]);
          expect(acceptModelSources([hung])).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("remotePlacesFor: a remote address is used only for the file it names", () => {
  it.each(ENTRIES)(
    "%s: keeps the addresses that name its file, in the order given, and drops every other",
    (_k, entry) => {
      const others = FILES.filter((file) => file !== entry.file);
      const list = [
        naming(entry.file, "cdn.huggingface.co"),
        ...others.map((file) => naming(file)),
        naming(entry.file, "models.artdaddy.app"),
        naming("ggml-medium.bin"),
      ];
      expect(remotePlacesFor(entry, list)).toEqual([
        naming(entry.file, "cdn.huggingface.co"),
        naming(entry.file, "models.artdaddy.app"),
      ]);
    },
  );

  it("gives each entry only its own, whichever of the two files an address names (every ordered pair of entries)", () => {
    for (const [, entry] of ENTRIES) {
      for (const [, other] of ENTRIES) {
        const offered = [naming(other.file), ...compiled(other)];
        const kept = remotePlacesFor(entry, offered);
        if (other.file === entry.file) expect(kept).toEqual(offered);
        else expect(kept, `${other.file} offered to ${entry.file}`).toEqual([]);
      }
    }
  });

  it.each(ENTRIES)(
    "%s: an address that only looks like it names the file is dropped",
    (_k, entry) => {
      const near = [
        `https://huggingface.co/a/${entry.file}.part`,
        `https://huggingface.co/a/x${entry.file}`,
        `https://huggingface.co/a/${entry.file}/`,
        `https://huggingface.co/a/${entry.file}/more`,
        `https://huggingface.co/${entry.file}/a`,
        `https://huggingface.co/a/${entry.file.toUpperCase()}`,
        `https://huggingface.co/a/${entry.file.replace(".", "%2E")}`,
        `https://huggingface.co/a/${entry.file.replace("-", "%2D")}`,
        `https://huggingface.co/a/${entry.file.slice(1)}`,
        `https://huggingface.co/?file=${entry.file}`,
        `https://huggingface.co/a/b?x=/${entry.file}`,
        "https://huggingface.co/a/",
        "https://huggingface.co/",
        "https://huggingface.co",
        "not an address",
        "",
      ];
      expect(remotePlacesFor(entry, near)).toEqual([]);
    },
  );

  it.each(ENTRIES)(
    "%s: the query and the end of the address are not part of the path",
    (_k, entry) => {
      const withQuery = `${naming(entry.file)}?download=true&name=ggml-other.bin`;
      const queryNamesIt = `https://huggingface.co/a/blob?name=${entry.file}`;
      expect(remotePlacesFor(entry, [withQuery, queryNamesIt])).toEqual([withQuery]);
    },
  );

  it("never invents, reorders or changes an address: the result is the entries that name the file, as given", () => {
    const junk = fc.oneof(fc.string(), fc.webUrl(), fc.constant(""));
    const offered = fc.array(
      fc.oneof(
        fc.constantFrom(...FILES).map((file) => naming(file)),
        fc.constantFrom(...FILES).map((file) => `${naming(file)}?download=true`),
        fc.constantFrom(...FILES).map((file) => `https://cdn.artdaddy.app/${file}`),
        fc.constantFrom(...ENTRIES.flatMap(([, entry]) => compiled(entry))),
        junk,
      ),
      { maxLength: 10 },
    );
    fc.assert(
      fc.property(fc.constantFrom(...ENTRIES.map(([, entry]) => entry)), offered, (entry, list) => {
        // Written another way: by the text of each address, not by a parsed one.
        expect(remotePlacesFor(entry, list)).toEqual(
          list.filter((place) => namesFile(place, entry.file)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("never throws, whatever it is given", () => {
    const entry = MODEL_MANIFEST.small;
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withBigInt: true }), (value) => {
        expect(() => remotePlacesFor(entry, value as readonly string[])).not.toThrow();
        expect(() => remotePlacesFor(entry, [value as string])).not.toThrow();
      }),
      { numRuns: 200 },
    );
    expect(remotePlacesFor(entry, null as unknown as string[])).toEqual([]);
    expect(remotePlacesFor({ file: "" }, [naming("")])).toEqual([]);
  });

  it("does not judge hosts: that is acceptModelSources' decision, taken where the list arrives", () => {
    const entry = MODEL_MANIFEST.small;
    const hostile = [naming(entry.file), `https://evil.example/${entry.file}`];
    // The pipeline in the order the app runs it: a list with a hostile entry is [] before it is ever narrowed.
    expect(remotePlacesFor(entry, acceptModelSources(hostile))).toEqual([]);
    expect(remotePlacesFor(entry, acceptModelSources([hostile[0]]))).toEqual([hostile[0]]);
  });
});

describe("the places the app asks for a model, with a remote list of any kind (primary, then the compiled second place, then the narrowed remote list)", () => {
  /** What the download composes: the compiled places, then the remote places that name this file. */
  const askedFor = (entry: ModelEntry, remote: readonly string[]): readonly string[] =>
    modelOrigins(entry, [...secondPlaces(entry), ...remotePlacesFor(entry, remote)]);

  const remoteLists = fc.array(
    fc.oneof(
      fc.constantFrom(...FILES).map((file) => naming(file)),
      fc.constantFrom(...FILES).map((file) => naming(file, "cdn.artdaddy.app")),
      fc.constantFrom(...ENTRIES.flatMap(([, entry]) => compiled(entry))),
      fc.string(),
    ),
    { maxLength: 10 },
  );

  it.each(ENTRIES)(
    "%s: nothing a remote list offers displaces or reorders a compiled place",
    (_k, entry) => {
      const front = compiled(entry);
      fc.assert(
        fc.property(remoteLists, (remote) => {
          const asked = askedFor(entry, remote);
          expect(asked.slice(0, front.length)).toEqual(front);
          expect(new Set(asked).size).toBe(asked.length);
          // Reversed or repeated, the compiled places still come first, once, in their order.
          expect(askedFor(entry, [...remote].reverse()).slice(0, front.length)).toEqual(front);
          expect(askedFor(entry, [...remote, ...remote]).slice(0, front.length)).toEqual(front);
        }),
        { numRuns: 200 },
      );
    },
  );

  it.each(ENTRIES)(
    "%s: the other files' places never enter its download, compiled or remote",
    (_k, entry) => {
      const foreign = ENTRIES.filter(([, other]) => other.file !== entry.file).flatMap(
        ([, other]) => [...compiled(other), naming(other.file)],
      );
      fc.assert(
        fc.property(remoteLists, (remote) => {
          const asked = askedFor(entry, [...remote, ...foreign]);
          for (const place of foreign) expect(asked).not.toContain(place);
          for (const place of asked.slice(compiled(entry).length))
            expect(namesFile(place, entry.file), place).toBe(true);
        }),
        { numRuns: 200 },
      );
    },
  );

  it.each(ENTRIES)(
    "%s: an address that names its file is added after the compiled places, once, in the order offered",
    (_k, entry) => {
      const a = naming(entry.file, "cdn.huggingface.co");
      const b = naming(entry.file, "models.artdaddy.app");
      expect(askedFor(entry, [a, b])).toEqual([...compiled(entry), a, b]);
      expect(askedFor(entry, [b, a, b])).toEqual([...compiled(entry), b, a]);
      // The compiled places offered again by the remote list keep the place they have.
      expect(askedFor(entry, [a, ...compiled(entry)])).toEqual([...compiled(entry), a]);
    },
  );

  it("leaves exactly the compiled places when the remote answer is not trusted, for every refusing case of the shared file", () => {
    for (const [, entry] of ENTRIES) {
      for (const c of cases.refuse_entry) {
        const trusted = acceptModelSources([naming(entry.file), c.entry]);
        expect(trusted, c.what).toEqual([]);
        expect(askedFor(entry, trusted), c.what).toEqual(compiled(entry));
      }
    }
  });

  it("adds a legitimate remote address for the file it names and for no other, for every accepting case of the shared file", () => {
    for (const [, entry] of ENTRIES) {
      for (const c of cases.accept_entry) {
        const trusted = acceptModelSources([c.entry]);
        expect(trusted, c.what).toEqual([c.entry]);
        const added = askedFor(entry, trusted).slice(compiled(entry).length);
        const alreadyCompiled = compiled(entry).includes(c.entry);
        expect(added, c.what).toEqual(
          namesFile(c.entry, entry.file) && !alreadyCompiled ? [c.entry] : [],
        );
      }
    }
  });

  it("is at most the compiled places and the most a remote answer may add", () => {
    for (const [, entry] of ENTRIES) {
      const remote = Array.from(
        { length: MAX_EXTRA_SOURCES },
        (_, i) => `https://cdn.huggingface.co/${i}/${entry.file}`,
      );
      expect(askedFor(entry, acceptModelSources(remote))).toHaveLength(
        compiled(entry).length + MAX_EXTRA_SOURCES,
      );
    }
  });
});
