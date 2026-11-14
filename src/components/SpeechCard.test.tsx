import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SpeechCard from "./SpeechCard";
import type { CardView } from "../tools/speechTimeLine";

const view = (lines: string[], notes: CardView["notes"] = []): CardView => ({ lines, notes });
const card = (): HTMLElement => screen.getByTestId("speech-card");
const rows = (): string[] => Array.from(card().children).map((row) => row.textContent ?? "");

const LINES = [
  "Downloading the speech model (one time): 40%, about 3 min left",
  "Then 5 files to transcribe.",
];
const NOTES = [
  { id: "a", text: "The speech engine failed on 1 file." },
  { id: "b", text: "Speech cannot run on this computer." },
];

describe("SpeechCard", () => {
  it("renders nothing for no view", () => {
    const { container } = render(<SpeechCard view={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("speech-card")).toBeNull();
  });

  it("is a status region named speech, so a change of what it says is announced", () => {
    render(<SpeechCard view={view(LINES)} onDismiss={vi.fn()} />);
    const region = screen.getByRole("status", { name: "speech" });
    expect(region).toBe(card());
    expect(region.tagName).toBe("SECTION");
  });

  it("shows every line, then every note, each in a row of its own and with the words it was given", () => {
    render(<SpeechCard view={view(LINES, NOTES)} onDismiss={vi.fn()} />);
    const children = Array.from(card().children);
    expect(children).toHaveLength(LINES.length + NOTES.length);
    expect(rows().slice(0, LINES.length)).toEqual(LINES);
    NOTES.forEach((note, i) => {
      const row = within(children[LINES.length + i] as HTMLElement);
      expect(row.getByText(note.text)).toBeTruthy();
      expect(row.getByRole("button", { name: "dismiss" })).toBeTruthy();
    });
    for (const line of children.slice(0, LINES.length))
      expect(line.querySelector("button")).toBeNull();
  });

  it("tells whoever owns the view which note was dismissed, once, and nothing before it is clicked", () => {
    const onDismiss = vi.fn();
    render(<SpeechCard view={view(LINES, NOTES)} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(NOTES[0].text));
    fireEvent.click(screen.getByText(LINES[0]));
    expect(onDismiss).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: "dismiss" });
    expect(buttons).toHaveLength(NOTES.length);
    fireEvent.click(buttons[1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("b");
    fireEvent.click(buttons[0]);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenLastCalledWith("a");
  });

  it("has no button at all when there are no notes", () => {
    render(<SpeechCard view={view(LINES)} onDismiss={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps no state of its own: a note stays until the view it is given no longer has it", () => {
    const view1 = view(LINES, NOTES);
    const { rerender } = render(<SpeechCard view={view1} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "dismiss" })[0]);
    expect(screen.getByText(NOTES[0].text)).toBeTruthy();
    rerender(<SpeechCard view={view(LINES, [NOTES[1]])} onDismiss={vi.fn()} />);
    expect(screen.queryByText(NOTES[0].text)).toBeNull();
    expect(screen.getByText(NOTES[1].text)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "dismiss" })).toHaveLength(1);
  });

  it("replaces what it shows when the view changes, leaving nothing of the old view behind", () => {
    const { rerender } = render(<SpeechCard view={view(LINES, NOTES)} onDismiss={vi.fn()} />);
    rerender(
      <SpeechCard
        view={view(["Transcribing 3 of 8 files · about 3 minutes"])}
        onDismiss={vi.fn()}
      />,
    );
    expect(rows()).toEqual(["Transcribing 3 of 8 files · about 3 minutes"]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    for (const old of [...LINES, ...NOTES.map((n) => n.text)])
      expect(screen.queryByText(old)).toBeNull();

    rerender(
      <SpeechCard
        view={view(["Transcribing 4 of 8 files · about 2 minutes"])}
        onDismiss={vi.fn()}
      />,
    );
    expect(rows()).toEqual(["Transcribing 4 of 8 files · about 2 minutes"]);
  });

  it("goes when the view goes and comes back with the next one", () => {
    const { rerender } = render(<SpeechCard view={view(LINES)} onDismiss={vi.fn()} />);
    rerender(<SpeechCard view={null} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId("speech-card")).toBeNull();
    rerender(<SpeechCard view={view(["Transcribing 0 of 1 file"])} onDismiss={vi.fn()} />);
    expect(rows()).toEqual(["Transcribing 0 of 1 file"]);
  });

  it("shows every note it is given even when two share an id, and keeps them right as they change", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <SpeechCard
        view={view(
          [],
          [
            { id: "x", text: "first" },
            { id: "x", text: "second" },
          ],
        )}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    rerender(
      <SpeechCard
        view={view(
          [],
          [
            { id: "x", text: "first" },
            { id: "x", text: "third" },
          ],
        )}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.queryByText("second")).toBeNull();
    expect(screen.getByText("third")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "dismiss" })).toHaveLength(2);
  });

  it("shows lines that repeat, one row each", () => {
    const { rerender } = render(<SpeechCard view={view(["same", "same"])} onDismiss={vi.fn()} />);
    expect(screen.getAllByText("same")).toHaveLength(2);
    rerender(<SpeechCard view={view(["same"])} onDismiss={vi.fn()} />);
    expect(screen.getAllByText("same")).toHaveLength(1);
  });

  it("shows a line as the text it is, never as markup", () => {
    render(
      <SpeechCard
        view={view(["<b>bold</b>"], [{ id: "a", text: "<i>x</i>" }])}
        onDismiss={vi.fn()}
      />,
    );
    expect(card().querySelector("b, i")).toBeNull();
    expect(rows()[0]).toBe("<b>bold</b>");
  });
});
