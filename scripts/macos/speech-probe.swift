// Does Apple's SpeechTranscriber return what we would need to replace whisper?
//
// Written to answer ONE question that no amount of documentation settles: whether the
// timing that comes back is PER WORD or only per phrase. Our transcript model carries
// start_seconds/end_seconds/probability for every word (src/tools/transcribe.ts), and the
// karaoke caption sweep animates from them, so phrase-level timing would make this a
// supplement to whisper rather than a replacement. Everything else here is context for
// that answer: whether the API is available at all, which locales, and what the asset
// download actually costs the first time.
//
// Deliberately NOT a sidecar. It transcribes one file and prints what it got; nothing here
// is wired into the app. Build the real thing once this says it is worth building.
//
// Every API used below was taken from Apple's own SpeechAnalyzer sample or its Topics list
// — none is guessed. The one thing that would be a guess, the name of the timing attribute
// key, is avoided on purpose: the run prints the AttributedString's own description, which
// carries whatever attributes are present without this file having to name them. A probe
// that fails to compile costs a rented Mac.
//
// WHAT THE FIRST RUN FOUND (macos-26 runner, macOS 26.5.2, 2026-09-03):
//
//   isAvailable: false      installedLocales: []      supportedLocales: []
//   asset install failed: SFSpeechErrorDomain Code=1
//     "Cannot check the download status, speech-probe is not subscribed to transcription.en"
//
// So the word-timing question is still open, but two things are now known. GitHub's macOS
// runners are VMs and do not support this API at all, which means CI cannot answer it — a
// real Apple Silicon Mac is required. And the asset error names the PROCESS ("speech-probe
// is not subscribed"), which is a warning about the plan that motivated this: a bare CLI
// sidecar in the whisper-cli mould may not be an eligible client for these models, and this
// may have to live inside the app bundle rather than beside it. Worth settling before any
// sidecar is written.
//
//   swiftc -O -target arm64-apple-macos26.0 -o speech-probe speech-probe.swift
//   ./speech-probe some.wav

import AVFoundation
import Foundation
import Speech

func line(_ s: String) {
    print(s)
    fflush(stdout)
}

func probe(_ path: String) async {
    line("macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)")
    line("isAvailable: \(SpeechTranscriber.isAvailable)")
    // Both locale lists are async properties (isAvailable is not), so they are read into
    // locals rather than interpolated.
    let installed = await SpeechTranscriber.installedLocales
    let supported = await SpeechTranscriber.supportedLocales
    line("installedLocales: \(installed.map(\.identifier))")
    line("supportedLocales: \(supported.map(\.identifier))")

    // Not a failure — a finding, and the reason this exits 0. GitHub's macOS runners are
    // VMs and report isAvailable == false with both locale lists empty, so they cannot
    // answer the word-timing question no matter how the rest of this is written. Apple's
    // own guidance for this case is to disable the feature or use DictationTranscriber.
    // Anything past here would fail for an environmental reason and read as a code defect.
    guard SpeechTranscriber.isAvailable else {
        line("")
        line("VERDICT: this machine does not support SpeechTranscriber, so nothing below can")
        line("be measured here. Re-run on real Apple Silicon (not a VM) to get an answer.")
        exit(0)
    }

    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
        line("::error::no supported locale equivalent to en-US")
        exit(1)
    }
    line("using locale: \(locale.identifier)")

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)

    // Apple ships and manages these models, which is the main structural advantage over
    // whisper's Core ML encoder (a 155 MB download per model size that we would have to
    // deliver ourselves). Worth knowing what it costs on a cold machine.
    do {
        let started = Date()
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            line("assets: not installed, downloading ...")
            try await request.downloadAndInstall()
            line(String(format: "assets: installed in %.1fs", Date().timeIntervalSince(started)))
        } else {
            line("assets: already present on this machine")
        }
    } catch {
        line("::error::asset install failed: \(error)")
        exit(1)
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])

    let collector = Task {
        var count = 0
        do {
            for try await result in transcriber.results {
                count += 1
                let text = result.text
                line("--- result \(count) ---")
                line("plain : \(String(text.characters))")
                line("runs  : \(text.runs.count)   (1 run = phrase-level timing at best)")
                line("attributed: \(String(describing: text))")
            }
        } catch {
            line("results stream error: \(error)")
        }
        line("total results: \(count)")
    }

    do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let seconds = Double(file.length) / file.fileFormat.sampleRate
        line(String(format: "audio: %.2fs @ %.0f Hz", seconds, file.fileFormat.sampleRate))
        let started = Date()
        _ = try await analyzer.analyzeSequence(from: file)
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let wall = Date().timeIntervalSince(started)
        line(String(format: "analysis: %.2fs wall for %.2fs of audio (%.2fx realtime)", wall, seconds, seconds / wall))
    } catch {
        line("::error::analysis failed: \(error)")
        exit(1)
    }

    await collector.value
}

let args = CommandLine.arguments
guard args.count > 1 else {
    line("usage: speech-probe <audio-file>")
    exit(2)
}
// Top-level `await` is only available in main.swift; this keeps the probe buildable as a
// plain file with swiftc.
let done = DispatchSemaphore(value: 0)
Task {
    await probe(args[1])
    done.signal()
}
done.wait()
