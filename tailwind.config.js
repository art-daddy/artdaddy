/** @type {import('tailwindcss').Config} */

// One accent, on a dark surround. The dark UI is not a style choice: bright chrome
// contaminates how you judge footage, which is why every NLE ships dark.
//
// The accent is amber rather than the leather brown of the logo — pure brown is too low
// in luminance and chroma to read against near-black and goes muddy. Amber keeps the
// same family and stays visible.
//
// The legacy tokens below are the SAME binding, not a copy, so `accent` and `brand`
// cannot drift apart.
const bg = "#0F0F11";
const surface = "#17171A";
const raised = "#1F1F24";
const edge = "#2A2A31";
const brand = "#C98A3E";
const brandHi = "#E0A45C";
const ink = "#F5F3F0";
const inkDim = "#A3A0A0";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg,
        surface,
        raised,
        edge,
        brand,
        "brand-hi": brandHi,
        // `ink` rather than the spec's `text`: a colour named `text` yields `text-text`.
        ink,
        "ink-dim": inkDim,
        success: "#4ADE80",
        warning: "#FBBF24",
        error: "#F87171",

        // Earlier names, kept so the ~60 existing `bg-accent` / `bg-panel` sites adopt the
        // palette without a rename. Prefer `brand` / `surface` in new markup.
        accent: brand,
        panel: surface,
      },
    },
  },
  plugins: [],
};
