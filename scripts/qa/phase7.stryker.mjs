import { readFileSync } from "node:fs";
import ts from "typescript";
import baseConfig from "../../stryker.config.mjs";

const targets = new Map([
  [
    "src/store/firstPrompt.ts",
    ["setFirstPrompt", "peekFirstPrompt", "discardFirstPrompt", "takeFirstPrompt"],
  ],
  [
    "src/tools/geminiEncode.ts",
    ["encodeVideoForGemini", "encodeVideo", "requireEncodeSession", "checkVideoBudget"],
  ],
  ["src/contract/params.ts", ["missingClipMessage"]],
  ["src/components/ChatView.tsx", []],
  ["src/components/ProjectPicker.tsx", []],
  ["src/tools/generation.ts", []],
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
      filename.endsWith("ChatView.tsx") &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      /(?:peek|take)FirstPrompt/.test(node.arguments[0]?.getText(source) ?? "")
    )
      add(node);
    if (
      filename.endsWith("ProjectPicker.tsx") &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "start" &&
      node.initializer
    )
      add(node.initializer);
    if (
      filename.endsWith("generation.ts") &&
      ts.isIfStatement(node) &&
      /suppliedRefs|max_reference_images/.test(node.expression.getText(source))
    )
      add(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (mutate.length < 14) throw new Error("Phase 7 mutation targets were not found");

export default {
  ...baseConfig,
  mutate,
  vitest: { configFile: "scripts/qa/phase7.vitest.config.ts", related: false },
  concurrency: 2,
  ignorePatterns: ["src-tauri/**"],
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/qa/phase7/mutation-client.json" },
};
