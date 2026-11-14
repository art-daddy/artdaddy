// The 3c estimate side's one reader of the remote switches. Each switch is read when it is asked for (the callers read them once, at the decision), a switch that cannot be read
// is its compiled default, and a value that is not a plain boolean is off, so a damaged store can only withhold a behaviour.
import { COMPILED_FLAG_DEFAULTS, exportFlag } from "../api/exportFlags";
import { FLAGS_3C, type Flag3cName, type Flags3c } from "./exportTypes3c";

export function flags3cNow(): Flags3c {
  const flags = {} as Record<Flag3cName, boolean>;
  for (const name of FLAGS_3C) {
    try {
      flags[name] = exportFlag(name) === true;
    } catch {
      flags[name] = COMPILED_FLAG_DEFAULTS[name];
    }
  }
  return flags;
}
