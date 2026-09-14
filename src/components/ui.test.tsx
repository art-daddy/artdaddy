import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, Empty, Spinner, cn } from "./ui";

describe("ui atoms", () => {
  it("cn joins only truthy classes", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("Button fires onClick", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("Button honours disabled", () => {
    render(<Button disabled>X</Button>);
    expect(screen.getByRole("button", { name: "X" })).toBeDisabled();
  });

  it("Spinner and Empty render", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("span")).toBeTruthy();
    render(<Empty>nothing here</Empty>);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});
