import type { Scenario } from "../types";
import { CANONICAL } from "./canonical";
import { EFFECT_SCENARIOS } from "./effects";
import { EXPORT_SCENARIOS } from "./exports";
import { JOURNEYS } from "./journeys";
import { REGRESSIONS } from "./regressions";
import { STUDIO_SCENARIOS } from "./studio";

/** The full eval corpus: canonical capability coverage (one verb, one assertion),
 *  known-bug regressions, end-to-end journeys (a whole job, graded on sequencing +
 *  deliverable rather than geometry alone), the export lane (graded purely on what
 *  the model DID, since a wasted render is invisible in the final timeline), and the
 *  studio surface (the catalog outside the timeline verbs — research, vision,
 *  generation, project, library). Add entries to the matching file to grow it. */
export const ALL_SCENARIOS: Scenario[] = [
  ...CANONICAL,
  ...EFFECT_SCENARIOS,
  ...REGRESSIONS,
  ...JOURNEYS,
  ...EXPORT_SCENARIOS,
  ...STUDIO_SCENARIOS,
];
