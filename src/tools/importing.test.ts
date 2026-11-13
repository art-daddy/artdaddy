// What the agent reads about files that are still coming in (UJ-088). The failure this guards is the "library is empty" answer given in the window between a drop and the
// import landing, so the cases that matter are the windows: a file that lands, or starts, in the middle of a read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { resetImportBatches, useImportJobs, withImportBatch } from "../store/importJobs";
import { importingField, importingFor, importingMatch, readWithImporting } from "./importing";

const store = { projectDir: "C:/proj" };

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((res) => (open = res));
  return { promise, open };
};
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

beforeEach(() => {
  resetImportBatches();
  __resetExportFlags();
  useImportJobs.setState({ jobs: [] });
});
afterEach(() => {
  resetImportBatches();
  __resetExportFlags();
});

describe("importingFor and the import_note flag", () => {
  it("is the registry for the open project, and nothing when no project is open", () => {
    const hold = gate();
    const batch = withImportBatch("C:/proj", ["D:/a.mp4"], () => hold.promise);
    expect(names(importingFor(store))).toEqual(["a.mp4"]);
    expect(importingFor({ projectDir: "C:/other" })).toEqual([]);
    expect(importingFor(null)).toEqual([]);
    expect(importingFor(undefined)).toEqual([]);
    hold.open();
    return batch;
  });

  it("is switched off by the server's flag, for every reader at once: 0.27.0 reports nothing", () => {
    const hold = gate();
    const batch = withImportBatch("C:/proj", ["D:/a.mp4"], () => hold.promise);
    __setExportFlag("import_note", false);
    expect(importingFor(store)).toEqual([]);
    expect(importingMatch(store, "a.mp4")).toBeNull();
    expect(importingField(importingFor(store))).toEqual({});
    __setExportFlag("import_note", true);
    expect(names(importingFor(store))).toEqual(["a.mp4"]);
    hold.open();
    return batch;
  });
});

describe("readWithImporting: a file is never in neither the library read nor the list", () => {
  it("reports a file that LANDS in the middle of the read (the read may not show it, the list does)", async () => {
    const job = gate();
    const end = gate();
    let landed: Promise<unknown> = Promise.resolve();
    const batch = withImportBatch("C:/proj", ["D:/a.mp4"], async (file) => {
      landed = file("D:/a.mp4", () => job.promise);
      await end.promise;
    });
    const { value, importing } = await readWithImporting(store, async () => {
      const library: string[] = []; // the library as it was when the read looked
      job.open(); // the file lands right after
      await landed;
      return library;
    });
    expect(value).toEqual([]);
    expect(names(importing)).toEqual(["a.mp4"]);
    expect(names(importingFor(store))).toEqual([]); // and a read after that sees it settled
    end.open();
    await batch;
  });

  it("reports a file that STARTS in the middle of the read", async () => {
    const hold = gate();
    let batch: Promise<unknown> = Promise.resolve();
    const { importing } = await readWithImporting(store, async () => {
      batch = withImportBatch("C:/proj", ["D:/dropped-meanwhile.mp4"], () => hold.promise);
      await tick();
      return [];
    });
    expect(names(importing)).toEqual(["dropped-meanwhile.mp4"]);
    hold.open();
    await batch;
  });

  it("lists a file once however many readings saw it, with the later percent", async () => {
    const hold = gate();
    useImportJobs.getState().begin("D:/shoot/big.mp4", "big.mp4");
    const batch = withImportBatch("C:/proj", ["D:/shoot/big.mp4"], () => hold.promise);
    const { importing } = await readWithImporting(store, async () => {
      useImportJobs.getState().progress("D:/shoot/big.mp4", 50, 100);
      return null;
    });
    expect(importing).toHaveLength(1);
    expect(importing[0].fraction).toBe(0.5);
    hold.open();
    await batch;
  });

  it("with nothing importing it adds nothing: the result is byte-identical to what it was", async () => {
    const { value, importing } = await readWithImporting(store, async () => ({
      ok: true,
      clips: [],
    }));
    expect(importing).toEqual([]);
    expect(JSON.stringify({ ...value, ...importingField(importing) })).toBe(
      '{"ok":true,"clips":[]}',
    );
  });

  it("a read that fails still fails: the list does not swallow it", async () => {
    await expect(
      readWithImporting(store, async () => {
        throw new Error("catalog unreadable");
      }),
    ).rejects.toThrow("catalog unreadable");
  });
});

describe("importingField", () => {
  it("is the shape every reader returns: names, and a whole-number percent once bytes are being read", () => {
    expect(
      importingField([
        { path: "D:/a.mp4", name: "a.mp4", fraction: 0.456 },
        { path: "D:/b.mp4", name: "b.mp4", fraction: null },
      ]),
    ).toEqual({ importing: [{ name: "a.mp4", percent: 46 }, { name: "b.mp4" }] });
  });
});

describe("importingMatch: the name the agent was given, never a guess", () => {
  it("finds a file by its name in any letter case, or by its whole path in either slash", () => {
    const hold = gate();
    const batch = withImportBatch("C:/proj", ["D:\\Shoot\\Big_1.MP4"], () => hold.promise);
    expect(importingMatch(store, "big_1.mp4")?.name).toBe("Big_1.MP4");
    expect(importingMatch(store, "  BIG_1.MP4 ")?.name).toBe("Big_1.MP4");
    expect(importingMatch(store, "D:/shoot/big_1.mp4")?.name).toBe("Big_1.MP4");
    expect(importingMatch(store, "D:\\Shoot\\Big_1.MP4")?.name).toBe("Big_1.MP4");
    hold.open();
    return batch;
  });

  it("does not match a part of a name, another name, an id, or nothing", () => {
    const hold = gate();
    const batch = withImportBatch("C:/proj", ["D:/shoot/big_1.mp4"], () => hold.promise);
    for (const ref of ["big", "big_1", "big_1.mp", "media_ab12cd34ef56", "", "   "])
      expect(importingMatch(store, ref), ref).toBeNull();
    hold.open();
    return batch;
  });
});
