import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AUTH_APP_STEPS } from "./authEvents";
import { SIGN_IN_PROBLEMS, signInProblemText, type CallbackReason } from "./signInProblems";

// A person who reads this has just finished in the browser and is looking at a screen that has not changed. What
// matters is that every way sign-in can fail has a sentence (or is deliberately silent), that the sentence is
// plain, and that the button it names is the button the screen really has.
const REASONS = AUTH_APP_STEPS.callback as readonly CallbackReason[];
const SILENT: readonly CallbackReason[] = ["unrecognized", "cancelled"];
const spoken = REASONS.filter((reason) => !SILENT.includes(reason));

describe("what the person is told when sign-in did not finish", () => {
  it("has a sentence, or a deliberate silence, for every way a callback can fail, and nothing else", () => {
    expect(Object.keys(SIGN_IN_PROBLEMS).sort()).toEqual([...REASONS].sort());
  });

  it("is silent for exactly a link that was not a sign-in link and a sign-in the person ended themselves", () => {
    expect(REASONS.filter((reason) => SIGN_IN_PROBLEMS[reason] === null).sort()).toEqual(
      [...SILENT].sort(),
    );
  });

  it.each(spoken)(
    "says %s in plain words, with what to press, and nothing from the code",
    (reason) => {
      const text = SIGN_IN_PROBLEMS[reason]!;
      expect(text).toMatch(/^(Sign-in didn't finish|You signed in)/);
      // Names the button the person can press, and presses it again rather than leaving them stuck.
      expect(text).toContain("“Log in or sign up”");
      // Nothing a developer would write: a number, an address, a status, a name from the code.
      expect(text, "a number or a status code").not.toMatch(/\d/);
      expect(text, "an address").not.toMatch(/https?:|artdaddy:|\/\/|\.com|localhost/i);
      for (const jargon of [
        "state",
        "token",
        "code",
        "exchange",
        "keychain",
        "verifier",
        "PKCE",
        "callback",
        "deep link",
        "401",
        "undefined",
        "null",
      ]) {
        expect(text.toLowerCase(), jargon).not.toContain(jargon.toLowerCase());
      }
      expect(text.length).toBeLessThan(180);
    },
  );

  it("tells a failure the person can fix from one they can only wait out", () => {
    expect(SIGN_IN_PROBLEMS.exchange_network).toMatch(/connection/);
    expect(SIGN_IN_PROBLEMS.exchange_server).toMatch(/wait a moment/i);
    expect(SIGN_IN_PROBLEMS.exchange_rejected).toMatch(/expired or was already used/);
    expect(SIGN_IN_PROBLEMS.state_mismatch).toMatch(/earlier try/);
  });

  it("names the button the sign-in screen really has", () => {
    // If the button is renamed this fails, instead of sending people to a button that is not there.
    const screen = readFileSync(path.resolve(__dirname, "../components/SignInScreen.tsx"), "utf8");
    expect(screen).toContain("Log in or sign up");
  });

  it("says nothing for a reason it does not know, including the keys every object has", () => {
    for (const unknown of [
      undefined,
      "telepathy",
      "constructor",
      "__proto__",
      "toString",
      "",
    ] as const) {
      expect(signInProblemText(unknown as CallbackReason | undefined), String(unknown)).toBeNull();
    }
  });

  it("gives the same sentence back for the same reason", () => {
    for (const reason of REASONS) expect(signInProblemText(reason)).toBe(SIGN_IN_PROBLEMS[reason]);
  });
});
