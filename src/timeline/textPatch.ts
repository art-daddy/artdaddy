// Partial patches for a text clip's style / transform / animation.
//
// "Partial" has to mean partial all the way down. `{outline: {width: 0}}` must not erase the
// outline's colour, because the model sends only what the user asked to change and has no way
// to restate the rest — it would have to read every field back first, which is the round trip
// this tool exists to avoid.
//
// Depth stops at the nested objects the text schema actually has (outline, shadow, box,
// position, emphasis). A general deep merge would also merge ARRAYS element-wise, which is
// wrong for `content`: replacing three runs with two must leave two.

/** Keys whose values are themselves partial patches rather than replacements. */
const NESTED = new Set(["outline", "shadow", "box", "position", "emphasis"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge `patch` over `base`, one level into the known nested objects. Returns a NEW object;
 *  neither input is mutated. `null` in the patch deletes the key — the only way to say
 *  "remove this outline" when omission means "leave it alone". */
export function mergePatch(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    if (v === undefined) continue;
    if (NESTED.has(k) && isPlainObject(v)) {
      out[k] = mergePatch(
        isPlainObject(out[k]) ? (out[k] as Record<string, unknown>) : undefined,
        v,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Normalize `content` the way add_text_clips does: a bare string is one run, so a title and a
 *  caption are the same shape downstream. */
export function normalizeContent(content: unknown): unknown {
  return typeof content === "string" ? [{ text: content }] : content;
}
