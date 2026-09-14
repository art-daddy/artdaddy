import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VZoom } from "./VZoom";

describe("VZoom", () => {
  it("calls onChange while dragging the thumb", () => {
    const onChange = vi.fn();
    render(<VZoom icon="V" value={1} onChange={onChange} kind="video" />);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider, { clientY: 10 });
    fireEvent(window, new PointerEvent("pointermove", { clientY: 5 }));
    fireEvent(window, new PointerEvent("pointerup"));
    expect(onChange).toHaveBeenCalled();
  });

  it("resets to 1x on double-click", () => {
    const onChange = vi.fn();
    render(<VZoom icon="A" value={2} onChange={onChange} kind="audio" />);
    fireEvent.doubleClick(screen.getByRole("slider"));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("exposes an accessible track-height slider", () => {
    render(<VZoom icon="V" value={1.5} onChange={() => {}} kind="video" />);
    expect(screen.getByRole("slider", { name: "video track height" })).toBeInTheDocument();
  });
});
