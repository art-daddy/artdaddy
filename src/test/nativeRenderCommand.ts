// The one spelling of the cargo command behind the native smoke cases. The smoke lane compiles the
// native test program once before any case starts (smokeGlobalSetup.ts), and each case then runs
// it (runNativeRenderSequence in src/tools/__e2e.ts). Both must select the same compiled unit, so
// both are built here: the build differs from the run only in what comes after the unit.
export const NATIVE_RENDER_PROGRAM = "cargo";
export const NATIVE_RENDER_TEST = "jobs::tests::render_sequence_real_artifact";

export function nativeRenderCargoArgs(mode: "run" | "build"): string[] {
  const unit = ["test", "--lib", NATIVE_RENDER_TEST];
  return mode === "build"
    ? [...unit, "--no-run"]
    : [...unit, "--", "--ignored", "--exact", "--nocapture"];
}
