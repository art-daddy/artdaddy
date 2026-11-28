// The footage the gap_media cases stand on: invented recordings whose content is fixed, so code can
// grade a highlights reel or a layout against what is really in them. Every fact a check uses is
// exported beside the clip that holds it (a goal's second, a speaker's spans, a folder's files),
// and the stand-ins (src/eval/footage.ts) tell the agent the same facts: `shots` are what a look at
// the pictures shows, `words` what is said, in SOURCE seconds. Nothing here comes from a real
// person's project: the names, places, paths and words are made up.
import type { FootageClip, FootageShot } from "../footage";

export type Row = readonly [string, number, number];
export type Span = readonly [number, number];

const shot = (from: number, to: number, shows: string): FootageShot => ({ from, to, shows });

/** A spoken row every `every` seconds over [from, to), cycling through `lines`, none inside `skip`. */
function filler(
  from: number,
  to: number,
  every: number,
  lines: readonly string[],
  skip: readonly Span[] = [],
  len = 5,
): Row[] {
  const rows: Row[] = [];
  let i = 0;
  for (let t = from; t + len <= to; t += every) {
    if (skip.some(([a, b]) => t + len > a && t < b)) continue;
    rows.push([lines[i % lines.length], t, t + len]);
    i += 1;
  }
  return rows;
}
const byTime = (...groups: readonly Row[][]): Row[] => groups.flat().sort((a, b) => a[1] - b[1]);

// ── gap 5: long recordings ─────────────────────────────────────────────────────────────────────

/** A 96-minute amateur cup final, one camera in the stand, a friend commentating. Blue won 3-1. */
export const MATCH = {
  ref: "media_match_final",
  seconds: 5760,
  /** Each goal: the team, the second the ball goes in, and the shot that shows it. */
  goals: [
    { team: "blue", at: 800, shot: [785, 815] },
    { team: "red", at: 2335, shot: [2320, 2350] },
    { team: "blue", at: 4295, shot: [4280, 4310] },
    { team: "blue", at: 5305, shot: [5290, 5320] },
  ],
  redCard: [4920, 4950],
  trophy: [5700, 5760],
  halfTime: [2700, 3600],
} as const;

const MATCH_SKIP: Span[] = [
  [780, 820],
  [2315, 2355],
  [2690, 3610],
  [4275, 4315],
  [4915, 4955],
  [5285, 5325],
  [5695, 5760],
];

export const MATCH_CLIP: FootageClip = {
  media_ref: MATCH.ref,
  filename: "cup_final_full.mp4",
  kind: "video",
  duration_s: MATCH.seconds,
  audio: true,
  sound: "Crowd noise from a small stand, the referee's whistle and a friend commentating.",
  shots: [
    shot(
      0,
      180,
      "players in blue shirts and in red shirts warming up on a grass pitch, filmed wide from the stand",
    ),
    shot(180, 785, "wide shot of open play in midfield; neither side gets near the goal"),
    shot(
      785,
      815,
      "the blue number 9 runs onto a through ball, shoots from the edge of the box and the ball flies into the top corner; the blue players run to the corner flag to celebrate",
    ),
    shot(815, 2320, "wide shot of open play, the red team pressing high"),
    shot(
      2320,
      2350,
      "a corner for red: a red player heads the ball in at the near post and the red players celebrate",
    ),
    shot(2350, 2700, "open play in midfield until the referee blows for half time"),
    shot(
      2700,
      3600,
      "half-time break: the pitch is empty and people stand on the touchline with drinks",
    ),
    shot(3600, 4280, "second half: wide shot of open play"),
    shot(
      4280,
      4310,
      "a penalty for blue: the blue captain shoots low to the keeper's left and scores; the blue players celebrate",
    ),
    shot(4310, 4920, "open play while both teams make substitutions"),
    shot(
      4920,
      4950,
      "a red defender makes a late tackle; the referee shows him a red card and he walks off",
    ),
    shot(4950, 5290, "blue on the attack, wide shot"),
    shot(
      5290,
      5320,
      "the blue number 7 shoots from thirty metres and the ball dips under the bar into the net; the blue players pile on him",
    ),
    shot(5320, 5700, "open play until the final whistle"),
    shot(
      5700,
      5760,
      "after the final whistle the blue team lifts a small trophy, everyone cheering",
    ),
  ],
  words: byTime(
    [
      ["And we're under way in the final.", 181, 185],
      ["Through ball for the number nine, he's clear...", 792, 798],
      ["He scores! Top corner! One nil to the blues!", 799, 804],
      ["Corner to the reds, swung in to the near post...", 2327, 2333],
      ["Headed in! One all.", 2334, 2338],
      ["That's half time, one each.", 2696, 2700],
      ["Back under way for the second half.", 3601, 3605],
      ["Penalty to the blues. The captain steps up...", 4283, 4290],
      ["Low to the left, and it's in! Two one to the blues.", 4294, 4299],
      ["Oh, that's a terrible tackle. And that's a red card, he's off.", 4926, 4934],
      ["Number seven, from way out... it's in! Three one!", 5301, 5309],
      ["There's the final whistle! The blues have won the cup!", 5700, 5706],
    ],
    filler(
      200,
      5690,
      75,
      [
        "Nice touch in the middle there.",
        "Reds keeping the ball well.",
        "Long ball forward, cleared.",
        "Throw-in to the blues.",
        "Good pressure from both sides.",
        "Not much happening at the moment.",
        "Free kick in midfield, played short.",
        "Switch of play out to the wing.",
      ],
      MATCH_SKIP,
    ),
  ),
};

/** A 72-minute panel: a moderator, three panelists, then questions from the floor. */
export const PANEL = {
  ref: "media_panel",
  seconds: 4320,
  /** When Mara speaks, every time. */
  mara: [
    [240, 540],
    [1270, 1480],
    [2210, 2390],
    [3340, 3500],
    [3745, 3990],
  ],
  /** The four turns at the floor microphone (the asking only, not the answers)... */
  questions: [
    [3120, 3155],
    [3300, 3340],
    [3500, 3530],
    [3700, 3745],
  ],
  /** ...and the words of each question inside them. */
  asked: [
    [3122, 3137],
    [3302, 3314],
    [3502, 3509],
    [3702, 3716],
  ],
} as const;

