import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  discardFirstPrompt,
  peekFirstFootage,
  peekFirstPrompt,
  setFirstPrompt,
  takeFirstFootage,
  takeFirstPrompt,
  type Footage,
} from "./firstPrompt";

const a: Footage = { name: "a.mp4", path: "D:/shoot/a.mp4" };
const b: Footage = { name: "b.mov", path: "D:/shoot/b.mov" };

beforeEach(() => setFirstPrompt("", ""));

// What the person wrote (and the footage they chose) on the start screen has to survive the navigation into the
// project it creates. The rules below are what the chat relies on to send it exactly once, with its footage,
// to the project it was made for.
describe("the start screen's first prompt and footage", () => {
  it("belongs to one project: no other project sees the text or the footage", () => {
    setFirstPrompt("p1", "Make my reel", [a, b]);
    expect(peekFirstPrompt("p2")).toBeNull();
    expect(peekFirstFootage("p2")).toEqual([]);
    expect(takeFirstFootage("p2")).toEqual([]);
    expect(takeFirstPrompt("p2")).toBeNull();
    // and asking as another project took nothing from the owner
    expect(peekFirstPrompt("p1")).toBe("Make my reel");
    expect(peekFirstFootage("p1")).toEqual([a, b]);
  });

  it("keeps the footage in the order chosen, and owns its own copy of the list", () => {
    const chosen = [b, a];
    setFirstPrompt("p1", "Make my reel", chosen);
    chosen.length = 0; // the caller reusing its array must not empty the queue
    expect(peekFirstFootage("p1")).toEqual([b, a]);
    peekFirstFootage("p1").length = 0; // …and a peek is not a handle on it either
    expect(peekFirstFootage("p1")).toEqual([b, a]);
  });

  it("is nothing without words: footage alone queues nothing, so no footage is imported for no message", () => {
    setFirstPrompt("p1", "   ", [a]);
    expect(peekFirstPrompt("p1")).toBeNull();
    expect(peekFirstFootage("p1")).toEqual([]);
    setFirstPrompt("", "Make my reel", [a]);
    expect(peekFirstFootage("")).toEqual([]);
  });

  it("hands the footage over once and leaves the words for the send", () => {
    setFirstPrompt("p1", "Make my reel", [a, b]);
    expect(takeFirstFootage("p1")).toEqual([a, b]);
    expect(takeFirstFootage("p1")).toEqual([]); // however often the chat renders, it imports once
    expect(peekFirstFootage("p1")).toEqual([]);
    expect(peekFirstPrompt("p1")).toBe("Make my reel");
    expect(takeFirstPrompt("p1")).toBe("Make my reel");
    expect(takeFirstPrompt("p1")).toBeNull();
  });

  it("taking the words takes everything: a later message inherits no footage", () => {
    setFirstPrompt("p1", "Make my reel", [a]);
    expect(takeFirstPrompt("p1")).toBe("Make my reel");
    expect(peekFirstFootage("p1")).toEqual([]);
  });

  it("a newer prompt replaces the older one whole, footage included", () => {
    setFirstPrompt("p1", "First", [a, b]);
    setFirstPrompt("p2", "Second");
    expect(peekFirstPrompt("p1")).toBeNull();
    expect(peekFirstFootage("p1")).toEqual([]);
    expect(peekFirstPrompt("p2")).toBe("Second");
    expect(peekFirstFootage("p2")).toEqual([]);
  });

  it("is discarded whole, and only by its own project", () => {
    setFirstPrompt("p1", "Make my reel", [a]);
    discardFirstPrompt("p2");
    expect(peekFirstPrompt("p1")).toBe("Make my reel");
    discardFirstPrompt("p1");
    expect(peekFirstPrompt("p1")).toBeNull();
    expect(peekFirstFootage("p1")).toEqual([]);
  });

  it("carries a web file as the file itself", () => {
    const file = new File(["x"], "web.mp4", { type: "video/mp4" });
    setFirstPrompt("p1", "Make my reel", [{ name: "web.mp4", file }]);
    const [only] = takeFirstFootage("p1");
    expect("file" in only && only.file).toBe(file);
  });

  it("property: whatever was chosen comes back once, in order, and the words once after it", () => {
    const footage = fc.array(
      fc.record({ name: fc.string({ minLength: 1 }), path: fc.string({ minLength: 1 }) }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), footage, (text, chosen) => {
        fc.pre(text.trim() !== "");
        setFirstPrompt("p1", text, chosen);
        expect(peekFirstFootage("p1")).toEqual(chosen);
        expect(takeFirstFootage("p1")).toEqual(chosen);
        expect(takeFirstFootage("p1")).toEqual([]);
        expect(takeFirstPrompt("p1")).toBe(text.trim());
        expect(takeFirstPrompt("p1")).toBeNull();
        expect(peekFirstFootage("p1")).toEqual([]);
      }),
    );
  });
});
