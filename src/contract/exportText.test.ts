// The words an assistant reads about exports, held from the client's side: the `export` and `manage_exports` descriptions with every one of their parameter texts, and the MCP instructions.
// The owner's rules for them: no advice to offer a lighter export, no expected time or any time the assistant works out itself, no promise of a gentler retry or of a speed-up, no claim that the
// picture differs (or is softer) and no offer to turn the graphics chip off. The server holds the same rules for the prompt's Exports section and for these texts too (tests/unit/test_export_rules_conformance.py
// in the server repository); this file is the part that runs in this repository on its own. Each ban is checked in BOTH directions: the pattern catches a planted sentence of the old kind, and the
// sentences the new text is free to say pass.
import { describe, expect, it } from "vitest";

import { toolDefinition, type ParamSchema } from ".";
import { ASYNC_JOBS, COST_POLICY, PROJECT_NAVIGATION } from "../mcp/instructions";
import { claimsIn } from "../test/retiredNames";

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

const BANS: ReadonlyArray<{ name: string; pattern: RegExp; bad: readonly string[] }> = [
  {
    name: "a lighter export is advised",
    pattern:
      /\blighter export\b|\boffer (?:them |the user |the person )?(?:a )?(?:lighter|lower[- ]quality|smaller) (?:one|export|version)\b/i,
    bad: [
      "offer a lighter export (a smaller `resolution`, `quality` 'low', or a lower `fps`) as THEIR choice",
      "If it is slow, offer a lighter export.",
      "Offer the user a smaller version if it takes long.",
    ],
  },
  {
    name: "an expected time is quoted or worked out",
    pattern:
      /\bexpected_s\b|\bexpected time\b|\bhow long (?:it|the export) is expected\b|\bthe time the app shows rather than a multiple\b|\bsay roughly how long\b|\banywhere from seconds to 15 minutes\b|\bover (?:10|ten) minutes\b|\btwice what was expected\b/i,
    bad: [
      "Start ONE and tell the user how long it is expected to take.",
      "When that is long (over 10 minutes, or over twice `expected_s`), do NOT cancel it.",
      "Say what you started, say roughly how long it takes, and END your turn.",
      "finish in the background, anywhere from seconds to 15 minutes.",
      "give the time the app shows rather than a multiple",
    ],
  },
  {
    name: "a gentler retry is promised",
    pattern:
      /\bgentler retry\b|\bretry (?:with|at|using) (?:a )?(?:gentler|lower|smaller|lighter)\b/i,
    bad: ["After a failure offer ONE gentler retry.", "Then retry with a lower resolution."],
  },
  {
    name: "a speed-up is promised or hinted",
    pattern:
      /\bmay be quicker\b|\bnever promise how much\b|\b(?:twice|double|\d+(?:\.\d+)?\s*(?:x|times))\s+(?:as\s+)?(?:fast|quick|the speed)|\bhalf the time\b|\d+\s*(?:%|percent)\s+(?:faster|quicker)/i,
    bad: [
      "Say it MAY be quicker, never promise how much.",
      "A lower setting takes half the time.",
      "It is 3 times quicker.",
    ],
  },
  {
    name: "the chip is offered off",
    pattern:
      /\b(?:turn|switch)\s+(?:the\s+)?(?:graphics\s+)?chip\s+off\b|\bturn\s+off\s+the\s+(?:graphics\s+)?chip\b/i,
    bad: ["Offer to turn the graphics chip off.", "You can turn off the chip if it is slow."],
  },
];

// What the new texts are free to say: each must pass every ban above (and the picture claims of the names guard).
const LEGIT: readonly string[] = [
  "Leave `resolution`, `quality` and `fps` out unless the user names a value or a goal only a setting meets; never lower them to speed an export up.",
  "If an export fails, say in plain words what happened and offer to try again as it was; do not start it again, or change a setting without the user's yes.",
  "Never guess how long an export takes; quote only a time the app gives you (`time_left_s`), when asked.",
  "A slow export is not a failed one: do NOT cancel it or lower its settings because it is slow or looks stuck.",
  "Cancel a RUNNING export only when the user's own latest message asks you to stop it or to replace it.",
  "Do not re-export to check your work: inspect_timeline BEFORE exporting.",
  "The destination is written only when the render SUCCEEDS.",
];

const bannedIn = (text: string): string[] => [
  ...BANS.filter((ban) => ban.pattern.test(text)).map((ban) => ban.name),
  ...claimsIn(text).map((claim) => `the picture claim "${claim}"`),
];

/** Every description a tool carries: the tool's own and each parameter's, however deep. */
function descriptions(schema: ParamSchema | undefined, at: string): Array<[string, string]> {
  if (!schema) return [];
  const out: Array<[string, string]> = [];
  const own = (schema as { description?: unknown }).description;
  if (typeof own === "string") out.push([at, own]);
  for (const [name, sub] of Object.entries(schema.properties ?? {}))
    out.push(...descriptions(sub, `${at}.${name}`));
  if (schema.items) out.push(...descriptions(schema.items, `${at}[]`));
  return out;
}

function exportTexts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of ["export", "manage_exports"]) {
    const tool = toolDefinition(name);
    if (!tool) throw new Error(`the catalog has no ${name}`);
    out.push([name, tool.description ?? ""], ...descriptions(tool.parameters, name));
    if (tool.text_variant) out.push([`${name} (text variant)`, tool.text_variant.description]);
  }
  out.push(
    ["ASYNC_JOBS", ASYNC_JOBS],
    ["COST_POLICY", COST_POLICY],
    ["PROJECT_NAVIGATION", PROJECT_NAVIGATION],
  );
  return out.map(([at, text]) => [at, flat(text)]);
}

describe("the export words the assistant reads, from the client's side", () => {
  it("walks the export and manage_exports texts with every parameter, and the MCP instructions (not an empty walk)", () => {
    const texts = exportTexts();
    const at = texts.map(([where]) => where);
    // export has seven parameters and manage_exports three: ten parameter texts, two descriptions, three constants.
    expect(texts.length).toBeGreaterThanOrEqual(15);
    for (const needed of [
      "export",
      "export.resolution",
      "export.quality",
      "export.fps",
      "manage_exports",
      "manage_exports.action",
      "ASYNC_JOBS",
    ])
      expect(at, needed).toContain(needed);
    expect(texts.every(([, text]) => text.length > 0)).toBe(true);
  });

  it("none of them advises a lighter export, quotes an expected time, promises a gentler retry or a speed-up, says the picture differs, or offers the chip off", () => {
    const found = exportTexts()
      .map(([where, text]) => [where, bannedIn(text)] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([where, hits]) => `${where}: ${hits.join(", ")}`);
    expect(found).toEqual([]);
  });

  it.each(BANS.flatMap((ban) => ban.bad.map((bad) => [ban.name, bad] as const)))(
    "the ban '%s' catches the old sentence %j",
    (name, bad) => {
      expect(bannedIn(bad)).toContain(name);
    },
  );

  it("a planted old sentence in any one of the texts is reported by its place and its ban", () => {
    for (const [where] of exportTexts()) {
      for (const ban of BANS) {
        const planted = exportTexts().map(
          ([at, text]) => [at, at === where ? `${text} ${ban.bad[0]}` : text] as const,
        );
        const found = planted
          .filter(([, text]) => bannedIn(text).includes(ban.name))
          .map(([at]) => at);
        expect(found, `${ban.name} planted in ${where}`).toEqual([where]);
      }
    }
  });

  it("lets the new words through", () => {
    for (const sentence of LEGIT) expect(bannedIn(sentence), sentence).toEqual([]);
  });
});