type Speaker = "theo" | "mara" | "felix" | "rosa" | "floor";
const PANEL_TURNS: [Speaker, number, number][] = [
  ["theo", 0, 240],
  ["mara", 240, 540],
  ["felix", 540, 840],
  ["rosa", 840, 1140],
  ["theo", 1140, 1270],
  ["mara", 1270, 1480],
  ["felix", 1480, 1720],
  ["rosa", 1720, 1950],
  ["theo", 1950, 2210],
  ["mara", 2210, 2390],
  ["felix", 2390, 2600],
  ["rosa", 2600, 2830],
  ["theo", 2830, 3120],
  ["floor", 3120, 3155],
  ["felix", 3155, 3300],
  ["floor", 3300, 3340],
  ["mara", 3340, 3500],
  ["floor", 3500, 3530],
  ["rosa", 3530, 3700],
  ["floor", 3700, 3745],
  ["mara", 3745, 3990],
  ["theo", 3990, 4320],
];
const PANEL_LOOK: Record<Speaker, [string, string]> = {
  theo: [
    "the moderator, a man in a dark suit, at the lectern; the lower third reads 'Theo Brandt, moderator'",
    "the moderator in the dark suit at the lectern",
  ],
  mara: [
    "close-up of the woman on the left of the stage in a grey blazer, speaking; the lower third reads 'Mara Lindqvist, marine biologist'",
    "close-up of the woman on the left in the grey blazer, speaking",
  ],
  felix: [
    "close-up of the man in the middle with glasses, speaking; the lower third reads 'Felix Amadi, robotics engineer'",
    "close-up of the man in the middle with glasses, speaking",
  ],
  rosa: [
    "close-up of the woman on the right with a red scarf, speaking; the lower third reads 'Rosa Ferreira, ocean policy adviser'",
    "close-up of the woman on the right with the red scarf, speaking",
  ],
  floor: [
    "a member of the audience at the microphone in the aisle, asking a question",
    "a member of the audience at the microphone in the aisle, asking a question",
  ],
};
const PANEL_LINES: Record<Exclude<Speaker, "floor">, string[]> = {
  theo: [
    "We have a full room tonight, thank you all for coming.",
    "Please keep your phones on silent.",
    "We'll take your questions at the end.",
  ],
  mara: [
    "Under the ice it stays completely dark for months.",
    "The seals there hold their breath for over an hour.",
    "We tag the animals and the robots listen for the tags.",
    "Most of what we know comes from a handful of winters.",
  ],
  felix: [
    "The hull has to survive the pressure at two thousand metres.",
    "We test every seal in a pressure tank first.",
    "Finding your way without satellites is the hard part.",
    "We map the underside of the ice with sonar.",
  ],
  rosa: [
    "Nobody owns the deep sea floor.",
    "The permits take longer than building the robot.",
    "The data should be public within a year.",
    "Fishing fleets want this data too.",
  ],
};
/** What each turn opens and closes with: the hand-overs that say who speaks. */
const PANEL_SAID: Row[] = [
  ["Good evening, and welcome to tonight's panel on robots in the deep ocean.", 4, 10],
  ["First, our marine biologist, Mara Lindqvist.", 232, 237],
  ["Thank you, Theo. I study the animals that live under the sea ice.", 242, 248],
  ["That's my side of it. Felix?", 532, 537],
  ["Thanks, Mara. I build the robots that go down there.", 542, 547],
  ["Rosa, your turn.", 834, 837],
  ["Thank you, Felix. I work on the rules for all of this.", 842, 848],
  ["Back to you, Theo.", 1134, 1137],
  [
    "What breaks first when a robot spends a winter under the ice? Mara, you've seen it up close.",
    1258,
    1267,
  ],
  ["The batteries, every time. The cold eats them.", 1272, 1277],
  ["Felix will disagree with me on that.", 1473, 1478],
  ["I do disagree, Mara. It's the seals on the hull.", 1482, 1487],
  ["Rosa?", 1715, 1717],
  ["From where I sit it's the paperwork that breaks first.", 1722, 1727],
  ["Who should own the data these robots collect? Mara, start us off.", 2198, 2206],
  ["Scientists should, and then everyone, as soon as possible.", 2212, 2217],
  ["I'm curious what Felix thinks.", 2384, 2388],
  ["Whoever pays for the robot, if we're honest.", 2392, 2397],
  ["Rosa, you've been shaking your head.", 2595, 2599],
  ["Because it has to be public, and the law should say so.", 2602, 2608],
  ["Let's open it up to the floor. There's a microphone in the aisle.", 2832, 2838],
  ["Yes, you in the front.", 3114, 3117],
  ["Hi. How do you power a robot that stays under the ice all winter?", 3122, 3130],
  ["Do you send it down with huge batteries?", 3132, 3137],
  ["Great question. We park it on a charging dock under the ice.", 3157, 3163],
  ["Thanks. Mara, have you ever lost a robot under the ice?", 3302, 3309],
  ["And what happened to it?", 3311, 3314],
  ["Twice. One of them turned up a year later, still recording.", 3342, 3349],
  ["Who pays for all of this? Is it public money?", 3502, 3509],
  ["Mostly public money, and that's why the data should be public.", 3532, 3539],
  ["Mara, what's the strangest animal you've seen on the cameras?", 3702, 3710],
  ["And did it ever attack the robot?", 3712, 3716],
  ["A sleeper shark, and no, it just looked at us for an hour.", 3747, 3754],
  ["We're out of time. Thank you to Mara, Felix and Rosa, and to all of you.", 4300, 4308],
];

export const PANEL_CLIP: FootageClip = {
  media_ref: PANEL.ref,
  filename: "deep_ocean_panel.mp4",
  kind: "video",
  duration_s: PANEL.seconds,
  audio: true,
  sound: "Voices through a hall's speakers and some applause; no music.",
  shots: PANEL_TURNS.map(([who, from, to], i) =>
    shot(from, to, PANEL_LOOK[who][PANEL_TURNS.findIndex(([w]) => w === who) === i ? 0 : 1]),
  ),
  words: byTime(
    PANEL_SAID,
    ...PANEL_TURNS.filter(([who]) => who !== "floor").map(([who, from, to]) =>
      filler(from + 15, to - 15, 40, PANEL_LINES[who as Exclude<Speaker, "floor">]),
    ),
  ),
};

