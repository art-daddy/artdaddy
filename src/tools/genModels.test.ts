import { describe, expect, it } from "vitest";

import {
  AUDIO_BY_ID,
  AUDIO_MODELS,
  audioModelsInfo,
  DEFAULT_VOICE,
  DEFAULTS,
  GEN_BY_ID,
  IMAGE_IDS,
  IMAGE_MODELS,
  modelInfo,
  MUSIC_IDS,
  MUSIC_MODELS,
  TTS_IDS,
  TTS_LANGUAGES,
  TTS_MODELS,
  TTS_VOICES,
  VIDEO_IDS,
  VIDEO_MODELS,
} from "./genModels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── catalog wiring ──────────────────────────────────────────────────────────
describe("catalog constants", () => {
  it("GEN_BY_ID indexes every image + video model by id (same object refs)", () => {
    for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) expect(GEN_BY_ID[m.id]).toBe(m);
    expect(Object.keys(GEN_BY_ID)).toHaveLength(IMAGE_MODELS.length + VIDEO_MODELS.length);
  });

  it("IMAGE_IDS / VIDEO_IDS mirror the catalog order", () => {
    expect(IMAGE_IDS).toEqual(IMAGE_MODELS.map((m) => m.id));
    expect(VIDEO_IDS).toEqual(VIDEO_MODELS.map((m) => m.id));
    expect(IMAGE_IDS).toContain("nano-banana");
    expect(VIDEO_IDS).toContain("veo-3.1");
  });

  it("every image model is kind=image and every video model is kind=video", () => {
    expect(IMAGE_MODELS.every((m) => m.kind === "image")).toBe(true);
    expect(VIDEO_MODELS.every((m) => m.kind === "video")).toBe(true);
  });

  it("AUDIO_BY_ID + TTS/MUSIC id lists mirror the audio catalogs", () => {
    for (const m of AUDIO_MODELS) expect(AUDIO_BY_ID[m.id]).toBe(m);
    expect(AUDIO_MODELS).toHaveLength(TTS_MODELS.length + MUSIC_MODELS.length);
    expect(TTS_IDS).toEqual(TTS_MODELS.map((m) => m.id));
    expect(MUSIC_IDS).toEqual(MUSIC_MODELS.map((m) => m.id));
  });

  it("DEFAULTS point at real catalog entries of the right kind/category", () => {
    expect(GEN_BY_ID[DEFAULTS.image]?.kind).toBe("image");
    expect(GEN_BY_ID[DEFAULTS.video]?.kind).toBe("video");
    expect(AUDIO_BY_ID[DEFAULTS.tts]?.category).toBe("tts");
    expect(AUDIO_BY_ID[DEFAULTS.music]?.category).toBe("music");
  });
});

