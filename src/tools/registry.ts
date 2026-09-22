// A registry of tools this client can execute locally. Handlers take the tool's
// JSON args and return a JSON-serialisable result (the same shape a server-side
// tool returns). Populated per platform (empty on web; Tauri/Node fills it in).
import { clampArgs, dropStrictNulls } from "../contract/clamp";
import { toolParams, unknownParams } from "../contract/params";
import { recordToolCall } from "../api/agentEvents";

export type ToolResult = unknown;
export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

export class ClientToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  get size(): number {
    return this.handlers.size;
  }

  async run(name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    // Recorded HERE rather than in the agent loop because this is the only point every tool
    // call passes through -- the loop never sees the three rejections below, and they are the
    // ones that mean the model is calling the tool wrong.
    const trace = (result: ToolResult): ToolResult => {
      const failed =
        result !== null && typeof result === "object" && (result as { ok?: unknown }).ok === false;
      recordToolCall({
        name,
        ok: !failed,
        ms: Date.now() - started,
        args: rawArgs,
        result,
        error: failed ? String((result as { error?: unknown }).error ?? "") : "",
      });
      return result;
    };
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no client tool registered: ${name}`);
    // Tool-call arguments are always a JSON object; anything else (null, array,
    // primitive) is malformed input -> reject gracefully instead of letting a
    // handler dereference it and crash.
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return trace({ ok: false, error: `${name}: arguments must be an object.` });
    }
    // Strict mode forces the model to emit EVERY declared property, so "I'm not
    // setting this" arrives as an explicit null. Normalise that back to absent
    // before anything reads the args (see dropStrictNulls).
    const args = dropStrictNulls(name, rawArgs);
    // Reject any top-level arg the served schema does not declare, so a mis-named
    // or hallucinated param fails LOUDLY instead of being silently ignored (our
    // server-declares / client-executes split can't catch that at compile time).
    // Underscore-prefixed keys are client-internal (e.g. _model_id) and allowed.
    const unknown = unknownParams(name, args);
    if (unknown.length) {
      const allowed = toolParams(name).join(", ") || "(none)";
      return trace({
        ok: false,
        error: `${name}: unknown param(s) ${unknown.join(", ")}. Allowed: ${allowed}.`,
      });
    }
    // Deliberately NOT symmetrical: there is no required-param gate here. The schema already
    // declares them, and each handler's own message is more specific than a generic "missing
    // required param" could be ("text must be a non-empty string" beats "missing text").
    // Adding one replaced ~30 better messages with a worse one.
    // The dispatch boundary is crash-proof: a handler that throws (or rejects) on
    // malformed args becomes a graceful { ok:false } so the agent loop can recover
    // instead of the whole turn dying. Clamp numeric args to contract min/max first.
    try {
      return trace(await handler(clampArgs(name, args)));
    } catch (e) {
      return trace({ ok: false, error: `${name}: ${(e as Error)?.message ?? String(e)}` });
    }
  }
}
