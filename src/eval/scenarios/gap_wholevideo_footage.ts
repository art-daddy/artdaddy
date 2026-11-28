// The footage the whole-video cases edit: seven libraries of a person's own clips, each clip with KNOWN
// content (what the pictures show, what is said and when, the sound), so code can tell which clips a
// finished video used and where. Made up for the eval: no real person's media, names or words.
//
// Filenames are the camera's own (IMG_3307.MOV, DJI_0142.MP4), as in most people's libraries: what a
// clip shows is learned by looking at it, never from its name.
import type { Footage, FootageClip, FootageShot } from "../footage";
import type { Clip, Timeline, Track } from "../../timeline/model";

const v = (
  media_ref: string,
  filename: string,
  duration_s: number,
  shots: FootageShot[] | string,
  extra: Partial<FootageClip> = {},
): FootageClip => ({
  media_ref,
  filename,
  kind: "video",
  duration_s,
  audio: true,
  shots: typeof shots === "string" ? [{ from: 0, to: duration_s, shows: shots }] : shots,
  ...extra,
});
const song = (
  media_ref: string,
  filename: string,
  duration_s: number,
  sound: string,
): FootageClip => ({
  media_ref,
  filename,
  kind: "audio",
  duration_s,
  audio: true,
  sound,
});
const photo = (
  media_ref: string,
  filename: string,
  width: number,
  height: number,
  shows: string,
): FootageClip => ({
  media_ref,
  filename,
  kind: "image",
  width,
  height,
  shots: [{ from: 0, to: 1, shows }],
});

// ── a weekend on a rocky coast: 19 clips and a song ─────────────────────────────

export const TRIP_REF = {
  bay: "media_4f1c9a2e7b30",
  lane: "media_8d03b6e1c254",
  harbourTalk: "media_2a7e5c90d1f8",
  boats: "media_c61f0b8a3e92",
  jump: "media_95e2d47a0c1b",
  octopus: "media_0b8e3f6c2d71",
  cave: "media_e47a1d9c05b3",
  lighthouse: "media_6c2f8e0a4b19",
  toast: "media_d10b7c3e9f42",
  sunset: "media_3e9a6f1b8c05",
  pocket: "media_a58c2e7d0f36",
  market: "media_7f4d0c1a9e28",
  cat: "media_1c6e9b4f2a07",
  cliffPath: "media_b2d85a0e7c61",
  hikeTalk: "media_59a1e3c7d0b4",
  snorkel: "media_f03c7b9e1a56",
  iceCream: "media_4b7e2d0f9c13",
  ferry: "media_c8a06f3d1e97",
  waves: "media_2e5b9c1f7a40",
  song: "media_9d3f0a6c4e18",
} as const;
const T = TRIP_REF;

