import { describe, expect, it } from "vitest";

import { CHIP_PREF_KEY, readChipPref, writeChipPref, type ChipPref } from "./chipPref";
import type { StorageLike } from "./pcClass";

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { set: 0, remove: 0 };
  const store: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      calls.set++;
      map.set(key, String(value));
    },
    removeItem: (key) => {
      calls.remove++;
      map.delete(key);
    },
  };
  return { store, map, calls, bytes: () => JSON.stringify([...map.entries()]) };
}

/** A storage whose writes (or reads) fail while `broken` says so, and that otherwise behaves. */
function flaky(broken: { get?: boolean; set?: boolean; remove?: boolean }) {
  const inner = memoryStore();
  const store: StorageLike = {
    getItem: (key) => {
      if (broken.get) throw new Error("storage is off");
      return inner.store.getItem(key);
    },
    setItem: (key, value) => {
      if (broken.set) throw new Error("storage is full");
      inner.store.setItem(key, value);
    },
    removeItem: (key) => {
      if (broken.remove) throw new Error("storage is off");
      inner.store.removeItem(key);
    },
  };
  return { store, broken, inner };
}

describe("the person's graphics-chip switch", () => {
  it("is Auto until the person says Off, and then Off, remembered under its own key", () => {
    const { store, map } = memoryStore();
    expect(readChipPref(store)).toBe("auto");
    writeChipPref(store, "off");
    expect(readChipPref(store)).toBe("off");
    expect([...map.keys()]).toEqual(["artdaddy.chipPref.v1"]);
    expect(CHIP_PREF_KEY).toBe("artdaddy.chipPref.v1");
  });

  it("is remembered by a new reader of the same storage (a restart)", () => {
    const { store, map } = memoryStore();
    writeChipPref(store, "off");
    const restarted = memoryStore(Object.fromEntries(map)).store;
    expect(readChipPref(restarted)).toBe("off");
  });

  it("goes back to Auto by removing its entry, and leaves every other key as it was", () => {
    const { store, map, calls } = memoryStore({ "artdaddy.chipTest.v1": '{"x":1}', other: "y" });
    const others = JSON.stringify([...map.entries()]);
    writeChipPref(store, "off");
    writeChipPref(store, "auto");
    expect(readChipPref(store)).toBe("auto");
    expect(calls.remove).toBe(1);
    expect(JSON.stringify([...map.entries()])).toBe(others);
  });

  it("reads anything but exactly Off as Auto: a damaged value never switches the chip off", () => {
    const damaged = [
      "",
      "OFF",
      "Off",
      " off",
      "off ",
      '"off"',
      "true",
      "1",
      "false",
      "{}",
      '{"pref":"off"}',
      "null",
      "auto",
      "x".repeat(10_000),
      "off".repeat(5000),
    ];
    for (const raw of damaged) {
      const { store } = memoryStore({ [CHIP_PREF_KEY]: raw });
      expect(readChipPref(store), raw.slice(0, 30)).toBe("auto");
    }
    expect(readChipPref(memoryStore({ [CHIP_PREF_KEY]: "off" }).store)).toBe("off");
  });

  it("is Auto with no storage, and with storage that cannot be read; nothing throws", () => {
    expect(readChipPref(null)).toBe("auto");
    expect(() => writeChipPref(null, "off")).not.toThrow();
    expect(readChipPref(flaky({ get: true }).store)).toBe("auto");
  });

  it("does not turn a value that is not a choice into one", () => {
    const { store, calls, bytes } = memoryStore();
    writeChipPref(store, "off");
    const before = bytes();
    const writes = calls.set + calls.remove;
    for (const junk of ["banana", "", "OFF", null, undefined, 3, {}] as unknown as ChipPref[])
      writeChipPref(store, junk);
    expect(bytes()).toBe(before);
    expect(calls.set + calls.remove).toBe(writes);
    expect(readChipPref(store)).toBe("off");
  });

  describe("when storage cannot be written", () => {
    it("is not a failure, and Off still holds for this run of the app", () => {
      const { store } = flaky({ set: true });
      expect(() => writeChipPref(store, "off")).not.toThrow();
      expect(readChipPref(store)).toBe("off");
    });

    it("lets the person switch back to Auto in the same run, with the storage failing or not", () => {
      const failing = flaky({ set: true, remove: true });
      writeChipPref(failing.store, "off");
      expect(readChipPref(failing.store)).toBe("off");
      writeChipPref(failing.store, "auto");
      expect(readChipPref(failing.store)).toBe("auto");

      const recovering = flaky({ set: true });
      writeChipPref(recovering.store, "off");
      recovering.broken.set = false;
      writeChipPref(recovering.store, "off");
      writeChipPref(recovering.store, "auto");
      expect(readChipPref(recovering.store)).toBe("auto");
      expect(readChipPref(recovering.inner.store)).toBe("auto");
    });

    it("does not leak a choice that could not be written into another storage", () => {
      const one = flaky({ set: true });
      const other = memoryStore();
      writeChipPref(one.store, "off");
      expect(readChipPref(one.store)).toBe("off");
      expect(readChipPref(other.store)).toBe("auto");
    });
  });
});
