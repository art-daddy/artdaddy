// RAN ONCE (19 Nov 2026) to write chooseEncoder.always.golden.json. That file's rows are pinned by hash in chooseEncoder.golden.test.ts and
// chooseEncoder.always.test.ts, so this script is never run again to make a test pass: if a row of the table moves, find out why.
//
// It does NOT call chooseEncoder. It reads the 0.27.0 table (chooseEncoder.golden.json, which stays as it is, byte for byte), expands it row
// by row in that table's own order, and applies the documented change of the rule to each row's old answer:
//   auto, a chip, the switch on          -> that chip, reason chip_default                      (what the rule changed)
//   auto, a chip, the switch off         -> the old answer (the processor, none)
//   auto, no chip                        -> the old answer (the processor's normal or faster setting)
//   full                                 -> the old answer (the processor, person)
//   fast, a chip                         -> that chip, reason person                            (what the rule changed)
//   fast, no chip                        -> the old answer (the processor, none)
// and the two row fields of every row by the new meaning: showRow is "a chip is usable"; defaultMode is fast exactly where a chip is usable and
// the switch is on.
//
// Run from the repository root: node src/timeline/__fixtures__/chooseEncoder.always.derive.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const OLD_FILE = "src/timeline/__fixtures__/chooseEncoder.golden.json";
const NEW_FILE = "src/timeline/__fixtures__/chooseEncoder.always.golden.json";
const OLD_ROWS_SHA256 = "b695117f9b34c1251a4b0cf3cb5c0dc7db83dc9da61fd6be35b9376a80c39bcc";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

const old = JSON.parse(readFileSync(OLD_FILE, "utf8"));
if (old.rowsSha256 !== OLD_ROWS_SHA256 || sha256(old.blocks.join("\n")) !== OLD_ROWS_SHA256)
  fail("the 0.27.0 table is not the one this script was written for");

// One block is every combination of the last three axes; the first six name the block.
const OUTER = old.order.slice(0, 6);
const INNER = old.order.slice(6);
if (OUTER.slice(0, 3).join() !== "request,chip,chipDefaultOn")
  fail("the first axes are not request, chip, chipDefaultOn");
const product = (axes) => axes.reduce((n, axis) => n * old.axes[axis].length, 1);
const blockSize = product(INNER);
if (old.blocks.length !== product(OUTER)) fail("the block count does not match the axes");
if (old.blocks.length * blockSize !== old.rows) fail("the row count does not match the axes");
for (const block of old.blocks) if (block.length !== blockSize) fail("a block has the wrong length");

/** The values of the first three axes of block `index` (a mixed-radix number, the last of the six axes varying fastest). */
function blockFacts(index) {
  const values = {};
  let rest = index;
  for (let at = OUTER.length - 1; at >= 0; at -= 1) {
    const list = old.axes[OUTER[at]];
    values[OUTER[at]] = list[rest % list.length];
    rest = Math.floor(rest / list.length);
  }
  return values;
}

/** An answer with its keys in the order the table keeps them in. */
const shaped = ({ encoder, preset, reason, showRow, defaultMode }) =>
  preset === undefined
    ? { encoder, reason, showRow, defaultMode }
    : { encoder, preset, reason, showRow, defaultMode };

const counts = { auto: 0, fast: 0, kept: 0, total: 0 };

function derive(before, { request, chip, chipDefaultOn }) {
  const hasChip = chip !== null;
  const row = { showRow: hasChip, defaultMode: hasChip && chipDefaultOn ? "fast" : "quality" };
  const same = () => shaped({ ...before, ...row });
  const processor = (reason) =>
    before.encoder === "x264" && before.preset === undefined && before.reason === reason;
  counts.total += 1;
  if (request === "auto" && hasChip && chipDefaultOn) {
    if (before.encoder !== chip) counts.auto += 1;
    return shaped({ encoder: chip, reason: "chip_default", ...row });
  }
  if (request === "auto" && hasChip) {
    if (!processor("none")) fail("an automatic request with the switch off was not the plain processor");
    return same();
  }
  if (request === "full") {
    if (!processor("person")) fail("a full request was not the plain processor, person");
    return same();
  }
  if (request === "fast" && hasChip) {
    if (before.encoder !== chip) counts.fast += 1;
    return shaped({ encoder: chip, reason: "person", ...row });
  }
  if (request === "fast") {
    if (!processor("none")) fail("a fast request with no chip was not the plain processor, none");
    return same();
  }
  if (request !== "auto") fail(`a request this script does not know: ${request}`);
  counts.kept += 1;
  return same();
}

const codes = new Map();
const legend = {};
const letters = "abcdefghijklmnopqrstuvwxyz";
const codeOf = (answer) => {
  const key = JSON.stringify(answer);
  if (!codes.has(key)) {
    const code = letters.charAt(codes.size);
    if (code === "") fail("more kinds of answer than letters");
    codes.set(key, code);
    legend[code] = answer;
  }
  return codes.get(key);
};

const blocks = old.blocks.map((block, index) => {
  const facts = blockFacts(index);
  let text = "";
  for (const char of block) {
    const before = old.legend[char];
    if (before === undefined) fail(`the old table has no answer for ${char}`);
    text += codeOf(derive(before, facts));
  }
  return text;
});

const table = {
  about:
    "chooseEncoder for the rule that uses the graphics chip whenever it passed its test for the picture's size and is not switched off, over every combination of the axes. " +
    "The rule changed on purpose: an automatic request gets the chip with no estimate, no length and no saving to pass first, and a person's Fast gets it whenever there is one. " +
    "The 0.27.0 table next to this one (chooseEncoder.golden.json) stays as it was, byte for byte, and this table was derived from it ONCE, row by row, by applying that change to each row's answer " +
    "(chooseEncoder.always.derive.mjs; it does not call the function). Never regenerated: if a row moves, find out why.",
  generatedFrom: {
    fixture: OLD_FILE,
    fixtureRowsSha256: OLD_ROWS_SHA256,
    release: "0.27.0",
    script: "src/timeline/__fixtures__/chooseEncoder.always.derive.mjs",
    function: "chooseEncoder",
  },
  order: old.order,
  axes: old.axes,
  rows: old.rows,
  rowsSha256: sha256(blocks.join("\n")),
  legend,
  blocks,
};
writeFileSync(NEW_FILE, JSON.stringify(table, null, 1) + "\n");

console.log(`rows ${counts.total}, kinds of answer ${codes.size}, rowsSha256 ${table.rowsSha256}`);
console.log(
  `cells whose chip answer replaced the processor's: auto ${counts.auto}, fast ${counts.fast}; auto cells with no chip kept as they were: ${counts.kept}`,
);