export const TRIP: Footage = {
  clips: [
    v(
      T.bay,
      "DJI_0142.MP4",
      14,
      [
        {
          from: 0,
          to: 6,
          shows:
            "an aerial shot gliding over a turquoise bay ringed by pale cliffs in early morning light",
        },
        {
          from: 6,
          to: 14,
          shows: "the aerial shot tilting down onto a small white sailboat anchored in the bay",
        },
      ],
      { audio: false, width: 3840, height: 2160 },
    ),
    v(
      T.lane,
      "IMG_3307.MOV",
      9,
      "a walking shot through a narrow old-town lane of whitewashed houses with blue doors",
      {
        sound: "footsteps on stone and distant voices, no music",
      },
    ),
    v(
      T.harbourTalk,
      "IMG_3311.MOV",
      12,
      "a woman in a straw hat talking to the camera on a harbour wall, fishing boats behind her",
      {
        sound: "her voice, gulls and lapping water",
        words: [
          ["Morning from the harbour!", 0.8, 2.4],
          ["We only got here last night and the water is unreal.", 2.9, 6.6],
          ["Today we're going to explore the whole coast.", 7.1, 10.4],
        ],
      },
    ),
    v(
      T.boats,
      "IMG_3319.MOV",
      8,
      "a close-up of fishing boats bobbing at their moorings, ropes and orange nets on the decks",
      {
        sound: "gulls and water slapping the hulls",
      },
    ),
    v(
      T.jump,
      "GX010233.MP4",
      15,
      [
        {
          from: 0,
          to: 5,
          shows: "a man standing on a high rock above the sea, counting down with his hand",
        },
        {
          from: 5,
          to: 8,
          shows: "the man jumping feet first off the rock and dropping toward the water",
        },
        { from: 8, to: 11, shows: "a huge splash as the man hits the water" },
        {
          from: 11,
          to: 15,
          shows: "an underwater view of bubbles and the man's legs kicking back up",
        },
      ],
      {
        sound: "shouting, a big splash, then muffled underwater sound",
        words: [["Three, two, one!", 1.5, 4.0]],
      },
    ),
    v(
      T.octopus,
      "IMG_3342.MOV",
      10,
      "a plate of grilled octopus and a glass of white wine on a taverna table; a hand squeezes lemon over the octopus",
      {
        sound: "restaurant chatter and cutlery",
      },
    ),
    v(
      T.cave,
      "IMG_3350.MOV",
      11,
      [
        {
          from: 0,
          to: 6,
          shows: "a kayak paddling into a sea cave, bright daylight at the cave mouth behind",
        },
        {
          from: 6,
          to: 11,
          shows:
            "inside the sea cave, light rippling on the rock ceiling and a paddle dipping into turquoise water",
        },
      ],
      { sound: "paddle strokes echoing in the cave" },
    ),
    v(
      T.lighthouse,
      "DJI_0151.MP4",
      13,
      "an aerial shot pulling back from a white lighthouse on a green headland in golden evening light",
      {
        audio: false,
        width: 3840,
        height: 2160,
      },
    ),
    v(
      T.toast,
      "IMG_3361.MOV",
      7,
      "four friends at an outdoor table at night under string lights, raising their glasses in a toast",
      {
        sound: "laughter and clinking glasses",
        words: [["To the best weekend ever!", 2.0, 3.8]],
      },
    ),
    v(
      T.sunset,
      "IMG_3368.MOV",
      16,
      "the sun sinking into the sea seen from a hilltop, the sky turning orange and pink",
      {
        sound: "wind",
      },
    ),
    v(
      T.pocket,
      "IMG_3372.MOV",
      6,
      "a blurry, shaking view of grass and the toe of a shoe: the phone was recording by accident in a pocket",
      {
        sound: "rustling fabric",
      },
    ),
    v(
      T.market,
      "IMG_3375.MOV",
      9,
      "a morning market stall piled with peaches, figs and tomatoes; a vendor weighs a bag of figs",
      {
        sound: "market chatter",
      },
    ),
    v(T.cat, "IMG_3381.MOV", 8, "a cat asleep on a sunny blue windowsill", {
      sound: "a quiet street",
    }),
    v(
      T.cliffPath,
      "IMG_3388.MOV",
      10,
      "a narrow cliff path with the sea far below, filmed while walking",
      {
        sound: "footsteps on gravel and wind",
      },
    ),
    v(
      T.hikeTalk,
      "IMG_3390.MOV",
      12,
      "the woman in the straw hat talking to the camera on the cliff path, out of breath",
      {
        sound: "wind and her voice",
        words: [
          ["Okay, this hike is harder than it looked.", 0.6, 3.4],
          ["But look at that view.", 4.0, 5.8],
        ],
      },
    ),
    v(T.snorkel, "GX010240.MP4", 9, "snorkelling over rocks with small silver fish darting below", {
      sound: "muffled underwater sound",
    }),
    v(
      T.iceCream,
      "IMG_3402.MOV",
      7,
      "two ice cream cones, strawberry and pistachio, held up against a blue sky",
      {
        sound: "street noise",
      },
    ),
    v(
      T.ferry,
      "IMG_3410.MOV",
      10,
      "a ferry pulling away from the harbour, seen from its deck, the town getting smaller",
      {
        sound: "engine rumble and wind",
      },
    ),
    v(
      T.waves,
      "DJI_0163.MP4",
      12,
      "an aerial top-down shot of waves breaking white on dark rocks",
      {
        audio: false,
        width: 3840,
        height: 2160,
      },
    ),
    song(T.song, "trip_song.mp3", 96, "an upbeat acoustic guitar song with hand claps, no vocals"),
  ],
};

