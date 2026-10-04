// Which URLs the network tools may open. The browser sidecar used to load anything Chromium can:
// `get_page_image` with file:///C:/Windows/win.ini returned a screenshot of the file's text
// (measured 2026-10-04), so an agent could read any local text file the user can, as an image.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isWebUrl } from "../../scripts/webUrl.mjs";

describe("isWebUrl: http and https pages only", () => {
  it("accepts web pages", () => {
    for (const u of [
      "https://example.com",
      "http://example.com/a?b=c#d",
      "HTTPS://EXAMPLE.COM/x",
      "https://www.youtube.com/watch?v=abc",
      "  https://example.com/padded  ",
      "https://user:pw@example.com:8443/p",
    ])
      expect(isWebUrl(u), u).toBe(true);
  });

  it("refuses everything that reads local or browser-internal content", () => {
    for (const u of [
      "file:///C:/Windows/win.ini",
      "FILE:///etc/passwd",
      "  file:///C:/Users/u/.ssh/id_rsa",
      "file://localhost/C:/x.txt",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "about:blank",
      "chrome://settings",
      "view-source:https://example.com",
      "blob:https://example.com/uuid",
      "ftp://example.com/x",
      "ws://example.com",
      "C:/Users/u/secret.txt",
      "C:\\Users\\u\\secret.txt",
      "/etc/passwd",
      "\\\\server\\share\\x.txt",
      "//example.com/x",
      "example.com",
      "",
      "http://",
    ])
      expect(isWebUrl(u), u).toBe(false);
  });

  it("refuses non-strings", () => {
    for (const v of [undefined, null, 42, {}, ["https://example.com"]])
      expect(isWebUrl(v as unknown as string)).toBe(false);
  });

  it("never accepts a URL whose scheme is not http or https (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (!isWebUrl(s)) return true;
        const p = new URL(s.trim()).protocol;
        return p === "http:" || p === "https:";
      }),
      { numRuns: 2000 },
    );
  });

  it("never refuses a well-formed http(s) URL (property)", () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ["http", "https"] }), (u) => isWebUrl(u)),
      { numRuns: 2000 },
    );
  });
});
