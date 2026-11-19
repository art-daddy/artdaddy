// The wake prompt is written for the MODEL: it lists ids and tells the agent how to behave.
// Showing that verbatim would put instructions in the transcript that the user did not write
// and does not need. This reduces it to the one line a person wants: what finished.
import { isOutOfCredits } from "../lib/outOfCredits";

const READY = /^- (.+?) (?:is|are) ready/;
const FAILED = /^- (.+?) FAILED: (.+)$/;
// A failed export's wake ends with its failure code, for the model: the person's line is the sentence before it.
const CODE = / \(failure_code: [a-z_]+\)$/;

export function jobNoteSummary(prompt: string): string {
  const ready: string[] = [];
  const failed: string[] = [];
  for (const line of prompt.split("\n")) {
    const f = FAILED.exec(line.trim());
    if (f) {
      const why = f[2].replace(CODE, "");
      failed.push(`${f[1]} failed — ${isOutOfCredits(why) ? "out of credits" : why}`);
      continue;
    }
    const r = READY.exec(line.trim());
    if (r) ready.push(r[1]);
  }
  const parts: string[] = [];
  if (ready.length) parts.push(`${list(ready)} ready`);
  parts.push(...failed);
  return parts.length ? parts.join(" · ") : "Background work finished";
}

function list(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
