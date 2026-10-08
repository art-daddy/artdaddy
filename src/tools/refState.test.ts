// The words the model reads about a linked file that is gone (UJ-014). The conformance test walks
// every tool through them; these pin what the words must and must not say.
import { describe, expect, it } from "vitest";

import { isExpected } from "../lib/errors";
import { MediaOfflineError, offlineRefMessage } from "./refState";
import { transcriptionFailureText } from "./transcribe";

const GONE = { id: "media_gone", path: "D:/Downloads/iCloud Fotos/New Jeans.mp3" };

describe("offlineRefMessage", () => {
  it("names the file as the library knows it, says what to do, and keeps the ref", () => {
    const msg = offlineRefMessage({ ...GONE, filename: "Interview take 3.mp3" });
    expect(msg).toMatch(/^'Interview take 3\.mp3' is offline/);
    expect(msg).toContain("Relink\u2026");
    expect(msg).toContain("'media_gone' is correct");
  });

  // An import by path records no filename on older rows: the name comes from the file, and the
  // user's own folder layout never reaches the model.
  it("without a filename, names the file by its path's last part, never its folders", () => {
    for (const path of [GONE.path, "D:\\Downloads\\iCloud Fotos\\New Jeans.mp3"]) {
      const msg = offlineRefMessage({ id: "media_gone", path });
      expect(msg).toMatch(/^'New Jeans\.mp3' is offline/);
      expect(msg).not.toMatch(/iCloud Fotos|Downloads/);
    }
    expect(offlineRefMessage({ id: "media_gone", path: "" })).toMatch(/^'media_gone' is offline/);
  });
});

describe("MediaOfflineError", () => {
  // The user's to fix, so it is a handled outcome: never reported as a crash.
  it("is expected, and carries the same words", () => {
    const e = new MediaOfflineError(GONE);
    expect(isExpected(e)).toBe(true);
    expect(e.message).toBe(offlineRefMessage(GONE));
  });
});

describe("transcriptionFailureText", () => {
  it("keeps our own error whole, however long, since it leads with what happened", () => {
    const e = new MediaOfflineError({ ...GONE, filename: `${"long name ".repeat(30)}.mp3` });
    expect(e.message.length).toBeGreaterThan(300);
    expect(transcriptionFailureText(e)).toBe(e.message);
  });

  // A subprocess puts its reason last: the head of its output is noise.
  it("keeps the TAIL of anything else", () => {
    const text = `${"progress ".repeat(60)}exit code 0xC0000135`;
    const out = transcriptionFailureText(new Error(text));
    expect(out).toHaveLength(200);
    expect(out.endsWith("exit code 0xC0000135")).toBe(true);
    expect(transcriptionFailureText("short")).toBe("short");
  });
});
