import { readFileSync } from "node:fs";
import ts from "typescript";
import baseConfig from "../../stryker.config.mjs";

const targets = new Map([
  [
    "src/api/agentEvents.ts",
    ["createToolTrace", "push", "deliverAgentEvents", "flushAgentEventsForExit"],
  ],
  ["src/api/appEvents.ts", ["reportAppEvent"]],
  ["src/observability/sentry.ts", ["beforeSend"]],
  ["src/components/StagePanel.tsx", []],
  ["src/components/SourceMonitor.tsx", []],
  ["src/tools/inspect.ts", []],
]);
const mutate = [];
for (const [filename, names] of targets) {
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const add = (node) => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.getEnd());
    mutate.push(
      `${filename}:${start.line + 1}:${start.character}-${end.line + 1}:${end.character}`,
    );
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) add(node);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("beginSessionActivity")
    )
      add(node);
    if (
      filename.endsWith("inspect.ts") &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "srcRef" &&
      node.initializer
    )
      add(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (mutate.length < 9) throw new Error("Telemetry mutation targets were not found");

export default {
  ...baseConfig,
  mutate,
  vitest: { configFile: "scripts/qa/phase6Telemetry.vitest.config.ts", related: false },
  concurrency: 2,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/qa/phase6/mutation-client.json" },
};
