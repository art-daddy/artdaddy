// AI generation model catalog (client-side). Ported from the server's
// generation.py (IMAGE_MODELS / VIDEO_MODELS) + audio.py (TTS/music + voices).
// The client owns model selection + validation now; the thin /ai/generate/*
// proxies just make the authed provider call. Keep in sync with the server's
// spec-only enums in v4/tools/definitions.py (the tool schemas the model sees).

export interface GenModel {
  id: string;
  kind: "image" | "video";
  provider: "gemini" | "gpt-image" | "mai";
  backend_id: string;
  label: string;
  aspect_ratios: string[];
  durations?: number[];
  resolutions?: string[];
  qualities?: string[];
  max_images?: number;
  supports_start_frame?: boolean;
  supports_end_frame?: boolean;
  supports_reference_images?: boolean;
}

export const IMAGE_MODELS: GenModel[] = [
  {
    id: "nano-banana",
    kind: "image",
    provider: "gemini",
    backend_id: "gemini-2.5-flash-image",
    label: "Nano Banana",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "nano-banana-pro",
    kind: "image",
    provider: "gemini",
    backend_id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    resolutions: ["1K", "2K", "4K"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "nano-banana-2",
    kind: "image",
    provider: "gemini",
    backend_id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    resolutions: ["1K", "2K", "4K"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "nano-banana-2-lite",
    kind: "image",
    provider: "gemini",
    backend_id: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    // 1K only: Google publishes no 2K/4K token count for this model, so offering
    // a higher resolution would bill at a guessed rate.
    resolutions: ["1K"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "gpt-image-1.5",
    kind: "image",
    provider: "gpt-image",
    backend_id: "gpt-image-1.5",
    label: "GPT Image 1.5",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    qualities: ["low", "medium", "high"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "gpt-image-2",
    kind: "image",
    provider: "gpt-image",
    backend_id: "gpt-image-2",
    label: "GPT Image 2",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    resolutions: ["1K", "2K", "4K"],
    qualities: ["low", "medium", "high"],
    max_images: 4,
    supports_reference_images: true,
  },
  {
    id: "mai-image-2.5",
    kind: "image",
    provider: "mai",
    backend_id: "MAI-Image-2.5",
    label: "MAI Image 2.5",
    aspect_ratios: ["9:16", "16:9", "1:1"],
    max_images: 4,
    supports_reference_images: true,
  },
];

export const VIDEO_MODELS: GenModel[] = [
  {
    id: "veo-3.1",
    kind: "video",
    provider: "gemini",
    backend_id: "veo-3.1-generate-001",
    label: "Veo 3.1",
    aspect_ratios: ["9:16", "16:9"],
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    supports_start_frame: true,
    supports_end_frame: true,
    supports_reference_images: true,
  },
  {
    id: "veo-3.1-fast",
    kind: "video",
    provider: "gemini",
    backend_id: "veo-3.1-fast-generate-001",
    label: "Veo 3.1 Fast",
    aspect_ratios: ["9:16", "16:9"],
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    supports_start_frame: true,
    supports_end_frame: true,
    supports_reference_images: true,
  },
  {
    id: "veo-3.1-lite",
    kind: "video",
    provider: "gemini",
    backend_id: "veo-3.1-lite-generate-001",
    label: "Veo 3.1 Lite",
    aspect_ratios: ["9:16", "16:9"],
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    supports_start_frame: true,
    supports_end_frame: true,
    supports_reference_images: true,
  },
];

export const GEN_BY_ID: Record<string, GenModel> = Object.fromEntries(
  [...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => [m.id, m]),
);
export const IMAGE_IDS = IMAGE_MODELS.map((m) => m.id);
export const VIDEO_IDS = VIDEO_MODELS.map((m) => m.id);

// NOTE: aspect_ratio/resolution -> vendor pixel size lives SERVER-side now
// (ai_proxy._gpt_image_size / _mai_wh). The client sends only the levers (other NLEs split).

export interface AudioModel {
  id: string;
  category: "tts" | "music" | "sfx";
  backend_id: string;
  label: string;
  supports_instrumental?: boolean;
  supports_lyrics?: boolean;
  supports_style_instructions?: boolean;
  interactions?: boolean;
}

export const TTS_MODELS: AudioModel[] = [
  {
    id: "gemini-tts-flash",
    category: "tts",
    backend_id: "gemini-3.1-flash-tts-preview",
    label: "Gemini Flash TTS",
  },
  {
    id: "gemini-tts-flash-2.5",
    category: "tts",
    backend_id: "gemini-2.5-flash-preview-tts",
    label: "Gemini 2.5 Flash TTS",
  },
  {
    id: "gemini-tts-pro-2.5",
    category: "tts",
    backend_id: "gemini-2.5-pro-preview-tts",
    label: "Gemini 2.5 Pro TTS",
  },
];
export const MUSIC_MODELS: AudioModel[] = [
  {
    id: "lyria",
    category: "music",
    backend_id: "lyria-002",
    label: "Lyria",
    supports_instrumental: true,
  },
  {
    id: "lyria-3-clip",
    category: "music",
    backend_id: "lyria-3-clip-preview",
    label: "Lyria 3 Clip",
    supports_instrumental: true,
    supports_lyrics: true,
    supports_style_instructions: true,
    interactions: true,
  },
  {
    id: "lyria-3-pro",
    category: "music",
    backend_id: "lyria-3-pro-preview",
    label: "Lyria 3 Pro",
    supports_instrumental: true,
    supports_lyrics: true,
    supports_style_instructions: true,
    interactions: true,
  },
];
export const AUDIO_MODELS: AudioModel[] = [...TTS_MODELS, ...MUSIC_MODELS];
export const AUDIO_BY_ID: Record<string, AudioModel> = Object.fromEntries(
  AUDIO_MODELS.map((m) => [m.id, m]),
);
export const TTS_IDS = TTS_MODELS.map((m) => m.id);
export const MUSIC_IDS = MUSIC_MODELS.map((m) => m.id);

// name -> vibe. The model picks a voice by vibe (surfaced via list_models).
export const TTS_VOICES: Record<string, string> = {
  Zephyr: "bright, clear",
  Puck: "upbeat, energetic, hype",
  Charon: "informative, neutral narrator (good default for explainers)",
  Kore: "firm, confident, authoritative",
  Fenrir: "excitable, high-energy",
  Leda: "youthful, casual",
  Orus: "firm",
  Aoede: "breezy, casual, light",
  Callirrhoe: "easy-going",
  Autonoe: "bright",
  Enceladus: "breathy",
  Iapetus: "clear",
  Umbriel: "easy-going",
  Algieba: "smooth, calm",
  Despina: "smooth",
  Erinome: "clear",
  Algenib: "gravelly",
  Rasalgethi: "informative",
  Laomedeia: "upbeat",
  Achernar: "soft",
  Alnilam: "firm",
  Schedar: "even",
  Gacrux: "mature",
  Pulcherrima: "forward",
  Achird: "friendly, warm, approachable",
  Zubenelgenubi: "casual",
  Vindemiatrix: "gentle, soft",
  Sadachbia: "lively",
  Sadaltager: "knowledgeable documentary expert",
  Sulafat: "warm storyteller",
};
export const TTS_LANGUAGES: string[] = [
  "ar",
  "bn",
  "nl",
  "en",
  "fr",
  "de",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "mr",
  "pl",
  "pt",
  "ro",
  "ru",
  "es",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
  "af",
  "sq",
  "am",
  "hy",
  "az",
  "eu",
  "be",
  "bg",
  "my",
  "ca",
  "ceb",
  "cmn",
  "hr",
  "cs",
  "da",
  "et",
  "fil",
  "fi",
  "gl",
  "ka",
  "el",
  "gu",
  "ht",
  "he",
  "hu",
  "is",
  "jv",
  "kn",
  "kok",
  "lo",
  "la",
  "lv",
  "lt",
  "lb",
  "mk",
  "mai",
  "mg",
  "ms",
  "ml",
  "mn",
  "ne",
  "nb",
  "nn",
  "or",
  "ps",
  "fa",
  "pa",
  "sr",
  "sd",
  "si",
  "sk",
  "sl",
  "sw",
  "sv",
  "ur",
];
export const DEFAULT_VOICE = "Charon";
export const DEFAULTS = {
  image: "nano-banana-pro",
  video: "veo-3.1-fast",
  tts: "gemini-tts-flash",
  music: "lyria",
};

/** Per-model capability payload for list_models (ports generation.py _model_info). */
export function modelInfo(m: GenModel): Record<string, unknown> {
  const info: Record<string, unknown> = {
    id: m.id,
    kind: m.kind,
    label: m.label,
    aspect_ratios: m.aspect_ratios,
  };
  if (m.durations?.length) info.durations = m.durations;
  if (m.resolutions?.length) info.resolutions = m.resolutions;
  if (m.qualities?.length) info.qualities = m.qualities;
  if (m.kind === "image") {
    info.max_images = m.max_images;
    info.supports_reference_images = m.supports_reference_images;
  } else {
    info.supports_start_frame = m.supports_start_frame;
    info.supports_end_frame = m.supports_end_frame;
    info.supports_reference_images = m.supports_reference_images;
  }
  return info;
}

/** Audio catalog payload for list_models (ports audio.py audio_models_info). */
export function audioModelsInfo(category?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of AUDIO_MODELS) {
    if (category && m.category !== category) continue;
    const info: Record<string, unknown> = {
      id: m.id,
      kind: "audio",
      category: m.category,
      label: m.label,
    };
    if (m.category === "tts") {
      info.voicesSample = Object.keys(TTS_VOICES).sort().slice(0, 3);
      info.voiceCount = Object.keys(TTS_VOICES).length;
      info.defaultVoice = DEFAULT_VOICE;
      info.language_detection = "auto";
      info.languages = TTS_LANGUAGES;
    } else if (m.category === "music") {
      info.supports_instrumental = Boolean(m.supports_instrumental);
      info.supports_lyrics = Boolean(m.supports_lyrics);
      info.supports_style_instructions = Boolean(m.supports_style_instructions);
    }
    out.push(info);
  }
  return out;
}
