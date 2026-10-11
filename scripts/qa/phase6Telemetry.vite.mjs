import path from "node:path";
import { defineConfig, normalizePath } from "vite";
import baseConfig from "../../vite.config.ts";

export default defineConfig(async (environment) => {
  if (environment.command !== "serve") throw new Error("Telemetry QA cannot produce a build");
  const root = process.env.ARTDADDY_PHASE6_DATA_DIR ?? "";
  if (!root.includes("artdaddy-phase6-"))
    throw new Error("Telemetry QA needs its temporary data root");
  const base = typeof baseConfig === "function" ? await baseConfig(environment) : baseConfig;
  const nativeCore = `/@fs/${normalizePath(path.resolve("node_modules/@tauri-apps/api/core.js"))}`;
  const virtual = "\0phase6-native-core";
  return {
    ...base,
    optimizeDeps: {
      exclude: [
        "@tauri-apps/api",
        "@tauri-apps/plugin-fs",
        "@tauri-apps/plugin-deep-link",
        "@tauri-apps/plugin-shell",
        "@tauri-apps/plugin-dialog",
      ],
    },
    plugins: [
      {
        name: "phase6-isolated-inputs",
        enforce: "pre",
        resolveId: (name) => (name === "@tauri-apps/api/core" ? virtual : undefined),
        load: (name) =>
          name === virtual
            ? `
          export * from ${JSON.stringify(nativeCore)};
          import { invoke as nativeInvoke } from ${JSON.stringify(nativeCore)};
          const root = ${JSON.stringify(root)};
          export async function invoke(command, args, options) {
            if (command === "sidecar_run") {
              const calls = globalThis.phase7Sidecars ??= [];
              if (calls.length < 500) calls.push({ program: args.program, args: [...args.args] });
            }
            if (command === "get_env") {
              return args.name === "ARTDADDY_DATA_DIR" ? root : args.name === "ARTDADDY_PROJECTS_DIR" ? root.replace(/\\\\/g, "/") + "/projects" : null;
            }
            if (command === "load_refresh_token") return "phase6-local-refresh";
            if (["store_refresh_token", "clear_refresh_token", "check_for_update"].includes(command)) return null;
            return nativeInvoke(command, args, options);
          }
        `
            : undefined,
      },
      ...(base.plugins ?? []),
    ],
  };
});
