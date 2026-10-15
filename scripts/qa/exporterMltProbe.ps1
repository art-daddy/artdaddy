param(
  [string]$BaselinePath = (Join-Path $PSScriptRoot '../../reports/bench/export-feasibility-baseline.json'),
  [string]$MeltPath = (Join-Path $env:TEMP 'artdaddy-export-mlt-26.9.27/runtime/Shotcut/melt.exe'),
  [ValidateSet(1, 16)] [int]$VisualLayers = 1,
  [ValidateRange(256, 4096)] [int]$MaxWorkingSetMB = 4096,
  [ValidateSet('MLT', 'Native')] [string]$Backend = 'MLT',
  [ValidateSet('CPU', 'D3D11', 'AMF', 'Vulkan')] [string]$NativeScale = 'CPU',
  [switch]$SharedDevice,
  [ValidateSet('Hardware', 'Software', 'D3D11Interop', 'Hybrid')] [string]$DecodeMode = 'Hardware',
  [ValidateSet('CPU', 'Vulkan')] [string]$NativeCompose = 'CPU',
  [ValidateRange(1, 8)] [int]$FilterThreads = 2,
  [ValidateSet(1, 10)] [int]$RepeatCount = 1
)

$ErrorActionPreference = 'Stop'
if ($Backend -ne 'Native' -and $RepeatCount -ne 1) { throw 'Repeating the frozen source is a native-only probe.' }
$useVulkan = $Backend -eq 'Native' -and $NativeScale -eq 'Vulkan'
if ($DecodeMode -in @('Software', 'D3D11Interop') -and -not $useVulkan) {
  throw 'The explicit alternative-decode comparison requires the private Vulkan path.'
}
if ($DecodeMode -eq 'Hybrid' -and
    ($Backend -ne 'Native' -or $NativeScale -ne 'CPU' -or $NativeCompose -ne 'CPU' -or $VisualLayers -ne 16)) {
  throw 'Private hybrid decode is exactly four software/twelve D3D11 readers with CPU composition.'
}
if ($NativeCompose -eq 'Vulkan' -and -not $useVulkan) {
  throw 'Private Vulkan composition requires Vulkan scaling and one shared device.'
}
$nativeDeviceType = $(if ($useVulkan) { 'vulkan' } else { 'd3d11va' })
$nativeFrameFormat = $(if ($useVulkan) { 'vulkan' } else { 'd3d11' })
if ($DecodeMode -eq 'D3D11Interop') { $nativeDeviceType = 'd3d11va'; $nativeFrameFormat = 'd3d11' }
$baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
$fixture = [IO.Path]::GetFullPath($baseline.fixtureDir)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $fixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($fixture)).StartsWith('artdaddy-bench-render-')) {
  throw 'MLT evaluation only accepts the private benchmark fixture directory.'
}
$simple = $baseline.cases | Where-Object { $_.level -eq 'simple' } | Select-Object -First 1
if (-not $simple -or -not $simple.artifact.stereoVerified) { throw 'A verified stereo baseline is required.' }
foreach ($inputFile in @($simple.artifact.sourcePath, $simple.artifact.outputPath)) {
  $full = [IO.Path]::GetFullPath($inputFile)
  if (-not $full.StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'An input lies outside the private fixture.'
  }
}
if ((Get-FileHash -LiteralPath $simple.artifact.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.sourceSha256 -or
    (Get-FileHash -LiteralPath $simple.artifact.outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.outputSha256) {
  throw 'Frozen source or baseline bytes changed; refusing comparison.'
}
$ffmpeg = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe'))
if ($Backend -eq 'MLT') {
  $runtimeRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP 'artdaddy-export-mlt-26.9.27'))
  $archive = Join-Path $runtimeRoot 'shotcut-win64-26.9.27.zip'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne
      '1f8c50ce7b125a2f0dcb60777b358e86baf03b8515982612b6adae10a83d93a5') {
    throw 'Pinned portable runtime archive changed.'
  }
  $MeltPath = [IO.Path]::GetFullPath($MeltPath)
  if (-not $MeltPath.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($MeltPath) -ne 'melt.exe') {
    throw 'The engine must be the private pinned melt.exe.'
  }
  $engineBinary = $MeltPath
  $engineName = 'MLT 7.41.0 / Shotcut v26.9.27'
  $reportPrefix = 'mlt'
} else {
  if ((Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash.ToLowerInvariant() -ne $baseline.backend.sha256) {
    throw 'Shipped native sidecar no longer matches the frozen baseline.'
  }
  $engineBinary = $ffmpeg
  $engineName = 'Shipped FFmpeg / ' + $nativeDeviceType + ' decode / h264_amf encode / ' + $NativeScale + ' scaling'
  if ($DecodeMode -eq 'Software') { $engineName = 'Shipped FFmpeg / software decode / Vulkan scaling / h264_amf encode' }
  if ($DecodeMode -eq 'Hybrid') { $engineName = 'Shipped FFmpeg / four software + twelve D3D11 readers / h264_amf encode' }
  $engineName += ' / ' + $NativeCompose + ' composition'
  if ($SharedDevice -or $useVulkan) { $engineName += ' / shared device' }
  $reportPrefix = 'native'
}
$ffprobe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../src-tauri/binaries/artdaddy-ffprobe-x86_64-pc-windows-msvc.exe'))
$work = Join-Path $fixture ($reportPrefix + '-probe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

if (-not ('ArtDaddyExportProbe2.ProcessProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ArtDaddyExportProbe2 {
  public class Measurement {
    public int Code;
    public double Seconds;
    public ulong PeakWorkingSetBytes;
    public long PeakPrivateDirectoryBytes;
    public bool TimedOut;
    public bool MemoryLimitExceeded;
    public string Stdout;
    public string Stderr;
  }
  public static class ProcessProbe {
    [StructLayout(LayoutKind.Sequential)]
    private struct Counters {
      public uint Size, PageFaultCount;
      public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage,
        QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage,
        PagefileUsage, PeakPagefileUsage;
    }
    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(IntPtr process, out Counters counters, uint size);

    private static string Quote(string value) {
      var result = new StringBuilder("\"");
      int slashes = 0;
      foreach (char character in value) {
        if (character == '\\') { slashes++; continue; }
        result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
        result.Append(character);
        slashes = 0;
      }
      result.Append('\\', slashes * 2).Append('"');
      return result.ToString();
    }
    public static Measurement Run(string binary, string[] args, string cwd, string work, int timeoutMs, ulong memoryLimit) {
      var start = new ProcessStartInfo(binary);
      var command = new StringBuilder();
      foreach (string argument in args) command.Append(Quote(argument)).Append(' ');
      start.Arguments = command.ToString();
      start.WorkingDirectory = cwd;
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.RedirectStandardOutput = true;
      start.RedirectStandardError = true;
      start.EnvironmentVariables["QT_QPA_PLATFORM"] = "offscreen";
      using (var process = new Process()) {
        process.StartInfo = start;
        var output = new StringBuilder();
        var error = new StringBuilder();
        var gate = new object();
        process.OutputDataReceived += (sender, eventArgs) => {
          if (eventArgs.Data == null) return;
          lock (gate) { output.AppendLine(eventArgs.Data); if (output.Length > 65536) output.Remove(0, output.Length - 65536); }
        };
        process.ErrorDataReceived += (sender, eventArgs) => {
          if (eventArgs.Data == null) return;
          lock (gate) { error.AppendLine(eventArgs.Data); if (error.Length > 65536) error.Remove(0, error.Length - 65536); }
        };
        var result = new Measurement();
        var clock = Stopwatch.StartNew();
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using (var sampler = new Timer(state => {
          try {
            Counters counters;
            if (GetProcessMemoryInfo(process.Handle, out counters, (uint)Marshal.SizeOf(typeof(Counters)))) {
              lock (gate) result.PeakWorkingSetBytes = Math.Max(result.PeakWorkingSetBytes, counters.PeakWorkingSetSize.ToUInt64());
              if (memoryLimit > 0 && counters.WorkingSetSize.ToUInt64() > memoryLimit) {
                result.MemoryLimitExceeded = true;
                process.Kill();
              }
            }
            long bytes = 0;
            foreach (string file in Directory.GetFiles(work, "*", SearchOption.AllDirectories)) {
              try { bytes += new FileInfo(file).Length; } catch (IOException) {}
            }
            lock (gate) result.PeakPrivateDirectoryBytes = Math.Max(result.PeakPrivateDirectoryBytes, bytes);
          } catch (InvalidOperationException) {} catch (IOException) {}
        }, null, 0, 100)) {
          if (!process.WaitForExit(timeoutMs)) {
            result.TimedOut = true;
            var killer = Process.Start(new ProcessStartInfo("taskkill", "/PID " + process.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
            if (killer != null) { killer.WaitForExit(); killer.Dispose(); }
          }
          process.WaitForExit();
          Counters finalCounters;
          if (GetProcessMemoryInfo(process.Handle, out finalCounters, (uint)Marshal.SizeOf(typeof(Counters))))
            result.PeakWorkingSetBytes = Math.Max(result.PeakWorkingSetBytes, finalCounters.PeakWorkingSetSize.ToUInt64());
        }
        result.Code = process.ExitCode;
        result.Seconds = clock.Elapsed.TotalSeconds;
        lock (gate) { result.Stdout = output.ToString(); result.Stderr = error.ToString(); }
        return result;
      }
    }
  }
}
'@
}

$timeline = Get-Content -LiteralPath (Join-Path $fixture 'simple-timeline.json') -Raw | ConvertFrom-Json
$referenceFrames = [int]$simple.artifact.decodedFrameCount
$frames = $referenceFrames * $RepeatCount
$durationSeconds = [double]$simple.videoSec * $RepeatCount
$output = Join-Path $work 'simple.mp4'
$xml = New-Object Xml.XmlDocument
$root = $xml.CreateElement('mlt')
[void]$xml.AppendChild($root)
function Add-Element($parent, [string]$name, [hashtable]$attributes = @{}) {
  $element = $xml.CreateElement($name)
  foreach ($key in $attributes.Keys) { $element.SetAttribute($key, [string]$attributes[$key]) }
  [void]$parent.AppendChild($element)
  return $element
}
function Add-Property($parent, [string]$name, $value) {
  $property = Add-Element $parent 'property' @{ name = $name }
  $property.InnerText = [string]$value
}
[void](Add-Element $root 'profile' @{
  width=$timeline.canvas.width; height=$timeline.canvas.height;
  frame_rate_num=$timeline.canvas.fps; frame_rate_den=1;
  progressive=1; sample_aspect_num=1; sample_aspect_den=1;
  display_aspect_num=$timeline.canvas.width; display_aspect_den=$timeline.canvas.height;
  colorspace=601
})
for ($index = 0; $index -lt $VisualLayers; $index++) {
  $source = $simple.artifact.sourcePath
  if ($VisualLayers -gt 1) {
    $source = Join-Path $work ('source-' + $index + '.mp4')
    New-Item -ItemType HardLink -Path $source -Target $simple.artifact.sourcePath | Out-Null
  }
  $producer = Add-Element $root 'producer' @{ id=('source' + $index) }
  Add-Property $producer 'resource' $source
  Add-Property $producer 'mlt_service' 'avformat'
  Add-Property $producer 'force_colorspace' 601
  Add-Property $producer 'threads' 1
  Add-Property $producer 'cache' 0
  Add-Property $producer 'noimagecache' 1
  $playlist = Add-Element $root 'playlist' @{ id=('sequence' + $index) }
  [void](Add-Element $playlist 'entry' @{ producer=('source' + $index); in=0; out=($frames - 1) })
}
if ($VisualLayers -gt 1) {
  $black = Add-Element $root 'producer' @{ id='black' }
  Add-Property $black 'resource' 'black'
  Add-Property $black 'mlt_service' 'color'
  $background = Add-Element $root 'playlist' @{ id='background' }
  [void](Add-Element $background 'entry' @{ producer='black'; in=0; out=($frames - 1) })
  $tractor = Add-Element $root 'tractor' @{ id='composition'; in=0; out=($frames - 1) }
  $tracks = Add-Element $tractor 'multitrack'
  [void](Add-Element $tracks 'track' @{ producer='background'; hide='audio' })
  for ($index = 0; $index -lt $VisualLayers; $index++) {
    [void](Add-Element $tracks 'track' @{ producer=('sequence' + $index); hide=$(if ($index -eq 0) { 'none' } else { 'audio' }) })
    $transition = Add-Element $tractor 'transition' @{ in=0; out=($frames - 1) }
    Add-Property $transition 'mlt_service' 'qtblend'
    Add-Property $transition 'a_track' 0
    Add-Property $transition 'b_track' ($index + 1)
    $tileWidth = [int]$timeline.canvas.width / 4
    $tileHeight = [int]$timeline.canvas.height / 4
    Add-Property $transition 'rect' (('{0} {1} {2} {3} 1' -f (($index % 4) * $tileWidth), ([Math]::Floor($index / 4) * $tileHeight), $tileWidth, $tileHeight))
    Add-Property $transition 'rotation' 0
  }
  $mix = Add-Element $tractor 'transition' @{ in=0; out=($frames - 1) }
  Add-Property $mix 'mlt_service' 'mix'
  Add-Property $mix 'a_track' 0
  Add-Property $mix 'b_track' 1
  Add-Property $mix 'always_active' 1
  Add-Property $mix 'sum' 1
}
$project = Join-Path $work 'simple.mlt'
$xml.Save($project)
$args = [string[]]@('-abort','-progress2',('xml:' + $project),'-consumer',('avformat:' + $output),
  'vcodec=libx264','acodec=aac','crf=23','preset=medium','pix_fmt=yuv420p','ar=48000','ac=2',
  'real_time=-1','threads=4','buffer=2','prefill=1')
if ($Backend -eq 'Native') {
  $args = [string[]]@('-y', '-nostdin', '-hide_banner', '-loglevel', 'verbose', '-filter_complex_threads', [string]$FilterThreads,
    '-filter_buffered_frames', '64')
  if ($DecodeMode -eq 'D3D11Interop') {
    $args += @('-init_hw_device', 'd3d11va=decode_probe:0', '-init_hw_device', 'vulkan=export_probe@decode_probe',
      '-filter_hw_device', 'export_probe')
  } elseif ($SharedDevice -or $useVulkan) {
    $args += @('-init_hw_device', ($nativeDeviceType + '=export_probe:0'), '-filter_hw_device', 'export_probe')
  }
  $filters = @()
  $decoderModes = @()
  for ($index = 0; $index -lt $VisualLayers; $index++) {
    $source = $(if ($VisualLayers -eq 1) { $simple.artifact.sourcePath } else { Join-Path $work ('source-' + $index + '.mp4') })
    $args += @('-threads', '1')
    $softwareSource = $DecodeMode -eq 'Software' -or ($DecodeMode -eq 'Hybrid' -and $index -lt 4)
    $decoderModes += $(if ($softwareSource) { 'Software' } else { $nativeDeviceType })
    if (-not $softwareSource) {
      $args += @('-hwaccel', $nativeDeviceType, '-hwaccel_output_format', $nativeFrameFormat, '-extra_hw_frames', '0')
      if ($DecodeMode -eq 'D3D11Interop') { $args += @('-hwaccel_device', 'decode_probe') }
      elseif ($SharedDevice -or $useVulkan) { $args += @('-hwaccel_device', 'export_probe') }
    }
    if ($RepeatCount -gt 1) { $args += @('-stream_loop', [string]($RepeatCount - 1)) }
    $args += @('-i', $source)
    if ($VisualLayers -gt 1) {
      if ($useVulkan) {
        $upload = $(if ($DecodeMode -eq 'Software') { 'format=nv12,hwupload,' } else { '' })
        if ($DecodeMode -eq 'D3D11Interop') { $upload = 'hwmap=derive_device=vulkan:mode=read+direct,' }
        $download = $(if ($NativeCompose -eq 'Vulkan') { '' } else { 'hwdownload,format=nv12,' })
        $filters += ('[{0}:v]{3}scale_vulkan=w={1}:h={2}:format=nv12,{4}setsar=1,settb=expr=1/{5},setpts=N[v{0}]' -f
          $index, ([int]$timeline.canvas.width / 4), ([int]$timeline.canvas.height / 4), $upload, $download, $timeline.canvas.fps)
      } elseif ($NativeScale -eq 'D3D11') {
        $filters += ('[{0}:v]scale_d3d11=width={1}:height={2}:format=nv12,hwdownload,format=nv12,setsar=1,settb=expr=1/{3},setpts=N[v{0}]' -f
          $index, ([int]$timeline.canvas.width / 4), ([int]$timeline.canvas.height / 4), $timeline.canvas.fps)
      } elseif ($NativeScale -eq 'AMF') {
        $filters += ('[{0}:v]vpp_amf=w={1}:h={2}:format=nv12:scale_type=bicubic:color_profile=bt601,hwdownload,format=nv12,setsar=1,settb=expr=1/{3},setpts=N[v{0}]' -f
          $index, ([int]$timeline.canvas.width / 4), ([int]$timeline.canvas.height / 4), $timeline.canvas.fps)
      } else {
        $download = $(if ($softwareSource) { '' } else { 'hwdownload,' })
        $filters += ('[{0}:v]{4}format=nv12,scale={1}:{2}:flags=bicubic,setsar=1,settb=expr=1/{3},setpts=N[v{0}]' -f
          $index, ([int]$timeline.canvas.width / 4), ([int]$timeline.canvas.height / 4), $timeline.canvas.fps, $download)
      }
    }
  }
  if ($VisualLayers -eq 1) {
    if ($useVulkan) {
      $upload = $(if ($DecodeMode -eq 'Software') { 'format=nv12,hwupload,' } else { '' })
      if ($DecodeMode -eq 'D3D11Interop') { $upload = 'hwmap=derive_device=vulkan:mode=read+direct,' }
      $filters += ('[0:v]{2}scale_vulkan=w={0}:h={1}:format=nv12,hwdownload,format=nv12,settb=expr=1/{3},setpts=N[out]' -f
        $timeline.canvas.width, $timeline.canvas.height, $upload, $timeline.canvas.fps)
    } else {
      $filters += ('[0:v]settb=expr=1/{0},setpts=N[out]' -f $timeline.canvas.fps)
    }
  } elseif ($NativeCompose -eq 'Vulkan') {
    $filters += ('color=c=black:s={0}x{1}:r={2}:d={3},format=nv12,hwupload,settb=expr=1/{2}[base0]' -f
      $timeline.canvas.width, $timeline.canvas.height, $timeline.canvas.fps, $durationSeconds)
    for ($index = 0; $index -lt $VisualLayers; $index++) {
      $x = [int](($index % 4) * $timeline.canvas.width / 4)
      $y = [int]([Math]::Floor($index / 4) * $timeline.canvas.height / 4)
      $filters += ('[base{0}][v{0}]overlay_vulkan=x={1}:y={2}[base{3}]' -f $index, $x, $y, ($index + 1))
    }
    $filters += ('[base{0}]hwdownload,format=nv12[out]' -f $VisualLayers)
  } else {
    $inputs = ((0..15 | ForEach-Object { '[v' + $_ + ']' }) -join '')
    $layout = ((0..15 | ForEach-Object {
      ([int](($_ % 4) * $timeline.canvas.width / 4)).ToString() + '_' +
        ([int]([Math]::Floor($_ / 4) * $timeline.canvas.height / 4)).ToString()
    }) -join '|')
    $filters += ($inputs + 'xstack=inputs=16:layout=' + $layout + '[out]')
  }
  $audioMap = '0:a:0'
  $audioCodec = 'copy'
  if ($RepeatCount -gt 1) {
    $sourceSamples = [int]([double]$simple.videoSec * 48000)
    $filters += ('[0:a:0]atrim=end_sample={0},asetpts=PTS-STARTPTS,aloop=loop={1}:size={0},asetpts=N/SR/TB[aout]' -f
      $sourceSamples, ($RepeatCount - 1))
    $audioMap = '[aout]'
    $audioCodec = 'aac'
  }
  $args += @('-filter_complex', ($filters -join ';'), '-map', '[out]', '-map', $audioMap,
    '-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp',
    '-qp_i', '23', '-qp_p', '23', '-qp_b', '23', '-async_depth', '2', '-frame_skipping', '0', '-bf', '0',
    '-c:a', $audioCodec, '-r', [string]$timeline.canvas.fps,
    '-t', [string]$durationSeconds, $output)
}
$measurement = [ArtDaddyExportProbe2.ProcessProbe]::Run($engineBinary, $args, [IO.Path]::GetDirectoryName($engineBinary), $work, 120000, ([uint64]$MaxWorkingSetMB * 1048576))
[IO.File]::WriteAllText((Join-Path $work ($reportPrefix + '-execution.json')), ([ordered]@{
  status='execution_observed_artifact_unverified'; engine=$engineName; profile=$timeline.canvas;
  visualLayers=$VisualLayers; decodeMode=$DecodeMode; nativeScale=$NativeScale; nativeCompose=$NativeCompose;
  decoderModes=$decoderModes;
  repeatCount=$RepeatCount; expectedFrames=$frames;
  arguments=$args; measurement=$measurement; sourceSha256=$simple.artifact.sourceSha256;
  baselineSha256=$simple.artifact.outputSha256
} | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
if ($measurement.Code -ne 0 -or $measurement.TimedOut -or $measurement.MemoryLimitExceeded -or -not (Test-Path -LiteralPath $output)) {
  [IO.File]::WriteAllText((Join-Path $work ($reportPrefix + '-failure.json')), ([ordered]@{
    status='failed'; phase='E0'; engine=$engineName; visualLayers=$VisualLayers; profile=$timeline.canvas;
    binarySha256=(Get-FileHash -LiteralPath $engineBinary -Algorithm SHA256).Hash.ToLowerInvariant();
    hardware=$baseline.hardware; nativeScale=$NativeScale; decodeMode=$DecodeMode; nativeCompose=$NativeCompose;
    sharedDevice=([bool]$SharedDevice -or $useVulkan); arguments=$args;
    memoryGuardBytes=([uint64]$MaxWorkingSetMB * 1048576); measurement=$measurement;
    sourceSha256=$simple.artifact.sourceSha256; baselineSha256=$simple.artifact.outputSha256;
    scope='Guarded private probe failure; no deliverable or parity claim'
  } | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  throw ($Backend + ' render failed; evidence at ' + (Join-Path $work ($reportPrefix + '-failure.json')) + ': ' +
    ([ordered]@{ code=$measurement.Code; seconds=$measurement.Seconds;
      peakWorkingSetBytes=$measurement.PeakWorkingSetBytes; timedOut=$measurement.TimedOut;
      memoryLimitExceeded=$measurement.MemoryLimitExceeded } | ConvertTo-Json -Compress))
}
$probe = [ArtDaddyExportProbe2.ProcessProbe]::Run($ffprobe,
  [string[]]@('-v','error','-count_frames','-show_entries','stream=codec_type,width,height,nb_read_frames,r_frame_rate,channels,sample_rate,duration:format=duration','-of','json',$output),
  $work, $work, 60000, 0)
if ($probe.Code -ne 0) { throw ('Candidate probe failed: ' + $probe.Stderr) }
$metadata = $probe.Stdout | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $work ($reportPrefix + '-artifact-metadata.json')), ($metadata | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
$video = $metadata.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
$audio = $metadata.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
if ([int]$video.nb_read_frames -ne $frames -or [int]$video.width -ne $timeline.canvas.width -or
    [int]$video.height -ne $timeline.canvas.height -or [int]$audio.channels -ne 2 -or [int]$audio.sample_rate -ne 48000) {
  throw ('Candidate artifact has wrong metadata: ' + ($metadata | ConvertTo-Json -Depth 6))
}
if ($Backend -eq 'Native' -and
    ($video.r_frame_rate -ne ([string]$timeline.canvas.fps + '/1') -or
      [double]$audio.duration -lt ($durationSeconds - 1.0 / 48000))) {
  throw ('Native artifact lost frame timing or audio tail: ' + ($metadata | ConvertTo-Json -Depth 6))
}
$report = [ordered]@{
  status='basic_artifact_emitted_semantic_checks_pending'; phase='E0'; engine=$engineName;
  binary=$engineBinary; binarySha256=(Get-FileHash -LiteralPath $engineBinary -Algorithm SHA256).Hash.ToLowerInvariant();
  source=$simple.artifact.sourcePath; sourceSha256=$simple.artifact.sourceSha256;
  baseline=$simple.artifact.outputPath; baselineSha256=$simple.artifact.outputSha256; expectedFrames=$frames;
  referenceFrames=$referenceFrames; repeatCount=$RepeatCount;
  visualLayers=$VisualLayers; profile=$timeline.canvas; workDirectory=$work;
  output=$output; outputSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant();
  measurement=$measurement; metadata=$metadata;
  scope='Private short profile/layer probe; reused media bytes with separate paths/readers, not full feature parity, 8 GB or two-hour qualification';
  resourceScope='Engine process native peak working set, not GPU/system/tree memory; private-directory sampled apparent bytes include final output and hard-link names, not physical scratch-only allocation';
  buffering=@{ decoderThreads=1; sourceImageCache=0; imageCaching=$false; processingThreads=1; encoderThreads=4; bufferFrames=2; prefillFrames=1 };
  colorScope='This frozen untagged-source fixture matches the reference decoder fallback with matrix 601; general source-color conformance is not established';
  parityGaps=@('libass caption semantics unverified','multi-input sidechain audio unverified','effects/transitions/keyframes unverified','restart/cancellation fencing unverified')
}
if ($Backend -eq 'Native') {
  $report.buffering = @{ decoderThreads=1; encoderAsyncDepth=2; filterThreads=$FilterThreads; filterBufferedFrames=64;
    extraHardwareFrames=$(if ($DecodeMode -ne 'Software') { 0 } else { $null }) }
  $report.colorScope = 'Frozen-source decoder/filter interpretation; independent picture comparison still required'
  $report.nativeScale = $NativeScale
  $report.decodeMode = $DecodeMode
  $report.decoderModes = $decoderModes
  $report.nativeCompose = $NativeCompose
  $report.frameClockScope = 'Known 60-FPS frozen fixture, one decoded frame per frame slot; not VFR or retiming conformance'
  $report.audioClockScope = $(if ($RepeatCount -gt 1) { 'Repeat exact 144000-sample frozen source window; AAC packet timestamps are not the edit clock' } else { 'One frozen stereo source copied without mixing' })
  $report.vulkanTimebase = $(if ($useVulkan -and $VisualLayers -gt 1) { '1/' + $timeline.canvas.fps } else { $null })
  $report.sharedDevice = [bool]$SharedDevice -or $useVulkan
  $report.nativeScope = 'Decode/composition modes explicitly selected, no automatic fallback; AMF encoder. Software input uploads and output downloads remain, not zero-copy export. QP23 is not CRF23 parity.'
  $report.transferScope = $(if ($NativeCompose -eq 'Vulkan') { 'Tiles remain on GPU; one composed frame download per output frame' } else { 'Per-input downloads followed by CPU xstack' })
  if ($NativeScale -eq 'AMF') { $report.colorScope = 'Explicit BT.601 compatibility for this frozen untagged fixture, not a general source-colour policy' }
}
if ((Get-FileHash -LiteralPath $simple.artifact.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.sourceSha256 -or
    (Get-FileHash -LiteralPath $simple.artifact.outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.outputSha256) {
  throw 'Frozen source or reference changed during evaluation.'
}
$reportPath = Join-Path $work ($reportPrefix + '-measurement.json')
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{ Report=$reportPath; Output=$output; Seconds=$measurement.Seconds;
  PeakWorkingSetBytes=$measurement.PeakWorkingSetBytes; Frames=$video.nb_read_frames } | ConvertTo-Json