/** A 62-minute lecture on tides, with one demonstration at a water tank. */
export const LECTURE = {
  ref: "media_lecture",
  seconds: 3720,
  demo: [1710, 1890],
} as const;

export const LECTURE_CLIP: FootageClip = {
  media_ref: LECTURE.ref,
  filename: "tides_lecture.mp4",
  kind: "video",
  duration_s: LECTURE.seconds,
  audio: true,
  shots: [
    shot(
      0,
      300,
      "a lecture hall; the lecturer, a woman in a green jumper, stands beside a slide titled 'Why the sea has two tides a day'",
    ),
    shot(300, 900, "the lecturer drawing the Earth and the Moon on a whiteboard"),
    shot(900, 1710, "a slide with a tide chart; the lecturer points at the peaks"),
    shot(
      1710,
      1890,
      "the lecturer lifts a jug of blue-dyed water over a glass tank of clear water and pours it in; the blue water sinks and spreads along the bottom in a layer",
    ),
    shot(1890, 2880, "back at the slides: a map of tidal ranges around the coast"),
    shot(2880, 2960, "the lecturer holds up a plastic model of the Moon"),
    shot(2960, 3720, "students raising their hands; the lecturer answers from the front"),
  ],
  words: byTime(
    [
      ["Good morning. Today is all about tides.", 5, 9],
      ["Okay, let me show you this with the tank.", 1700, 1705],
      ["This jug is salt water, dyed blue. Watch what happens when I pour it in.", 1712, 1719],
      [
        "See how it sinks and spreads along the bottom? Heavier water slides under lighter water.",
        1790,
        1799,
      ],
      ["Right, back to the slides.", 1884, 1888],
      ["Here's a little model of the Moon to pass around.", 2882, 2887],
    ],
    filler(
      20,
      3700,
      45,
      [
        "The Moon pulls on the oceans a little harder on the near side.",
        "There is a second bulge on the far side of the Earth.",
        "So most coasts get two high tides a day.",
        "Spring tides come when the Sun and the Moon line up.",
        "Neap tides are the weak ones, a week later.",
        "Write that down, it will be in the exam.",
      ],
      [
        [1690, 1900],
        [2875, 2895],
      ],
    ),
  ),
};

/** A 48-minute wedding ceremony filmed from the back of the room. */
export const CEREMONY = {
  ref: "media_ceremony",
  seconds: 2880,
  aisle: [420, 540],
  vows: [1500, 1680],
  rings: [1700, 1790],
  kiss: [1800, 1815],
} as const;

export const CEREMONY_CLIP: FootageClip = {
  media_ref: CEREMONY.ref,
  filename: "ceremony_full.mp4",
  kind: "video",
  duration_s: CEREMONY.seconds,
  audio: true,
  sound: "A string quartet before and after the ceremony; voices in between.",
  shots: [
    shot(0, 420, "guests arriving and taking their seats in a garden; a string quartet plays"),
    shot(
      420,
      540,
      "the walk down the aisle: Ana walks down the aisle on her father's arm between the rows of guests",
    ),
    shot(
      540,
      900,
      "the officiant welcomes everyone; Ana and Leo stand in front of an arch of flowers",
    ),
    shot(900, 1500, "two friends take turns reading at a small lectern"),
    shot(1500, 1590, "Leo reads his vows from a card"),
    shot(1590, 1680, "Ana reads her vows, laughing halfway through"),
    shot(1680, 1700, "the officiant asks for the rings; the best man hands them over"),
    shot(1700, 1790, "the ring exchange: Leo and Ana put the rings on each other's fingers"),
    shot(1790, 1800, "the officiant pronounces them married"),
    shot(1800, 1815, "the kiss: Ana and Leo kiss and the guests stand up and cheer"),
    shot(1815, 1900, "Ana and Leo walk back up the aisle together while guests throw petals"),
    shot(1900, 2880, "after the ceremony: group photos and guests chatting; the camera wanders"),
  ],
  words: byTime(
    [
      ["Welcome, everyone. We're here today for Ana and Leo.", 545, 551],
      ["Our first reading is from Ana's sister.", 902, 906],
      ["I, Leo, take you, Ana, to be my partner, today and every day after.", 1505, 1513],
      ["I promise to listen, even when you talk about football.", 1540, 1546],
      ["I, Ana, take you, Leo. I promise to laugh at your jokes, most of them.", 1595, 1604],
      ["That is my promise to you.", 1582, 1588],
      ["And I will love you, always.", 1673, 1679],
      ["May we have the rings, please?", 1683, 1687],
      ["With this ring, I marry you.", 1712, 1716],
      ["With this ring, I marry you.", 1752, 1756],
      ["I now pronounce you married. You may kiss!", 1791, 1798],
      ["Everyone, please follow the couple out for photos.", 1905, 1911],
    ],
    filler(960, 1490, 50, [
      "Love is patient, love is kind.",
      "Two are better than one.",
      "Let your love be like the morning sun.",
    ]),
    // The vows are read without a pause, start to finish.
    filler(
      1514,
      1588,
      10,
      [
        "I promise to make you coffee on Sundays.",
        "I promise to be on your side, even when you are wrong.",
        "I promise to keep learning who you are.",
      ],
      [[1538, 1548]],
      8,
    ),
    filler(
      1605,
      1678,
      10,
      [
        "I promise to tell you the truth, kindly.",
        "I promise to dance badly at every wedding we go to.",
        "I promise you a home, wherever we are.",
      ],
      [],
      8,
    ),
  ),
};

/** A two-hour game stream: three tries at the dragon, the third one won. */
export const STREAM = {
  ref: "media_stream",
  seconds: 7200,
  /** The fight that was won, and the second the dragon falls. */
  win: [6300, 6780],
  dragonFalls: 6745,
  /** The two tries that were lost. */
  lost: [
    [5300, 5420],
    [5800, 5950],
  ],
} as const;

