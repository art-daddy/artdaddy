// Contract-driven arg clamping. Every numeric tool arg is clamped to the
// `minimum`/`maximum` declared for it in the tool contract (pulled at runtime
// from /contract/tools), recursively through nested objects and arrays. The
// contract is the SINGLE SOURCE OF TRUTH for both the documented range and the
// clamp, so adding min/max to a param both documents it AND auto-clamps
// out-of-range model input. No-op for tools/params that declare no range (or
// before the contract has loaded).
import { paramSchema, type ParamSchema } from ".";

type Schema = ParamSchema;

function clampVal(schema: Schema | undefined, value: unknown): unknown {
  if (!schema || value === null || value === undefined) return value;
  if (typeof value === "number") {
    let v = value;
    if (typeof schema.minimum === "number") v = Math.max(schema.minimum, v);
    if (typeof schema.maximum === "number") v = Math.min(schema.maximum, v);
    return v;
  }
  if (Array.isArray(value)) {
    return schema.items ? value.map((el) => clampVal(schema.items, el)) : value;
  }
  if (typeof value === "object" && schema.properties) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in out) out[k] = clampVal(sub, out[k]);
    }
    return out;
  }
  return value;
}

/** Clamp every numeric arg of a tool call to its contract min/max (recursively).
 *  Returns a clamped COPY; a no-op when the tool or a param declares no range. */
export function clampArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = paramSchema(name);
  if (!schema?.properties) return args;
  return clampVal(schema, args) as Record<string, unknown>;
}

const declaresNull = (s: Schema): boolean => Array.isArray(s.type) && s.type.includes("null");

/** A value the model only produced because it had to produce something. */
const isBlank = (v: unknown, schema: Schema): boolean =>
  v === "" || (v === null && !declaresNull(schema));

function stripVal(schema: Schema | undefined, value: unknown): unknown {
  if (!schema || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return schema.items ? value.map((el) => stripVal(schema.items, el)) : value;
  }
  if (typeof value === "object" && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = schema.properties[k];
      if (!sub) {
        out[k] = v; // undeclared: unknownParams reports it, don't silently eat it
        continue;
      }
      if (isBlank(v, sub)) continue;
      out[k] = stripVal(sub, v);
    }
    return out;
  }
  return value;
}

/** Drop args the model only filled in because it had to, so a handler sees the same
 *  thing it saw when a param could simply be omitted.
 *
 *  We send tools to OpenAI in STRICT mode, where every property must be present;
 *  optionality is expressed as a `["integer", "null"]` union, so the model says
 *  "unset" by sending null. It also reaches for `""` on string params — with or
 *  without strict mode. Without this, `Number(null) === 0` turns every unset numeric
 *  into a real 0 (a 0x0 canvas, a `[0, 0)` window) and an empty string gets looked up
 *  as a real id; both in every tool at once, which is why it belongs at the shared
 *  boundary and not in 56 handlers.
 *
 *  The CONTRACT we serve is un-strictified, so a param that is genuinely nullable
 *  (set_transition.transition_in, where null means "remove the transition") still
 *  declares null and keeps it. Free-form objects declare no properties, so the walk
 *  never descends into them and the model's own data survives. */
export function dropStrictNulls(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = paramSchema(name);
  if (!schema?.properties) return args;
  return stripVal(schema, args) as Record<string, unknown>;
}
