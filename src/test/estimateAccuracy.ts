// The accuracy compare of the estimate: one pure function over a table of cells, so that the same rule judges 0.27.0's recorded estimates now and the new estimator's when it has been fitted. It lives with the tests: nothing in the app reads it.
//
// A cell: its row and profile, the seconds of video, the seconds the estimate said, the seconds the export really took and, when the estimate showed one, its range and whether it said "could take much longer".

export const BAR = Object.freeze({ factor: 2, share: 0.9, minCells: 10, underFactor: 4 });

export interface AccuracyCell {
  row: string;
  profile: string;
  videoS: number;
  estimate: number | null | undefined;
  measured: number;
  low?: number | null;
  high?: number | null;
  couldTakeMuchLonger?: boolean;
}

export interface Share {
  n: number;
  ok: number;
  share: number | null;
}

export interface Verdict {
  verdict: "pass" | "fail" | "insufficient";
  reasons: string[];
  thin: string[];
  judged: number;
  measures: { within2: Share; within2Weak: Share; insideRange: Share; silentUnder4: number };
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const usable = (c: AccuracyCell): boolean =>
  finite(c.estimate) && c.estimate > 0 && finite(c.measured) && c.measured > 0;
const weak = (c: AccuracyCell): boolean => /^WEAK/i.test(String(c.profile ?? ""));

/** The share of `cells` whose measured time is within `factor` times of the estimate, in either direction. A cell with no usable estimate is a miss. */
export function within(cells: readonly AccuracyCell[], factor: number = BAR.factor): Share {
  const ok = cells.filter(
    (c) => usable(c) && c.measured / c.estimate! <= factor && c.estimate! / c.measured <= factor,
  );
  return { n: cells.length, ok: ok.length, share: cells.length ? ok.length / cells.length : null };
}

/** The verdict over a table. A cell is judged only when it is long enough (`minVideoS`) and has a measurement; an estimate that is not a positive number COUNTS AS A MISS (no line is not an accurate
 *  line), it is never dropped. The measures that decide: (1) the share within 2 times over the judged cells; (2) the same over the weak profiles alone; (3) the share whose measured time lies inside the shown
 *  range; (4) no cell under-estimated by 4 times or more that did not say "could take much longer". `insufficient` (never `pass`) when a measure has too few cells to stand on, and that includes a measure the
 *  table has NO cells for: a table without weak profiles has not been judged on the weak PCs, and one without a shown range has not been judged on its range. `rangeNotShown` waives the range measure alone, for
 *  an estimate that never shows one (0.27.0's own); the weak measure is never waived. */
export function compare(
  cells: readonly AccuracyCell[],
  options: { minVideoS?: number; bar?: typeof BAR; rangeNotShown?: boolean } = {},
): Verdict {
  const { minVideoS = 20, bar = BAR, rangeNotShown = false } = options;
  const judged = cells.filter(
    (c) => finite(c.videoS) && c.videoS >= minVideoS && finite(c.measured) && c.measured > 0,
  );
  const m1 = within(judged, bar.factor);
  const weakCells = judged.filter(weak);
  const m2 = within(weakCells, bar.factor);
  const ranged = judged.filter((c) => finite(c.low) && finite(c.high));
  const inside = ranged.filter((c) => c.measured >= c.low! && c.measured <= c.high!);
  const m3: Share = {
    n: ranged.length,
    ok: inside.length,
    share: ranged.length ? inside.length / ranged.length : null,
  };
  const silent = judged.filter(
    (c) =>
      usable(c) && c.measured / c.estimate! >= bar.underFactor && c.couldTakeMuchLonger !== true,
  );
  const reasons: string[] = [];
  const thin: string[] = [];
  const need = (name: string, m: Share, required: boolean): void => {
    if (m.n < bar.minCells) thin.push(`${name}: ${m.n} cells, at least ${bar.minCells} needed`);
    else if (required && m.share! < bar.share)
      reasons.push(
        `${name}: ${(100 * m.share!).toFixed(0)} % (${m.ok} of ${m.n}), the bar is ${100 * bar.share} %`,
      );
  };
  need("within 2 times, all judged cells", m1, true);
  need("within 2 times, weak profiles", m2, true);
  if (!rangeNotShown) need("measured time inside the shown range", m3, true);
  if (silent.length > 0)
    reasons.push(
      `${silent.length} cell(s) under-estimated by ${bar.underFactor} times or more without "could take much longer": ${silent
        .slice(0, 5)
        .map((c) => `${c.row}/${c.profile}`)
        .join(", ")}`,
    );
  const verdict = reasons.length ? "fail" : thin.length ? "insufficient" : "pass";
  return {
    verdict,
    reasons,
    thin,
    judged: judged.length,
    measures: { within2: m1, within2Weak: m2, insideRange: m3, silentUnder4: silent.length },
  };
}
