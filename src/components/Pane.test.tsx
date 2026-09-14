// The two shared containers. `Pane` is the top-level chrome; `PaneSection` is the collapsible
// group inside one (panel groups in other NLEs).
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Pane, PaneSection } from "./Pane";

beforeEach(() => localStorage.clear());

describe("Pane", () => {
  it("titles the region and shows its body", () => {
    render(<Pane title="Inspector">body</Pane>);
    expect(screen.getByRole("region", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("offers a hide button only when the pane is allowed to be hidden", () => {
    const onHide = vi.fn();
    const { rerender } = render(<Pane title="Inspector">b</Pane>);
    expect(screen.queryByLabelText("hide Inspector")).not.toBeInTheDocument();
    rerender(
      <Pane title="Inspector" onHide={onHide}>
        b
      </Pane>,
    );
    fireEvent.click(screen.getByLabelText("hide Inspector"));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe("PaneSection", () => {
  it("hides its content when collapsed and brings it back", () => {
    render(
      <PaneSection title="Transform" id="t">
        <span>fields</span>
      </PaneSection>,
    );
    expect(screen.getByText("fields")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(screen.queryByText("fields")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(screen.getByText("fields")).toBeInTheDocument();
  });

  it("remembers the collapsed state per id across a remount", () => {
    const { unmount } = render(
      <PaneSection title="Transform" id="t">
        <span>fields</span>
      </PaneSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    unmount();
    render(
      <PaneSection title="Transform" id="t">
        <span>fields</span>
      </PaneSection>,
    );
    expect(screen.queryByText("fields")).not.toBeInTheDocument();
  });

  it("keeps two sections independent, so collapsing one does not close the other", () => {
    render(
      <>
        <PaneSection title="A" id="a">
          <span>a-body</span>
        </PaneSection>
        <PaneSection title="B" id="b">
          <span>b-body</span>
        </PaneSection>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(screen.queryByText("a-body")).not.toBeInTheDocument();
    expect(screen.getByText("b-body")).toBeInTheDocument();
  });

  it("stays open when it has no id to remember by", () => {
    const { unmount } = render(
      <PaneSection title="Transform">
        <span>fields</span>
      </PaneSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    unmount();
    render(
      <PaneSection title="Transform">
        <span>fields</span>
      </PaneSection>,
    );
    expect(screen.getByText("fields")).toBeInTheDocument();
  });
});