// ── a makers' meetup: 13 clips and a theme ──────────────────────────────────────

export const EVENT_REF = {
  hall: "media_71c0e9a4b3d2",
  keynote: "media_0e4b8d2f6a19",
  applause: "media_a3f17c5e0b84",
  printer: "media_5c9e02b7d4a1",
  handshake: "media_d8b4a61f3e07",
  banner: "media_3a0f9e7c1d52",
  panel: "media_f6d23b8a0c4e",
  kids: "media_8e1a5c3f9b62",
  interview: "media_42c7f0d9e1b5",
  coffee: "media_b90e6a2d5c73",
  trophy: "media_1f8d3c6b0a94",
  volunteers: "media_6b2a9f4e7d18",
  carpet: "media_c3e7b1a05f29",
  theme: "media_e5a90d4c2b61",
} as const;
const E = EVENT_REF;

export const EVENT: Footage = {
  clips: [
    v(
      E.hall,
      "A7S_0201.MP4",
      12,
      "a wide shot of a hall filling up, people finding their seats in front of a stage",
      {
        sound: "the murmur of a crowd",
      },
    ),
    v(
      E.keynote,
      "A7S_0204.MP4",
      15,
      "a woman with short grey hair speaking at a podium on stage, a slide behind her reading 'Makers Meetup 2026'",
      {
        sound: "her voice through the speakers, light applause at the end",
        words: [
          ["Thank you all for coming.", 0.8, 2.6],
          ["This year we doubled the number of local makers in this room.", 3.2, 7.4],
          ["Let's build something together.", 8.6, 10.8],
        ],
      },
    ),
    v(
      E.applause,
      "A7S_0207.MP4",
      10,
      "the audience clapping and cheering, a wide shot from the stage",
      { sound: "applause" },
    ),
    v(
      E.printer,
      "A7S_0210.MP4",
      9,
      "a close-up of a 3D printer laying down orange plastic at a booth",
      {
        sound: "the printer whirring",
      },
    ),
    v(
      E.handshake,
      "A7S_0213.MP4",
      11,
      "two people shaking hands and laughing at a booth full of wooden toys",
      {
        sound: "chatter",
      },
    ),
    v(
      E.banner,
      "A7S_0216.MP4",
      8,
      "the entrance banner reading 'Makers Meetup 2026' above the doors, people walking in",
      {
        sound: "chatter",
      },
    ),
    v(
      E.panel,
      "A7S_0219.MP4",
      14,
      "four panelists on stools on stage, one of them holding a microphone",
      {
        sound: "a panelist speaking",
        words: [["The best tools are the ones you share.", 2.0, 4.6]],
      },
    ),
    v(
      E.kids,
      "A7S_0222.MP4",
      10,
      "children building a small robot kit at a workshop table, a volunteer helping them",
      {
        sound: "children chatting",
      },
    ),
    v(
      E.interview,
      "A7S_0225.MP4",
      13,
      "a young man in a beanie being interviewed in front of a booth, looking just off camera",
      {
        sound: "his voice and the hall behind him",
        words: [
          ["I came for the workshops,", 0.7, 2.3],
          ["and honestly I stayed for the people.", 2.6, 4.9],
          ["Everyone here wants to help you finish your project.", 5.6, 9.3],
        ],
      },
    ),
    v(
      E.coffee,
      "A7S_0228.MP4",
      7,
      "an overhead shot of the coffee break crowd around a long table of cups",
      { sound: "a crowd" },
    ),
    v(E.trophy, "A7S_0231.MP4", 12, "a winner lifting a trophy on stage as confetti falls", {
      sound: "cheering",
    }),
    v(
      E.volunteers,
      "A7S_0234.MP4",
      9,
      "a group photo of about twenty volunteers in yellow t-shirts waving at the camera",
      {
        sound: "cheering",
      },
    ),
    v(
      E.carpet,
      "A7S_0237.MP4",
      6,
      "a blurred, tilted shot of the carpet while the camera was being carried",
      {
        sound: "footsteps",
      },
    ),
    song(E.theme, "event_theme.mp3", 120, "an upbeat electronic track, no vocals"),
  ],
};

