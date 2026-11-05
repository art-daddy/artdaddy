import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { displayFolder } from "../timeline/exportQuestions";
import { lastExportDir, rememberExportDir, savedToPath } from "./exportDir";

describe("savedToPath", () => {
  it("keeps the path the person chose, in the way their system wrote it, when the export went there", () => {
    const chosen = "D:\\Client Work\\hero cut.mp4";
    expect(savedToPath(chosen, "D:/Client Work/hero cut.mp4")).toBe(chosen);
    // Windows does not tell two spellings of a name apart.
    expect(savedToPath("d:\\client work\\HERO cut.MP4", "D:/Client Work/hero cut.mp4")).toBe(
      "d:\\client work\\HERO cut.MP4",
    );
    expect(savedToPath("/Users/me/Movies/a.mp4", "/Users/me/Movies/a.mp4")).toBe(
      "/Users/me/Movies/a.mp4",
    );
  });

  it("says where the export really went when that is not where they chose: another folder, or another name", () => {
    expect(savedToPath("D:\\Client Work\\hero cut.mp4", "E:/Elsewhere/hero cut.mp4")).toBe(
      "E:\\Elsewhere\\hero cut.mp4",
    );
    // numbered past a file that was already in the folder they moved it to
    expect(savedToPath("D:\\Videos\\a.mp4", "D:/Videos/a 2.mp4")).toBe("D:\\Videos\\a 2.mp4");
    // a path is not the same path on a system that tells names apart
    expect(savedToPath("/Users/me/Movies/a.mp4", "/Users/me/movies/a.mp4")).toBe(
      "/Users/me/movies/a.mp4",
    );
  });

  it("falls back to whichever it has: nothing known is not a made-up place", () => {
    expect(savedToPath("D:\\a.mp4", null)).toBe("D:\\a.mp4");
    expect(savedToPath("D:\\a.mp4", undefined)).toBe("D:\\a.mp4");
    expect(savedToPath("D:\\a.mp4", "  ")).toBe("D:\\a.mp4");
    // Nothing chosen (the web build has no Save As): the real place as it was given, unchanged.
    expect(savedToPath(null, "C:/Users/test/Downloads/a.mp4")).toBe(
      "C:/Users/test/Downloads/a.mp4",
    );
    expect(savedToPath(null, null)).toBeNull();
    expect(savedToPath("", undefined)).toBeNull();
  });

  it("is always one of the two it was given, written for the system it names, and never a third place", () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9 ._-]{1,8}$/)
      .filter((s) => s === s.trim() && !/^\.+$/.test(s));
    const path = fc
      .tuple(
        fc.constantFrom("C", "D", "E"),
        fc.array(segment, { minLength: 1, maxLength: 3 }),
        segment,
      )
      .map(([drive, folders, leaf]) => `${drive}:/${folders.join("/")}/${leaf}.mp4`);
    fc.assert(
      fc.property(path, path, fc.boolean(), (a, b, backslashes) => {
        const chosen = backslashes ? displayFolder(a) : a;
        const got = savedToPath(chosen, b);
        const same = a.toLowerCase() === b.toLowerCase();
        expect(got).toBe(same ? chosen : displayFolder(b));
      }),
    );
  });
});

describe("lastExportDir", () => {
  beforeEach(() => localStorage.clear());

  it("is null until an export has actually landed somewhere", () => {
    expect(lastExportDir()).toBeNull();
  });

  it("remembers the FOLDER of the chosen file, never the file itself", () => {
    // The whole point: the next save dialog opens in this directory. Storing the file
    // path would pre-fill the dialog with a folder that does not exist.
    rememberExportDir("D:/Videos/Client Work/final cut.mp4");
    expect(lastExportDir()).toBe("D:/Videos/Client Work");
    rememberExportDir("C:\\Users\\me\\Desktop\\v2.mp4");
    expect(lastExportDir()).toBe("C:\\Users\\me\\Desktop");
  });

  it("keeps the previous folder rather than storing a bare filename with no directory", () => {
    rememberExportDir("D:/Videos/one.mp4");
    rememberExportDir("two.mp4"); // no directory part — nothing to learn from it
    expect(lastExportDir()).toBe("D:/Videos");
  });

  it("treats a blank stored value as no folder, and ignores a root-level file", async () => {
    // Surviving mutants said both were untested. A whitespace entry would otherwise be
    // handed to joinPath and pre-fill the save dialog with a folder that does not exist.
    localStorage.setItem("artdaddy.export_dir", "   ");
    expect(lastExportDir()).toBeNull();
    localStorage.setItem("artdaddy.export_dir", "");
    expect(lastExportDir()).toBeNull();
    // cut === 0: the file sits at a POSIX root, so the directory part is "/", not "".
    localStorage.clear();
    rememberExportDir("/out.mp4");
    expect(lastExportDir()).toBeNull();
  });

  it("survives storage being unavailable instead of breaking the export", () => {
    // Safari private mode throws on setItem; a failed PREFERENCE must never be the reason a
    // render does not start. Stubbed via stubGlobal: jsdom's localStorage is a Proxy, so
    // assigning `localStorage.setItem = fn` STORES AN ITEM under the key "setItem" instead of
    // shadowing the method — that stub never fires and the test passes while proving nothing.
    const boom = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    try {
      expect(() => rememberExportDir("D:/Videos/x.mp4")).not.toThrow();
      expect(lastExportDir()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
