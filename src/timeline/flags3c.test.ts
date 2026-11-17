// The one reader of the remote switches the estimate side uses: every switch is read when it is asked for, a switch that cannot be read is the compiled default, and
// the reader cannot throw into an export or a dialog.
import { afterEach, describe, expect, it, vi } from "vitest";

import * as exportFlags from "../api/exportFlags";
import {
  COMPILED_FLAG_DEFAULTS,
  EXPORT_FLAG_NAMES,
  __resetExportFlags,
  __setExportFlag,
} from "../api/exportFlags";
import { flags3cNow } from "./flags3c";
import { FLAGS_3C, flags3cAllOn } from "./exportTypes3c";

afterEach(() => {
  vi.restoreAllMocks();
  __resetExportFlags();
  exportFlags.__setHeldOffByBuild(null);
});

describe("flags3cNow", () => {
  it("names exactly the switches of the shared list, and every one is a switch the flag store knows", () => {
    const got = flags3cNow();
    expect(Object.keys(got).sort()).toEqual([...FLAGS_3C].sort());
    // A name the flag store does not know reads as off for ever: the list and the store cannot drift apart unseen.
    for (const name of FLAGS_3C) expect(EXPORT_FLAG_NAMES as readonly string[]).toContain(name);
  });

  it("is every switch on before the server has said anything (the compiled defaults)", () => {
    expect(flags3cNow()).toEqual(flags3cAllOn());
    for (const name of FLAGS_3C) expect(COMPILED_FLAG_DEFAULTS[name]).toBe(true);
  });

  it("follows the store at the moment it is asked, one switch at a time", () => {
    for (const name of FLAGS_3C) {
      __setExportFlag(name, false);
      const got = flags3cNow();
      expect(got[name], name).toBe(false);
      for (const other of FLAGS_3C) if (other !== name) expect(got[other], other).toBe(true);
      __setExportFlag(name, true);
    }
    __setExportFlag("estimate_v2", false);
    expect(flags3cNow().estimate_v2).toBe(false);
    __setExportFlag("estimate_v2", true);
    expect(flags3cNow().estimate_v2).toBe(true);
  });

  it("gives the compiled default for a switch that cannot be read, and never throws", () => {
    __setExportFlag("estimate_v2", false);
    vi.spyOn(exportFlags, "exportFlag").mockImplementation((name) => {
      if (name === "pc_check") throw new Error("the store broke");
      return false;
    });
    let got!: ReturnType<typeof flags3cNow>;
    expect(() => (got = flags3cNow())).not.toThrow();
    expect(got.pc_check).toBe(COMPILED_FLAG_DEFAULTS.pc_check);
    expect(got.estimate_v2).toBe(false);
  });

  it("reads a value that is not a boolean as off, so a damaged store can only withhold a behaviour", () => {
    vi.spyOn(exportFlags, "exportFlag").mockImplementation(() => "yes" as unknown as boolean);
    for (const name of FLAGS_3C) expect(flags3cNow()[name], name).toBe(false);
  });

  it("keeps what the build holds off, off, when a switch cannot be read: the compiled default does not undo the hold", () => {
    exportFlags.__setHeldOffByBuild(true);
    vi.spyOn(exportFlags, "exportFlag").mockImplementation(() => {
      throw new Error("the store broke");
    });
    const got = flags3cNow();
    for (const name of FLAGS_3C)
      expect(got[name], name).toBe(
        exportFlags.OFF_IN_THIS_BUILD.has(name) ? false : COMPILED_FLAG_DEFAULTS[name],
      );
    expect(got.estimate_v2).toBe(false);
    expect(got.pc_check).toBe(false);
  });
});