// ── a flat for sale: 7 rooms and a piano track ──────────────────────────────────

export const HOME_REF = {
  kitchen: "media_9a4c1e7b3f02",
  outside: "media_37e0b5d9a1c8",
  bedroom: "media_c2f6a8e0d4b7",
  balcony: "media_5e1d3b9c7a06",
  living: "media_a0b7f2c6e9d3",
  hallway: "media_1d9c4a7e0f5b",
  bathroom: "media_8b3e6f1d2c90",
  piano: "media_f4a2c0e8b7d1",
} as const;
const H = HOME_REF;

const room = (ref: string, name: string, s: number, shows: string): FootageClip =>
  v(ref, name, s, shows, { audio: false });
export const HOME: Footage = {
  clips: [
    room(
      H.kitchen,
      "H_0101.MP4",
      10,
      "a modern kitchen with a white island and a black hob, the camera slowly pushing in",
    ),
    room(
      H.outside,
      "H_0102.MP4",
      9,
      "the outside of a five-storey apartment building with balconies, seen from the street",
    ),
    room(
      H.bedroom,
      "H_0103.MP4",
      11,
      "a bedroom with a double bed, linen bedding and a window onto trees",
    ),
    room(
      H.balcony,
      "H_0104.MP4",
      8,
      "the view from a balcony over a park with tall trees and a pond",
    ),
    room(
      H.living,
      "H_0105.MP4",
      12,
      "a bright living room with big windows, a grey sofa and a wooden floor, the camera slowly panning",
    ),
    room(
      H.hallway,
      "H_0106.MP4",
      9,
      "a front door opening into a hallway with a coat rack and a mirror",
    ),
    room(H.bathroom, "H_0107.MP4", 9, "a bathroom with a walk-in shower and white tiles"),
    song(H.piano, "piano_light.mp3", 80, "a light piano piece, no vocals"),
  ],
};

// ── a coffee roaster's product shoot: 8 clips, a logo and a beat ─────────────────

export const CAFE_REF = {
  beans: "media_06d4b9e2a7f3",
  espresso: "media_b5e8c3a1f0d6",
  latte: "media_2c0a7f5e9b48",
  founder: "media_e9f3d6b0c1a2",
  bag: "media_74b1e0c8d3f9",
  sip: "media_3d6f9a2b8e0c",
  greyCard: "media_a1e4c7f0b9d5",
  roaster: "media_5f0b2d8c6a3e",
  logo: "media_c7d9e3a5f1b0.png",
  beat: "media_0a3e8f6d4c27",
} as const;
const K = CAFE_REF;

export const CAFE: Footage = {
  clips: [
    v(
      K.beans,
      "C0011.MP4",
      10,
      "coffee beans pouring in slow motion into the hopper of a grinder",
      { sound: "beans rattling" },
    ),
    v(
      K.espresso,
      "C0012.MP4",
      12,
      "a barista pulling an espresso shot, golden crema filling a small glass cup",
      {
        sound: "the hiss of the machine",
      },
    ),
    v(K.latte, "C0013.MP4", 9, "milk being poured into a cup to draw a leaf of latte art", {
      sound: "quiet",
    }),
    v(
      K.founder,
      "C0014.MP4",
      14,
      "a bearded man in an apron talking to the camera in front of a coffee roaster",
      {
        sound: "his voice and the roaster's hum",
        words: [
          ["We roast every batch by hand,", 0.9, 3.0],
          ["in small lots,", 3.3, 4.4],
          ["two days before it ships to you.", 4.8, 7.2],
          ["That's the whole secret.", 8.0, 9.6],
        ],
      },
    ),
    v(
      K.bag,
      "C0015.MP4",
      8,
      "a kraft paper coffee bag labelled 'Fresh Beans Co.' on a kitchen counter in morning light; a hand picks it up",
      {
        sound: "a quiet kitchen",
      },
    ),
    v(
      K.sip,
      "C0016.MP4",
      11,
      "a woman at a cafe window smiling as she takes her first sip of coffee",
      { sound: "cafe chatter" },
    ),
    v(K.greyCard, "C0017.MP4", 6, "an out-of-focus grey card filling the frame: a camera test", {
      sound: "silence",
    }),
    v(
      K.roaster,
      "C0018.MP4",
      10,
      "freshly roasted beans tumbling in the cooling tray of a drum roaster, steam rising",
      {
        sound: "the roaster's drum turning",
      },
    ),
    photo(
      K.logo,
      "logo_freshbeans.png",
      2000,
      2000,
      "the 'Fresh Beans Co.' logo: a brown coffee bean above the name, on a transparent background",
    ),
    song(K.beat, "lofi_beat.mp3", 60, "a mellow lo-fi beat, no vocals"),
  ],
};