export const STREAM_CLIP: FootageClip = {
  media_ref: STREAM.ref,
  filename: "stream_vod_full.mp4",
  kind: "video",
  duration_s: STREAM.seconds,
  audio: true,
  sound: "Game music and sound effects under the streamer's voice.",
  shots: [
    shot(0, 600, "the streamer's webcam in a corner over a game menu; he chats with viewers"),
    shot(600, 1500, "gameplay: the player explores a snowy forest"),
    shot(
      1500,
      1740,
      "a boss fight against a giant spider; a health bar at the top reads 'Spider Queen'",
    ),
    shot(1740, 3900, "gameplay: the player crosses a mountain pass and trades in a village"),
    shot(3900, 4260, "a boss fight against a stone giant; the health bar reads 'Stone Giant'"),
    shot(4260, 5300, "gameplay: the player climbs towards a volcano"),
    shot(
      5300,
      5420,
      "a fight with a huge red dragon, health bar 'Ashwing'; the player dies and 'YOU DIED' fills the screen",
    ),
    shot(5420, 5800, "the streamer changes his gear and talks to chat"),
    shot(5800, 5950, "a second fight with the red dragon; the player dies again"),
    shot(5950, 6300, "the streamer takes a short break; a 'back soon' card"),
    shot(
      6300,
      6745,
      "a third fight with the red dragon 'Ashwing'; the player dodges fire and keeps attacking",
    ),
    shot(
      6745,
      6780,
      "the dragon collapses, a 'VICTORY' banner fills the screen and the streamer jumps up cheering on the webcam",
    ),
    shot(6780, 7200, "the streamer thanks viewers and reads chat messages"),
  ],
  words: byTime(
    [
      ["Okay chat, spider queen time.", 1498, 1502],
      ["Here's the stone giant, wish me luck.", 3898, 3903],
      ["There it is. The dragon. First try, let's go.", 5298, 5304],
      ["No! I died. Okay, again.", 5416, 5421],
      ["Second try at the dragon.", 5798, 5802],
      ["Died again. I need a break.", 5946, 5951],
      ["Okay chat, dragon time. Third try.", 6296, 6301],
      ["Yes! We did it! The dragon is dead!", 6747, 6753],
      ["Thanks for watching, everyone.", 7150, 7154],
    ],
    filler(
      10,
      7190,
      90,
      [
        "Thanks for the follow!",
        "Let me check the map.",
        "Chat, which way should I go?",
        "I need more potions.",
        "This music is great.",
      ],
      [
        [1495, 1745],
        [3895, 4265],
        [5295, 5425],
        [5795, 5955],
        [6290, 6785],
        [7145, 7160],
      ],
    ),
  ),
};

/** An 88-minute podcast episode with a baker as the guest, in four parts. */
export const PODCAST = {
  ref: "media_podcast",
  seconds: 5280,
  topics: [
    [0, 1200],
    [1200, 2700],
    [2700, 4200],
    [4200, 5280],
  ],
  /** Where she explains how she prices her bread. */
  breadPricing: [1830, 1950],
} as const;

export const PODCAST_CLIP: FootageClip = {
  media_ref: PODCAST.ref,
  filename: "small_business_podcast_ep42.mp4",
  kind: "video",
  duration_s: PODCAST.seconds,
  audio: true,
  shots: [
    shot(0, 1200, "two hosts and a guest at a table with microphones, a bakery logo on the wall"),
    shot(
      1200,
      2700,
      "the same table; the guest, a baker in a flour-dusted apron, talks with her hands",
    ),
    shot(2700, 4200, "the same table; one host reads from a notebook"),
    shot(4200, 5280, "the same table; a host reads questions from a phone"),
  ],
  words: byTime(
    [
      ["Welcome back to the show. Today our guest runs a bakery.", 3, 9],
      ["How did it all start? I was baking at home at night.", 30, 37],
      ["Let's talk money. How do you set your prices?", 1201, 1206],
      ["For bread it's simple: we price by the weight of the loaf.", 1832, 1839],
      ["The flour is about a fifth of the price, the rest is time and the oven.", 1850, 1858],
      ["A big sourdough costs more because it proves for two days.", 1880, 1887],
      ["And we round every loaf to a whole number so the till is quick.", 1910, 1917],
      ["That's how we price bread.", 1940, 1944],
      ["Okay, let's move on to hiring.", 2701, 2705],
      ["Hiring my first baker was the scariest thing I've done.", 2712, 2718],
      ["Now some questions from our listeners.", 4201, 4205],
      ["That's all for this week, thanks for listening.", 5260, 5265],
    ],
    filler(45, 1195, 45, [
      "I sold my first loaves at a market stall.",
      "My first oven was second hand.",
      "We opened the shop after two years of markets.",
    ]),
    filler(
      1215,
      2695,
      45,
      [
        "Coffee is where the margin is.",
        "Wholesale customers want a discount.",
        "We raised prices once and nobody left.",
      ],
      [[1825, 1955]],
    ),
    filler(2725, 4195, 45, [
      "I wrote the job advert three times.",
      "Training takes about a month.",
      "Now we're a team of five.",
    ]),
    filler(4215, 5255, 45, [
      "A listener asks how early we start. Four in the morning.",
      "Someone asks about gluten-free bread.",
      "Another listener wants to open a cafe.",
    ]),
  ),
};

/** A 42-minute gig: seven songs, with talking and tuning in between. */
export const GIG = {
  ref: "media_gig",
  seconds: 2520,
  songs: [
    [60, 290],
    [350, 590],
    [660, 900],
    [1010, 1260],
    [1330, 1590],
    [1700, 2000],
    [2150, 2400],
  ],
} as const;

const GIG_BETWEEN: string[] = [
  "Thank you! This next one's about my brother.",
  "Hang on, I need to tune this guitar.",
  "Is the sound okay at the back?",
  "We've got a record out next month.",
  "Thanks for coming out on a Tuesday.",
  "Thank you, that's our set!",
  "Thank you, goodnight!",
];

