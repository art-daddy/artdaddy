import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

// Every DLL the staged whisper binaries IMPORT must be resolvable on a clean Windows install.
//
// One user's transcription was dead for a whole session: whisper-cli.exe statically imports
// MSVCP140.dll / VCRUNTIME140.dll / VCRUNTIME140_1.dll, which are the Visual C++
// REDISTRIBUTABLE — not part of Windows. The loader fails before `main`, so there is no
// stderr, no whisper exit status, just NTSTATUS 0xC0000135 (-1073741515). Indistinguishable
// from silent footage. Every dev box has the redist installed via Visual Studio, so it worked
// for all of us and for nobody without it.
//
// scripts/fetch-sidecars.mjs now stages those three DLLs beside whisper, but a test that
// asserted "stageVcRuntime() copied 3 files" would only restate the fix. It would not notice
// a whisper rebuild that starts importing a FOURTH library, which is the same bug again with
// a different file name. So this reads the import table out of the shipped bytes and asks the
// question that actually matters: is there anything in here the target machine might not have?
//
// Checked for EVERY PE in the directory, not just whisper-cli.exe. The ggml/whisper DLLs are
// separately-linked binaries with their own imports, and verifying one member of a class is
// evidence about that member only.
//
// Residual: this reads the standard import directory. A dependency loaded lazily through
// LoadLibrary (which is how ggml probes its CPU/Vulkan backends) is invisible here by design —
// those are soft-failed and fall back, so they cannot produce this crash.

// Overridable so the same check can be aimed at an EXTRACTED INSTALLER, which is the artifact
// users actually get; the repo's staging directory is only what we hope ends up there.
const whisperDir =
  process.env.ARTDADDY_WHISPER_DIR || join(process.cwd(), "src-tauri/resources/whisper");

/** DLLs that ship WITH Windows (or with the GPU driver), so importing them is safe.
 *
 *  Deliberately does NOT include msvcp140/vcruntime140*: those are the redistributable, and
 *  treating them as system DLLs is precisely the assumption that broke transcription. */
const SYSTEM_DLL = [
  /^api-ms-win-/, // the umbrella/apiset stubs
  /^ext-ms-win-/,
  // The universal CRT and the ancient msvcrt are part of the OS; the 140 series is not.
  /^(ucrtbase|msvcrt)\.dll$/,
  /^(kernel32|kernelbase|ntdll|advapi32|sechost|rpcrt4|user32|gdi32|gdi32full)\.dll$/,
  /^(shell32|shlwapi|ole32|oleaut32|combase|version|psapi|userenv|imm32)\.dll$/,
  /^(ws2_32|crypt32|bcrypt|ncrypt|secur32|winmm|powrprof|setupapi|cfgmgr32)\.dll$/,
  /^(dwmapi|uxtheme|comctl32|comdlg32|dbghelp|winhttp|wininet|iphlpapi)\.dll$/,
  // Graphics stacks come from the driver/OS, and ggml soft-probes its Vulkan backend anyway.
  /^(vulkan-1|opengl32|dxgi|d3d11|d3d12|dxcore)\.dll$/,
];

function readU16(buf: Buffer, at: number): number {
  return buf.readUInt16LE(at);
}
function readU32(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at);
}

/** Names from a PE's import directory, lowercased. Throws rather than returning [] on a
 *  malformed file: an empty list would make every assertion below pass vacuously. */