// ── a mum's sixtieth birthday: 8 clips from two phones, 2 old photos, a song ────

export const PARTY_REF = {
  candles: "media_d2a6f0c9e4b1",
  toast: "media_6f9b3e1a0d7c",
  balloons: "media_b8c1d5f7a2e0",
  album: "media_0c5e2a8b6f93",
  present: "media_9e7a4d0c3b16",
  dancing: "media_4a1f8c6e2d05",
  cakeCut: "media_e3b0d7f9a5c8",
  hug: "media_7c4e1b0f8a62",
  photo1986: "media_1b8f5d3a9e04.jpg",
  photo1994: "media_a6d0e9c2f7b3.jpg",
  song: "media_3f2c7a0e5d98",
} as const;
const B = PARTY_REF;
const tall = { width: 1080, height: 1920 };

export const PARTY: Footage = {
  clips: [
    v(
      B.candles,
      "MVI_0410.MP4",
      10,
      "a woman with silver hair blowing out the candles on a cake with a big '60' candle while everyone sings",
      {
        sound: "everyone singing",
        words: [["Happy birthday dear Mum, happy birthday to you!", 2.0, 7.5]],
      },
    ),
    v(
      B.toast,
      "MVI_0411.MP4",
      12,
      "a man in a blue shirt standing in a garden with his glass raised, giving a toast",
      {
        sound: "his voice and birdsong",
        words: [
          ["Everyone, a quick word.", 0.6, 2.2],
          ["Mum, you taught us to be kind and to laugh at ourselves.", 2.8, 7.0],
          ["To Mum, sixty years young!", 7.8, 10.2],
        ],
      },
    ),
    v(B.balloons, "MVI_0414.MP4", 8, "two small children running across a lawn holding balloons", {
      ...tall,
      sound: "children shrieking happily",
    }),
    v(B.album, "MVI_0417.MP4", 11, "a close-up of hands turning the pages of an old photo album", {
      sound: "pages turning",
    }),
    v(
      B.present,
      "MVI_0420.MP4",
      9,
      "the woman with silver hair unwrapping a present, a hand-knitted red scarf, and laughing",
      {
        ...tall,
        sound: "laughter",
      },
    ),
    v(
      B.dancing,
      "MVI_0423.MP4",
      14,
      "the family dancing in a living room, the woman with silver hair in the middle",
      {
        sound: "music from a speaker and laughter",
      },
    ),
    v(B.cakeCut, "MVI_0426.MP4", 7, "the birthday cake being cut into slices on a kitchen table", {
      ...tall,
      sound: "chatter",
    }),
    v(
      B.hug,
      "MVI_0429.MP4",
      10,
      "the woman with silver hair hugging her sister by the garden gate",
      { sound: "birdsong" },
    ),
    photo(
      B.photo1986,
      "photo_1986.jpg",
      1600,
      1200,
      "an old faded photo of a young woman with dark hair laughing on a beach",
    ),
    photo(
      B.photo1994,
      "photo_1994.jpg",
      1200,
      1600,
      "an old photo of a family of four in front of a small house, the mother holding a toddler",
    ),
    song(B.song, "garden_song.mp3", 140, "a gentle piano and strings piece, no vocals"),
  ],
};

// ── a baking day, filmed upright on a phone: 10 clips and a beat ────────────────

