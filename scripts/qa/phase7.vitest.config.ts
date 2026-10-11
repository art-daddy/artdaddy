import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        "src/components/ChatView.test.tsx",
        "src/components/ProjectPicker.test.tsx",
        "src/tools/geminiEncode.test.ts",
        "src/tools/generation.test.ts",
        "src/contract/params.test.ts",
      ],
      maxWorkers: 1,
      minWorkers: 1,
    },
  }),
);
