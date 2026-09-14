// A poster is generated in the BACKGROUND, after the clip or library tile is already on
// screen. In a real project the gap was 16s for one asset and 2m32s for another, and the
// thumbnail resolved once at mount, found nothing, and kept its placeholder for the rest of
// the session with a perfectly good poster sitting on disk beside it.
//
// Its own file: ClipThumbnail.test.tsx mocks resolveSourceUrl to a fixed "blob:fake" that its
// other cases depend on, and `restoreMocks` is on, so re-programming that mock mid-suite
// risks deciding those tests by ordering.
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../preview/resolve", () => ({
  resolveSourceUrl: vi.fn(async () => null),
}));

import { announceMediaDerived } from "../preview/mediaDerived";
import { resolveSourceUrl } from "../preview/resolve";
import type { Clip } from "../timeline/model";
import { ClipThumbnail } from "./ClipThumbnail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const store = {
  projectDir: "/p",
  resolveRef: vi.fn(async (r: string) => `/p/library/${r}.mp4`),
} as Any;

const clip = { id: "c1", media_ref: "media_gen_abc", kind: "video" } as unknown as Clip;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ClipThumbnail when the poster lands after it mounted", () => {
  it("looks again when derived media is announced — and not before", async () => {
    const resolve = vi.mocked(resolveSourceUrl);
    resolve.mockResolvedValue(null); // nothing generated yet

    const { container } = render(<ClipThumbnail store={store} clip={clip} kind="video" />);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();

    // The poster now exists on disk. Nothing on screen knows that yet, and this is the half
    // that was broken: re-rendering or refetching the library does not make it look again.
    resolve.mockResolvedValue("blob:poster");
    await flush();
    expect(container.querySelector("img")).toBeNull();

    announceMediaDerived("library/media_gen_abc.mp4");
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  });

  it("stops listening once it has something to show", async () => {
    const resolve = vi.mocked(resolveSourceUrl);
    resolve.mockResolvedValue("blob:poster");

    const { container } = render(<ClipThumbnail store={store} clip={clip} kind="video" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const calls = resolve.mock.calls.length;

    // Every other asset in the project finishing must not re-run the lookup on a thumbnail
    // that is already resolved — a library of generated clips would otherwise re-resolve
    // every tile N times over.
    announceMediaDerived("library/something_else.mp4");
    announceMediaDerived("library/another.mp4");
    await flush();
    expect(resolve.mock.calls.length).toBe(calls);
  });
});
