import { afterEach, describe, expect, it } from "vitest";

import { noteServerAnswered, resetServerContact, serverQuietMs } from "./serverContact";

afterEach(() => resetServerContact());

describe("when the server last answered this app", () => {
  it("says nothing is known until the server has answered in this run", () => {
    expect(serverQuietMs(1_000_000)).toBeNull();
  });

  it("counts the quiet from the last answer, never negative, and an answer ends it", () => {
    noteServerAnswered(1_000);
    expect(serverQuietMs(1_000 + 6 * 60_000)).toBe(6 * 60_000);
    expect(serverQuietMs(500)).toBe(0); // a clock that went back is not a negative silence
    noteServerAnswered(1_000 + 6 * 60_000);
    expect(serverQuietMs(1_000 + 6 * 60_000 + 10)).toBe(10);
  });
});
