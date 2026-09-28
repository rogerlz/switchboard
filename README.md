# Switchboard

A personal macOS app for meetings. It notices when a call starts and records it, transcribes the mic and system audio live (on-device models or your own streaming API key), and saves the transcript with speaker labels into local notes. A menu-bar calendar and an upcoming-meetings column keep the next call one click away.

Switchboard is a personal hard fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr), used under its MIT license (see [LICENSE](LICENSE); copyright remains with the OpenWhispr Team for their work). It keeps OpenWhispr's meeting, notes and calendar pieces, drops everything else (dictation, hotkeys, AI features, accounts, cloud sync, auto-update), and runs only on macOS. It is not affiliated with or supported by OpenWhispr.

## Features

- Meeting detection from mic activity, meeting apps (Zoom, Teams, Webex, FaceTime) and calendar reminders
- Mic + system-audio capture (macOS 14.2+ audio tap) with echo cancellation
- Local transcription with Whisper, Parakeet, Nemotron, Cohere or Orukeet, or streaming via OpenAI, Deepgram, AssemblyAI, Corti or Tinfoil with your own key
- Live and post-meeting speaker identification
- Local notes (SQLite), optional Markdown mirror, and Granola import
- Google, Microsoft and Apple calendars, plus a menu-bar calendar popover

## Run

Requires macOS, Node 24 and the Xcode command-line tools (for the Swift helpers).

```bash
npm install
# npm 12 skips install scripts by default; run the ones the app needs:
npm rebuild electron ffmpeg-static onnxruntime-node esbuild
npm run dev
```

`npm run dev` compiles the native helpers and downloads the transcription binaries on first run.

## Build

```bash
npm run build        # DMG + zip for the current arch
npm run pack         # unsigned .app in dist/
```

## Test

```bash
npm run typecheck
npm run lint
npm test
```