export const BAKE_REF = {
  intro: "media_8f0d4b2e6a17",
  mix: "media_2b6a9e0c4f81",
  knead: "media_d5c3f8a1e09b",
  restTalk: "media_61e9b7d0a3c4",
  run: "media_c0a4e2f6b9d8",
  shape: "media_9b5d1a7c3e20",
  bake: "media_4e8c0f3b6d1a",
  crustTalk: "media_a7f1c5e9d2b0",
  slice: "media_3c9e6b0a8f45",
  dog: "media_f8b2a4d6c0e3",
  music: "media_07e5c1d9a4f6",
} as const;
const V = BAKE_REF;

export const BAKE: Footage = {
  clips: [
    v(
      V.intro,
      "PXL_20261103_081205.mp4",
      14,
      "a woman with a ponytail talking to the camera in a sunny kitchen",
      {
        ...tall,
        sound: "her voice",
        words: [
          ["Okay so today I'm finally making the sourdough", 0.5, 3.9],
          ["everyone keeps asking about.", 3.9, 5.6],
          ["Let's go.", 9.2, 10.0],
        ],
      },
    ),
    v(V.mix, "PXL_20261103_081540.mp4", 8, "hands mixing flour and water in a big glass bowl", {
      ...tall,
      sound: "a spoon scraping the bowl",
    }),
    v(V.knead, "PXL_20261103_083012.mp4", 9, "hands kneading dough on a floured wooden board", {
      ...tall,
      sound: "dough thumping on wood",
    }),
    v(
      V.restTalk,
      "PXL_20261103_084033.mp4",
      16,
      "the woman talking to the camera and pointing at a bowl covered with a tea towel",
      {
        ...tall,
        sound: "her voice",
        words: [
          ["Now it has to rest for four hours,", 0.6, 3.2],
          ["so I'm going for a run.", 3.5, 5.0],
        ],
      },
    ),
    v(
      V.run,
      "PXL_20261103_090517.mp4",
      10,
      "a selfie shot of the woman running along a river path",
      {
        ...tall,
        sound: "heavy breathing and footsteps",
      },
    ),
    v(
      V.shape,
      "PXL_20261103_113009.mp4",
      9,
      "hands shaping the dough into a round loaf on a floured board",
      { ...tall, sound: "quiet" },
    ),
    v(
      V.bake,
      "PXL_20261103_131044.mp4",
      7,
      "an oven door opening on a golden loaf, steam pouring out",
      { ...tall, sound: "the oven fan" },
    ),
    v(
      V.crustTalk,
      "PXL_20261103_132015.mp4",
      13,
      "the woman holding the loaf up to the camera and grinning",
      {
        ...tall,
        sound: "her voice",
        words: [
          ["Look at that crust!", 0.7, 2.1],
          ["Honestly, best one yet.", 6.2, 8.0],
        ],
      },
    ),
    v(
      V.slice,
      "PXL_20261103_132251.mp4",
      6,
      "a bread knife cutting the loaf, a close-up of the airy crumb",
      { ...tall, sound: "crust crackling" },
    ),
    v(
      V.dog,
      "PXL_20261103_134002.mp4",
      5,
      "a dog sniffing the edge of the kitchen table, hoping for bread",
      { ...tall, sound: "sniffing" },
    ),
    song(V.music, "kitchen_beat.mp3", 90, "a light funky instrumental, no vocals"),
  ],
};

// ── a bike-repair lesson in six takes, with pauses and filler words ──────────────

export const LESSON_REF = {
  intro: "media_5a8d2f0c7e13",
  wheel: "media_e0c6b3a9f4d2",
  tyre: "media_9f4a7e1c0b68",
  hole: "media_2d7b0e5a8c39",
  patch: "media_b6e1f9d3a0c5",
  done: "media_47c0a2e8f6d1",
} as const;
const P = LESSON_REF;

