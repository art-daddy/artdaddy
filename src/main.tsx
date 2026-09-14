import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { initSentry, Sentry } from "./observability/sentry";
import { installCrashWatch } from "./observability/crashWatch";
import { installGlobalErrorHandlers } from "./observability/globalErrors";
import { loadBundledFonts } from "./preview/fonts";
import "./index.css";

// The caption families are bundled, not installed: any canvas that draws text on
// THIS thread (thumbnails, the non-worker rasterize path) needs them registered
// or it silently renders in Times. The preview worker registers its own copy.
void loadBundledFonts(document.fonts);

// Opt-in error reporting (no-op unless VITE_SENTRY_DSN is set).
initSentry();
// AuthProvider identifies the signed-in tester once the desktop-auth session resolves.
// The failures that kill the process cannot report themselves, so the previous session's
// unclean exit is reported HERE, on the next start. Must follow initSentry.
installCrashWatch({ release: __ARTDADDY_RELEASE__ });
// Last-resort boundaries for errors that escape React's tree (async rejections,
// event-handler throws). Expected, handled control-flow errors are skipped.
installGlobalErrorHandlers();

// DEV-ONLY seam for the UI sweep (scripts/uisweep): it drives real pointer input for the
// gesture under test, but needs a stable handle to BUILD each scenario's starting timeline.
// Reaching the store through a dynamic import gets a different module instance once HMR has
// versioned it, which silently tests the wrong store.
if (import.meta.env.DEV) {
  void Promise.all([import("./store/editor"), import("./store/exportJob")]).then(([ed, ex]) => {
    (window as unknown as { __artdaddyTest?: unknown }).__artdaddyTest = {
      editor: ed.useEditor,
      exportJob: ex.useExportJob,
    };
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div className="flex h-full items-center justify-center p-6 text-sm text-neutral-400">
          Something went wrong. Please reload the app.
        </div>
      }
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
