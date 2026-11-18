// The Export dialog's Quality / Fast row (design D2), driven the way a person drives it (the pointer, Tab, the arrow keys, the dialog's Escape question) and read the way a screen reader reads it
// (role and accessible name, accessible description). The expected words are written out here, never read from the words file. No store and no dialog: the row only reports a pick and
// answers whether its tooltip was open.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Choice } from "../timeline/exportChoiceView";
import ChoiceRow from "./ChoiceRow";

interface Props {
  choice: Choice;
  figure: number | null;
}

/** The row between two buttons (the rest of a dialog's tab order), with a recording onPick and the ref the dialog's Escape reads. */
function mount(start: Partial<Props> = {}) {
  const onPick = vi.fn<(choice: Choice) => void>();
  const closeTip: MutableRefObject<(() => boolean) | null> = { current: null };
  let now: Props = { choice: "quality", figure: null, ...start };
  const draw = () => (
    <>
      <button type="button">before</button>
      <ChoiceRow choice={now.choice} figure={now.figure} onPick={onPick} closeTip={closeTip} />
      <button type="button">after</button>
    </>
  );
  const view = render(draw());
  return {
    onPick,
    closeTip,
    user: userEvent.setup(),
    unmount: view.unmount,
    update(next: Partial<Props>) {
      now = { ...now, ...next };
      view.rerender(draw());
    },
  };
}

