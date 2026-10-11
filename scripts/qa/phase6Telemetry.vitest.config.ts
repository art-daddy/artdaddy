import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        "src/api/appEvents.test.ts",
        "src/api/agentEvents.test.ts",
        "src/api/agentEventsAuth.test.ts",
        "src/api/sessionEndEvents.test.ts",
        "src/App.quit.test.tsx",
        "src/mcp/bridge.test.ts",
        "src/tools/host.test.ts",
        "src/observability/crashWatch.test.ts",
        "src/observability/sentry.test.ts",
        "src/components/StagePanel.test.tsx",
        "src/components/SourceMonitor.resolve.test.tsx",
        "src/tools/inspect.test.ts",
      ],
      maxWorkers: 1,
      minWorkers: 1,
    },
  }),
);
