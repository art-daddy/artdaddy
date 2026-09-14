import { describe, expect, it } from "vitest";

import { Transport } from "./transport";

describe("Transport", () => {
  it("starts at 0, paused", () => {
    const t = new Transport(10);
    expect(t.time).toBe(0);
    expect(t.playing).toBe(false);
  });

  it("advances only while playing", () => {
    const t = new Transport(10);
    expect(t.tick(1000)).toBe(0); // paused: no advance
    t.play();
    expect(t.playing).toBe(true);
    expect(t.tick(1000)).toBe(1);
    expect(t.tick(500)).toBe(1.5);
  });

  it("clamps and auto-pauses at the end", () => {
    const t = new Transport(2);
    t.play();
    t.tick(3000);
    expect(t.time).toBe(2);
    expect(t.playing).toBe(false);
  });

  it("restarts from the top when played at the end", () => {
    const t = new Transport(2);
    t.seek(2);
    t.play();
    expect(t.time).toBe(0);
    expect(t.playing).toBe(true);
  });

  it("seek clamps to [0, duration]", () => {
    const t = new Transport(5);
    t.seek(-3);
    expect(t.time).toBe(0);
    t.seek(99);
    expect(t.time).toBe(5);
  });

  it("toggle flips play/pause", () => {
    const t = new Transport(5);
    t.toggle();
    expect(t.playing).toBe(true);
    t.toggle();
    expect(t.playing).toBe(false);
  });

  it("does not play a zero-length timeline", () => {
    const t = new Transport(0);
    t.play();
    expect(t.playing).toBe(false);
  });

  it("setDuration shrinks the current time if needed", () => {
    const t = new Transport(10);
    t.seek(8);
    t.setDuration(5);
    expect(t.time).toBe(5);
    expect(t.duration).toBe(5);
    t.setDuration(-1);
    expect(t.duration).toBe(0);
  });
});