const GIG_LYRICS = [
  "♪ we ran all night along the river ♪",
  "♪ and the lights went out on the bridge ♪",
  "♪ hold on, hold on ♪",
];
/** A song sung from just after its first bar to its last, in ten-second lines. */
function sung([a, b]: readonly [number, number]): Row[] {
  const rows: Row[] = [];
  for (let t = a + 2, i = 0; t < b - 1; t += 10, i += 1)
    rows.push([GIG_LYRICS[i % GIG_LYRICS.length], t, Math.min(t + 10, b - 1)]);
  return rows;
}

export const GIG_CLIP: FootageClip = {
  media_ref: GIG.ref,
  filename: "gig_full_set.mp4",
  kind: "video",
  duration_s: GIG.seconds,
  audio: true,
  sound: "A live four-piece band and a small crowd cheering between songs.",
  shots: [
    shot(0, 60, "the band on a small stage; the singer talks to the crowd"),
    ...GIG.songs.flatMap(([a, b], i): FootageShot[] => [
      shot(a, b, `the band playing song ${i + 1}, the singer at the microphone`),
      shot(
        b,
        i + 1 < GIG.songs.length ? GIG.songs[i + 1][0] : GIG.seconds,
        i === 5
          ? "the band leaves the stage while the crowd chants for more"
          : i === 6
            ? "the band waves goodbye and the lights come up"
            : "between songs: the singer talks to the crowd while the guitarist tunes",
      ),
    ]),
  ],
  words: byTime(
    [["Good evening! We're the Night Ferries.", 10, 15]],
    ...GIG.songs.map(sung),
    GIG.songs.map(([, b], i): Row => [GIG_BETWEEN[i], b + 10, b + 16]),
  ),
};

/** 34 minutes of drone footage along a coast, no sound. A red sailing boat is in three shots. */
export const DRONE = {
  ref: "media_drone",
  seconds: 2040,
  boat: [
    [410, 470],
    [1220, 1300],
    [1790, 1830],
  ],
} as const;

export const DRONE_CLIP: FootageClip = {
  media_ref: DRONE.ref,
  filename: "drone_coast_raw.mp4",
  kind: "video",
  duration_s: DRONE.seconds,
  audio: false,
  shots: [
    shot(0, 410, "the drone rises over a beach and turns along white cliffs"),
    shot(410, 470, "a red sailing boat crosses the bay below the cliffs"),
    shot(470, 900, "waves breaking on rocks, seen from straight above"),
    shot(900, 960, "a white motorboat speeds past a lighthouse"),
    shot(960, 1220, "a long pass along the cliff tops"),
    shot(1220, 1300, "the red sailing boat again, closer, its sail filling"),
    shot(1300, 1790, "a fishing village and its harbour"),
    shot(1790, 1830, "the red sailing boat enters the harbour"),
    shot(1830, 2040, "the drone lands on the beach"),
  ],
};

/** Three long travel vlogs, one per day, each with one moment worth keeping. */
export const TRIP = {
  days: [
    { ref: "media_trip_day1", seconds: 2160, moment: [1530, 1560] },
    { ref: "media_trip_day2", seconds: 2400, moment: [980, 1000] },
    { ref: "media_trip_day3", seconds: 1980, moment: [1700, 1760] },
  ],
} as const;

export const TRIP_CLIPS: FootageClip[] = [
  {
    media_ref: TRIP.days[0].ref,
    filename: "day1_mountain_hike.mp4",
    kind: "video",
    duration_s: TRIP.days[0].seconds,
    audio: true,
    shots: [
      shot(0, 1530, "a hiker filming herself on a steep mountain path"),
      shot(
        1530,
        1560,
        "she reaches the summit cairn, raises her arms and turns the camera to the valley",
      ),
      shot(1560, 2160, "the walk back down"),
    ],
    words: [
      ["Day one, the big climb.", 4, 8],
      ["We made it! The summit!", 1533, 1538],
    ],
  },
  {
    media_ref: TRIP.days[1].ref,
    filename: "day2_kayaking.mp4",
    kind: "video",
    duration_s: TRIP.days[1].seconds,
    audio: true,
    shots: [
      shot(0, 980, "paddling a kayak along a calm coast"),
      shot(980, 1000, "a whale's tail rises out of the water right next to the kayak"),
      shot(1000, 2400, "paddling back to the beach"),
    ],
    words: [
      ["Day two, out on the water.", 4, 8],
      ["Whoa, a whale! Right there!", 983, 988],
    ],
  },
  {
    media_ref: TRIP.days[2].ref,
    filename: "day3_old_town.mp4",
    kind: "video",
    duration_s: TRIP.days[2].seconds,
    audio: true,
    shots: [
      shot(0, 1700, "walking through an old town's narrow streets"),
      shot(1700, 1760, "fireworks burst over the harbour"),
      shot(1760, 1980, "the crowd heading home after the fireworks"),
    ],
    words: [
      ["Day three, exploring the old town.", 4, 8],
      ["Look at those fireworks!", 1705, 1709],
    ],
  },
];

/** A 28-minute skatepark session: five tricks landed, two falls, a lot of waiting. */
export const SKATE = {
  ref: "media_skate",
  seconds: 1680,
  /** Every moment worth a short: the five landed tricks and the two falls. */
  moments: [
    [212, 220],
    [420, 428],
    [640, 650],
    [980, 990],
    [1105, 1114],
    [1388, 1398],
    [1590, 1602],
  ],
} as const;

