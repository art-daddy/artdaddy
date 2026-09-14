// Style schema + parser (client port of style_schema.py). A style is a
// markdown doc whose H2 sections are editorial dimensions; extract_style parses
// the Gemini output to report which required dimensions are present/missing.

export const REQUIRED_SECTIONS = [
  "identity",
  "pacing",
  "density",
  "composition",
  "captions",
  "sourcing",
] as const;
export const OPTIONAL_SECTIONS = [
  "footage_motion",
  "color",
  "effects",
  "transitions",
  "transform",
  "audio",
  "narrative",
] as const;

export const SECTION_DISPLAY_NAMES: Record<string, string> = {
  identity: "Identity",
  pacing: "Pacing",
  density: "Density",
  composition: "Composition",
  captions: "Text",
  sourcing: "Sourcing",
  footage_motion: "Footage Motion",
  color: "Color Grade",
  effects: "Effects",
  transitions: "Transitions",
  transform: "Transform & Animation",
  audio: "Audio",
  narrative: "Narrative",
};

// Heading spelling -> canonical id (normalized before lookup).
const HEADING_ALIASES: Record<string, string> = {
  identity: "identity",
  "editorial summary": "identity",
  summary: "identity",
  pacing: "pacing",
  "pacing rhythm": "pacing",
  rhythm: "pacing",
  "when to cut": "pacing",
  density: "density",
  "density restraint": "density",
  restraint: "density",
  intensity: "density",
  composition: "composition",
  framing: "composition",
  layout: "composition",
  captions: "captions",
  "captions text": "captions",
  text: "captions",
  sourcing: "sourcing",
  sources: "sourcing",
  "b roll sources": "sourcing",
  "broll sources": "sourcing",
  "footage motion": "footage_motion",
  motion: "footage_motion",
  "motion intensity": "footage_motion",
  movement: "footage_motion",
  "internal motion": "footage_motion",
  energy: "footage_motion",
  "color grade": "color",
  "color grading": "color",
  color: "color",
  colour: "color",
  grade: "color",
  look: "color",
  "look color": "color",
  "visual identity": "color",
  effects: "effects",
  effect: "effects",
  stylization: "effects",
  stylisation: "effects",
  "visual effects": "effects",
  vfx: "effects",
  transitions: "transitions",
  transition: "transitions",
  "transform animation": "transform",
  transform: "transform",
  animation: "transform",
  "clip animation": "transform",
  audio: "audio",
  sound: "audio",
  music: "audio",
  "sound design": "audio",
  narrative: "narrative",
  "narrative structure": "narrative",
  structure: "narrative",
  story: "narrative",
  "story structure": "narrative",
};

/** Lowercase, drop &, /, "and", punctuation; collapse whitespace (ports _normalize). */
function normalize(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/&/g, " ").replace(/\//g, " ");
  s = s.replace(/\band\b/g, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function headingToId(heading: string): string | null {
  return HEADING_ALIASES[normalize(heading)] ?? null;
}

export interface ParsedStyle {
  sections: Record<string, string>;
  present_required: string[];
  missing_required: string[];
  present_optional: string[];
  extra_sections: [string, string][];
}

/** Parse a style markdown into canonical dimensions (ports parse_style_markdown). */
export function parseStyleMarkdown(_name: string, body: string): ParsedStyle {
  const lines = body.split(/\r?\n/);
  const sections: [string | null, string[]][] = [[null, []]];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) sections.push([m[1], []]);
    else sections[sections.length - 1][1].push(line);
  }
  let preamble = sections[0][1].join("\n").trim();
  preamble = preamble.replace(/^#\s+.*\n?/, "").trim();

  const parsed: ParsedStyle = {
    sections: {},
    present_required: [],
    missing_required: [],
    present_optional: [],
    extra_sections: [],
  };
  const seen = new Set<string>();
  for (let i = 1; i < sections.length; i += 1) {
    const [heading, bodyLines] = sections[i];
    if (heading === null) continue;
    const cid = headingToId(heading);
    const content = bodyLines.join("\n").trim();
    if (cid !== null && !(cid in parsed.sections)) {
      parsed.sections[cid] = content;
      seen.add(cid);
    } else {
      parsed.extra_sections.push([heading.trim(), content]);
    }
  }
  if (!seen.has("identity") && preamble) {
    parsed.sections.identity = preamble;
    seen.add("identity");
  }
  parsed.present_required = REQUIRED_SECTIONS.filter((s) => seen.has(s));
  parsed.missing_required = REQUIRED_SECTIONS.filter((s) => !seen.has(s));
  parsed.present_optional = OPTIONAL_SECTIONS.filter((s) => seen.has(s));
  return parsed;
}
