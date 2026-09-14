import { registerTimelineTools } from "../timeline/ops";
import { registerPackTools } from "../timeline/pack";
import type { ClientToolContext } from "./context";
import { registerFileTools } from "./artifacts";
import { registerAudioTools } from "./audio";
import { registerGenerationTools } from "./generation";
import { registerImportTools } from "./import";
import { registerInspectTools } from "./inspect";
import { registerLibraryTools } from "./library";
import { registerMediaTools } from "./media";
import { registerNetTools } from "./net";
import { registerProjectTools } from "./project";
import { ClientToolRegistry } from "./registry";
import { registerStyleTools } from "./style";
import { registerTranscriptTools } from "./transcribe";
import { registerCaptionTools } from "./captions";
import { registerVideoTools } from "./video";
import { registerVisionTools } from "./vision";
import { registerWebTools } from "./web";

// Build the registry of tools this client can run locally. Handlers read the
// current context (built from the CLIENT's own co-located project dir). The
// per-project host that constructs the context + drives execution lives in
// `./host` (the client owns the agent loop — no server WS tool proxy).
export function createToolRegistry(getCtx: () => ClientToolContext | null): ClientToolRegistry {
  const registry = new ClientToolRegistry();
  registerMediaTools(registry, getCtx);
  registerInspectTools(registry, getCtx);
  registerFileTools(registry, getCtx);
  registerNetTools(registry, getCtx);
  registerProjectTools(registry, getCtx);
  registerTranscriptTools(registry, getCtx);
  registerCaptionTools(registry, getCtx);
  registerImportTools(registry, getCtx);
  registerWebTools(registry, getCtx);
  registerVisionTools(registry, getCtx);
  registerVideoTools(registry, getCtx);
  registerGenerationTools(registry, getCtx);
  registerAudioTools(registry, getCtx);
  registerStyleTools(registry, getCtx);
  registerTimelineTools(registry, getCtx);
  registerLibraryTools(registry, getCtx);
  registerPackTools(registry, getCtx);
  return registry;
}

export { ClientToolRegistry };
