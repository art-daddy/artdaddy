param(
  [ValidateSet('Stage', 'Build', 'Run')] [string]$Action = 'Stage',
  [ValidateSet(1, 16)] [int]$Readers = 1,
  [ValidateSet(180, 1800)] [int]$Frames = 180,
  [ValidateSet('Hardware', 'Software')] [string]$DecodeMode = 'Hardware',
  [switch]$GpuResize,
  [switch]$GpuBatch,
  [switch]$EncodeVideo,
  [switch]$SkipReaderDiagnostics,
  [ValidateSet('Raw', 'Qtrle')] [string]$CaptionTransport = 'Qtrle',
  [ValidateRange(1, 512)] [int]$EncodedBudgetMB = 512,
  [switch]$CheckCache
)

$ErrorActionPreference = 'Stop'
if ($CheckCache -and $Action -ne 'Build') { throw 'CheckCache requires Action Build.' }
if ($GpuResize -and $DecodeMode -ne 'Hardware') { throw 'Private GPU resize requires the hardware frame path.' }
if ($GpuBatch -and -not $GpuResize) { throw 'Private GPU batching requires bounded GPU resize slots.' }
if ($EncodeVideo -and $DecodeMode -ne 'Hardware') { throw 'Private video output requires hardware surface ownership.' }
if ($EncodeVideo -and $Readers -eq 16 -and (-not $GpuResize -or -not $GpuBatch)) { throw 'Dense encoded fixture requires bounded GPU resize/batch.' }
if ($SkipReaderDiagnostics -and (-not $EncodeVideo -or -not $GpuResize -or -not $GpuBatch)) { throw 'Output-only probe requires encoded shader composition.' }
$revisionPrefix = 'c867e13549'
$sourceRevision = 'c867e135494d97b27158d17837d254bbbb8d4f7b'
$privateRoot = Join-Path ([IO.Path]::GetTempPath()) ('artdaddy-export-native-sdk-' + $revisionPrefix)
$runtimeRoot = Join-Path ([IO.Path]::GetTempPath()) 'artdaddy-export-mlt-26.9.27/runtime/Shotcut'
$pinnedArchive = Join-Path ([IO.Path]::GetTempPath()) 'artdaddy-export-mlt-26.9.27/shotcut-win64-26.9.27.zip'
if ((Get-FileHash -LiteralPath $pinnedArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    '1f8c50ce7b125a2f0dcb60777b358e86baf03b8515982612b6adae10a83d93a5') {
  throw 'The private runtime archive no longer matches its pinned release digest.'
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'ffmpeg.exe'))) {
  throw 'The pinned private runtime is unavailable.'
}
$runtimeVersion = (& (Join-Path $runtimeRoot 'ffmpeg.exe') -version 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -notmatch ('\bg' + $revisionPrefix + '\b')) {
  throw 'The private runtime does not report the expected FFmpeg source revision.'
}
$headers = @{ 'User-Agent' = 'ArtDaddy-private-exporter-feasibility' }
$commit = [pscustomobject]@{ sha=$sourceRevision }
New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
$sourceArchive = Join-Path $privateRoot ($commit.sha + '.zip')
$sourceUrl = 'https://github.com/FFmpeg/FFmpeg/archive/' + $commit.sha + '.zip'
if (-not (Test-Path -LiteralPath $sourceArchive)) {
  Invoke-WebRequest -Uri $sourceUrl -Headers $headers -OutFile $sourceArchive -UseBasicParsing -TimeoutSec 120
}
if ((Get-Item -LiteralPath $sourceArchive).Length -gt 64MB) { throw 'Source archive exceeds the private SDK byte budget.' }
$sourceRoot = Join-Path $privateRoot ('FFmpeg-' + $commit.sha)
if (-not (Test-Path -LiteralPath $sourceRoot)) {
  Expand-Archive -LiteralPath $sourceArchive -DestinationPath $privateRoot
}
$versions = [ordered]@{
  avcodec = @{ directory='libavcodec'; major=63; minor=1; micro=102 }
  avformat = @{ directory='libavformat'; major=63; minor=1; micro=102 }
  avutil = @{ directory='libavutil'; major=61; minor=1; micro=102 }
  avfilter = @{ directory='libavfilter'; major=12; minor=1; micro=102 }
  swscale = @{ directory='libswscale'; major=10; minor=1; micro=102 }
  swresample = @{ directory='libswresample'; major=7; minor=1; micro=102 }
}
$libraryReceipts = @()
foreach ($name in $versions.Keys) {
  $expected = $versions[$name]
  $macro = 'LIB' + $name.ToUpperInvariant() + '_VERSION_'
  $header = Join-Path $sourceRoot ($expected.directory + '/version.h')
  $majorHeader = Join-Path $sourceRoot ($expected.directory + '/version_major.h')
  $versionText = Get-Content -LiteralPath $header -Raw -Encoding UTF8
  if (Test-Path -LiteralPath $majorHeader) { $versionText += Get-Content -LiteralPath $majorHeader -Raw -Encoding UTF8 }
  foreach ($part in @('major', 'minor', 'micro')) {
    $pattern = '(?m)^\s*#define\s+' + $macro + $part.ToUpperInvariant() + '\s+(\d+)\s*$'
    $match = [regex]::Match($versionText, $pattern)
    if (-not $match.Success -or [int]$match.Groups[1].Value -ne $expected[$part]) {
      throw ('Source header version does not match the staged runtime: ' + $name + '.' + $part)
    }
  }
  $binary = Join-Path $runtimeRoot ($name + '-' + $expected.major + '.dll')
  if (-not (Test-Path -LiteralPath $binary)) { throw ('Missing pinned library: ' + $name) }
  $libraryReceipts += [ordered]@{
    name=$name; version=('{0}.{1}.{2}' -f $expected.major, $expected.minor, $expected.micro)
    binary=$binary; binarySha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    headerSha256=(Get-FileHash -LiteralPath $header -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
foreach ($required in @('libavcodec/avcodec.h', 'libavformat/avformat.h', 'libavutil/hwcontext_d3d11va.h', 'COPYING.GPLv3')) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required))) { throw ('SDK source is missing ' + $required) }
}
$headerDigests = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.h' | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path=$_.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$headerManifestBytes = [Text.Encoding]::UTF8.GetBytes(($headerDigests | ConvertTo-Json -Compress -Depth 4))
$headerHasher = [Security.Cryptography.SHA256]::Create()
try { $consumerHeadersSha256 = ([BitConverter]::ToString($headerHasher.ComputeHash($headerManifestBytes))).Replace('-', '').ToLowerInvariant() }
finally { $headerHasher.Dispose() }
$receipt = [ordered]@{
  status='source_staged_versions_match_configuration_headers_pending'; phase='E0'
  commit=$commit.sha; sourceUrl=$sourceUrl; sourceRoot=$sourceRoot; runtimeRoot=$runtimeRoot
  sourceArchiveSha256=(Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  provenance='HTTPS upstream immutable commit; observed archive digest, not an independently published archive checksum'
  runtimeArchiveSha256='1f8c50ce7b125a2f0dcb60777b358e86baf03b8515982612b6adae10a83d93a5'
  license='Pinned runtime reports GPL/version3 enabled; private evaluation only, no distribution approval'
  libraries=$libraryReceipts; stagedAt=(Get-Date).ToUniversalTime().ToString('o')
  consumerHeadersSha256=$consumerHeadersSha256; headerCount=$headerDigests.Count
  residuals=@('generated configuration headers still required', 'no worker compiled yet', 'no production dependency or bundle change')
}
$receiptPath = Join-Path $privateRoot 'sdk-provenance.json'
if ($Action -eq 'Stage') {
  [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
}
if ($Action -eq 'Build') {
  $vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
  $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'An existing MSVC compiler is required.' }
  Import-Module (Join-Path $installation 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
  Enter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
  foreach ($variable in @('INCLUDE', 'LIB', 'LIBPATH')) {
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $entries = @([Environment]::GetEnvironmentVariable($variable) -split ';' | Where-Object { $_ -and $seen.Add($_) })
    [Environment]::SetEnvironmentVariable($variable, ($entries -join ';'))
  }
  $bash = 'C:/Program Files/Git/bin/bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) { throw 'The existing Git bash configure tool is required.' }
  $buildRoot = Join-Path $privateRoot 'build-msvc'
  New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
  $configure = ($sourceRoot -replace '\\', '/') + '/configure'
  $configureArgs = @('--toolchain=msvc', '--disable-programs', '--disable-doc', '--disable-everything', '--disable-autodetect', '--disable-x86asm', '--enable-shared', '--disable-static')
  $compiler = (Get-Command cl.exe -ErrorAction Stop).Source
  $configurationInputs = [ordered]@{
    version=1; sourceArchive=$receipt.sourceArchiveSha256; sourceHeaders=$consumerHeadersSha256
    configure=(Get-FileHash -LiteralPath $configure -Algorithm SHA256).Hash
    compiler=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash; compilerPath=$compiler
    bash=(Get-FileHash -LiteralPath $bash -Algorithm SHA256).Hash; arguments=$configureArgs
    include=$env:INCLUDE; lib=$env:LIB; toolVersion=$env:VCToolsVersion; windowsSdk=$env:WindowsSDKVersion
    compilerFlags=$env:CL; compilerTailFlags=$env:_CL_; linkerFlags=$env:LINK; linkerTailFlags=$env:_LINK_
    cflags=$env:CFLAGS; cppflags=$env:CPPFLAGS; ldflags=$env:LDFLAGS
  }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $configurationKey = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($configurationInputs | ConvertTo-Json -Compress -Depth 6))))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  $configurationCachePath = Join-Path $buildRoot 'configuration-cache.json'
  $configurationCache = $null
  if (Test-Path -LiteralPath $configurationCachePath) {
    try { $configurationCache = Get-Content -LiteralPath $configurationCachePath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { $configurationCache = $null }
  }
  if ($configurationCache -and $configurationCache.key -ne $configurationKey) {
    for ($copies = 2; $copies -le 16; $copies++) {
      $legacyInputs = [ordered]@{}
      foreach ($field in $configurationInputs.Keys) { $legacyInputs[$field] = $configurationInputs[$field] }
      $legacyInputs.include = (@(1..$copies | ForEach-Object { $env:INCLUDE }) -join ';')
      $legacyInputs.lib = (@(1..$copies | ForEach-Object { $env:LIB }) -join ';')
      $hasher = [Security.Cryptography.SHA256]::Create()
      try { $legacyKey = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($legacyInputs | ConvertTo-Json -Compress -Depth 6))))).Replace('-', '').ToLowerInvariant() }
      finally { $hasher.Dispose() }
      if ($configurationCache.key -eq $legacyKey) {
        $configurationCache.key = $configurationKey
        break
      }
    }
  }
  $configurationReusable = $configurationCache -and $configurationCache.key -eq $configurationKey
  $configurationMiss = 'configuration input identity changed or receipt absent'
  if ($configurationReusable) {
    $currentHeaders = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Filter '*.h')
    if ($currentHeaders.Count -ne @($configurationCache.headers).Count) {
      $configurationReusable = $false
      $configurationMiss = ('generated header set changed: {0} current / {1} cached' -f $currentHeaders.Count, @($configurationCache.headers).Count)
    }
    foreach ($header in $configurationCache.headers) {
      if (-not (Test-Path -LiteralPath $header.path) -or (Get-FileHash -LiteralPath $header.path -Algorithm SHA256).Hash -ne $header.sha256) {
        $configurationReusable = $false
        $configurationMiss = ('generated header changed: ' + $header.path)
        break
      }
    }
    if (-not $configurationCache.headers -or -not (Test-Path -LiteralPath (Join-Path $buildRoot 'libavutil/avconfig.h'))) { $configurationReusable = $false }
  }
  Push-Location $buildRoot
  try {
    if (-not $configurationReusable) {
      if ($CheckCache) { throw ('SDK cache miss: ' + $configurationMiss) }
      Write-Output ('SDK cache miss: ' + $configurationMiss)
      & $bash $configure @configureArgs
      if ($LASTEXITCODE -ne 0) { throw 'Private SDK configuration failed; inspect build-msvc/ffbuild/config.log.' }
      if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'libavutil/avconfig.h'))) { throw 'SDK configuration emitted no consumer header.' }
      $generatedHeaders = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Filter '*.h' | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path=$_.FullName; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
      })
      [IO.File]::WriteAllText($configurationCachePath, ([ordered]@{ key=$configurationKey; inputs=$configurationInputs; headers=$generatedHeaders } | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    }
    Write-Output ('SDK configuration cache: ' + $(if ($configurationReusable) { 'verified hit' } else { 'rebuilt' }))
    if ($CheckCache) { return }
    if (-not $CheckCache -and $configurationReusable) {
      [IO.File]::WriteAllText($configurationCachePath, ([ordered]@{ key=$configurationKey; inputs=$configurationInputs; headers=$configurationCache.headers } | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    }
    $worker = Join-Path $buildRoot 'exporterNativeWorker.exe'
    $workerSource = Join-Path $PSScriptRoot 'exporterNativeWorker.cpp'
    $dependencyPath = Join-Path $buildRoot 'worker-dependencies.json'
    $compileArgs = @('/nologo', '/std:c++20', '/EHsc', '/O2', '/W4', ('/I' + $buildRoot), ('/I' + $sourceRoot),
      '/sourceDependencies', $dependencyPath, $workerSource, ('/Fe:' + $worker), '/link', 'psapi.lib', 'd3dcompiler.lib')
    $workerSourceHash = (Get-FileHash -LiteralPath $workerSource -Algorithm SHA256).Hash
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    & $compiler @compileArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $worker)) { throw 'Private worker compilation failed.' }
    $dependencies = Get-Content -LiteralPath $dependencyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($dependencies.Data.Source -ne $workerSource -or -not $dependencies.Data.Includes) { throw 'Compiler emitted no matching source dependency manifest.' }
    if ((Get-FileHash -LiteralPath $workerSource -Algorithm SHA256).Hash -ne $workerSourceHash) { throw 'Worker source changed during compilation.' }
    $receipt.workerDependencies = @($dependencies.Data.Includes | Sort-Object -Unique | ForEach-Object {
      [ordered]@{ path=$_; sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    })
    $receipt.status = 'sdk_configured_worker_compiled_artifact_unverified'
    $receipt.worker = $worker
    $receipt.workerSha256 = (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.workerSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'exporterNativeWorker.cpp') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.configurationHeader = Join-Path $buildRoot 'libavutil/avconfig.h'
    $receipt.configurationSha256 = (Get-FileHash -LiteralPath (Join-Path $buildRoot 'libavutil/avconfig.h') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.residuals = @('worker artifact checks not yet run', 'SDK configuration is for consumer compilation, not a rebuild of runtime libraries', 'no production dependency or bundle change')
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  } finally { Pop-Location }
}
if ($Action -eq 'Run') {
  $built = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($built.status -ne 'sdk_configured_worker_compiled_artifact_unverified' -or $built.commit -ne $commit.sha -or
      (Get-FileHash -LiteralPath $built.worker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $built.workerSha256 -or
      (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'exporterNativeWorker.cpp') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $built.workerSourceSha256) {
    throw 'The private worker no longer matches its pinned SDK build receipt.'
  }
  if ($consumerHeadersSha256 -ne $built.consumerHeadersSha256 -or
      (Get-FileHash -LiteralPath $built.configurationHeader -Algorithm SHA256).Hash.ToLowerInvariant() -ne $built.configurationSha256) {
    throw 'The private SDK consumer/configuration headers changed after compilation.'
  }
  if ((Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $built.sourceArchiveSha256) {
    throw 'The private SDK source archive changed after compilation.'
  }
  foreach ($library in $built.libraries) {
    $observed = $libraryReceipts | Where-Object { $_.name -eq $library.name } | Select-Object -First 1
    if (-not $observed -or $observed.binarySha256 -ne $library.binarySha256 -or $observed.headerSha256 -ne $library.headerSha256) {
      throw ('Pinned SDK header/runtime library changed after compilation: ' + $library.name)
    }
  }
  $baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../reports/bench/export-feasibility-baseline.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $simple = $baseline.cases | Where-Object { $_.level -eq 'simple' } | Select-Object -First 1
  $fixture = [IO.Path]::GetFullPath($baseline.fixtureDir)
  if (-not ([IO.Path]::GetFileName($fixture)).StartsWith('artdaddy-bench-render-') -or
      -not $fixture.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or
      $baseline.profile.width -ne 3840 -or $baseline.profile.height -ne 2160 -or $baseline.profile.fps -ne 60) {
    throw 'Native worker accepts only the frozen private 4K/60 fixture.'
  }
  foreach ($file in @($simple.artifact.sourcePath, $simple.artifact.outputPath)) {
    if (-not ([IO.Path]::GetFullPath($file)).StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A frozen source/reference escapes the private fixture.'
    }
  }
  if ((Get-FileHash -LiteralPath $simple.artifact.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.sourceSha256 -or
      (Get-FileHash -LiteralPath $simple.artifact.outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.outputSha256) {
    throw 'Frozen source/reference changed before native work.'
  }
  $work = Join-Path $fixture ('native-worker-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $pixels = Join-Path $work 'frames.rgb'
  $arguments = @($runtimeRoot, $simple.artifact.sourcePath, $pixels, [string]$Readers, [string]$Frames,
    $(if ($DecodeMode -eq 'Hardware') { '1' } else { '0' }), $(if ($GpuResize) { '1' } else { '0' }), $(if ($GpuBatch) { '1' } else { '0' }))
  $elementary = $null
  $scene = $null
  if ($EncodeVideo) {
    $scene = Get-Content -LiteralPath (Join-Path $fixture 'native-scene-current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($scene.readers -ne $Readers -or $scene.frames -ne $Frames -or $scene.sourceSha256 -ne $simple.artifact.sourceSha256 -or
        $scene.referenceSha256 -ne $simple.artifact.outputSha256 -or
        -not ([IO.Path]::GetFullPath($scene.file)).StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $scene.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.sha256) {
      throw 'Private encoded fixture must use the matching immutable shared-scene manifest.'
    }
    if ($scene.mode -and $scene.mode -ne 'tiles') {
      if (-not $scene.renderReference -or
          -not ([IO.Path]::GetFullPath($scene.renderReference.path)).StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
          (Get-FileHash -LiteralPath $scene.renderReference.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.renderReference.sha256) {
        throw 'Overlap mode requires its independently frozen existing-renderer artifact.'
      }
    }
    $elementary = Join-Path $work 'video.h264'
    $arguments += @($scene.file, $elementary, [string]($EncodedBudgetMB * 1048576))
    if ($scene.alphaAsset) {
      foreach ($asset in @(@{file=$scene.alphaAsset.path; sha=$scene.alphaAsset.sha256}, @{file=$scene.alphaAsset.rgba; sha=$scene.alphaAsset.rgbaSha256})) {
        if (-not ([IO.Path]::GetFullPath($asset.file)).StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            (Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha) {
          throw 'Admitted alpha media changed or escaped the private fixture.'
        }
      }
      $arguments += @($scene.alphaAsset.rgba)
    }
    if ($scene.captionPlane) {
      if ($scene.captionPlane.frames -ne $Frames -or $scene.captionPlane.fps -ne 60) { throw 'Caption frame clock differs from the admitted scene.' }
      foreach ($asset in @(@{file=$scene.captionPlane.ass; sha256=$scene.captionPlane.sha256}) + @($scene.captionPlane.fonts)) {
        if (-not ([IO.Path]::GetFullPath($asset.file)).StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            (Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) {
          throw 'Frozen caption/font asset changed or escaped the fixture.'
        }
      }
      $arguments += @($(if ($CaptionTransport -eq 'Qtrle') { '--caption-qtrle-stdin' } else { '--caption-premultiplied-rgba-stdin' }))
    }
  }
  if ($SkipReaderDiagnostics) {
    if (-not $scene.mode -or $scene.mode -eq 'tiles') { throw 'Output-only probe cannot replace tiled compositor inputs.' }
    $arguments += @('--no-comparison')
  }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $built.worker
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = [bool]($scene -and $scene.captionPlane)
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  [void]$process.Start()
  $ownedHandle = $process.Handle
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $captionProcess = $null
  $captionTask = $null
  $captionErrors = $null
  $captionArguments = $null
  if ($scene -and $scene.captionPlane) {
    try {
      if (-not ('ArtDaddyPrivateCaptionPipeV2' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading.Tasks;
public static class ArtDaddyPrivateCaptionPipeV2 {
  public static async Task<long> Copy(Stream source, Stream destination, long limit, bool exact) {
        long bytes = 0;
        byte[] buffer = new byte[65536];
        try {
            int count;
            while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) {
                bytes += count;
                if (bytes > limit) throw new IOException("Caption stream exceeded its admitted byte budget.");
                await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
            }
            if (bytes == 0 || (exact && bytes != limit)) throw new IOException("Caption stream was truncated.");
            return bytes;
        } finally { destination.Dispose(); }
    }
}
'@
      }
      $captionStart = New-Object Diagnostics.ProcessStartInfo
      $captionStart.FileName = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe'))
      $captionStart.WorkingDirectory = [IO.Path]::GetDirectoryName($scene.captionPlane.ass)
      $captionArguments = @('-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-threads', '1',
        '-f', 'lavfi', '-i', ('color=c=black@0:s=3840x2160:r=60:d=' + ($Frames / 60.0) + ',format=rgba'),
        '-vf', ('ass=f=' + [IO.Path]::GetFileName($scene.captionPlane.ass) + ':fontsdir=fonts:alpha=1'),
        '-frames:v', [string]$Frames)
      if ($CaptionTransport -eq 'Qtrle') {
        $captionArguments += @('-c:v', 'qtrle', '-pix_fmt', 'argb', '-threads:v', '1',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mov', 'pipe:1')
      } else { $captionArguments += @('-pix_fmt', 'rgba', '-threads:v', '1', '-f', 'rawvideo', 'pipe:1') }
      $captionStart.Arguments = ($captionArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
      $captionStart.UseShellExecute = $false; $captionStart.CreateNoWindow = $true
      $captionStart.RedirectStandardOutput = $true; $captionStart.RedirectStandardError = $true
      $captionProcess = New-Object Diagnostics.Process
      $captionProcess.StartInfo = $captionStart
      [void]$captionProcess.Start()
      $captionHandle = $captionProcess.Handle
      $captionErrors = $captionProcess.StandardError.ReadToEndAsync()
      $captionLimit = if ($CaptionTransport -eq 'Qtrle') { [long]536870912 } else { [long]$Frames * 3840 * 2160 * 4 }
      $captionTask = [ArtDaddyPrivateCaptionPipeV2]::Copy($captionProcess.StandardOutput.BaseStream, $process.StandardInput.BaseStream,
        $captionLimit, ($CaptionTransport -eq 'Raw'))
    } catch {
      if ($captionProcess -and -not $captionProcess.HasExited) { $captionProcess.Kill(); $captionProcess.WaitForExit() }
      if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
      if ($captionProcess) { $captionProcess.Dispose() }
      $process.Dispose()
      throw
    }
  }
  $timedOut = -not $process.WaitForExit(120000)
  if ($timedOut) { $process.Kill(); $process.WaitForExit() }
  $captionFailed = $false
  if ($captionProcess) {
    $captionTimedOut = -not $captionProcess.WaitForExit(1000)
    if ($captionTimedOut) { $captionProcess.Kill(); $captionProcess.WaitForExit() }
    $captionCode = $captionProcess.ExitCode
    $captionBytes = 0
    $captionCopyError = $null
    try { $captionBytes = $captionTask.GetAwaiter().GetResult() } catch { $captionCopyError = $_.Exception.Message }
    $captionFailed = $captionTimedOut -or $captionCode -ne 0 -or [bool]$captionCopyError
    [IO.File]::WriteAllText((Join-Path $work 'caption-execution.json'), ([ordered]@{
      code=$captionCode; timedOut=$captionTimedOut; bytes=$captionBytes; copyError=$captionCopyError
      transport=$CaptionTransport; limitBytes=$captionLimit
      stderr=$captionErrors.GetAwaiter().GetResult(); arguments=$captionArguments
      ffmpegSha256=(Get-FileHash -LiteralPath $captionStart.FileName -Algorithm SHA256).Hash.ToLowerInvariant()
      scope='Bounded 65536-byte pipe plus native current-frame buffer; producer/whole-job GPU/system memory unqualified'
    } | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    $captionProcess.Dispose()
  }
  $exitCode = $process.ExitCode
  $outputText = $stdout.GetAwaiter().GetResult()
  $errorText = $stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $work 'worker-execution.json'), ([ordered]@{
    status='execution_observed_artifact_unverified'; code=$exitCode; timedOut=$timedOut
    stdout=$outputText; stderr=$errorText; arguments=$arguments
  } | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  $process.Dispose()
  if ($exitCode -ne 0 -or $timedOut -or $captionFailed -or -not (Test-Path -LiteralPath $pixels) -or
      (Get-Item -LiteralPath $pixels).Length -ne $(if ($SkipReaderDiagnostics) { 0 } else { $Readers * $Frames * 32 * 18 * 3 })) {
    throw ('Native worker refused/failed/incomplete; partial artifact at ' + $work)
  }
  if ((Get-FileHash -LiteralPath $simple.artifact.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.sourceSha256 -or
      (Get-FileHash -LiteralPath $simple.artifact.outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.outputSha256) {
    throw 'Frozen source/reference changed during native work.'
  }
  if ($EncodeVideo -and (Get-FileHash -LiteralPath $scene.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.sha256) {
    throw 'Shared scene manifest changed during native encoding; artifact remains unverified.'
  }
  if ($EncodeVideo -and $scene.alphaAsset -and
      ((Get-FileHash -LiteralPath $scene.alphaAsset.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.alphaAsset.sha256 -or
       (Get-FileHash -LiteralPath $scene.alphaAsset.rgba -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.alphaAsset.rgbaSha256)) {
    throw 'Admitted alpha media changed during native work.'
  }
  if ($EncodeVideo -and $scene.captionPlane) {
    foreach ($asset in @(@{file=$scene.captionPlane.ass; sha256=$scene.captionPlane.sha256}) + @($scene.captionPlane.fonts)) {
      if ((Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) {
        throw 'Frozen caption/font asset changed during native work.'
      }
    }
  }
  $report = [ordered]@{
    status='decoded_only_artifact_verification_pending'; phase='E0'; readers=$Readers; frames=$Frames; decodeMode=$DecodeMode
    gpuResize=[bool]$GpuResize; gpuBatch=[bool]$GpuBatch
    encodeVideo=[bool]$EncodeVideo; encodedBudgetBytes=($EncodedBudgetMB * 1048576); elementary=$elementary; sharedScene=$scene
    captionTransport=$CaptionTransport
    diagnostics=(-not $SkipReaderDiagnostics)
    source=$simple.artifact.sourcePath; sourceSha256=$simple.artifact.sourceSha256
    baseline=$simple.artifact.outputPath; baselineSha256=$simple.artifact.outputSha256
    rawPixels=$pixels; rawPixelsSha256=(Get-FileHash -LiteralPath $pixels -Algorithm SHA256).Hash.ToLowerInvariant()
    workerSha256=$built.workerSha256; sourceCommit=$built.commit
    measurement=($outputText | ConvertFrom-Json)
    scope='Bounded source decode and comparison downsample only; no output compositor/audio/encoder/delivery qualification'
  }
  if ($EncodeVideo) {
    if (-not (Test-Path -LiteralPath $elementary) -or (Get-Item -LiteralPath $elementary).Length -eq 0) {
      throw 'Native encoder emitted no elementary video.'
    }
    $video = Join-Path $work 'video.mp4'
    $ffmpeg = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe'))
    $duration = $Frames / 60.0
    $muxArgs = @('-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-r', '60', '-i', $elementary,
      '-i', $simple.artifact.sourcePath, '-map', '0:v', '-c:v', 'copy')
    if ($Frames -eq 1800) {
      $muxArgs += @('-filter_complex', '[1:a:0]atrim=end_sample=144000,asetpts=PTS-STARTPTS,aloop=loop=9:size=144000,asetpts=N/SR/TB[aout]',
        '-map', '[aout]', '-c:a', 'aac', '-ar', '48000', '-ac', '2')
    } else { $muxArgs += @('-map', '1:a:0', '-c:a', 'copy') }
    $muxArgs += @('-t', [string]$duration, $video)
    $muxStart = New-Object Diagnostics.ProcessStartInfo
    $muxStart.FileName = $ffmpeg
    $muxStart.Arguments = ($muxArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $muxStart.UseShellExecute = $false; $muxStart.CreateNoWindow = $true
    $muxStart.RedirectStandardError = $true
    $mux = New-Object Diagnostics.Process
    $mux.StartInfo = $muxStart
    $muxClock = [Diagnostics.Stopwatch]::StartNew()
    [void]$mux.Start()
    $muxHandle = $mux.Handle
    $muxErrors = $mux.StandardError.ReadToEndAsync()
    $muxTimedOut = -not $mux.WaitForExit(60000)
    if ($muxTimedOut) { $mux.Kill(); $mux.WaitForExit() }
    $muxCode = $mux.ExitCode
    $muxError = $muxErrors.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $work 'mux-execution.json'), ([ordered]@{
      code=$muxCode; timedOut=$muxTimedOut; seconds=$muxClock.Elapsed.TotalSeconds; stderr=$muxError; arguments=$muxArgs
    } | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    $mux.Dispose()
    if ($muxCode -ne 0 -or $muxTimedOut -or -not (Test-Path -LiteralPath $video)) { throw ('Native artifact remux failed: ' + $work) }
    if ((Get-FileHash -LiteralPath $simple.artifact.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $simple.artifact.sourceSha256 -or
        (Get-FileHash -LiteralPath $scene.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.sha256) {
      throw 'Frozen source/shared scene changed during mux; artifact remains unverified.'
    }
    if ($scene.alphaAsset -and
        ((Get-FileHash -LiteralPath $scene.alphaAsset.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.alphaAsset.sha256 -or
         (Get-FileHash -LiteralPath $scene.alphaAsset.rgba -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.alphaAsset.rgbaSha256)) {
      throw 'Frozen alpha media changed during mux; artifact remains unverified.'
    }
    if ($scene.captionPlane) {
      foreach ($asset in @(@{file=$scene.captionPlane.ass; sha256=$scene.captionPlane.sha256}) + @($scene.captionPlane.fonts)) {
        if ((Get-FileHash -LiteralPath $asset.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) {
          throw 'Frozen caption/font asset changed during mux; artifact remains unverified.'
        }
      }
    }
    $report.output = $video
    $report.outputSha256 = (Get-FileHash -LiteralPath $video -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.expectedFrames = $Frames; $report.referenceFrames = 180; $report.repeatCount = $Frames / 180
    $report.visualLayers = $Readers; $report.profile = $baseline.profile
    $report.muxSeconds = $muxClock.Elapsed.TotalSeconds
    $report.scope = 'Private opaque shared-placement decode/composition/hardware encode plus exact stereo-source remux; not general effects/audio/recovery/delivery qualification'
    if ($scene.mode -and $scene.mode -ne 'tiles') {
      if ((Get-FileHash -LiteralPath $scene.renderReference.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $scene.renderReference.sha256) {
        throw 'Frozen overlap render reference changed during native output.'
      }
      $report.baseline = $scene.renderReference.path
      $report.baselineSha256 = $scene.renderReference.sha256
      $report.referenceFrames = if ($scene.renderReference.referenceFrames) { $scene.renderReference.referenceFrames } else { $Frames }
      $report.repeatCount = $Frames / $report.referenceFrames
      $report.scope = 'Private shared per-frame overlap/z-order/opacity encoded output; independent existing-renderer conformance pending'
      if ($scene.alphaAsset) {
        $report.scope = 'Private static PNG pixel-alpha times shared clip opacity encoded output; image reader RGB diagnostics are zero placeholders, not image-content proof; independent full-canvas conformance pending'
      }
      if ($scene.captionPlane) {
        $report.scope = 'Private explicit shipped-libass coverage-weighted RGBA stream to bounded native caption texture; one topmost band only; caption-region/reference conformance pending; producer/whole-job memory and performance unqualified'
      }
    }
  }
  $reportPath = Join-Path $work 'worker-measurement.json'
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  [pscustomobject]@{ Report=$reportPath; Readers=$Readers; Frames=$Frames; RawBytes=(Get-Item -LiteralPath $pixels).Length } | ConvertTo-Json
  return
}
[pscustomobject]@{ Receipt=$receiptPath; SourceRevision=$commit.sha; SourceRoot=$sourceRoot; Status=$receipt.status } | ConvertTo-Json