// Guard for a bug the unit suite structurally CANNOT see (caught 2026-08-07 by driving the
// real app): StageOverlay used to be a sibling of PreviewCanvas inside the stage's padded
// box, so it measured 425x377 while the canvas letterboxed itself into 203x361 — handles
// sat ~9px off the picture. happy-dom gives every element a 0x0 box, so no amount of
// rendering catches that; what CAN be asserted is the structural precondition that makes
// the geometry line up.
//
// The invariant: the overlay shares the canvas's containing block, and that block has no
// padding of its own. Residual: this proves the containing block, NOT the pixels — only a
// real browser can do that.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../store/editor", () => ({
  useEditor: (sel: (s: unknown) => unknown) => sel({ store: null }),
}));
vi.mock("../preview/previewClient", () => ({
  createPreviewClient: () => ({
    render: vi.fn(),
    setStore: vi.fn(),
    capture: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import PreviewCanvas from "./PreviewCanvas";

const timeline = { canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [] };

describe("PreviewCanvas overlay slot", () => {
  it("puts overlay children in the SAME box the canvas letterboxes into", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(
      <PreviewCanvas timeline={timeline as any}>
        <div data-testid="overlay" />
      </PreviewCanvas>,
    );
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(screen.getByTestId("overlay").parentElement).toBe(canvas!.parentElement);
  });

  it("that box carries NO padding — padding is what shrank the canvas away from the overlay", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(<PreviewCanvas timeline={timeline as any} />);
    const box = container.querySelector("canvas")!.parentElement!;
    expect(box.className).not.toMatch(/(^|\s)-?p[trblxy]?-\d/);
    // ...and it must establish a containing block, or an absolutely-positioned overlay
    // would resolve against some ancestor instead.
    expect(box.className).toMatch(/\brelative\b/);
  });

  it("sizes that box by ZOOM, so overlay geometry follows the magnified picture", () => {
    // The overlay derives everything from this box. If zoom scaled the canvas without
    // scaling the box, handles would sit on the picture's old size — the same class of
    // drift that put them 9px off before.
    const at = (zoom: number | "fit"): HTMLElement => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { container } = render(<PreviewCanvas timeline={timeline as any} zoom={zoom} />);
      return container.querySelector("canvas")!.parentElement!;
    };
    expect(at(1).style.width).toBe("1080px");
    expect(at(1).style.height).toBe("1920px");
    expect(at(0.5).style.width).toBe("540px");
    expect(at(2).style.height).toBe("3840px");
  });

  it("scrolls rather than clips once the picture is bigger than the viewport", () => {
    // Premiere shows scrollbars past Fit. overflow-hidden here would make a zoomed-in
    // frame unreachable, which is the bug the zoom exists to solve.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { container } = render(<PreviewCanvas timeline={timeline as any} zoom={4} />);
    const viewport = container.querySelector("canvas")!.parentElement!.parentElement!;
    expect(viewport.className).toMatch(/overflow-auto/);
    expect(viewport.className).not.toMatch(/overflow-hidden/);
  });
});
