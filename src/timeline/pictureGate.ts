// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`; the memory-shape prior is held instead by the picture gate's
// pending answers (this table), and its own switch `memory_shape` is not in OFF_IN_THIS_BUILD), kept for a later
// release, so do not remove it as unused; see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// The picture gate's table (the owner's picture rule, read as option A: three guards together). A route that can change a Full quality picture (a graphics chip, the processor's faster setting, a gentler rung) may be made
// MORE REACHABLE than 0.27.0 made it only when a recorded answer says so; until then its rule keeps reading 0.27.0's numbers. The table keeps, per route, a hash of the route's own arguments beside the guards' results
// and the owner's answer, so an answer given to one set of arguments is never believed for another (a retuned quality, a new rung cap). Pure: nothing here measures, reads a file or decides what a picture looks like.

export const GATE_ROUTES = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "faster_x264",
  "rung_1",
  "rung_2",
] as const;
export type GateRoute = (typeof GATE_ROUTES)[number];

export type GuardState = "pass" | "fail" | "unmeasured";
/** The owner's answer after his three looks: he cannot see a difference; he can, but yes; no; not asked yet. */
export type OwnerAnswer = "pending" | "agree" | "visible_yes" | "no";

export interface GateRecord {
  readonly route: GateRoute;
  /** `hashArgs` of the route's arguments as the code produced them when the answer was given (see `pictureGate.test.ts` for what is hashed). */
  readonly argsHash: string;
  /** Guard 1: the lossless pictures before the encoder equal 0.27.0's. */
  readonly exact: GuardState;
  /** Guard 2: the delivered file within the clip's own noise floor, colour difference included. */
  readonly floor: GuardState;
  readonly answer: OwnerAnswer;
  readonly answeredOn: string | null;
}

/** A stable 64-bit hash (two FNV-1a runs with different bases) of any JSON value, as 16 hex digits. Not a security hash: it only notices a change. */
export function hashArgs(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The table as it stands before the owner's first look: every route unmeasured and unanswered, hashes of 0.27.0's own arguments (computed from the code by `pictureGate.test.ts`). */
export const GATE_TABLE: readonly GateRecord[] = [
  {
    route: "chip_amd",
    argsHash: "714c78ebc4fbaa57",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
  {
    route: "chip_nvidia",
    argsHash: "2a20b6efa4500270",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
  {
    route: "chip_intel",
    argsHash: "2a719879b04f2e66",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
  {
    route: "faster_x264",
    argsHash: "95984ef1f2130bbf",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
  {
    route: "rung_1",
    argsHash: "0ece12cc53b0b35a",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
  {
    route: "rung_2",
    argsHash: "854259cbb860fca0",
    exact: "unmeasured",
    floor: "unmeasured",
    answer: "pending",
    answeredOn: null,
  },
];

/** Whether `route` may be chosen MORE OFTEN than 0.27.0 chose it. Only when the owner answered "agree" or "visible, but yes", the answer was given to the arguments the code has NOW (`currentHash`),
 *  and, unless he said "visible, but yes", both measured guards passed. Everything else (no record, no answer, "no", a changed argument, a failed or unmeasured guard) is false: the route keeps
 *  0.27.0's reach and its rule keeps reading 0.27.0's numbers. Never throws. */
export function mayWidenRoute(
  route: GateRoute,
  currentHash: string,
  table: readonly GateRecord[] = GATE_TABLE,
): boolean {
  try {
    const records = table.filter((r) => r.route === route);
    if (records.length !== 1) return false;
    const r = records[0]!;
    if (r.argsHash !== currentHash) return false;
    if (r.answer === "visible_yes") return true;
    return r.answer === "agree" && r.exact === "pass" && r.floor === "pass";
  } catch {
    return false;
  }
}
