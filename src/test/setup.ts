import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import fc from "fast-check";
import { afterEach } from "vitest";

import { _resetAppCaches } from "../tools/appCache";
import { __resetWorkGate } from "../tools/workGate";

// The app cache is one instance per folder, as in the app. Every fake disk here names the same
// folder, so without this one case's transcripts would answer the next case's questions.
afterEach(() => _resetAppCaches());
// So is the work gate, one per page: a case that ends holding a turn would stall the next case's.
afterEach(() => __resetWorkGate());

// Property failures must carry their own evidence. Without this, a seed-dependent failure
// reports only "Property failed after N tests" in the JSON reporter — the counterexample and the
// seed needed to reproduce it are printed elsewhere and lost. One such failure cost an hour of
// blind re-running; the next one should name itself.
fc.configureGlobal({ includeErrorInReport: true });

// The DOM environment doesn't fully implement these; components use them.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
// Node >= 22 ships its own global `localStorage`, which SHADOWS the environment's and throws
// ("localStorage.clear is not a function") unless node was given --localstorage-file. Restore a
// working Storage so the suite tests the app rather than the runtime it happens to run on.
if (typeof globalThis.localStorage?.clear !== "function") {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
  Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
}
if (typeof window.prompt !== "function") {
  window.prompt = () => null;
}
if (typeof window.confirm !== "function") {
  window.confirm = () => false;
}

afterEach(() => cleanup());
