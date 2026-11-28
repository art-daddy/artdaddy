// The text looks the tool catalog offers the agent (src/contract/catalog.json: every `font`, `size`, style `preset` and
// animation `preset` of add_text_clips, add_captions and update_text) against the tables that draw them: the families
// the render plan keeps (renderPlan.ts), the metrics the export sizes text by (fontMetrics.data.ts), the font file the
// export burns with (FONT_FILES) and the face the preview draws with (preview/fonts.ts). fontMetrics.test.ts holds the
// metrics to the font files; this holds what the agent may ask for to all of them, so a family, a size or a look offered
// on one side and missing on another is a caption that silently comes out in another font, size or look.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import catalog from "../contract/catalog.json";
import { BUNDLED_FONT_URLS } from "../preview/fonts";
import { exportCell } from "./fontMetrics";
import { BUNDLED_FACES } from "./fontMetrics.data";
import { parseFont } from "./fontParse";
import type { Timeline } from "./model";
import { FONT_FILES } from "./render";
import { BUNDLED_FONTS, mergeAnimation, resolveRenderPlan } from "./renderPlan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Schema {
  enum?: unknown[];
  description?: string;
  properties?: Record<string, Schema>;
}
interface Found {
  where: string;
  schema: Schema;
  /** The object schema the property sits in: a style preset's siblings are the style's own fields. */
  parent: Record<string, Schema>;
}

/** Every property called `key`, anywhere in any tool's parameters, with where it is. */
function everywhere(key: string): Found[] {
  const found: Found[] = [];
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (!node || typeof node !== "object") return;
    const props = (node as Schema).properties;
    if (props && typeof props === "object")
      for (const [name, schema] of Object.entries(props))
        if (name === key) found.push({ where: `${where}.${name}`, schema, parent: props });
    for (const [name, child] of Object.entries(node)) walk(child, `${where}.${name}`);
  };
  for (const tool of (catalog as unknown as { tools: Array<{ name: string }> }).tools)
    walk(tool, tool.name);
  return found;
}

const FONT_DIR = path.resolve(process.cwd(), "src-tauri/resources/fonts");
const CANVAS = { width: 1920, height: 1080, fps: 30 };

/** The look a one-clip timeline gives a text clip: what the export and the preview both draw. */
function look(style: Record<string, unknown>, canvas: Record<string, number> = CANVAS): Any {
  const timeline = {
    canvas,
    tracks: [
      {
        id: "t",
        kind: "video",
        z: 0,
        clips: [{ kind: "text", text: "Hello", timeline_in: 0, timeline_out: 2, style }],
      },
    ],
  } as unknown as Timeline;
  return resolveRenderPlan(timeline).clips[0].text;
}

describe("the fonts the catalog offers are the fonts the app draws", () => {
  const fonts = everywhere("font");

  it("finds the font lists of every text tool, or the walks below pass for nothing", () => {
    expect(fonts.length).toBeGreaterThanOrEqual(3);
    expect(fonts.every((f) => Array.isArray(f.schema.enum) && f.schema.enum.length > 0)).toBe(true);
  });

  // A family the agent may pick that the plan does not keep is drawn in Poppins, and one the plan keeps that no tool
  // offers can only reach a project by hand.
  it("offers exactly the families the render plan keeps, in every place a font is asked for", () => {
    for (const { where, schema } of fonts)
      expect([...(schema.enum as string[])].sort(), where).toEqual([...BUNDLED_FONTS].sort());
  });

  it("draws a caption in each family it offers in that family", () => {
    for (const family of fonts[0].schema.enum as string[])
      expect(look({ font: family }).font, family).toBe(family);
  });

  // The export burns a caption with FONT_FILES' file and sizes it by the metrics; the preview draws it with its own copy.
  // If one of them named another file, the export would size the text for one face and draw it in another.
  it.each(BUNDLED_FONTS.map((f) => [f]))(
    "%s: the export, the preview and the sizing all read the same file",
    (family) => {
      const file = FONT_FILES[family];
      expect(BUNDLED_FACES[family]?.file).toBe(file);
      expect(decodeURIComponent(BUNDLED_FONT_URLS[family])).toMatch(
        new RegExp(`/${file.replace(/[.]/g, "\\.")}$`),
      );
      const face = parseFont(new Uint8Array(readFileSync(path.join(FONT_DIR, file))));
      expect(face.family).toBe(family);
      expect(exportCell("Hello", family)).toBeCloseTo(
        (face.winAscent + face.winDescent) / face.upm,
        9,
      );
    },
  );
});