export const SKATE_CLIP: FootageClip = {
  media_ref: SKATE.ref,
  filename: "skatepark_session.mp4",
  kind: "video",
  duration_s: SKATE.seconds,
  audio: true,
  shots: [
    shot(0, 212, "skaters waxing a ledge and chatting"),
    shot(212, 220, "a skater lands a clean kickflip"),
    shot(220, 420, "waiting at the top of the bowl"),
    shot(420, 428, "a skater falls hard off the ledge"),
    shot(428, 640, "skaters sitting on their boards, talking"),
    shot(640, 650, "a skater lands a heelflip down the stairs"),
    shot(650, 980, "a long wait while someone fixes a wheel"),
    shot(980, 990, "a skater slams on the rail"),
    shot(990, 1105, "skaters chatting by the fence"),
    shot(1105, 1114, "a skater lands a tre flip"),
    shot(1114, 1388, "warm-up laps around the park"),
    shot(1388, 1398, "a skater does a long boardslide on the rail"),
    shot(1398, 1590, "skaters taking a drink break"),
    shot(1590, 1602, "a skater lands a 50-50 down the big rail; everyone cheers"),
    shot(1602, 1680, "the skaters pack up"),
  ],
  words: [
    ["Let's go!", 219, 221],
    ["Ouch, you okay?", 428, 431],
    ["Down the stairs! Yes!", 649, 652],
    ["That looked painful.", 990, 993],
    ["Tre flip! Clean!", 1113, 1116],
    ["Look at that slide!", 1397, 1400],
    ["The big rail! Let's go!", 1601, 1604],
  ],
};

// ── gap 6: media to bring in and lay out ───────────────────────────────────────────────────────

/** A video file on disk or in the library, with no content anyone asks about. */
function plain(
  ref: string,
  filename: string,
  seconds: number,
  shows: string,
  more: Partial<FootageClip> = {},
): FootageClip {
  return {
    media_ref: ref,
    filename,
    kind: "video",
    duration_s: seconds,
    audio: true,
    shots: [shot(0, seconds, shows)],
    ...more,
  };
}
/** A photo on disk or in the library. Its ref carries the image's extension: placement reads a
 *  clip's kind from it (timeline/helpers.ts placeableKind), and the eval's store has no catalog. */
function photo(
  ref: string,
  filename: string,
  shows: string,
  more: Partial<FootageClip> = {},
): FootageClip {
  return { media_ref: ref, filename, kind: "image", shots: [shot(0, 0, shows)], ...more };
}

/** Six harbour clips in one folder on disk. */
export const HARBOUR_DIR = "D:/Footage/harbour";
export const HARBOUR = [
  ["media_harbour_01", "harbour_01.mp4", 12, "fishing boats tied up at dawn"],
  ["media_harbour_02", "harbour_02.mp4", 9, "a man mending nets"],
  ["media_harbour_03", "harbour_03.mp4", 15, "gulls over the fish market"],
  ["media_harbour_04", "harbour_04.mp4", 8, "a crane unloading crates"],
  ["media_harbour_05", "harbour_05.mp4", 11, "a ferry leaving the harbour"],
  ["media_harbour_06", "harbour_06.mp4", 10, "the harbour lights at dusk"],
] as const;
export function harbourClips(inLibrary: (i: number) => boolean): FootageClip[] {
  return HARBOUR.map(([ref, file, seconds, shows], i) =>
    plain(ref, file, seconds, shows, { path: `${HARBOUR_DIR}/${file}`, inLibrary: inLibrary(i) }),
  );
}

/** Eleven numbered takes in one folder: a plain name sort puts take 10 and 11 before take 2. */
export const TAKES_DIR = "E:/Shoot/takes";
export const TAKES = Array.from({ length: 11 }, (_, i) => ({
  ref: `media_take_${String(i + 1).padStart(2, "0")}`,
  filename: `take ${i + 1}.mp4`,
  seconds: 4 + (i % 3),
}));
export const TAKES_CLIPS: FootageClip[] = TAKES.map((t, i) =>
  plain(t.ref, t.filename, t.seconds, `take ${i + 1} of a product shot: a cup turning on a table`, {
    path: `${TAKES_DIR}/${t.filename}`,
    inLibrary: false,
  }),
);

/** Five market clips in a folder on disk. */
export const MARKET_DIR = "D:/Footage/market";
export const MARKET_CLIPS: FootageClip[] = [
  ["media_market_1", "market_fruit.mp4", 7, "a fruit stall"],
  ["media_market_2", "market_fish.mp4", 9, "a fish stall on ice"],
  ["media_market_3", "market_flowers.mp4", 6, "buckets of flowers"],
  ["media_market_4", "market_bread.mp4", 8, "loaves in baskets"],
  ["media_market_5", "market_crowd.mp4", 10, "a busy crowd from above"],
].map(([ref, file, seconds, shows]) =>
  plain(String(ref), String(file), Number(seconds), String(shows), {
    path: `${MARKET_DIR}/${String(file)}`,
    inLibrary: false,
  }),
);

/** Four files on disk the person names in an order of their own. */
export const SHOOT = {
  drone: { ref: "media_drone_open", file: "drone_open.mp4", seconds: 9 },
  interview: { ref: "media_interview_a", file: "interview_a.mp4", seconds: 40 },
  market: { ref: "media_broll_market", file: "broll_market.mp4", seconds: 12 },
  sunset: { ref: "media_outro_sunset", file: "outro_sunset.mp4", seconds: 8 },
} as const;
export const SHOOT_CLIPS: FootageClip[] = [
  plain(SHOOT.drone.ref, SHOOT.drone.file, 9, "a drone shot rising over rooftops", {
    path: `D:/Shoot/${SHOOT.drone.file}`,
    inLibrary: false,
  }),
  plain(
    SHOOT.interview.ref,
    SHOOT.interview.file,
    40,
    "a woman talking to the camera in her kitchen",
    { path: `D:/Shoot/${SHOOT.interview.file}`, inLibrary: false },
  ),
  plain(SHOOT.market.ref, SHOOT.market.file, 12, "close-ups of a busy market", {
    path: `D:/Shoot/${SHOOT.market.file}`,
    inLibrary: false,
  }),
  plain(SHOOT.sunset.ref, SHOOT.sunset.file, 8, "the sun setting over the sea", {
    path: `D:/Shoot/${SHOOT.sunset.file}`,
    inLibrary: false,
  }),
];

