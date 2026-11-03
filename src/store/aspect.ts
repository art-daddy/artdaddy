// The aspect choices a new project offers (start screen and File > New Project).
//
// "auto" leaves the canvas to the first video clip placed on the project (timeline/canvasAuto.ts); the
// others are a choice, and a choice is kept.
export const AUTO_ASPECT = "auto";

export const ASPECT_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: AUTO_ASPECT, label: "Auto (from your first clip)" },
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
];
