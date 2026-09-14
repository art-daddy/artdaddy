// The clip is the ONLY place a user learns their media does not exist yet. Nothing else on the
// timeline distinguishes a placeholder from a clip that renders black, so this label is the
// whole visual contract of async generation — and it had no test at all.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../preview/resolve", () => ({
  resolveSourceUrl: vi.fn(async () => "blob:fake"),
}));

import { ClipThumbnail } from "./ClipThumbnail";
import type { Clip } from "../timeline/model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const store = {
  projectDir: "/p",
  resolveRef: vi.fn(async (r: string) => `/p/library/${r}.png`),
} as Any;

const clip = { id: "c1", media_ref: "media_gen_abc", kind: "image" } as unknown as Clip;

describe("ClipThumbnail while its media is still being made", () => {
  it("says the media is generating", () => {
    render(<ClipThumbnail store={store} clip={clip} kind="image" status="generating" />);
    expect(screen.getByText(/Generating/)).toBeTruthy();
  });

  it("says so when it failed, and does not keep claiming it is on the way", () => {
    render(<ClipThumbnail store={store} clip={clip} kind="image" status="failed" />);
    expect(screen.getByText("Generation failed")).toBeTruthy();
    expect(screen.queryByText(/Generating/)).toBeNull();
  });

  // The label has to CLEAR, or every generated clip wears it forever.
  it("shows the real thumbnail once the media has landed", async () => {
    const { container } = render(
      <ClipThumbnail store={store} clip={clip} kind="image" status={undefined} />,
    );
    expect(screen.queryByText(/Generating/)).toBeNull();
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  });

  // An unknown status must read as READY: guessing "generating" would label ordinary
  // imported media as a placeholder across the whole timeline.
  it("treats an unrecognised status as ready", () => {
    render(<ClipThumbnail store={store} clip={clip} kind="image" status="something-else" />);
    expect(screen.queryByText(/Generating/)).toBeNull();
    expect(screen.queryByText("Generation failed")).toBeNull();
  });
});
