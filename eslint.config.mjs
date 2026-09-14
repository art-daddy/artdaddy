// ESLint 9 flat config for the ArtDaddy client.
//
// Warnings-only rollout: typescript-eslint *recommended* (not strict — strict
// drowns an existing codebase), react-hooks (exhaustive-deps catches real effect
// bugs), and import/no-cycle (nothing else enforces the "no circular deps" that
// currently holds). CI runs this non-blocking at first; flip to blocking once the
// backlog is cleared.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "build",
      "coverage",
      "reports",
      "public",
      "node_modules",
      "src-tauri",
      "scripts",
      "**/*.d.ts",
      "src/contract/tools.json",
      "*.config.{ts,js,mjs,cjs}",
      "*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
        node: true,
      },
    },
    rules: {
      // Real-bug rules (the reason this linter exists).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "import/no-cycle": ["warn", { maxDepth: 1, ignoreExternal: true }],

      // Pragmatic severities so the rollout never blocks mid-work. `any` and
      // unused vars are warnings; underscore-prefixed args/vars are intentional.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Non-null assertions + ts-comments are used deliberately in a few spots.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
  {
    // Tests exercise edge cases with `any`, empty mocks, and non-null asserts.
    files: ["src/**/*.{test,e2e,property,eval}.{ts,tsx}", "src/test/**", "src/eval/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
      "import/no-cycle": "off",
    },
  },
);