export const LESSON: Footage = {
  clips: [
    v(
      P.intro,
      "MVI_1001.MP4",
      12,
      "a man in a workshop talking to the camera beside a bike on a stand",
      {
        sound: "his voice in a small room",
        words: [
          ["Hi everyone, um, today I'm showing you how to fix a puncture.", 0.6, 4.8],
          ["It takes about ten minutes.", 7.6, 9.4],
        ],
      },
    ),
    v(
      P.wheel,
      "MVI_1002.MP4",
      10,
      "the man flipping open the quick-release lever on the front wheel",
      {
        sound: "his voice in a small room",
        words: [
          ["First, take the wheel off.", 0.5, 2.3],
          ["Uh, just open this lever here.", 5.4, 7.6],
        ],
      },
    ),
    v(P.tyre, "MVI_1003.MP4", 11, "a close-up of tyre levers prising the tyre off the rim", {
      sound: "his voice in a small room",
      words: [
        ["Then lever the tyre off the rim,", 0.8, 3.2],
        ["and pull out the inner tube.", 3.5, 5.4],
      ],
    }),
    v(P.hole, "MVI_1004.MP4", 9, "the man pumping up the inner tube and listening to it", {
      sound: "his voice in a small room",
      words: [
        ["Find the hole by pumping it up.", 2.6, 4.6],
        ["Um, you'll hear the air.", 5.0, 6.6],
      ],
    }),
    v(P.patch, "MVI_1005.MP4", 10, "hands pressing a patch onto the inner tube", {
      sound: "his voice in a small room",
      words: [
        ["Put a patch on and press hard for a minute.", 0.7, 4.0],
        ["Then put it all back together.", 6.9, 8.8],
      ],
    }),
    v(P.done, "MVI_1006.MP4", 8, "the man spinning the repaired wheel and giving a thumbs up", {
      sound: "his voice in a small room",
      words: [["And that's it, um, you're ready to ride.", 0.5, 3.6]],
    }),
  ],
};

// ── seeds ────────────────────────────────────────────────────────────────────────

/** A new project nobody has placed anything in, as the app makes one: the default canvas, still
 *  "Auto" (the first video placed sets its size), and the two starter tracks. */
export function newProject(): Timeline {
  return {
    units: "frames",
    canvas: { width: 1080, height: 1920, fps: 30 },
    canvas_auto: true,
    tracks: [
      { id: "v1", kind: "video", z: 0, clips: [] },
      { id: "a1", kind: "audio", z: 0, clips: [] },
    ],
  } as Timeline;
}

/** The clips a placed seed names, in order: `c01`.. for the pictures and `s01`.. for their sound. */
export const placedIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
export const soundIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `s${String(i + 1).padStart(2, "0")}`);

/** `refs` placed whole and back to back on v1 in that order, a video's sound as its linked audio clip on
 *  a1, as add_clips places them; on the canvas the first clip set. */
export function placedProject(footage: Footage, refs: readonly string[]): Timeline {
  const fps = 30;
  const first = footage.clips.find((c) => c.media_ref === refs[0]);
  const pictures: Clip[] = [];
  const sounds: Clip[] = [];
  let at = 0;
  refs.forEach((ref, i) => {
    const c = footage.clips.find((x) => x.media_ref === ref);
    if (!c) throw new Error(`no footage clip ${ref}`);
    const len = Math.round((c.duration_s ?? 5) * fps);
    const n = String(i + 1).padStart(2, "0");
    const picture: Clip = {
      id: `c${n}`,
      kind: c.kind === "image" ? "image" : "video",
      media_ref: ref,
      timeline_in: at,
      timeline_out: at + len,
      ...(c.kind === "video" ? { source_in: 0, source_out: len } : {}),
    };
    if (c.kind === "video" && c.audio) {
      picture.link_group = `lg${n}`;
      sounds.push({
        id: `s${n}`,
        kind: "audio",
        media_ref: ref,
        timeline_in: at,
        timeline_out: at + len,
        source_in: 0,
        source_out: len,
        link_group: `lg${n}`,
      });
    }
    pictures.push(picture);
    at += len;
  });
  const tracks: Track[] = [
    { id: "v1", kind: "video", z: 0, clips: pictures },
    { id: "a1", kind: "audio", z: 0, clips: sounds },
  ];
  return {
    units: "frames",
    canvas: { width: first?.width ?? 1920, height: first?.height ?? 1080, fps },
    tracks,
  } as Timeline;
}