/** A folder of three photos and two videos; the filenames start with their order. */
export const LISBON_DIR = "D:/Trip/lisbon";
export const LISBON = [
  { ref: "media_lisbon_01.jpg", file: "01_tram.jpg", kind: "image", seconds: 0 },
  { ref: "media_lisbon_02", file: "02_tram_ride.mp4", kind: "video", seconds: 14 },
  { ref: "media_lisbon_03.jpg", file: "03_tiles.jpg", kind: "image", seconds: 0 },
  { ref: "media_lisbon_04", file: "04_viewpoint.mp4", kind: "video", seconds: 11 },
  { ref: "media_lisbon_05.jpg", file: "05_pastries.jpg", kind: "image", seconds: 0 },
] as const;
export const LISBON_CLIPS: FootageClip[] = LISBON.map((m) =>
  m.kind === "image"
    ? photo(m.ref, m.file, `a photo: ${m.file.slice(3, -4).replace(/_/g, " ")}`, {
        path: `${LISBON_DIR}/${m.file}`,
        inLibrary: false,
      })
    : plain(m.ref, m.file, m.seconds, `a video: ${m.file.slice(3, -4).replace(/_/g, " ")}`, {
        path: `${LISBON_DIR}/${m.file}`,
        inLibrary: false,
      }),
);

/** Eight harbour photos and a 48-second song, already in the library. */
export const QUAY = {
  photos: Array.from({ length: 8 }, (_, i) => `media_quay_${i + 1}.jpg`),
  song: { ref: "media_song_evening", file: "evening_walk.mp3", seconds: 48 },
} as const;
export const QUAY_CLIPS: FootageClip[] = [
  ...QUAY.photos.map((ref, i) =>
    photo(ref, `quay_${i + 1}.jpg`, `a photo of the quay, number ${i + 1} of a walk at dusk`, {
      folder: "Photos",
    }),
  ),
  {
    media_ref: QUAY.song.ref,
    filename: QUAY.song.file,
    kind: "audio",
    duration_s: QUAY.song.seconds,
    audio: true,
    sound: "A slow acoustic guitar tune, no singing.",
    folder: "Music",
  },
];

/** A ten-minute screen recording on the timeline, and the webcam recorded with it. */
export const TUTORIAL = {
  screen: { ref: "media_screen_rec", seconds: 600 },
  webcam: { ref: "media_webcam", seconds: 600 },
} as const;
export const TUTORIAL_CLIPS: FootageClip[] = [
  plain(
    TUTORIAL.screen.ref,
    "screen_recording.mp4",
    600,
    "a spreadsheet being edited on a computer screen",
    { audio: false },
  ),
  plain(TUTORIAL.webcam.ref, "webcam.mp4", 600, "a man at a desk talking to the camera", {
    sound: "The man's voice, explaining what he does on screen.",
  }),
];

/** A three-minute interview on the timeline and three cutaways in a folder on disk. */
export const INTERVIEW = { ref: "media_baker_interview", seconds: 180 } as const;
export const BROLL_DIR = "D:/Footage/broll";
export const BROLL = {
  oven: { ref: "media_broll_oven", file: "bakery_oven.mp4", at: 10 },
  flour: { ref: "media_broll_flour", file: "flour_pour.mp4", at: 45 },
  shop: { ref: "media_broll_shop", file: "shop_front.mp4", at: 80 },
} as const;
export const INTERVIEW_CLIPS: FootageClip[] = [
  plain(INTERVIEW.ref, "baker_interview.mp4", 180, "a baker talking to the camera in her shop", {
    sound: "The baker's voice and a quiet hum from the fridges.",
  }),
  ...Object.values(BROLL).map((b) =>
    plain(b.ref, b.file, 12, `a cutaway: ${b.file.slice(0, -4).replace(/_/g, " ")}`, {
      path: `${BROLL_DIR}/${b.file}`,
      inLibrary: false,
      sound: "Kitchen noise.",
    }),
  ),
];

/** Three scenes already in the library. */
export const SCENES = [
  { ref: "media_scene_one", file: "scene_one.mp4", seconds: 10 },
  { ref: "media_scene_two", file: "scene_two.mp4", seconds: 8 },
  { ref: "media_scene_three", file: "scene_three.mp4", seconds: 12 },
] as const;
export const SCENES_CLIPS: FootageClip[] = SCENES.map((s, i) =>
  plain(s.ref, s.file, s.seconds, `scene ${i + 1} of a short film`, { folder: "Scenes" }),
);

/** A 30-asset library in folders; Day 2's filenames start with the time each clip was shot. */
export const DAY2 = [
  { ref: "media_d2_harbour", file: "D2_0915_harbour.mp4", seconds: 14 },
  { ref: "media_d2_sunrise", file: "D2_0742_sunrise.mp4", seconds: 10 },
  { ref: "media_d2_lunch", file: "D2_1310_lunch.mp4", seconds: 9 },
  { ref: "media_d2_market", file: "D2_1102_market.mp4", seconds: 12 },
  { ref: "media_d2_beach", file: "D2_1630_beach.mp4", seconds: 16 },
  { ref: "media_d2_dinner", file: "D2_1955_dinner.mp4", seconds: 11 },
] as const;
export const DAY2_IN_SHOOTING_ORDER = [
  "media_d2_sunrise",
  "media_d2_harbour",
  "media_d2_market",
  "media_d2_lunch",
  "media_d2_beach",
  "media_d2_dinner",
] as const;
const OTHER_DAYS: FootageClip[] = [
  ...[
    "D1_0810_station",
    "D1_0955_train",
    "D1_1230_arrival",
    "D1_1500_hotel",
    "D1_1745_walk",
    "D1_2010_bar",
    "D1_2200_night",
  ].map((name, i) =>
    plain(`media_d1_${i + 1}`, `${name}.mp4`, 8 + i, name.slice(8).replace(/_/g, " "), {
      folder: "Day 1",
    }),
  ),
  ...[
    "D3_0700_run",
    "D3_0930_museum",
    "D3_1200_park",
    "D3_1415_boat",
    "D3_1730_rooftop",
    "D3_2100_concert",
  ].map((name, i) =>
    plain(`media_d3_${i + 1}`, `${name}.mp4`, 9 + i, name.slice(8).replace(/_/g, " "), {
      folder: "Day 3",
    }),
  ),
  ...["arrival_sign", "map", "tickets", "postcard", "selfie_bridge", "group_photo"].map((name, i) =>
    photo(`media_still_${i + 1}.jpg`, `${name}.jpg`, `a photo: ${name.replace(/_/g, " ")}`, {
      folder: "Stills",
    }),
  ),
  ...["upbeat_theme", "calm_guitar", "city_ambience", "drum_loop", "piano_outro"].map(
    (name, i): FootageClip => ({
      media_ref: `media_music_${i + 1}`,
      filename: `${name}.mp3`,
      kind: "audio",
      duration_s: 60 + i * 15,
      audio: true,
      folder: "Music",
    }),
  ),
];
export const BIG_LIBRARY: FootageClip[] = [
  ...OTHER_DAYS.slice(0, 7),
  ...DAY2.map((d) => plain(d.ref, d.file, d.seconds, d.file.slice(8, -4), { folder: "Day 2" })),
  ...OTHER_DAYS.slice(7),
];

