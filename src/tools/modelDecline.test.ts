import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetModelDecline,
  clearModelDecline,
  declineModel,
  modelDeclined,
} from "./modelDecline";

const KEY = "artdaddy.speech_model_declined.v1";

/** A storage that holds text and can be made to fail, as a full or blocked one does. */
function fakeStorage() {
  const held = new Map<string, string>();
  const fails = { get: false, set: false, remove: false };
  return {
    held,
    fails,
    getItem: (k: string): string | null => {
      if (fails.get) throw new Error("blocked");
      return held.get(k) ?? null;
    },
    setItem: (k: string, v: string): void => {
      if (fails.set) throw new Error("full");
      held.set(k, v);
    },
    removeItem: (k: string): void => {
      if (fails.remove) throw new Error("blocked");
      held.delete(k);
    },
  };
}

beforeEach(() => __resetModelDecline());
afterEach(() => __resetModelDecline());

describe("a Cancel of the speech model's download that the app remembers", () => {
  it("is remembered, as a time and the release it was said in", () => {
    const store = fakeStorage();
    expect(modelDeclined(store, "1.0")).toBe(false);
    declineModel(1234, store, "1.0");
    expect(modelDeclined(store, "1.0")).toBe(true);
    expect(JSON.parse(store.held.get(KEY) ?? "null")).toEqual({ at: 1234, version: "1.0" });
  });

  it("is still there after the app is closed and opened again, but not after an update", () => {
    const store = fakeStorage();
    store.held.set(KEY, JSON.stringify({ at: 1234, version: "1.0" }));
    // Nothing is in memory: a start of the app that has only the storage to go by.
    expect(modelDeclined(store, "1.0")).toBe(true);
    expect(modelDeclined(store, "1.1")).toBe(false);
  });

  it("ends when the model is wanted again, in memory and in storage", () => {
    const store = fakeStorage();
    declineModel(1, store, "1.0");
    clearModelDecline(store);
    expect(modelDeclined(store, "1.0")).toBe(false);
    expect(store.held.has(KEY)).toBe(false);
  });

  it("is kept for this session when the storage cannot be written, and never throws", () => {
    const store = fakeStorage();
    store.fails.set = true;
    expect(() => declineModel(1, store, "1.0")).not.toThrow();
    expect(modelDeclined(store, "1.0")).toBe(true);
    store.fails.remove = true;
    expect(() => clearModelDecline(store)).not.toThrow();
    expect(modelDeclined(store, "1.0")).toBe(false);
  });

  it("is not there when the storage cannot be read, or holds anything but a record", () => {
    const store = fakeStorage();
    store.fails.get = true;
    expect(modelDeclined(store, "1.0")).toBe(false);
    store.fails.get = false;
    for (const text of [
      "not json",
      "null",
      "[]",
      "7",
      JSON.stringify({ version: "1.0" }),
      JSON.stringify({ at: "yesterday", version: "1.0" }),
      JSON.stringify({ at: 5, version: 1 }),
      JSON.stringify({ at: 5 }),
    ]) {
      store.held.set(KEY, text);
      expect(modelDeclined(store, "1.0"), text).toBe(false);
    }
    expect(modelDeclined(null, "1.0")).toBe(false);
  });
});
