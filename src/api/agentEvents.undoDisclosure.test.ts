// The undo events are a new data practice: a build may send them only once both privacy documents say so
// (art-daddy/backlog#131). The commit that turns UNDO_EVENTS_SHIPPED on must add the disclosure to the app's PRIVACY.txt
// and to the website's privacy page in the same words; until then this holds the switch off.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { UNDO_EVENTS_SHIPPED } from "./agentEvents";

const APP = path.resolve(__dirname, "..", "..", "src-tauri", "PRIVACY.txt");
// The landing repository, when it sits beside this one (the lab's worktrees put it there; CI has none).
const SITE = path.resolve(__dirname, "..", "..", "..", "akaru-landing", "landing", "privacy.html");

/** A clause that discloses it: an undo of an edit the agent made. A clause ends at a full stop or a semicolon. */
const DISCLOSES = /\bundo\b[^.;]*\bedits?\b[^.;]*\bagent\b/i;

/** The page's words without its markup, so a sentence split by a tag still reads as one. */
const words = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ");

describe("the undo events and the privacy documents", () => {
  it("knows the disclosure when it sees one, and does not take the count of hand actions for one", () => {
    // The guard below is only as good as this pattern: it must read the drafted sentence, and must not read the existing
    // count of hand actions ("such as move, trim, split, delete, undo") as one.
    expect(
      "when you undo an edit the agent made, or put a clip it changed back the way it was by hand",
    ).toMatch(DISCLOSES);
    expect(
      "how many of each kind of action you took by hand (such as move, trim, split, delete, undo), counted in windows of about a minute",
    ).not.toMatch(DISCLOSES);
  });

  it("are not sent by a build whose PRIVACY.txt does not disclose them", () => {
    if (!DISCLOSES.test(readFileSync(APP, "utf8")))
      expect(UNDO_EVENTS_SHIPPED, "turn the undo events on only with the privacy text").toBe(false);
  });

  it.skipIf(!existsSync(SITE))(
    "are not sent by a build whose website privacy page does not disclose them",
    () => {
      if (!DISCLOSES.test(words(readFileSync(SITE, "utf8"))))
        expect(UNDO_EVENTS_SHIPPED, "the website's privacy page must say it too").toBe(false);
    },
  );
});