/** A small library: five videos, three photos and one song. */
export const SMALL_LIBRARY = {
  videos: ["media_lib_v1", "media_lib_v2", "media_lib_v3", "media_lib_v4", "media_lib_v5"],
  photos: ["media_lib_p1.jpg", "media_lib_p2.jpg", "media_lib_p3.jpg"],
  song: "media_lib_song",
} as const;
export const SMALL_LIBRARY_CLIPS: FootageClip[] = [
  plain("media_lib_v1", "beach_walk.mp4", 11, "a walk along a beach"),
  photo("media_lib_p1.jpg", "shells.jpg", "a photo of shells on sand"),
  plain("media_lib_v2", "surf_lesson.mp4", 15, "a surf lesson"),
  plain("media_lib_v3", "cafe.mp4", 8, "coffee being poured in a beach cafe"),
  photo("media_lib_p2.jpg", "sunset.jpg", "a photo of a sunset"),
  {
    media_ref: "media_lib_song",
    filename: "summer_song.mp3",
    kind: "audio",
    duration_s: 95,
    audio: true,
    sound: "An upbeat pop song.",
  },
  plain("media_lib_v4", "volleyball.mp4", 13, "a beach volleyball game"),
  photo("media_lib_p3.jpg", "family.jpg", "a photo of a family on the sand"),
  plain("media_lib_v5", "bonfire.mp4", 10, "a bonfire at night"),
];

/** Two camera angles of one interview, recorded together, already in the library. */
export const ANGLES = {
  wide: { ref: "media_cam_wide", seconds: 300 },
  close: { ref: "media_cam_close", seconds: 300 },
} as const;
export const ANGLES_CLIPS: FootageClip[] = [
  plain(ANGLES.wide.ref, "cam_a_wide.mp4", 300, "a wide shot of two people talking at a table"),
  plain(ANGLES.close.ref, "cam_b_closeup.mp4", 300, "a close-up of the guest talking"),
];

/** A voiceover and a piece of music, on disk. */
export const AUDIO_DIR = "D:/Audio";
export const VOICE = {
  ref: "media_voiceover_final",
  file: "voiceover_final.wav",
  seconds: 95,
} as const;
export const PIANO = { ref: "media_calm_piano", file: "calm_piano.mp3", seconds: 180 } as const;
export const AUDIO_CLIPS: FootageClip[] = [
  {
    media_ref: VOICE.ref,
    filename: VOICE.file,
    kind: "audio",
    duration_s: VOICE.seconds,
    audio: true,
    sound: "A woman's voice narrating, no music.",
    path: `${AUDIO_DIR}/${VOICE.file}`,
    inLibrary: false,
    words: [
      ["Every town has a story, and ours starts at the river.", 1, 6],
      ["That's the story of our river.", 90, 94],
    ],
  },
  {
    media_ref: PIANO.ref,
    filename: PIANO.file,
    kind: "audio",
    duration_s: PIANO.seconds,
    audio: true,
    sound: "Slow solo piano.",
    path: `${AUDIO_DIR}/${PIANO.file}`,
    inLibrary: false,
  },
];

/** A 40-second narration on the timeline, five sentences, and a photo for each in the library. */
export const LIGHTHOUSE = {
  narration: { ref: "media_lighthouse_narration", seconds: 40 },
  /** Where each sentence is spoken, in seconds: uneven, so five equal slots do not fit them. */
  sentences: [
    [0.5, 4],
    [4.5, 13.5],
    [14, 18],
    [18.5, 31],
    [31.5, 39],
  ],
  photos: [1, 2, 3, 4, 5].map((i) => `media_lighthouse_${i}.jpg`),
} as const;
const LIGHTHOUSE_SAID = [
  "The lighthouse was built in eighteen sixty on bare rock.",
  "Its first keeper lived there alone with his dog.",
  "In the great storm the lamp stayed lit all night.",
  "The light was made automatic in nineteen eighty.",
  "Today it is a museum you can climb.",
];
export const LIGHTHOUSE_CLIPS: FootageClip[] = [
  {
    media_ref: LIGHTHOUSE.narration.ref,
    filename: "lighthouse_narration.wav",
    kind: "audio",
    duration_s: LIGHTHOUSE.narration.seconds,
    audio: true,
    words: LIGHTHOUSE.sentences.map(([a, b], i): Row => [LIGHTHOUSE_SAID[i], a, b]),
  },
  ...LIGHTHOUSE.photos.map((ref, i) =>
    photo(
      ref,
      `lighthouse_${i + 1}.jpg`,
      [
        "an old engraving of the lighthouse on its rock",
        "a faded photo of a keeper and his dog",
        "a painting of waves breaking over the lighthouse at night",
        "a photo of the automatic lamp machinery",
        "a photo of visitors climbing the lighthouse stairs",
      ][i],
    ),
  ),
];

/** Four garden clips in the library, and two more the person is still importing. */
export const GARDEN = {
  inLibrary: ["media_garden_1", "media_garden_2", "media_garden_3", "media_garden_4"],
  importing: ["garden_5.mp4", "garden_6.mp4"],
} as const;
export const GARDEN_CLIPS: FootageClip[] = GARDEN.inLibrary.map((ref, i) =>
  plain(
    ref,
    `garden_${i + 1}.mp4`,
    6 + i,
    `a garden shot, number ${i + 1}: flowers in the morning`,
  ),
);
