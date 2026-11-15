# Notice: the test data in this folder

These seven files feed the first-word tests (`speechWordTimes.ts`, `transcribe.ts`). They hold speech-engine output (text and times) for short read-aloud sentences. They hold no audio.

## Where the six fixtures come from

- **Audio that was transcribed:** clips of the FLEURS test set (Google, licence CC BY 4.0). No FLEURS audio is stored here.
- **Sentence text:** FLEURS reads sentences taken from FLoRes-101. That text may be under CC BY-SA 4.0 (the FLoRes-101 licence), so treat it as applying to the sentences kept in these files.
- **Output:** whisper small (`ggml-small`) output, run with `-dtw small -nfa`, cut to its first N segments, tokens as whisper wrote them (`t_dtw` included). Only `params.model` was changed, to `models/ggml-small.bin`. The files were re-saved with tab indents, so number formatting may differ from whisper's own bytes.

| fixture                             | language (FLEURS set) | FLEURS clip id       | segments kept |
| ----------------------------------- | --------------------- | -------------------- | ------------- |
| `en-leading-silence.json`           | English (en_us)       | 10335587906469246566 | 1 of 1        |
| `ar-leading-silence.json`           | Arabic (ar_eg)        | 10219273669592698682 | 1 of 1        |
| `de-long-first-segment.json`        | German (de_de)        | 10171859810965764480 | first 4 of 6  |
| `ja-unspaced.json`                  | Japanese (ja_jp)      | 10281646305484957883 | 1 of 1        |
| `zh-unspaced.json`                  | Chinese (cmn_hans_cn) | 10104380129516909856 | 3 of 3        |
| `en-first-segment-starts-late.json` | English (en_us)       | 1003119935936341070  | 1 of 1        |

`frozen-0.27.0.json` is what the 0.27.0 parser made of these six files and of six made-up inputs (for example "Hello world"). It is our own output, not recorded speech, and must never be regenerated to make a test pass.

## No personal data

Every JSON file in this folder was searched for drive letters and paths (`C:\`, `\Users\`, `/Users/`), for the name of the person and of the PC that made the files, for e-mail addresses (`@`), web addresses and audio file names. Nothing was found. The only path-like text is `models/ggml-small.bin`. Each fixture's `systeminfo` line lists the CPU features of the study PC (SSE3, AVX2, AVX512 and so on) and nothing that names a person or a machine.
