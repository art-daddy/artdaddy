import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));

import { pickFolder } from "./pickFolder";

type Marked = { __TAURI_INTERNALS__?: unknown };
const view = window as unknown as Marked;

beforeEach(() => {
  openDialog.mockReset();
  view.__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete view.__TAURI_INTERNALS__;
});

describe("pickFolder", () => {
  it("asks the platform for ONE folder, with the title it was given, and returns what the person chose", async () => {
    openDialog.mockResolvedValueOnce("E:\\Elsewhere");
    expect(await pickFolder("Save the video to")).toBe("E:\\Elsewhere");
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openDialog.mock.calls[0][0]).toMatchObject({
      directory: true,
      multiple: false,
      title: "Save the video to",
    });
  });

  it("starts where it is told, written the way Windows writes a path", async () => {
    openDialog.mockResolvedValue("E:\\Elsewhere");
    await pickFolder("t", "D:/Videos/Cuts");
    expect(openDialog.mock.calls[0][0]).toMatchObject({ defaultPath: "D:\\Videos\\Cuts" });
    await pickFolder("t", "/Users/me/Movies");
    expect(openDialog.mock.calls[1][0]).toMatchObject({ defaultPath: "/Users/me/Movies" });
  });

  it("does not pass a starting folder it cannot use", async () => {
    openDialog.mockResolvedValue("E:\\Elsewhere");
    for (const from of [undefined, "", "   ", "relative/folder"]) {
      await pickFolder("t", from);
      expect(openDialog.mock.calls.at(-1)![0], String(from)).not.toHaveProperty("defaultPath");
    }
  });

  it("is no choice when the person closes the picker", async () => {
    openDialog.mockResolvedValueOnce(null);
    expect(await pickFolder("t")).toBeNull();
  });

  it("takes the first folder of a list, and never hands back an empty or padded name", async () => {
    openDialog.mockResolvedValueOnce(["E:\\One", "F:\\Two"]);
    expect(await pickFolder("t")).toBe("E:\\One");
    for (const odd of ["", "   ", [], [""], 42, {}, undefined]) {
      openDialog.mockResolvedValueOnce(odd);
      expect(await pickFolder("t"), JSON.stringify(odd)).toBeNull();
    }
    openDialog.mockResolvedValueOnce("  E:\\Padded  ");
    expect(await pickFolder("t")).toBe("E:\\Padded");
  });

  it("is no choice, not an error, when the picker cannot open", async () => {
    openDialog.mockRejectedValueOnce(new Error("no dialog backend"));
    expect(await pickFolder("t")).toBeNull();
  });

  it("is no choice outside the app, where there is no folder picker to ask", async () => {
    delete view.__TAURI_INTERNALS__;
    expect(await pickFolder("t")).toBeNull();
    expect(openDialog).not.toHaveBeenCalled();
  });
});
