import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import CompatibilityGate from "./CompatibilityGate";
import { useCompatibility } from "../update/compatibility";
import { useAuth } from "../store/auth";

vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

beforeEach(() => {
  useAuth.setState({ status: "offline" });
  useCompatibility.setState({
    status: "checking",
    error: null,
    check: vi.fn(async () => undefined),
  });
});

it.each(["checking", "unverified", "required"] as const)(
  "does not mount editing controls while %s",
  (status) => {
    const mount = vi.fn();
    function EditorProbe() {
      mount();
      return <button>Destructive edit</button>;
    }
    useCompatibility.setState({ status });
    render(
      <CompatibilityGate>
        <EditorProbe />
      </CompatibilityGate>,
    );
    expect(mount).not.toHaveBeenCalled();
    expect(screen.queryByText("Destructive edit")).not.toBeInTheDocument();
  },
);

it("permits a previously verified build and immediately blocks it when an update becomes required", () => {
  const edit = vi.fn();
  const dispose = vi.fn();
  function EditorProbe() {
    useEffect(() => {
      window.addEventListener("keydown", edit);
      return () => {
        window.removeEventListener("keydown", edit);
        dispose();
      };
    }, []);
    return <button onClick={edit}>Editing surface</button>;
  }
  useCompatibility.setState({ status: "allowed" });
  render(
    <CompatibilityGate>
      <EditorProbe />
    </CompatibilityGate>,
  );
  expect(screen.getByText("Editing surface")).toBeVisible();
  fireEvent.click(screen.getByText("Editing surface"));
  expect(edit).toHaveBeenCalledTimes(1);
  act(() => useCompatibility.setState({ status: "required" }));
  expect(screen.getByText("Editing surface")).not.toBeVisible();
  fireEvent.click(screen.getByText("Editing surface"));
  fireEvent.keyDown(window, { key: "Delete" });
  expect(edit).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  expect(screen.getByText("ArtDaddy update required")).toBeInTheDocument();
  act(() => useCompatibility.setState({ status: "allowed" }));
  expect(screen.getByText("Editing surface")).toBeVisible();
  expect(dispose).not.toHaveBeenCalled();
});
