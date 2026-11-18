// Whether Fast export is on offer for the slow-export banner's Switch button and for the assistant's own words. Those two places are not in this build (the owner has deferred
// them) and read this when they are: it stays false until then. The Export dialog's own Fast choice does not read it; it asks `chooseRoute` in exportRoute.ts, with the switch `quick_route`.
export function quickAvailable(): boolean {
  return false;
}
