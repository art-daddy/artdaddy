import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CreditLimitError } from "../api/usage";
import { ClientToolRegistry } from "../tools/registry";
import { CREDITS_PAUSED, isOutOfCredits, markOutOfCredits, OUT_OF_CREDITS } from "./outOfCredits";

describe("isOutOfCredits", () => {
  // Every hop between the 402 and the screen wraps the message in more text: the registry
  // prefixes the tool name, the loop stringifies the throw, the wake prompt adds the job label.
  it("still recognises a marked message however much text is wrapped around it", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (before, body, after) =>
        isOutOfCredits(before + markOutOfCredits(body) + after),
      ),
    );
  });

  // The failure direction: the offer must not spread to errors more credits cannot fix,
  // including ones that merely mention credit.
  it.each([
    "Your credit card was declined",
    "the credit limit is reached, so no paid call can succeed right now",
    "Couldn't reach the server. Check your connection and try again.",
    "the provider returned nothing for this one — usually a content filter",
    "credit_limit",
    "",
  ])("does not call %j out of credits", (text) => {
    expect(isOutOfCredits(text)).toBe(false);
  });

  it("ignores anything that is not text", () => {
    for (const v of [undefined, null, 0, {}, ["[credit_limit]"]]) {
      expect(isOutOfCredits(v)).toBe(false);
    }
  });

  it("recognises both sentences a person can be shown", () => {
    expect(isOutOfCredits(OUT_OF_CREDITS)).toBe(true);
    expect(isOutOfCredits(CREDITS_PAUSED)).toBe(true);
  });
});

describe("the real error through the real boundaries", () => {
  it("survives the tool registry, which turns every throw into text", async () => {
    const reg = new ClientToolRegistry().register("generate_image", () => {
      throw new CreditLimitError({ used: 500, limit: 500 });
    });
    const out = (await reg.run("generate_image", {})) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(isOutOfCredits(out.error)).toBe(true);
  });

  it("survives String(), which is how the agent loop flattens a throw", () => {
    expect(isOutOfCredits(String(new CreditLimitError(null)))).toBe(true);
  });

  it("is recognised from what a person is told, for either scope", () => {
    expect(isOutOfCredits(new CreditLimitError({ scope: "user" }).userMessage)).toBe(true);
    expect(isOutOfCredits(new CreditLimitError({ scope: "global" }).userMessage)).toBe(true);
  });
});
