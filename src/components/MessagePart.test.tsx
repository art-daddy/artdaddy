import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MessagePart from "./MessagePart";

describe("MessagePart", () => {
  it("reasoning is collapsed until toggled", () => {
    render(<MessagePart part={{ kind: "reasoning", text: "secret" }} />);
    expect(screen.queryByText("secret")).toBeNull();
    fireEvent.click(screen.getByText(/reasoning/));
    expect(screen.getByText("secret")).toBeInTheDocument();
  });

  it("renders assistant text", () => {
    render(<MessagePart part={{ kind: "text", text: "hello" }} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders nothing for empty text", () => {
    const { container } = render(<MessagePart part={{ kind: "text", text: "" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a tool part — ChatView folds those into a ToolCalls row", () => {
    // The transcript no longer shows tool names or argument JSON inline; buildRows pairs a
    // call with its result and ToolCalls renders one sentence, with the payload behind a
    // chevron. Rendering here too would put both on screen.
    for (const part of [
      { kind: "tool_call", name: "get_timeline", args: { a: 1 } },
      { kind: "tool_call", name: "totally_unknown", arguments: { z: 9 } },
      { kind: "tool_result", name: "t", ok: true, result: {} },
      { kind: "tool_result", name: "t", ok: false, result: { error: "bad" } },
    ]) {
      const { container, unmount } = render(<MessagePart part={part} />);
      expect(container.firstChild, `${part.kind} ${part.name} still renders inline`).toBeNull();
      unmount();
    }
  });

  it("renders an error part", () => {
    render(<MessagePart part={{ kind: "error", error: "kaboom" }} />);
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  });

  it("renders nothing for an unknown kind", () => {
    const { container } = render(<MessagePart part={{ kind: "weird" }} />);
    expect(container.firstChild).toBeNull();
  });
});
