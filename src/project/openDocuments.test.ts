import { afterEach, describe, expect, it } from "vitest";

import { openDocumentByDir, setOpenDocumentResolver } from "./openDocuments";
import { asProjectId } from "./types";
import type { ProjectDocument } from "./ProjectDocument";

afterEach(() => setOpenDocumentResolver(() => undefined)); // reset the injected module global

describe("openDocumentByDir", () => {
  it("returns undefined when no resolver is wired (bare test store / pre-composition)", () => {
    expect(openDocumentByDir("C:/x/projects/proj_a1")).toBeUndefined();
  });

  it("resolves the FINAL path segment as the project id, normalizing separators + trailing slash", () => {
    const seen: string[] = [];
    const doc = {} as ProjectDocument;
    setOpenDocumentResolver((id) => {
      seen.push(id);
      return id === asProjectId("proj_a1") ? doc : undefined;
    });
    expect(openDocumentByDir("C:/Users/x/Akaru/projects/proj_a1")).toBe(doc);
    expect(openDocumentByDir("C:\\Users\\x\\ArtDaddy\\projects\\proj_a1\\")).toBe(doc);
    expect(openDocumentByDir("D:/other/proj_zz")).toBeUndefined(); // a different (unregistered) project
    expect(seen).toContain("proj_a1");
  });

  it("returns undefined for an empty or separator-only dir", () => {
    setOpenDocumentResolver(() => ({}) as ProjectDocument);
    expect(openDocumentByDir("")).toBeUndefined();
    expect(openDocumentByDir("///")).toBeUndefined();
  });
});
