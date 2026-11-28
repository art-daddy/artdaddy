// The empty stage is what a new project shows in its largest area, so its two buttons are a newcomer's way in: bring a
// file in (click, or drop one) or start the recorder. Each has to end in the library listing the file, the recorder
// opening, or a sentence saying what went wrong, never in a button that silently did nothing.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doors = vi.hoisted(() => ({ uploadFiles: vi.fn(), importViaDialog: vi.fn() }));
vi.mock("../lib/upload", async (orig) => ({
  ...(await orig<typeof import("../lib/upload")>()),
  uploadFiles: doors.uploadFiles,
  importViaDialog: doors.importViaDialog,
}));

import { useProjectNotice } from "../store/projectNotice";
import { useRecordPanel } from "../store/recordPanel";
import StageEmpty from "./StageEmpty";

const video = new File([new Uint8Array([1, 2, 3])], "beach.mp4", { type: "video/mp4" });
const notes = new File(["hello"], "notes.txt", { type: "text/plain" });

let listed = 0;
const onListed = () => {
  listed += 1;
};
beforeEach(() => {
  listed = 0;
  window.addEventListener("artdaddy:files-changed", onListed);
  doors.uploadFiles.mockReset().mockResolvedValue([]);
  doors.importViaDialog.mockReset().mockResolvedValue([]);
  useProjectNotice.getState().clear();
  useRecordPanel.setState({ open: false });
});
afterEach(() => window.removeEventListener("artdaddy:files-changed", onListed));

const uploadButton = () => screen.getByRole("button", { name: "upload file" });
/** A drop of `files` on the upload button, as the OS hands it to the page. */
function drop(files: File[]): void {
  const dataTransfer = { types: ["Files"], files };
  fireEvent.dragOver(uploadButton(), { dataTransfer });
  fireEvent.drop(uploadButton(), { dataTransfer });
}
/** A bare dragover carrying `types`; true when the page offered to take it (it cancelled the browser's default). */
function offered(types: string[]): boolean {
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { types, files: [], dropEffect: "none" } });
  uploadButton().dispatchEvent(event);
  return event.defaultPrevented;
}

describe("dropping a file on the empty stage", () => {
  it("imports the media into this project and has the library list it", async () => {
    doors.uploadFiles.mockResolvedValue([
      { path: "/p/beach.mp4", name: "beach.mp4", rel: "x", id: "m1" },
    ]);
    render(<StageEmpty projectId="p1" />);
    drop([video]);
    await waitFor(() => expect(listed).toBe(1));
    expect(doors.uploadFiles).toHaveBeenCalledWith("p1", [video]);
    expect(uploadButton()).not.toBeDisabled();
  });

  it("imports only the media of a mixed drop, and nothing at all from a drop with none", async () => {
    render(<StageEmpty projectId="p1" />);
    drop([notes, video]);
    await waitFor(() => expect(doors.uploadFiles).toHaveBeenCalledTimes(1));
    expect(doors.uploadFiles).toHaveBeenCalledWith("p1", [video]);
    drop([notes]);
    await act(async () => {});
    expect(doors.uploadFiles).toHaveBeenCalledTimes(1);
  });

  it("shows it is importing while the file comes in, and cannot be started twice", async () => {
    let finish!: () => void;
    doors.uploadFiles.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<StageEmpty projectId="p1" />);
    drop([video]);
    await waitFor(() => expect(screen.getByText("Importing…")).toBeInTheDocument());
    expect(uploadButton()).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByText("Upload file")).toBeInTheDocument();
    expect(uploadButton()).not.toBeDisabled();
  });

  it("says why when the import fails, and lets the person try again", async () => {
    doors.uploadFiles.mockRejectedValue(new Error("the disk is full"));
    render(<StageEmpty projectId="p1" />);
    drop([video]);
    await waitFor(() =>
      expect(useProjectNotice.getState().message).toBe("Couldn't import: the disk is full"),
    );
    expect(listed).toBe(0);
    expect(uploadButton()).not.toBeDisabled();
  });

  it("offers to take a drag of files, and ignores one that carries none, such as text from another window", () => {
    render(<StageEmpty projectId="p1" />);
    expect(offered(["Files"])).toBe(true);
    expect(offered(["text/plain"])).toBe(false);
  });
});

describe("clicking Upload file", () => {
  it("lists what the person picked in the system's dialog", async () => {
    doors.importViaDialog.mockResolvedValue([{ id: "m1" }]);
    render(<StageEmpty projectId="p1" />);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(listed).toBe(1));
    expect(doors.importViaDialog).toHaveBeenCalledWith("p1", "Import media");
  });

  it("changes nothing when the dialog is cancelled", async () => {
    doors.importViaDialog.mockResolvedValue([]);
    render(<StageEmpty projectId="p1" />);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(uploadButton()).not.toBeDisabled());
    await new Promise((r) => setTimeout(r, 150)); // past the library's debounce
    expect(listed).toBe(0);
    expect(useProjectNotice.getState().message).toBeNull();
  });

  // In the browser build there is no system dialog: the page's own file picker opens, and what it returns is imported.
  it("falls back to the page's own file picker where there is no system dialog", async () => {
    doors.importViaDialog.mockResolvedValue(null);
    doors.uploadFiles.mockResolvedValue([{ id: "m1" }]);
    const { container } = render(<StageEmpty projectId="p1" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const opened = vi.spyOn(input, "click");
    fireEvent.click(uploadButton());
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { files: [notes, video] } });
    await waitFor(() => expect(listed).toBe(1));
    expect(doors.uploadFiles).toHaveBeenCalledWith("p1", [video]);
  });

  it("says why when the dialog fails", async () => {
    doors.importViaDialog.mockRejectedValue(new Error("no permission to read that folder"));
    render(<StageEmpty projectId="p1" />);
    fireEvent.click(uploadButton());
    await waitFor(() =>
      expect(useProjectNotice.getState().message).toBe(
        "Couldn't import: no permission to read that folder",
      ),
    );
    expect(uploadButton()).not.toBeDisabled();
  });
});

it("Record opens the recorder", () => {
  render(<StageEmpty projectId="p1" />);
  fireEvent.click(screen.getByRole("button", { name: "record video" }));
  expect(useRecordPanel.getState().open).toBe(true);
});
