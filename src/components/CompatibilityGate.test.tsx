import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import CompatibilityGate from "./CompatibilityGate";
import { useCompatibility } from "../update/compatibility";
import { useAuth } from "../store/auth";
import { __testing as launchClock } from "./waking";

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

// UJ-082, launch screen 2: the build check is a request to the server. While it is out and the app has been up for 3 s, the screen says what is slow;
// it says it of nothing else (not of an update that is required, nor of a check that failed).
it("says the server is waking once the build check has made the person wait 3 s, and carries on from the launch clock", () => {
  vi.useFakeTimers();
  try {
    launchClock.setLaunchedAt(Date.now() - 14_000); // screen 1 already took 14 s: this screen does not start its own 3 s
    render(
      <CompatibilityGate>
        <button>Editing surface</button>
      </CompatibilityGate>,
    );
    expect(screen.getByRole("status").textContent).toBe("Waking the server…");
    expect(screen.getByText("0:14")).toBeInTheDocument();
    expect(screen.getByText(/nothing is wrong/i)).toBeInTheDocument();
    expect(screen.getByText("Checking this build with the service.")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByText("0:17")).toBeInTheDocument();
    act(() => useCompatibility.setState({ status: "allowed" }));
    expect(screen.queryByText(/waking the server/i)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// A check that comes later in a running session (the app was already open once) is its own wait: it counts from its own start, not from a launch hours ago.
it("counts a later re-check from its own start, not from the launch", () => {
  vi.useFakeTimers();
  try {
    launchClock.setLaunchedAt(Date.now() - 2 * 3600_000);
    useCompatibility.setState({ status: "allowed" });
    render(
      <CompatibilityGate>
        <button>Editing surface</button>
      </CompatibilityGate>,
    );
    act(() => useCompatibility.setState({ status: "checking" })); // checked again, hours into the session
    expect(screen.queryByText(/waking the server/i)).not.toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("status").textContent).toBe("Waking the server…");
    expect(screen.getByText("0:03")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("says nothing of it on a warm start, where the check answers within a second or two", () => {
  vi.useFakeTimers();
  try {
    launchClock.setLaunchedAt(Date.now() - 1_500);
    render(
      <CompatibilityGate>
        <button>Editing surface</button>
      </CompatibilityGate>,
    );
    expect(screen.queryByText(/waking the server/i)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["required", "unverified"] as const)(
  "never says the server is waking when the check has already ended as %s",
  (status) => {
    vi.useFakeTimers();
    try {
      launchClock.setLaunchedAt(Date.now() - 60_000);
      useCompatibility.setState({
        status,
        error: status === "unverified" ? "Couldn't verify this build." : null,
      });
      render(
        <CompatibilityGate>
          <button>Editing surface</button>
        </CompatibilityGate>,
      );
      expect(screen.queryByText(/waking the server/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  },
);
