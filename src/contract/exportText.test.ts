// The words an assistant reads about exports, held from the client's side: the `export` and `manage_exports` descriptions with every one of their parameter texts, and the MCP instructions.
// The owner's rules for them: no advice to offer a lighter export, no expected time or any time the assistant works out itself, no promise of a gentler retry or of a speed-up, no claim that the
// picture differs (or is softer) and no offer to turn the graphics chip off. The server holds the same rules for the prompt's Exports section and for these texts too (tests/unit/test_export_rules_conformance.py
// in the server repository); this file is the part that runs in this repository on its own. Both directions are held: each ban catches a planted sentence of the old kind (and lets the sentences the new
// text is free to say pass), and each rule the new text states (RULES) is still stated in the place that carries it, so deleting a paragraph turns this red as surely as adding an old sentence does.
import { describe, expect, it } from "vitest";

import { toolDefinition, type ParamSchema } from ".";
import { ASYNC_JOBS, COST_POLICY, PROJECT_NAVIGATION } from "../mcp/instructions";
import { claimsIn } from "../test/retiredNames";

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

const BANS: ReadonlyArray<{ name: string; pattern: RegExp; bad: readonly string[] }> = [
  {
    name: "a lighter export is advised",
    pattern:
      /\blighter export\b|\boffer (?:them |the user |the person )?(?:a )?(?:lighter|lower[- ]quality|smaller) (?:one|export|version)\b|\b(?:suggest|propose|recommend)\b[^.]{0,40}\b(?:lower|smaller|720p|lighter)\b/i,
    bad: [
      "offer a lighter export (a smaller `resolution`, `quality` 'low', or a lower `fps`) as THEIR choice",
      "If it is slow, offer a lighter export.",
      "Offer the user a smaller version if it takes long.",
      "If it is slow, suggest a lower resolution.",
      "If it takes long, propose 720p.",
      "Recommend a smaller picture when it is slow.",
    ],
  },
  {
    name: "an expected time is quoted or worked out",
    pattern:
      /\bexpected_s\b|\bexpected time\b|\bhow long (?:it|the export) is expected\b|\bthe time the app shows rather than a multiple\b|\bsay roughly how long\b|\banywhere from seconds to 15 minutes\b|\bover (?:10|ten) minutes\b|\btwice what was expected\b|\b(?:should|will|about)\s+take\b[^.]{0,20}\bminutes?\b|\b(?:say|tell)\b[^.]{0,30}\btakes?\b[^.]{0,20}\bminutes?\b/i,
    bad: [
      "Start ONE and tell the user how long it is expected to take.",
      "When that is long (over 10 minutes, or over twice `expected_s`), do NOT cancel it.",
      "Say what you started, say roughly how long it takes, and END your turn.",
      "finish in the background, anywhere from seconds to 15 minutes.",
      "give the time the app shows rather than a multiple",
      "Tell the user it should take about 5 minutes.",
      "When you start one, say it takes a few minutes.",
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
      /\bmay be quicker\b|\bnever promise how much\b|\bmay (?:be|finish|render|run|go)\b[^.]{0,30}\b(?:faster|quicker|sooner)\b|\b(?:twice|double|\d+(?:\.\d+)?\s*(?:x|times))\s+(?:as\s+)?(?:fast|quick|the speed)|\bhalf the time\b|\d+\s*(?:%|percent)\s+(?:faster|quicker)/i,
    bad: [
      "Say it MAY be quicker, never promise how much.",
      "A lower setting takes half the time.",
      "It is 3 times quicker.",
      "A lower resolution may be faster.",
      "A lower setting may finish sooner.",
    ],
  },
  {
    name: "the chip is offered off",
    pattern:
      /\b(?:turn|switch)\s+(?:the\s+)?(?:graphics\s+)?chip\s+off\b|\bturn\s+off\s+the\s+(?:graphics\s+)?chip\b|\b(?:disable|stop using|do without)\s+(?:the\s+)?(?:graphics\s+)?chip\b/i,
    bad: [
      "Offer to turn the graphics chip off.",
      "You can turn off the chip if it is slow.",
      "You can disable the graphics chip if it is slow.",
    ],
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
  "Set it only when the user asks for a smaller file, and say what you set.",
  "The reply may be a minute late while the file is written; wait for it with `wait_seconds`.",
  "The app may stop an export that makes no progress, and the row says why.",
  "The graphics chip may be busy; a row with `working` true is not stuck.",
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

// What the new texts must STILL say: one short, stable phrase per rule, in the place that carries it (the MCP bullet's rules are held in src/mcp/instructions.test.ts).
// A rule taken out of its text turns this red and names the place and the rule; it is the other direction of the bans above.
const RULES: ReadonlyArray<{ at: string; rule: string; pattern: RegExp }> = [
  {
    at: "export",
    rule: "one export per request, one at a time, never a second while one is queued or running",
    pattern:
      /ONE export per request and ONE at a time: NEVER start a second while one is queued or running/,
  },
  {
    at: "export",
    rule: "no re-export to check the work",
    pattern: /Do not re-export to check your work: inspect_timeline BEFORE exporting/,
  },
  {
    at: "export",
    rule: "a plain request passes no resolution, quality or fps",
    pattern: /pass NO `resolution`, `quality` or `fps`/,
  },
  {
    at: "export",
    rule: "a setting only for a value or a goal the user gives",
    pattern: /Set one ONLY when the user names its value[^.]*or a goal only it can meet/,
  },
  {
    at: "export",
    rule: "never a setting to speed an export up",
    pattern: /Never set one to speed an export up/,
  },
  {
    at: "export",
    rule: "never guess how long an export takes",
    pattern: /never guess how long an export takes/,
  },
  {
    at: "export",
    rule: "nothing about duration at the start",
    pattern: /say nothing about duration when you start one/,
  },
  {
    at: "export",
    rule: "quote only the app's own time, when asked",
    pattern:
      /quote only a time the app gives you \(manage_exports `time_left_s`[^.]*when the user asks/,
  },
  {
    at: "export",
    rule: "a slow export is not a failed one",
    pattern:
      /A slow export is not a failed one: do NOT cancel it or lower its settings because it is slow or looks stuck/,
  },
  {
    at: "export",
    rule: "a failure is told in plain words",
    pattern: /say in plain words what happened/,
  },
  {
    at: "export",
    rule: "after a failure, try again as it was",
    pattern: /offer to try again as it was/,
  },
  {
    at: "export",
    rule: "nothing started or changed after a failure without a yes",
    pattern: /Do not start again, or change a setting, without the user's yes/,
  },
  {
    at: "export.resolution",
    rule: "left null unless the user names a size",
    pattern: /Leave null[^.]*set only when the user names a size/,
  },
  {
    at: "export.quality",
    rule: "left null unless the user asks for a quality",
    pattern: /Leave null[^.]*set only when the user asks for better or worse quality/,
  },
  {
    at: "export.fps",
    rule: "left null unless the user names a frame rate",
    pattern: /Leave null[^.]*set only when the user names a frame rate/,
  },
  {
    at: "manage_exports",
    rule: "the list row names the failure, its code and the progress fields",
    pattern: /failure\?, failure_code\?[^}]*progress_percent\?, time_left_s\?/,
  },
  {
    at: "manage_exports",
    rule: "a failure is told from `failure`, not the raw error",
    pattern: /`failure` \(what happened, in plain words\)[^.]*not the raw `error`/,
  },
  {
    at: "manage_exports",
    rule: "a running export is cancelled only when the user's own latest message asks",
    pattern:
      /Cancel a RUNNING export only when the user's own latest message asks you to stop it or to replace it/,
  },
  {
    at: "manage_exports",
    rule: "never cancelled for being slow",
    pattern: /Do NOT cancel one because it is slow/,
  },
  {
    at: "manage_exports",
    rule: "the only time to give is `time_left_s`, when asked",
    pattern: /give `time_left_s` in plain words; never estimate a time any other way/,
  },
  {
    at: "manage_exports",
    rule: "never lower the settings",
    pattern: /never lower its settings yourself/,
  },
  {
    at: "manage_exports",
    rule: "a queued export may be cancelled to remove a mistake",
    pattern: /A QUEUED export may be cancelled to remove a mistake/,
  },
  {
    at: "manage_exports",
    rule: "wait with `wait_seconds`, do not poll",
    pattern: /Don't poll in a loop: pass `wait_seconds`/,
  },
  {
    at: "manage_exports.action",
    rule: "cancel a running export only when the user's own latest message asks",
    pattern:
      /a RUNNING export only when the user's own latest message asks, one still QUEUED to remove a mistake/,
  },
];

const lacking = (texts: ReadonlyArray<readonly [string, string]>): string[] => {
  const byPlace = new Map(texts);
  return RULES.filter(({ at, pattern }) => !pattern.test(byPlace.get(at) ?? "")).map(
    ({ at, rule }) => `${at}: ${rule}`,
  );
};

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

  it("still states every rule of the new text, in the place that carries it", () => {
    expect(lacking(exportTexts())).toEqual([]);
  });

  it("holds a rule in every text it is supposed to (not an empty table)", () => {
    const places = new Set(exportTexts().map(([at]) => at));
    expect(RULES.length).toBeGreaterThanOrEqual(20);
    for (const at of new Set(RULES.map((r) => r.at))) expect(places, at).toContain(at);
    for (const at of [
      "export",
      "export.resolution",
      "export.quality",
      "export.fps",
      "manage_exports",
      "manage_exports.action",
    ])
      expect(
        RULES.some((r) => r.at === at),
        at,
      ).toBe(true);
  });

  it.each(RULES.map((r) => [r.at, r.rule, r.pattern] as const))(
    "a text without the rule is reported by its place and its rule: %s, %s",
    (at, rule, pattern) => {
      const planted = exportTexts().map(
        ([place, text]) => [place, place === at ? text.replace(pattern, "") : text] as const,
      );
      expect(planted.find(([place]) => place === at)?.[1]).not.toBe(
        exportTexts().find(([place]) => place === at)?.[1],
      );
      expect(lacking(planted)).toContain(`${at}: ${rule}`);
    },
  );
});
