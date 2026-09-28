# Switchboard

A personal macOS app for meetings. It notices when a call starts, records the mic and system audio, transcribes them live (on-device models or your own streaming API key), and saves the transcript with speaker labels into local notes. A menu-bar calendar keeps the next call, and its Join button, one click away.

Switchboard is a personal hard fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr), used under its MIT license (see [LICENSE](LICENSE); copyright for their work remains with the OpenWhispr Team). It keeps OpenWhispr's meeting, notes and calendar pieces, drops everything else (dictation, hotkeys, AI features, accounts, cloud sync, auto-update) and runs only on macOS. It is not affiliated with or supported by OpenWhispr.

## Features

- Meeting detection from mic activity, meeting apps (Zoom, Teams, Webex, FaceTime) and calendar reminders
- Mic + system-audio capture (macOS 14.2+ audio tap) with echo cancellation
- Local transcription with Whisper, Parakeet, Nemotron, Cohere or Orukeet, or streaming via OpenAI, Deepgram, AssemblyAI, Corti or Tinfoil with your own key
- Live and post-meeting speaker identification
- Local notes (SQLite), an optional Markdown mirror of notes and transcripts, and Granola import
- Google, Microsoft and Apple calendars
- Menu-bar calendar: next meeting in the menu bar, world clocks, month view, Join & transcribe, and Accept/Maybe/Decline for Google invites

## Run

Requires macOS 14.2+, Node 24 (`.nvmrc`) and Xcode (for the Swift helpers and the app icon).

```bash
npm install
npm run dev
```

`npm run dev` compiles the native helpers and downloads the transcription binaries on first run. Development data lives in `~/Library/Application Support/Switchboard-development`.

## Calendar setup

Apple Calendar needs no setup. Google and Microsoft need your own OAuth clients; put their IDs in a `.env` (see [`.env.example`](.env.example)). For Google: create a Google Cloud project, enable the Calendar API, add yourself as a test user, add the `calendar.events` and `calendar.calendarlist.readonly` scopes, and create a "Desktop app" OAuth client.

## Build

```bash
CSC_NAME="Apple Development: <name> (<team>)" npm run build
```

This produces a signed `.app`, DMG and zip in `dist/`. A stable signing identity keeps macOS microphone, system-audio and calendar permissions across rebuilds; without one the build is signed ad hoc and asks again each time. `npm run pack` makes a quick unsigned build.

## Test

```bash
npm run typecheck
npm run lint
npm test
```