describe("the named sizes the catalog offers are sizes the app draws", () => {
  const sizes = everywhere("size").filter((f) => /named tier/.test(f.schema.description ?? ""));
  const tiersOf = (f: Found): string[] =>
    [.../named tier \(([^,]+),/.exec(f.schema.description!)![1].matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );

  it("finds the size of every text tool, each naming the same tiers", () => {
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const f of sizes) expect(tiersOf(f), f.where).toEqual(tiersOf(sizes[0]));
    expect(tiersOf(sizes[0]).length).toBeGreaterThan(1);
  });

  // "Sized to the canvas": a tier is a share of the canvas height, so a portrait canvas draws it larger than a landscape
  // one, and each tier is larger than the one before it. A tier the plan did not know would keep the clip's default size
  // (the control below), which is the middle tier's: any other tier lost that way breaks the order.
  it("draws each tier at its own size, in order, as a share of the canvas height", () => {
    const tiers = tiersOf(sizes[0]);
    const wide = tiers.map((t) => look({ size: t }).sizePx);
    const tall = tiers.map((t) => look({ size: t }, { width: 1080, height: 1920, fps: 30 }).sizePx);
    for (let i = 1; i < tiers.length; i++)
      expect(wide[i], `${tiers[i]} after ${tiers[i - 1]}`).toBeGreaterThan(wide[i - 1]);
    // Sizes are whole pixels, so the two shares agree to within one pixel of rounding.
    tiers.forEach((t, i) =>
      expect(Math.abs(tall[i] / 1920 - wide[i] / 1080), t).toBeLessThan(1 / 1080),
    );
    expect(look({ size: "huge" }).sizePx, "a name the plan does not know").toBe(look({}).sizePx);
  });
});

describe("the named looks and motions the catalog offers change what is drawn", () => {
  const looks = everywhere("preset").filter((f) => "font" in f.parent);
  const motions = everywhere("preset").filter((f) => "build" in f.parent);

  it("finds the style and animation presets of every text tool", () => {
    expect(looks.length).toBeGreaterThanOrEqual(3);
    expect(motions.length).toBeGreaterThanOrEqual(3);
    for (const f of [...looks, ...motions])
      expect(f.schema.enum?.length, f.where).toBeGreaterThan(0);
  });

  // A look the plan has no table entry for is ignored: the caption comes out plain, although the agent picked a look.
  it("gives every style preset a look of its own, in a font the catalog offers", () => {
    const plain = JSON.stringify(look({}));
    for (const { where, schema, parent } of looks)
      for (const preset of schema.enum as string[]) {
        const styled = look({ preset });
        expect(JSON.stringify(styled), `${where}: ${preset}`).not.toBe(plain);
        expect(parent.font.enum, `${where}: ${preset}`).toContain(styled.font);
      }
  });

  // A motion seeds build, entrance and timing; each value it seeds must be one the same schema offers for that field, or
  // the motion asks the renderer for something no caller could.
  it("gives every animation preset a build, and seeds only values its schema offers", () => {
    for (const { where, schema, parent } of motions)
      for (const preset of schema.enum as string[]) {
        const seeded = mergeAnimation({ preset });
        expect(seeded.build, `${where}: ${preset}`).toBeDefined();
        for (const field of ["build", "entrance", "timing"] as const)
          if (seeded[field] !== undefined)
            expect(parent[field]?.enum, `${where}: ${preset}.${field}`).toContain(seeded[field]);
      }
  });
});