function importedDlls(file: string): string[] {
  const buf = readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a PE`);

  const peAt = readU32(buf, 0x3c);
  if (buf.readUInt32LE(peAt) !== 0x00004550) throw new Error(`${file}: no PE signature`);

  const sectionCount = readU16(buf, peAt + 6);
  const optSize = readU16(buf, peAt + 20);
  const optAt = peAt + 24;
  const magic = readU16(buf, optAt);
  // PE32 keeps the data directories at +96; PE32+ widens several fields and pushes them to +112.
  const dirAt = optAt + (magic === 0x20b ? 112 : 96);
  const importRva = readU32(buf, dirAt + 8); // directory[1] = imports

  if (importRva === 0) return []; // legitimately importless (a resource-only DLL)

  const sections: { va: number; size: number; raw: number }[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = peAt + 24 + optSize + i * 40;
    sections.push({
      va: readU32(buf, s + 12),
      size: readU32(buf, s + 16),
      raw: readU32(buf, s + 20),
    });
  }

  const toOffset = (rva: number): number => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.size, 1));
    if (!s) throw new Error(`${file}: RVA ${rva} is outside every section`);
    return rva - s.va + s.raw;
  };

  const names: string[] = [];
  for (let d = toOffset(importRva); ; d += 20) {
    // The descriptor array ends at an all-zero entry; the Name RVA alone is enough to detect it.
    const nameRva = readU32(buf, d + 12);
    if (nameRva === 0) break;
    let p = toOffset(nameRva);
    let end = p;
    while (end < buf.length && buf[end] !== 0) end++;
    names.push(buf.toString("ascii", p, end).toLowerCase());
  }
  return names;
}

// The binary the app SPAWNS is the externalBin copy, which lives outside the DLL directory and
// finds its libraries through the cwd TauriCommandRunner sets (src/tools/tauri.ts). An earlier
// version of this file checked a whisper-cli.exe that happened to sit in resources/whisper —
// fetch-sidecars prunes that copy as "not part of this build", so the check was aimed at a file
// that is not shipped and not executed.
function runtimeExe(): string | null {
  if (process.env.ARTDADDY_WHISPER_EXE) return process.env.ARTDADDY_WHISPER_EXE;
  const dir = join(process.cwd(), "src-tauri/binaries");
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => /^artdaddy-whisper-cli.*\.exe$/i.test(f));
  return hit ? join(dir, hit) : null;
}

const stagedDlls = existsSync(whisperDir)
  ? readdirSync(whisperDir).filter((f) => /\.(dll|exe)$/i.test(f))
  : [];
const exe = runtimeExe();

/** Everything the loader touches: the spawned exe plus every library beside it. */
const loaded: { label: string; path: string }[] = [
  ...(exe ? [{ label: basename(exe), path: exe }] : []),
  ...stagedDlls.map((f) => ({ label: f, path: join(whisperDir, f) })),
];

// Sidecars are fetched by a separate script, so a clean checkout has nothing to inspect.
// Scoped to "the directory is empty" rather than per-file, so a PARTIAL stage still fails.
describe.skipIf(stagedDlls.length === 0)("staged whisper binaries: runtime dependencies", () => {
  it("parses real import tables (guards the parser itself)", () => {
    expect(exe, "no artdaddy-whisper-cli executable to check").not.toBeNull();

    const imports = importedDlls(exe!);
    // If the parse silently returned nothing, every other assertion here would pass on an
    // empty set. whisper-cli links the CRT and Win32; it is never importless.
    expect(imports.length, "parsed no imports at all — the PE parser is broken").toBeGreaterThan(2);
    expect(imports).toContain("kernel32.dll");
  });

  it.each(loaded)(
    "$label imports nothing a clean Windows install would lack",
    ({ label, path }) => {
      const present = new Set(stagedDlls.map((f) => f.toLowerCase()));

      const unresolvable = importedDlls(path).filter(
        (dep) => !present.has(dep) && !SYSTEM_DLL.some((re) => re.test(dep)),
      );

      expect(
        unresolvable,
        `${label} imports ${unresolvable.join(", ")}, which is neither staged beside it nor part ` +
          "of Windows. On a machine without it the process dies in the loader with no stderr and " +
          "no exit status, and transcription fails looking exactly like silent audio. Stage the " +
          "library in scripts/fetch-sidecars.mjs, or link it statically in the whisper workflow.",
      ).toEqual([]);
    },
  );

  // Whichever redist libraries this build still imports must be staged. Kept as a separate
  // assertion because the check above passes just as happily when NOTHING imports them, so it
  // cannot tell "we linked statically" from "we stopped looking".
  it("stages every redistributable library the build still imports", () => {
    const redist = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"];
    const importedSomewhere = new Set(loaded.flatMap((f) => importedDlls(f.path)));
    const present = new Set(stagedDlls.map((f) => f.toLowerCase()));

    for (const dep of redist.filter((d) => importedSomewhere.has(d))) {
      expect(present.has(dep), `${dep} is imported but not staged`).toBe(true);
    }
  });
});
