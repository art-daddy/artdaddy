// What the mocked modules of the wake harness hand back. The test file's vi.mock calls read this, and the
// harness sets it: the project's own tool context for the tool host, the project's folder, and the model.
import type { ClientToolContext } from "../tools/context";
import type { ScriptedModel } from "./wakeModel";

export const wiring: {
  context: ClientToolContext | null;
  projectDir: string;
  model: ScriptedModel | null;
} = { context: null, projectDir: "", model: null };

const refuse = (what: string): never => {
  throw new Error(`the wake harness has no ${what}: the app must not reach it`);
};

/** The module the tool host gets for `./tauri`: the one thing it asks of it is a context for the
 *  project, and that is the harness's own (an in-memory disk and fake programs). */
export function tauriModule() {
  return {
    makeTauriContext: (_projectDir: string): ClientToolContext => {
      if (!wiring.context) return refuse("project, no harness is running");
      return wiring.context;
    },
    launchSpec: () => refuse("process launcher"),
    TauriFs: class {
      constructor() {
        refuse("desktop filesystem");
      }
    },
    TauriCommandRunner: class {
      constructor() {
        refuse("process runner");
      }
    },
  };
}
