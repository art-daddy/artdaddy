param(
  [ValidateRange(128, 8192)] [int]$MemoryMiB = 6144,
  [ValidateSet('App', 'DenseWorker', 'DensePipe')] [string]$Workload = 'App',
  [string]$ReferenceReport,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Native memory simulation requires 64-bit PowerShell.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'exporterNative.mjs'
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ExporterMemoryJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
    public ushort ShowWindow, ReservedSize;
    public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Limits limits, uint length, IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static ulong PeakBytes;
  public static int Run(string executable, string arguments, string cwd, ulong cap) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ProcessInfo process = new ProcessInfo();
    try {
      Limits limits = new Limits();
      limits.Basic.LimitFlags = 0x2000 | (cap == 0 ? 0U : 0x200U);
      limits.JobMemoryLimit = new UIntPtr(cap);
      uint size = (uint)Marshal.SizeOf(typeof(Limits));
      if (!SetInformationJobObject(job, 9, ref limits, size)) throw new Win32Exception();
      Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
      if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 4,
          IntPtr.Zero, cwd, ref startup, out process)) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
      if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
      if (WaitForSingleObject(process.Process, UInt32.MaxValue) != 0) throw new Win32Exception();
      uint code;
      if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
      if (!QueryInformationJobObject(job, 9, out limits, size, IntPtr.Zero)) throw new Win32Exception();
      PeakBytes = limits.PeakJobMemoryUsed.ToUInt64();
      return unchecked((int)code);
    } catch {
      if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      throw;
    } finally {
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      CloseHandle(job);
    }
  }
}
'@
$className = 'ExporterMemoryJob_' + [Guid]::NewGuid().ToString('N')
$jobType = Add-Type -TypeDefinition ($source.Replace('ExporterMemoryJob', $className)) -PassThru | Where-Object { $_.Name -eq $className }
$cap = [uint64]$MemoryMiB * 1048576
if ($SelfTest) {
  if ($MemoryMiB -gt 256) { throw 'Use 128 or 256 MiB for the bounded allocation discriminator.' }
  $arguments = '--max-old-space-size=2048 -e "try{const values=[];for(let index=0;index<64;index++)values.push(Buffer.alloc(8*1024*1024,37));process.exit(0);}catch(error){if(error instanceof RangeError && /allocation failed/.test(error.message))process.exit(73);throw error;}"'
  $control = $jobType::Run($node, $arguments, $PSScriptRoot, 0)
  if ($control -ne 0) { throw 'Unrestricted allocation control failed; environment cannot demonstrate the cap.' }
  $controlPeak = $jobType::PeakBytes
  $result = $jobType::Run($node, $arguments, $PSScriptRoot, $cap)
  if ($result -ne 73) { throw ('Expected explicit allocation refusal, received ' + $result) }
  Write-Output ('PASS native allocation-pressure discriminator; configuredCommitLimit={0}; reportedPeak={1}; unrestrictedPeak={2}; childExit={3}; not an exact physical peak ceiling' -f $cap, $jobType::PeakBytes, $controlPeak, $result)
} else {
  $executable = $node
  $arguments = '"' + $script + '"'
  $scene = $null
  if ($Workload -in @('DenseWorker', 'DensePipe')) {
    $baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../reports/bench/export-feasibility-baseline.json') -Raw | ConvertFrom-Json
    if ($Workload -eq 'DensePipe') {
      if (-not $ReferenceReport -or -not ([IO.Path]::GetFullPath($ReferenceReport)).StartsWith(
          [IO.Path]::GetFullPath($baseline.fixtureDir) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'DensePipe requires a retained report inside the frozen private fixture.'
      }
      $retained = Get-Content -LiteralPath $ReferenceReport -Raw -Encoding UTF8 | ConvertFrom-Json
      $scene = $retained.sharedScene
    } else {
      $scene = Get-Content -LiteralPath (Join-Path $baseline.fixtureDir 'native-scene-current.json') -Raw | ConvertFrom-Json
    }
    if ($scene.readers -ne 16 -or $scene.frames -notin @(1800, 3600) -or $scene.mode -ne 'captions-overlap') {
      throw 'Dense worker requires the retained sixteen-reader thirty- or sixty-second caption-overlap fixture.'
    }
    $sceneFrames = [int]$scene.frames
    $executable = Join-Path $PSHOME 'powershell.exe'
    $workerScript = Join-Path $PSScriptRoot 'exporterNativeWorker.ps1'
    $vitest = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../node_modules/vitest/vitest.mjs'))
    $command = @"
  `$ErrorActionPreference = 'Stop'
  `$report = (& '$workerScript' -Action Run -Readers 16 -Frames $sceneFrames -GpuResize -GpuBatch -EncodeVideo -SkipReaderDiagnostics) | Out-String | ConvertFrom-Json
  if (-not `$report.Report) { throw 'Dense worker returned no artifact report.' }
  `$env:ARTDADDY_ENGINE_REPORT = `$report.Report
  Write-Output ('Dense artifact report: ' + `$report.Report)
  & '$node' '$vitest' run --config vitest.smoke.config.ts src/tools/bench_render.e2e.ts -t 'preserves the frozen source' --reporter=dot
  exit `$LASTEXITCODE
"@
    if ($Workload -eq 'DensePipe') {
      $command = @"
  `$ErrorActionPreference = 'Stop'
  Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue
  `$env:NO_COLOR = '1'
  `$env:ARTDADDY_NATIVE_MUX_VERIFY = '1'
  `$captured = (& '$node' '$vitest' run --config vitest.smoke.config.ts src/tools/bench_render.e2e.ts --pool=threads --maxWorkers=1 --minWorkers=1 -t 'owns the complete pipeline' --reporter=dot) | Out-String
  `$code = `$LASTEXITCODE
  Write-Output `$captured
  if (`$code -ne 0) { throw 'Dense packet pipeline failed.' }
  `$line = (`$captured -split '\r?\n' | Where-Object { `$_.StartsWith('{"mode":"complete"') } | Select-Object -Last 1)
  if (-not `$line) { throw 'Dense packet pipeline returned no artifact report.' }
  `$report = `$line | ConvertFrom-Json
  if (`$report.artifactVerified -ne `$true) { throw 'Dense packet artifact was not independently verified.' }
  Write-Output ('Dense packet artifact report: ' + `$report.report)
  exit 0
"@
    }
    $arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  }
  $previousCap = $env:ARTDADDY_QA_MEMORY_CAP_BYTES
  $previousReference = $env:ARTDADDY_NATIVE_MUX_REFERENCE
  if ($Workload -eq 'DensePipe') { $env:ARTDADDY_NATIVE_MUX_REFERENCE = [IO.Path]::GetFullPath($ReferenceReport) }
  $env:ARTDADDY_QA_MEMORY_CAP_BYTES = [string]$cap
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  try {
    $result = $jobType::Run($executable, $arguments, (Join-Path $PSScriptRoot '../..'), $cap)
  } finally {
    $elapsed.Stop()
    if ($null -eq $previousCap) { Remove-Item Env:ARTDADDY_QA_MEMORY_CAP_BYTES -ErrorAction SilentlyContinue }
    else { $env:ARTDADDY_QA_MEMORY_CAP_BYTES = $previousCap }
    if ($null -eq $previousReference) { Remove-Item Env:ARTDADDY_NATIVE_MUX_REFERENCE -ErrorAction SilentlyContinue }
    else { $env:ARTDADDY_NATIVE_MUX_REFERENCE = $previousReference }
  }
  $output = Join-Path $PSScriptRoot '../../reports/qa/exporter'
  [IO.Directory]::CreateDirectory($output) | Out-Null
  $requiresVerification = $Workload -in @('DenseWorker', 'DensePipe')
  $verificationConfirmed = if ($result -eq 0) { $requiresVerification } else { $null }
  $receipt = [ordered]@{ scope='windows-job-commit-pressure-simulation'; workload=$Workload; harnessPool=$(if ($Workload -eq 'DensePipe') { 'threads-single' } else { $null }); verificationWorker=$(if ($Workload -eq 'DensePipe') { 'same-worker-shared-verifier' } else { $null }); sceneSha256=$scene.sha256; elapsedSeconds=$elapsed.Elapsed.TotalSeconds; verificationRequired=$requiresVerification; includesArtifactVerification=$verificationConfirmed; configuredCommitLimitBytes=$cap;
    reportedPeakBytes=$jobType::PeakBytes; exitCode=$result; physicalMinimumMachine=$false; exactPeakCeiling=$false }
  [IO.File]::WriteAllText((Join-Path $output ('memory-' + [Guid]::NewGuid().ToString('N') + '.json')),
    ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Write-Output ('Native QA memory simulation; configuredCommitLimit={0}; reportedPeak={1}; exit={2}; not physical 8 GB qualification or an exact peak ceiling' -f $cap, $jobType::PeakBytes, $result)
  if ($result -ne 0) { throw ('Capped native exporter QA failed: ' + $result) }
}