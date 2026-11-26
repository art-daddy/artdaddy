# Writes the spoken-captions fixture (art-daddy/backlog#83): src/tools/__fixtures__/speech/spoken.ogg
# and spoken.words.json, what the voice says and when each word starts.
#
#   powershell -NoProfile -File scripts/genSpeechFixture.ps1
#
# The voice is Windows' own "Microsoft Zira Desktop" (System.Speech, offline and free: nothing leaves
# the PC and no paid service is used). Its word times come from the synthesiser itself (SpeakProgress),
# so the reference is what was actually said, never typed in by hand. The audio is encoded to Opus
# (32 kb/s, mono) by the shipped ffmpeg to keep it small. Windows only; the files are committed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "src\tools\__fixtures__\speech"
$ffmpeg = Join-Path $root "src-tauri\binaries\artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path $ffmpeg)) { throw "the shipped ffmpeg is not staged at $ffmpeg (npm run fetch:sidecars)" }
New-Item -ItemType Directory -Force $out | Out-Null

$voice = "Microsoft Zira Desktop"
$sentences = @(
  "Captions should follow the voice.",
  "Every word appears while it is spoken.",
  "The picture and the sound stay together."
)
# Quiet before, between and after the sentences: the captions must come and go with the voice.
$ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
  '<break time="600ms"/>' + ($sentences -join '<break time="1200ms"/>') + '<break time="600ms"/></speak>'

Add-Type -AssemblyName System.Speech
$wav = Join-Path ([System.IO.Path]::GetTempPath()) "artdaddy-spoken-$PID.wav"
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$words = New-Object System.Collections.ArrayList
try {
  $synth.SelectVoice($voice)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($wav, $format)
  $synth.add_SpeakProgress({
      param($sender, $e)
      [void]$words.Add([ordered]@{ word = $e.Text; start = [math]::Round($e.AudioPosition.TotalSeconds, 3) })
    })
  $synth.SpeakSsml($ssml)
} finally {
  $synth.Dispose()
}

& $ffmpeg -y -v error -i $wav -c:a libopus -b:a 32k -ac 1 -fflags +bitexact -flags:a +bitexact -serial_offset 1 (Join-Path $out "spoken.ogg")
if ($LASTEXITCODE -ne 0) { throw "ffmpeg could not encode $wav" }
Remove-Item $wav

$lines = $words | ForEach-Object { '    { "word": "' + $_.word + '", "start": ' + $_.start.ToString([System.Globalization.CultureInfo]::InvariantCulture) + ' }' }
$json = "{`n" +
  '  "made_by": "scripts/genSpeechFixture.ps1",' + "`n" +
  '  "voice": "' + $voice + '",' + "`n" +
  '  "text": "' + ($sentences -join " ") + '",' + "`n" +
  '  "words": [' + "`n" + ($lines -join ",`n") + "`n  ]`n}`n"
# No byte-order mark: the test reads it as plain UTF-8 JSON.
[System.IO.File]::WriteAllText((Join-Path $out "spoken.words.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "wrote $($words.Count) words to $out"
