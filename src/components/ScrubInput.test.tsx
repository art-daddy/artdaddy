import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScrubInput } from "./ScrubInput";

const ptr = (type: string, init: MouseEventInit) => fireEvent(window, new MouseEvent(type, init));

describe("ScrubInput", () => {
  it("shows the value formatted with precision + suffix", () => {
    render(<ScrubInput value={1.5} precision={2} suffix="x" onChange={() => {}} aria-label="v" />);
    expect(screen.getByLabelText("v")).toHaveTextContent("1.50x");
  });

  it("scrubs by dragging (dx * step)", () => {
    const onChange = vi.fn();
    render(<ScrubInput value={10} step={2} onChange={onChange} aria-label="v" />);
    fireEvent.pointerDown(screen.getByLabelText("v"), { clientX: 0 });
    ptr("pointermove", { clientX: 5 }); // +5px * 2 = +10 -> 20
    ptr("pointerup", {});
    expect(onChange).toHaveBeenLastCalledWith(20);
  });

  it("commits ONCE per drag, however many moves it takes", () => {
    // TimelineSession.apply pushes an undo entry per call, so a per-move commit buried the
    // pre-drag value under one entry per pixel and made Ctrl+Z useless after a slider drag.
    const onChange = vi.fn();
    render(<ScrubInput value={10} step={2} onChange={onChange} aria-label="v" />);
    const el = screen.getByLabelText("v");
    fireEvent.pointerDown(el, { clientX: 0 });
    for (const x of [3, 7, 11, 15, 20]) ptr("pointermove", { clientX: x });
    expect(onChange).not.toHaveBeenCalled(); // nothing written mid-gesture
    expect(el).toHaveTextContent("50"); // ...but the reading still tracks the pointer
    ptr("pointerup", {});
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
  });

  it("keeps tracking when the PARENT re-renders mid-drag", () => {
    // The reported jank: "the slider moved a little and then stopped". The Inspector passes an
    // inline onChange, so every parent re-render gives this component a new `onChange` -> a new
    // `commit` -> a new `onUp`. The cleanup effect keyed on those identities then removed the
    // window listeners MID-GESTURE and the drag went dead where it stood, with the value stuck
    // at whatever pixel the last surviving move reported.
    const onChange = vi.fn();
    const Harness = ({ tick }: { tick: number }) => (
      <div data-tick={tick}>
        <ScrubInput value={10} step={2} onChange={() => onChange(tick)} aria-label="v" />
      </div>
    );
    const { rerender } = render(<Harness tick={0} />);
    const el = screen.getByLabelText("v");
    fireEvent.pointerDown(el, { clientX: 0 });
    ptr("pointermove", { clientX: 5 });
    rerender(<Harness tick={1} />); // e.g. the playhead moved, or autosave flipped `dirty`
    ptr("pointermove", { clientX: 25 });
    expect(el).toHaveTextContent("60"); // still following the pointer, not frozen at 20
    ptr("pointerup", {});
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1); // ...and it commits through the LATEST handler
  });

  it("writes nothing at all when a press never moves (that is a click, not an edit)", () => {
    const onChange = vi.fn();
    render(<ScrubInput value={10} step={2} onChange={onChange} aria-label="v" />);
    fireEvent.pointerDown(screen.getByLabelText("v"), { clientX: 0 });
    ptr("pointermove", { clientX: 1 }); // under the 2px move threshold
    ptr("pointerup", {});
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps to min/max while scrubbing", () => {
    const onChange = vi.fn();
    render(<ScrubInput value={0} step={1} min={0} max={1} onChange={onChange} aria-label="v" />);
    fireEvent.pointerDown(screen.getByLabelText("v"), { clientX: 0 });
    ptr("pointermove", { clientX: 50 });
    ptr("pointerup", {});
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("clicking (no drag) enters edit mode; typing + Enter commits", () => {
    const onChange = vi.fn();
    render(<ScrubInput value={5} onChange={onChange} aria-label="v" />);
    fireEvent.pointerDown(screen.getByLabelText("v"), { clientX: 0 });
    ptr("pointerup", {}); // no move -> edit
    const input = screen.getByLabelText("v");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(42);
  });
});
