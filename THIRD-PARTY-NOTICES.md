# Third-party components

ArtDaddy ships several programs it did not write. They keep their own licenses, and
those licenses are why this application is distributed under the GPL: the bundled
ffmpeg builds are GPL, and a work that conveys them must be GPL-compatible.

Nothing here is statically linked into the application. Each is an independent
executable that ArtDaddy launches as a subprocess ("sidecar") and communicates with
over its command line and standard streams.

## Bundled executables

| Component | Upstream | License |
| --- | --- | --- |
| ffmpeg / ffprobe (Windows, Linux) | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) — `*-gpl` builds | **GPL-3.0-or-later** (these builds enable GPL components such as libx264) |
| ffmpeg / ffprobe (macOS) | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) | GPL or LGPL depending on the build; see the upstream page |
| whisper.cpp (`whisper-cli`) | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT |
| yt-dlp | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |

`scripts/fetch-sidecars.mjs` downloads these at build time from the URLs above; they
are not committed to this repository.

## Speech model

The model weights the app downloads are OpenAI's Whisper models converted to the ggml format by the whisper.cpp
project and published at [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), whose model card
declares the MIT license. Whisper is MIT, Copyright (c) 2022 OpenAI; whisper.cpp is MIT, Copyright (c) 2023-2026 The
ggml authors.

The weights are not bundled in the installer and are not committed to this repository. The app downloads them on first
use from that upstream repository or, when it is unavailable, from an unmodified copy that ArtDaddy hosts at
`models.artdaddy.app`. Wherever the bytes come from, the app uses a file only after its size and SHA-256 equal the
values pinned in `src/tools/modelManifest.ts`.

## Obtaining the source of bundled GPL components

The ffmpeg builds are unmodified upstream releases. Their corresponding source is
published by the projects linked above, which is where these binaries come from.
If you need a copy and cannot obtain it from upstream, open an issue and we will
point you at the exact release the build came from.

## Fonts and assets

Fonts bundled for captions and titles carry their own licenses; see
`src-tauri/resources/` for the files shipped with a release.
