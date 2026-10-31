// The functions the generation tools AND the approval bar's price quote both derive a call's inputs from (genModels.ts).
// holdInputs.test.ts proves the tools and the quote agree; these pin each rule on its own, because a mistake in a shared
// function changes both sides at once and an agreement test cannot see it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AUDIO_BY_ID,
  DEFAULT_TTS_BACKEND,
  DEFAULTS,
  GEN_BY_ID,
  IMAGE_MODELS,
  MUSIC_MODELS,
  TTS_MODELS,
  VIDEO_MODELS,
  imageCount,
  resolveGenModel,
  resolveMusicModel,
  resolveTtsBackend,
  videoReferences,
  videoSeconds,
  voiceoverContents,
} from "./genModels";

// What a model can send: any JSON value.
const json = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.boolean(),
  fc.array(fc.integer(), { maxLength: 3 }),
  fc.constant({}),
);

describe("imageCount", () => {
  it("is a whole number from one to what the model allows, whatever was asked", () => {
    fc.assert(
      fc.property(fc.constantFrom(...IMAGE_MODELS), json, (m, asked) => {
        const n = imageCount(m, asked);
        return Number.isInteger(n) && n >= 1 && n <= (m.max_images ?? 1);
      }),
    );
  });

  it("asks for one image when told nothing, and honours a count that fits", () => {
    const m = IMAGE_MODELS[0];
    expect(imageCount(m, undefined)).toBe(1);
    expect(imageCount(m, null)).toBe(1);
    expect(imageCount(m, 3)).toBe(3);
    expect(imageCount(m, "2")).toBe(2);
    expect(imageCount(m, 2.9)).toBe(2);
    expect(imageCount(m, "many")).toBe(1);
  });

  it("never gives less than one, or more than the model allows", () => {
    const m = IMAGE_MODELS[0];
    expect(m.max_images).toBeGreaterThan(1);
    for (const asked of [0, -1, -3, -1e9]) expect(imageCount(m, asked)).toBe(1);
    for (const asked of [m.max_images! + 1, 99, 1e9])
      expect(imageCount(m, asked)).toBe(m.max_images);
  });

  it("allows one image from a model that does not say how many it can make", () => {
    expect(imageCount({ ...IMAGE_MODELS[0], max_images: undefined }, 4)).toBe(1);
  });
});

describe("videoSeconds", () => {
  it("is 8 in reference-image mode, whatever was asked", () => {
    fc.assert(fc.property(json, (asked) => videoSeconds(asked, true) === 8));
  });

  it("is 8 when told nothing or something unusable, and otherwise the whole seconds asked", () => {
    for (const asked of [undefined, null, 0, "soon", "", NaN])
      expect(videoSeconds(asked, false), String(asked)).toBe(8);
    expect(videoSeconds(4, false)).toBe(4);
    expect(videoSeconds(6, false)).toBe(6);
    expect(videoSeconds("5", false)).toBe(5);
    expect(videoSeconds(5.7, false)).toBe(5);
  });
});

describe("videoReferences", () => {
  it("is the named references with the blank ones dropped, in order", () => {
    expect(videoReferences(["a.png", "", "  ", "b.png"])).toEqual(["a.png", "b.png"]);
    expect(videoReferences([])).toEqual([]);
  });

  it("is empty when what was sent is not a list", () => {
    for (const raw of [undefined, null, "a.png", 7, {}])
      expect(videoReferences(raw), String(raw)).toEqual([]);
  });
});

describe("resolveGenModel", () => {
  it("finds a model of the kind asked for, ignoring surrounding space", () => {
    for (const m of IMAGE_MODELS)
      expect(resolveGenModel(`  ${m.id} `, "image", DEFAULTS.image)).toBe(m);
    for (const m of VIDEO_MODELS) expect(resolveGenModel(m.id, "video", DEFAULTS.video)).toBe(m);
  });

  it("falls back to the default only for an empty id; an id of only spaces names nothing", () => {
    expect(resolveGenModel("", "image", DEFAULTS.image)).toBe(GEN_BY_ID[DEFAULTS.image]);
    expect(resolveGenModel("", "video", DEFAULTS.video)).toBe(GEN_BY_ID[DEFAULTS.video]);
    expect(resolveGenModel("  ", "video", DEFAULTS.video)).toBeNull();
  });

  it("refuses a model of the other kind and one that does not exist", () => {
    expect(resolveGenModel(VIDEO_MODELS[0].id, "image", DEFAULTS.image)).toBeNull();
    expect(resolveGenModel(IMAGE_MODELS[0].id, "video", DEFAULTS.video)).toBeNull();
    expect(resolveGenModel("no-such-model", "image", DEFAULTS.image)).toBeNull();
  });
});

describe("resolveTtsBackend", () => {
  it("is the default voice backend when no model is named", () => {
    expect(DEFAULT_TTS_BACKEND).toBe(AUDIO_BY_ID[DEFAULTS.tts].backend_id);
    for (const none of [undefined, null, "", 0])
      expect(resolveTtsBackend(none)).toBe(DEFAULT_TTS_BACKEND);
  });

  it("is the backend of the voice model named, and nothing for any other model", () => {
    for (const m of TTS_MODELS) expect(resolveTtsBackend(` ${m.id} `)).toBe(m.backend_id);
    for (const other of [...IMAGE_MODELS, ...VIDEO_MODELS, ...MUSIC_MODELS])
      expect(resolveTtsBackend(other.id), other.id).toBeNull();
    expect(resolveTtsBackend("no-such-model")).toBeNull();
  });
});

describe("resolveMusicModel", () => {
  it("is the default music model when none is named", () => {
    for (const none of [undefined, null, "", 0])
      expect(resolveMusicModel(none)).toBe(AUDIO_BY_ID[DEFAULTS.music]);
  });

  it("is the music model named, and nothing for any other model", () => {
    for (const m of MUSIC_MODELS) expect(resolveMusicModel(` ${m.id} `)).toBe(m);
    for (const other of [...IMAGE_MODELS, ...VIDEO_MODELS, ...TTS_MODELS])
      expect(resolveMusicModel(other.id), other.id).toBeNull();
    expect(resolveMusicModel("no-such-model")).toBeNull();
  });
});

describe("voiceoverContents", () => {
  it("is the text alone with no style, and the style as a prefix with one", () => {
    expect(voiceoverContents("hi there", "")).toBe("hi there");
    expect(voiceoverContents("hi there", "calm")).toBe("calm: hi there");
  });

  it("does not double a trailing colon on the style", () => {
    expect(voiceoverContents("hi", "calm:")).toBe("calm: hi");
    expect(voiceoverContents("hi", "calm::")).toBe("calm: hi");
    expect(voiceoverContents("hi", "a:b")).toBe("a:b: hi");
  });
});
