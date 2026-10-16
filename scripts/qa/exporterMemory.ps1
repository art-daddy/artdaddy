param(
  [ValidateRange(128, 8192)] [int]$MemoryMiB = 6144,
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
  $previousCap = $env:ARTDADDY_QA_MEMORY_CAP_BYTES
  $env:ARTDADDY_QA_MEMORY_CAP_BYTES = [string]$cap
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  try {
    $result = $jobType::Run($executable, $arguments, (Join-Path $PSScriptRoot '../..'), $cap)
  } finally {
    $elapsed.Stop()
    if ($null -eq $previousCap) { Remove-Item Env:ARTDADDY_QA_MEMORY_CAP_BYTES -ErrorAction SilentlyContinue }
    else { $env:ARTDADDY_QA_MEMORY_CAP_BYTES = $previousCap }
  }
  $output = Join-Path $PSScriptRoot '../../reports/qa/exporter'
  [IO.Directory]::CreateDirectory($output) | Out-Null
  $receipt = [ordered]@{ scope='windows-job-commit-pressure-simulation'; workload='App'; elapsedSeconds=$elapsed.Elapsed.TotalSeconds; verificationRequired=$false; includesArtifactVerification=$null; configuredCommitLimitBytes=$cap;
    reportedPeakBytes=$jobType::PeakBytes; exitCode=$result; physicalMinimumMachine=$false; exactPeakCeiling=$false }
  [IO.File]::WriteAllText((Join-Path $output ('memory-' + [Guid]::NewGuid().ToString('N') + '.json')),
    ($receipt | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Write-Output ('Native QA memory simulation; configuredCommitLimit={0}; reportedPeak={1}; exit={2}; not physical 8 GB qualification or an exact peak ceiling' -f $cap, $jobType::PeakBytes, $result)
  if ($result -ne 0) { throw ('Capped native exporter QA failed: ' + $result) }
}