/** The row as the view uses it: a pick changes the choice, which the checked radio then follows. */
function Live({ start, spy }: { start: Choice; spy: (choice: Choice) => void }) {
  const [choice, setChoice] = useState<Choice>(start);
  const closeTip = useRef<(() => boolean) | null>(null);
  return (
    <>
      <button type="button">before</button>
      <ChoiceRow
        choice={choice}
        figure={4}
        onPick={(picked) => {
          spy(picked);
          setChoice(picked);
        }}
        closeTip={closeTip}
      />
      <button type="button">after</button>
    </>
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const button = (name: string) => screen.getByRole("button", { name });
const tipElement = () => screen.getByTestId("export-fast-tip");
const figureText = () => screen.getByText("(4x)");
/** What a person (or a screen reader) can reach: a tooltip with the hidden attribute is not found. */
const tooltipShown = () => screen.queryByRole("tooltip") !== null;

/** What the dialog's Escape handler does: ask the row, inside act because an answer of true redraws it. */
function ask(closeTip: MutableRefObject<(() => boolean) | null>): boolean | undefined {
  let answer: boolean | undefined;
  act(() => {
    answer = closeTip.current?.();
  });
  return answer;
}

describe("ChoiceRow without a figure", () => {
  it("is the two plain words: no figure, no tooltip, no description, nothing about speed", () => {
    mount({ figure: null });
    expect(radio("Quality")).toBeInTheDocument();
    const fast = radio("Fast");
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(screen.queryByTestId("export-fast-tip")).toBeNull();
    expect(fast).not.toHaveAttribute("aria-describedby");
    expect(fast).toHaveAccessibleDescription("");
    expect(screen.getByTestId("export-choice").textContent).toBe("QualityFast");
    expect(document.body.innerHTML).not.toMatch(/faster|speed-up/i);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "a figure of %s cannot be written, so it stays the plain word",
    (figure) => {
      mount({ figure });
      expect(radio("Fast")).not.toHaveAttribute("aria-describedby");
      expect(screen.queryByTestId("export-fast-tip")).toBeNull();
      expect(screen.getByTestId("export-choice").textContent).toBe("QualityFast");
    },
  );

  it("has nothing to close, so Escape is left for the dialog even with the pointer over Fast", async () => {
    const { user, closeTip } = mount({ figure: null });
    await user.hover(radio("Fast"));
    expect(ask(closeTip)).toBe(false);
  });
});

describe("ChoiceRow with a figure", () => {
  it.each([
    {
      figure: 4,
      name: "Fast (4x)",
      described: "About 4 times faster. Typical speed-up; your PC may differ.",
    },
    {
      figure: 2.5,
      name: "Fast (2.5x)",
      described: "About 2.5 times faster. Typical speed-up; your PC may differ.",
    },
    {
      figure: 4.04,
      name: "Fast (4x)",
      described: "About 4 times faster. Typical speed-up; your PC may differ.",
    },
    {
      figure: 10,
      name: "Fast (10x)",
      described: "About 10 times faster. Typical speed-up; your PC may differ.",
    },
  ])(
    "a figure of $figure: the Fast radio is named $name and described to a screen reader",
    ({ figure, name, described }) => {
      mount({ figure });
      const fast = radio(name);
      expect(fast).toHaveAccessibleDescription(described);
      expect(fast.closest("label")?.textContent).toBe(name);
      expect(radio("Quality")).toHaveAccessibleDescription("");
      expect(radio("Quality")).not.toHaveAttribute("aria-describedby");
    },
  );
});

describe("ChoiceRow tooltip", () => {
  it("is in the page from the start but hidden, and says what the owner wrote", () => {
    mount({ figure: 4 });
    const tip = tipElement();
    expect(tip).toHaveAttribute("hidden");
    expect(tip).not.toBeVisible();
    expect(tooltipShown()).toBe(false);
    expect(screen.getByRole("tooltip", { hidden: true })).toBe(tip);
    expect(tip.textContent).toBe("Typical speed-up; your PC may differ.");
  });

  it("opens when the pointer is over the figure and closes when it leaves, never taking focus", async () => {
    const { user } = mount({ figure: 4 });
    await user.tab();
    expect(button("before")).toHaveFocus();
    await user.hover(figureText());
    expect(tooltipShown()).toBe(true);
    expect(tipElement()).toBeVisible();
    expect(tipElement()).not.toHaveAttribute("hidden");
    expect(button("before")).toHaveFocus();
    await user.unhover(figureText());
    expect(tooltipShown()).toBe(false);
    expect(tipElement()).toHaveAttribute("hidden");
    expect(button("before")).toHaveFocus();
  });

  it("opens for the pointer anywhere on the Fast card, and not for the Quality card", async () => {
    const { user } = mount({ figure: 4 });
    await user.hover(radio("Quality"));
    expect(tooltipShown()).toBe(false);
    await user.hover(radio("Fast (4x)"));
    expect(tooltipShown()).toBe(true);
    await user.hover(radio("Quality"));
    expect(tooltipShown()).toBe(false);
  });

  it("stays open while the pointer travels from the figure onto the tooltip, and closes when it leaves the tooltip", async () => {
    const { user } = mount({ figure: 4 });
    await user.hover(figureText());
    const tip = tipElement();
    // The pointer goes straight from the figure onto the tooltip: only leaving the whole Fast area may close it.
    fireEvent.mouseOut(figureText(), { relatedTarget: tip });
    fireEvent.mouseOver(tip, { relatedTarget: figureText() });
    expect(tooltipShown()).toBe(true);
    fireEvent.mouseOut(tip, { relatedTarget: document.body });
    expect(tooltipShown()).toBe(false);
  });

  it("is not part of the Fast label: a click on the tooltip picks nothing", async () => {
    const { user, onPick } = mount({ figure: 4 });
    await user.hover(figureText());
    await user.click(tipElement());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("opens on keyboard focus of the Fast radio and closes when focus leaves, but not for the Quality radio", async () => {
    const quality = mount({ choice: "quality", figure: 4 });
    await quality.user.tab();
    await quality.user.tab();
    expect(radio("Quality")).toHaveFocus();
    expect(tooltipShown()).toBe(false);
    quality.unmount();

    const { user } = mount({ choice: "fast", figure: 4 });
    await user.tab();
    expect(tooltipShown()).toBe(false);
    await user.tab();
    expect(radio("Fast (4x)")).toHaveFocus();
    expect(tooltipShown()).toBe(true);
    await user.tab();
    expect(button("after")).toHaveFocus();
    expect(tooltipShown()).toBe(false);
  });

  it("closes when the pointer leaves even though the radio keeps focus, and opens again on the next focus", async () => {
    const { user } = mount({ choice: "fast", figure: 4 });
    await user.tab();
    await user.tab();
    expect(tooltipShown()).toBe(true);
    await user.hover(figureText());
    expect(tooltipShown()).toBe(true);
    await user.unhover(figureText());
    expect(radio("Fast (4x)")).toHaveFocus();
    expect(tooltipShown()).toBe(false);
    await user.tab();
    await user.tab({ shift: true });
    expect(radio("Fast (4x)")).toHaveFocus();
    expect(tooltipShown()).toBe(true);
  });

  it("is closed by the dialog's Escape question, which is answered true only when it was open", async () => {
    const { user, closeTip } = mount({ choice: "fast", figure: 4 });
    expect(ask(closeTip)).toBe(false);
    await user.tab();
    await user.tab();
    expect(tooltipShown()).toBe(true);
    expect(ask(closeTip)).toBe(true);
    expect(tooltipShown()).toBe(false);
    expect(radio("Fast (4x)")).toHaveFocus();
    expect(ask(closeTip)).toBe(false);
  });

  it("answers true to one Escape only, even when asked twice before it redraws", async () => {
    const { user, closeTip } = mount({ figure: 4 });
    await user.hover(figureText());
    let answers: (boolean | undefined)[] = [];
    act(() => {
      answers = [closeTip.current?.(), closeTip.current?.()];
    });
    expect(answers).toEqual([true, false]);
    expect(tooltipShown()).toBe(false);
  });

  it("is dismissed, not disabled: the pointer leaving and coming back opens it again", async () => {
    const { user, closeTip } = mount({ figure: 4 });
    await user.hover(figureText());
    expect(ask(closeTip)).toBe(true);
    expect(tooltipShown()).toBe(false);
    await user.unhover(figureText());
    await user.hover(figureText());
    expect(tooltipShown()).toBe(true);
  });

  it("is handed to the dialog while the row is mounted and taken back when it unmounts", () => {
    const { closeTip, unmount } = mount({ figure: 4 });
    expect(closeTip.current).toBeTypeOf("function");
    unmount();
    expect(closeTip.current).toBeNull();
  });
});

describe("ChoiceRow picks", () => {
  it("reports a click on the Fast radio as fast, and never as quality", async () => {
    const { user, onPick } = mount({ choice: "quality", figure: 4 });
    await user.click(radio("Fast (4x)"));
    expect(onPick).toHaveBeenCalledWith("fast");
    expect(onPick).not.toHaveBeenCalledWith("quality");
  });

  it("reports a click on a card's word, or on the figure, as that card's choice", async () => {
    const { user, onPick } = mount({ choice: "quality", figure: 4 });
    await user.click(screen.getByText("Fast"));
    expect(onPick).toHaveBeenLastCalledWith("fast");
    onPick.mockClear();
    await user.click(figureText());
    expect(onPick).toHaveBeenLastCalledWith("fast");
    onPick.mockClear();
    await user.click(screen.getByText("Quality"));
    expect(onPick).toHaveBeenLastCalledWith("quality");
  });

  it.each([
    { choice: "quality", name: "Quality" },
    { choice: "fast", name: "Fast (4x)" },
  ] as const)(
    "still reports a click on the radio that is already checked ($choice), so a re-pick can reset the view",
    async ({ choice, name }) => {
      const { user, onPick } = mount({ choice, figure: 4 });
      await user.click(radio(name));
      expect(onPick).toHaveBeenCalledWith(choice);
    },
  );

  it("moves the pick with the arrow keys, and the checked radio follows the pick", async () => {
    const spy = vi.fn<(choice: Choice) => void>();
    render(<Live start="quality" spy={spy} />);
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(radio("Quality")).toHaveFocus();
    expect(radio("Quality")).toBeChecked();
    await user.keyboard("{ArrowRight}");
    expect(spy).toHaveBeenLastCalledWith("fast");
    expect(radio("Fast (4x)")).toBeChecked();
    expect(radio("Quality")).not.toBeChecked();
    expect(radio("Fast (4x)")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(spy).toHaveBeenLastCalledWith("quality");
    expect(radio("Quality")).toBeChecked();
    expect(radio("Fast (4x)")).not.toBeChecked();
    expect(radio("Quality")).toHaveFocus();
  });

  it("shows the radio the choice prop names as checked, and follows the prop", () => {
    const { update } = mount({ choice: "quality", figure: 4 });
    expect(radio("Quality")).toBeChecked();
    expect(radio("Fast (4x)")).not.toBeChecked();
    update({ choice: "fast" });
    expect(radio("Quality")).not.toBeChecked();
    expect(radio("Fast (4x)")).toBeChecked();
    update({ choice: "quality" });
    expect(radio("Quality")).toBeChecked();
    expect(radio("Fast (4x)")).not.toBeChecked();
  });

  it("is one radiogroup named export choice, and its two radios share one name", () => {
    mount({ figure: 4 });
    const group = screen.getByRole("radiogroup", { name: "export choice" });
    expect(group).toBe(screen.getByTestId("export-choice"));
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(radio("Quality")).toHaveAttribute("name", "export-choice");
    expect(radio("Fast (4x)")).toHaveAttribute("name", "export-choice");
  });

  it.each([
    { choice: "quality", name: "Quality" },
    { choice: "fast", name: "Fast (4x)" },
  ] as const)(
    "is one tab stop, on the checked radio ($choice), in both directions",
    async ({ name, choice }) => {
      const { user } = mount({ choice, figure: 4 });
      await user.tab();
      expect(button("before")).toHaveFocus();
      await user.tab();
      expect(radio(name)).toHaveFocus();
      await user.tab();
      expect(button("after")).toHaveFocus();
      await user.tab({ shift: true });
      expect(radio(name)).toHaveFocus();
      await user.tab({ shift: true });
      expect(button("before")).toHaveFocus();
    },
  );
});

describe("ChoiceRow when the figure changes", () => {
  it("drops the tooltip and the description when the figure goes, and adds them, hidden, when it comes", () => {
    const { update } = mount({ figure: 4 });
    expect(radio("Fast (4x)")).toHaveAccessibleDescription(
      "About 4 times faster. Typical speed-up; your PC may differ.",
    );
    update({ figure: null });
    expect(radio("Fast")).toHaveAccessibleDescription("");
    expect(radio("Fast")).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(screen.queryByTestId("export-fast-tip")).toBeNull();
    update({ figure: 2.5 });
    expect(radio("Fast (2.5x)")).toHaveAccessibleDescription(
      "About 2.5 times faster. Typical speed-up; your PC may differ.",
    );
    expect(tipElement()).toHaveAttribute("hidden");
    expect(tooltipShown()).toBe(false);
  });

  it("leaves nothing open when the figure goes while the tooltip is open, and nothing to close", async () => {
    const { user, closeTip, update } = mount({ figure: 4 });
    await user.hover(figureText());
    expect(tooltipShown()).toBe(true);
    update({ figure: null });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(screen.queryByTestId("export-fast-tip")).toBeNull();
    expect(ask(closeTip)).toBe(false);
  });
});
