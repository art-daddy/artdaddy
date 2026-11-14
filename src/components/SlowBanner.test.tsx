// The banner as a view: what it draws for each state the view-model gives, which buttons it has, and what each does. The views are the real view-model's own output (exportHelp), never a hand-built shape.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SlowBanner from "./SlowBanner";
import { exportHelp, type HelpInput, type HelpView } from "../timeline/exportHelp";
import { BANNER_BUTTON_LABELS, KEEP_GOING_NOTE, type BannerButton } from "../timeline/routeWords";

afterEach(cleanup);

const base: HelpInput = {
  elapsedSeconds: 600,
  producedFraction: 0.15,
  renderEtaSeconds: 3360,
  expectedSeconds: 1260,
  expectedBasis: "pc_check",
  quickSeconds: 540,
  quietSeconds: 0,
  verdict: "busy",
  canSwitch: true,
  shown: { slowShown: 0, silencedAtProjection: null, quietShown: false },
  flagOn: true,
};
const view = (over: Partial<HelpInput> = {}): HelpView => exportHelp({ ...base, ...over });
const slowWithQuick = () => view();
const slowWithoutQuick = () => view({ canSwitch: false });
const stopped = () => view({ quietSeconds: 75, verdict: "idle", renderEtaSeconds: null });
const nothing = () => view({ flagOn: false });

const handlers = () => ({ onKeepGoing: vi.fn(), onCancel: vi.fn() });

describe("the slow banner", () => {
  it("draws the headline and the lines of a slow export, and Keep going and Cancel", () => {
    render(<SlowBanner view={slowWithoutQuick()} {...handlers()} />);
    const group = screen.getByRole("group", { name: "slow export" });
    expect(
      within(group).getByText("This PC is slower than expected: about 56 min left"),
    ).toBeVisible();
    expect(within(group).getByText("It was expected to take about 21 min.")).toBeVisible();
    expect(
      within(group).getByText("To go faster, cancel, use fewer layers or clips, and export again."),
    ).toBeVisible();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([BANNER_BUTTON_LABELS.keep_going, BANNER_BUTTON_LABELS.cancel]);
  });

  it("draws the stopped-moving banner for a render that has stopped, under its own name", () => {
    render(<SlowBanner view={stopped()} {...handlers()} />);
    const group = screen.getByRole("group", { name: "export stopped moving" });
    expect(within(group).getByText("This export has stopped moving")).toBeVisible();
    expect(within(group).getByText("No progress for 75 s.")).toBeVisible();
    expect(
      within(group).getByText("ArtDaddy stops it if nothing moves for 3 minutes."),
    ).toBeVisible();
  });

  it("draws nothing for a view with nothing to say, and one quiet line once the person has said keep going", () => {
    const { container } = render(<SlowBanner view={nothing()} {...handlers()} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(<SlowBanner view={nothing()} keptGoing {...handlers()} />);
    expect(screen.getByText(KEEP_GOING_NOTE)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    // and not while a banner is up: the banner is the answer to be given
    cleanup();
    render(<SlowBanner view={slowWithoutQuick()} keptGoing {...handlers()} />);
    expect(screen.queryByText(KEEP_GOING_NOTE)).toBeNull();
  });

  it("calls Keep going and Cancel, each once", () => {
    const h = handlers();
    render(<SlowBanner view={slowWithoutQuick()} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(h.onKeepGoing).toHaveBeenCalledTimes(1);
    expect(h.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("walks every button the view-model can give: each is labelled with the copy pack's own words", () => {
    const labels: Record<BannerButton, string> = {
      switch_to_quick: "Switch to Quick export",
      keep_going: "Keep going",
      cancel: "Cancel",
    };
    expect(BANNER_BUTTON_LABELS).toEqual(labels);
    const given = new Set<BannerButton>([
      ...slowWithQuick().buttons,
      ...slowWithoutQuick().buttons,
      ...stopped().buttons,
    ]);
    expect([...given].sort()).toEqual(Object.keys(labels).sort());
    render(<SlowBanner view={slowWithQuick()} onSwitchToQuick={() => undefined} {...handlers()} />);
    const group = screen.getByRole("group", { name: "slow export" });
    for (const button of slowWithQuick().buttons)
      expect(within(group).getByRole("button", { name: labels[button] })).toBeVisible();
  });

  describe("Switch to Quick: held back until the route side is merged", () => {
    it("is not drawn without a handler, even when the view-model offers it: a button that does nothing is never shown", () => {
      expect(slowWithQuick().buttons).toContain("switch_to_quick");
      render(<SlowBanner view={slowWithQuick()} {...handlers()} />);
      expect(screen.queryByRole("button", { name: /quick/i })).toBeNull();
      expect(screen.getByRole("button", { name: "Keep going" })).toBeVisible();
    });

    it("is the first button, and calls its handler, when the card was given one and the view-model offers it", () => {
      const onSwitchToQuick = vi.fn();
      render(
        <SlowBanner view={slowWithQuick()} onSwitchToQuick={onSwitchToQuick} {...handlers()} />,
      );
      const group = screen.getByRole("group", { name: "slow export" });
      expect(
        within(group)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["Switch to Quick export", "Keep going", "Cancel"]);
      fireEvent.click(within(group).getByRole("button", { name: "Switch to Quick export" }));
      expect(onSwitchToQuick).toHaveBeenCalledTimes(1);
    });

    it("is not drawn when the view-model does not offer it, whatever handler there is", () => {
      render(<SlowBanner view={slowWithoutQuick()} onSwitchToQuick={vi.fn()} {...handlers()} />);
      expect(screen.queryByRole("button", { name: /quick/i })).toBeNull();
    });
  });

  describe("a click that comes too late (the export ended as it was pressed)", () => {
    it("says why in a line of its own, in place of the buttons, and nothing else changes", () => {
      const onKeepGoing = vi.fn(() => ({
        ok: false as const,
        line: "This export has already ended.",
      }));
      const h = { ...handlers(), onKeepGoing };
      render(<SlowBanner view={slowWithoutQuick()} {...h} />);
      fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      expect(screen.getByText("This export has already ended.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Keep going" })).toBeNull();
      expect(h.onCancel).not.toHaveBeenCalled();
    });

    it("says nothing extra when the click was taken", () => {
      const onKeepGoing = vi.fn(() => ({ ok: true as const }));
      render(<SlowBanner view={slowWithoutQuick()} {...handlers()} onKeepGoing={onKeepGoing} />);
      fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      expect(onKeepGoing).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/already/)).toBeNull();
    });

    it("is not stopped by a handler that throws: the banner stays and nothing is thrown at the person", () => {
      const onKeepGoing = vi.fn(() => {
        throw new Error("the queue fell over");
      });
      render(<SlowBanner view={slowWithoutQuick()} {...handlers()} onKeepGoing={onKeepGoing} />);
      expect(() =>
        fireEvent.click(screen.getByRole("button", { name: "Keep going" })),
      ).not.toThrow();
      expect(screen.getByRole("group", { name: "slow export" })).toBeVisible();
    });
  });
});
