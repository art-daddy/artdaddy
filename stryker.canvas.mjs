import base from "./stryker.config.mjs";
export default { ...base, mutate: ["src/timeline/canvas.ts"], vitest: { configFile: "vitest.mutation.config.ts" }, reporters: ["clear-text", "progress"] };
