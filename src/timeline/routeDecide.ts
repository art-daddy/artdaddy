// Quality or Fast for an export that reaches the `export` tool: what the person chose in the Export dialog (the slot in the tool context), read once, when the export is asked for.
// Nothing here asks anybody: the chat's question and the slow-export banner's switch are not in this build, so an export nobody picked a route for is Quality, as it always was.
// Fast is decided only while its switch is on (`quick_route`): with it off, or held off by the build, a slot that asks for Fast is read as no pick at all and the export is Quality
// in every byte of its command. Never throws.
import { exportFlag } from "../api/exportFlags";
import type { ClientToolContext } from "../tools/context";
import { chooseRoute, explicitOfCall, type RouteReason } from "./exportRoute";
import type { ExplicitSettings, RouteKind } from "./exportTypes3c";

export interface RouteOutcome {
  route: RouteKind;
  /** Whether Fast was on offer when the route was decided, whichever way the export goes. */
  offer: RouteReason;
  /** For a Fast export: which of the size, the rate and the quality were set, so that Fast composes only what was not (what was set stays set). Absent for Quality. */
  quick: { explicit: ExplicitSettings } | null;
}

const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

/** Which of the size, the rate and the quality were set: the dialog's own word when its slot gives one (it knows whether a "same as the project" was picked), else what the
 *  call's arguments say. A slot that gives it badly is not believed. */
function explicitOf(
  slot: ClientToolContext["exportRoute"],
  args: Record<string, unknown>,
): ExplicitSettings {
  const given = slot?.explicit;
  if (given && typeof given === "object" && isFlag(given.size) && isFlag(given.fps))
    return {
      size: given.size,
      fps: given.fps,
      ...(isFlag(given.quality) ? { quality: given.quality } : {}),
    };
  return explicitOfCall(args);
}

/** Decides the route once, as the export is asked for: Fast only when the switch is on and the slot asks for it. `args` is the call's own arguments. */
export function decideRoute(
  ctx: Pick<ClientToolContext, "exportRoute"> | null | undefined,
  args: Record<string, unknown>,
): RouteOutcome {
  try {
    const slot = ctx?.exportRoute;
    const decision = chooseRoute({
      quickRouteOn: exportFlag("quick_route") === true,
      picked: slot?.route === "quick" || slot?.route === "standard" ? slot.route : null,
    });
    if (decision.selected !== "quick")
      return { route: "standard", offer: decision.reason, quick: null };
    return { route: "quick", offer: decision.reason, quick: { explicit: explicitOf(slot, args) } };
  } catch {
    return { route: "standard", offer: "off", quick: null };
  }
}
