import { beforeEach, describe, expect, it, vi } from "vitest";

import { lastExportDir, rememberExportDir } from "./exportDir";

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