// ── modelInfo ───────────────────────────────────────────────────────────────
describe("modelInfo", () => {
  it("emits an image payload with no resolutions/qualities/durations for a bare model", () => {
    const info = modelInfo(GEN_BY_ID["nano-banana"]);
    expect(info).toMatchObject({
      id: "nano-banana",
      kind: "image",
      label: "Nano Banana",
      aspect_ratios: ["9:16", "16:9", "1:1"],
      max_images: 4,
      supports_reference_images: true,
    });
    expect(info.durations).toBeUndefined();
    expect(info.resolutions).toBeUndefined();
    expect(info.qualities).toBeUndefined();
    expect(info.supports_start_frame).toBeUndefined();
  });

  it("includes resolutions when the image model declares them", () => {
    const info = modelInfo(GEN_BY_ID["nano-banana-pro"]);
    expect(info.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(info.qualities).toBeUndefined();
  });

  it("includes qualities (and no resolutions) for gpt-image-1.5", () => {
    const info = modelInfo(GEN_BY_ID["gpt-image-1.5"]);
    expect(info.qualities).toEqual(["low", "medium", "high"]);
    expect(info.resolutions).toBeUndefined();
  });

  it("includes both resolutions and qualities for gpt-image-2", () => {
    const info = modelInfo(GEN_BY_ID["gpt-image-2"]);
    expect(info.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(info.qualities).toEqual(["low", "medium", "high"]);
  });

  it("emits a video payload with durations/resolutions + frame-support flags", () => {
    const info = modelInfo(GEN_BY_ID["veo-3.1"]);
    expect(info).toMatchObject({
      id: "veo-3.1",
      kind: "video",
      durations: [4, 6, 8],
      resolutions: ["720p", "1080p"],
      supports_start_frame: true,
      supports_end_frame: true,
      supports_reference_images: true,
    });
    expect(info.max_images).toBeUndefined();
    expect(info.qualities).toBeUndefined();
  });

  it("maps every catalog model without throwing", () => {
    for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) {
      const info = modelInfo(m);
      expect(info.id).toBe(m.id);
      expect(info.kind).toBe(m.kind);
    }
  });
});

// ── audioModelsInfo ─────────────────────────────────────────────────────────
describe("audioModelsInfo", () => {
  it("returns every audio model with tts + music payloads when no category is given", () => {
    const all = audioModelsInfo();
    expect(all).toHaveLength(AUDIO_MODELS.length);

    const tts = all.filter((m) => m.category === "tts");
    const music = all.filter((m) => m.category === "music");
    expect(tts).toHaveLength(TTS_MODELS.length);
    expect(music).toHaveLength(MUSIC_MODELS.length);

    const t0 = tts[0] as Any;
    expect(t0.kind).toBe("audio");
    expect(t0.defaultVoice).toBe(DEFAULT_VOICE);
    expect(t0.voiceCount).toBe(Object.keys(TTS_VOICES).length);
    expect(t0.voicesSample).toEqual(["Achernar", "Achird", "Algenib"]);
    expect(t0.language_detection).toBe("auto");
    expect(t0.languages).toEqual(TTS_LANGUAGES);
    expect(t0.supports_instrumental).toBeUndefined();
  });

  it("emits the instrumental/lyrics/style flags for music models", () => {
    const all = audioModelsInfo();
    const lyria = all.find((m) => m.id === "lyria") as Any;
    expect(lyria.supports_instrumental).toBe(true);
    expect(lyria.supports_lyrics).toBe(false);
    expect(lyria.supports_style_instructions).toBe(false);
    expect(lyria.languages).toBeUndefined();

    const lyria3 = all.find((m) => m.id === "lyria-3-clip") as Any;
    expect(lyria3.supports_instrumental).toBe(true);
    expect(lyria3.supports_lyrics).toBe(true);
    expect(lyria3.supports_style_instructions).toBe(true);
  });

  it("filters to tts-only when category=tts", () => {
    const tts = audioModelsInfo("tts");
    expect(tts).toHaveLength(TTS_MODELS.length);
    expect(tts.every((m) => m.category === "tts")).toBe(true);
  });

  it("filters to music-only when category=music", () => {
    const music = audioModelsInfo("music");
    expect(music).toHaveLength(MUSIC_MODELS.length);
    expect(music.every((m) => m.category === "music")).toBe(true);
  });

  it("returns nothing for a category with no models (skips every entry)", () => {
    expect(audioModelsInfo("sfx")).toEqual([]);
  });
});

// ── voice / language tables ─────────────────────────────────────────────────
describe("voice + language tables", () => {
  it("DEFAULT_VOICE is a real entry in TTS_VOICES", () => {
    expect(TTS_VOICES[DEFAULT_VOICE]).toBeDefined();
    expect(typeof TTS_VOICES[DEFAULT_VOICE]).toBe("string");
  });

  it("TTS_LANGUAGES holds unique ISO-ish codes including English", () => {
    expect(TTS_LANGUAGES).toContain("en");
    expect(new Set(TTS_LANGUAGES).size).toBe(TTS_LANGUAGES.length);
  });
});
