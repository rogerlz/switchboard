# Switchboard — Technical Reference

Switchboard is a personal, macOS-only Electron app, hard-forked from OpenWhispr (MIT). It does four things:

1. **Meeting detection**: notices a call starting (mic activity, meeting apps, calendar reminders) and prompts to record.
2. **Meeting recording and transcription**: captures mic + system audio, transcribes live with local models or a BYOK streaming provider, and writes the transcript into a note with speaker labels.
3. **Local notes**: SQLite-backed notes, folders and spaces, optionally mirrored to Markdown files.
4. **Calendar**: Google/Microsoft (OAuth) and Apple (EventKit) calendars, an upcoming-meetings column in Notes, and a menu-bar calendar popover.

There is no account, cloud sync, dictation, hotkey, paste, LLM or update mechanism. Do not reintroduce them.

## Response style

Keep responses focused and brief. Summarize at a high level unless asked for depth.

## Stack

- Electron 41 (context isolation, preload bridge), React 19, TypeScript, Tailwind CSS v4, Vite
- better-sqlite3 for notes and calendar data; zustand stores in the renderer
- whisper.cpp (`whisper-server`) and sherpa-onnx (Parakeet, Nemotron, Cohere, Orukeet) for local transcription
- `onnxruntime-node` for speaker embeddings, in a utility process
- Node 24 (`.nvmrc`)

## Process model

- **Main process**: `main.js` creates the managers, then `IPCHandlers` (`src/helpers/ipcHandlers.js`) registers every IPC channel. `preload.js` exposes `window.electronAPI`; `src/types/electron.ts` types it.
- **Windows**, all rendered from one React bundle and routed in `src/AppRouter.jsx` by query string:
  - control panel (notes, integrations, settings). It stays hidden until the renderer calls `controlPanelReady()`, which also releases the meeting-prompt gate (`WindowManager.setControlPanelReady`).
  - `?meeting-notification=true`: the always-on-top meeting prompt card (content-protected).
  - `?tray-calendar=true`: the menu-bar calendar popover.
- **ONNX utility process**: `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js` runs speaker-embedding inference. It is lazy-spawned and respawned with backoff; a native crash stays in the worker.
- **Sidecars** (whisper-server, sherpa servers, diarization, ONNX worker) are registered in `sidecarRegistry` and stopped on quit. `sidecarPidFile` + `sidecarReaper` kill orphans left by a crash.

## Meeting pipeline

Detection:

- `meetingDetectionEngine.js` merges three sources into one prompt, suppresses prompts while recording, and coalesces signals. It drives the auto-end controller.
- `audioActivityDetector.js` listens to `macos-mic-listener` (CoreAudio process objects). Aggregate-device activity only prompts while a known meeting app runs. A crashed listener is respawned with backoff, and audio prompts pause meanwhile.
- `meetingProcessDetector.js` watches NSWorkspace notifications for Zoom/Teams/Webex/FaceTime. This is context only; it never prompts by itself.
- `calendarReminderScheduler.js` fires one minute before a calendar event.
- `meetingDetectionPreferencePolicy.js` maps the renderer's notification prefs to which detectors run. Nothing runs until the renderer syncs them.
- `meetingAutoEndController.js` / `meetingAudioActivityMonitor.js` end a recording when the call is over.

Capture and transcription:

- The renderer (`src/stores/meetingRecordingStore.ts`) captures the mic via an AudioWorklet at 24 kHz and streams chunks over `meeting-transcription-send`.
- The main process captures system audio with `macos-audio-tap` (`audioTapManager.js`, macOS 14.2+), timestamped by `meetingAudioTimeline.js` and watched by `meetingSystemAudioWatchdog.js`.
- Echo handling:
  - `meetingAecManager.js` runs the `meeting-aec-helper` (WebRTC AEC).
  - `meetingEchoLeakDetector.js` correlates the mic against system audio.
  - `meetingMicGate.js` decides send, zero or skip per chunk.
  - `meetingMicHoldback.js` holds back or retracts mic finals that duplicate the remote side.
- Routing: `meetingTranscriptionRouting.js` (renderer) turns settings into options. `meetingStreamingProviders.js` maps providers to clients:
  - `openaiRealtimeStreaming`, `assemblyAiStreaming`, `deepgramStreaming`, `cortiStreaming`, `tinfoilRealtimeStreaming`
  - `realtimeTokenProviders.js` mints tokens for them
  - `local`, which chunks audio to whisper-server or the sherpa-onnx websocket servers (`whisper.js`/`whisperServer.js`, `parakeet.js`/`parakeetServer.js`/`parakeetWsServer.js`)
- Speakers:
  - `liveSpeakerIdentifier.js` labels speakers live from system audio.
  - `diarization.js` runs sherpa-onnx diarization after stop.
  - `speakerAssignmentPolicy.js`, `speakerEmbeddings.js` and the DB speaker profiles map voices to people.
- The renderer applies segment events through `meetingSegmentReducer.ts` and saves the transcript into the note (`meetingTranscriptPersistence.ts`).

## Calendar

- `googleCalendarManager.js` / `microsoftCalendarManager.js` use REST with incremental sync tokens. Their OAuth goes through `oauthLoopbackFlow.js` (PKCE on 127.0.0.1), and retries back off via `calendarSyncInterval.js`.
- `appleCalendarManager.js` runs the `macos-calendar-listener` Swift helper (EventKit snapshots on stdout), launched through `macos-disclaim-exec` so the permission prompt is attributed to the app.
- All providers write to the shared `calendar_events` table.
- Menu bar: `tray.js` owns the tray icon and context menu (right click); `trayCalendar.js` owns the popover window (left click), the next-meeting tray title and its own IPC (`tray-calendar-get-events`, `-refresh`, `-open-app`). `src/components/TrayCalendar.tsx` renders world clocks (setting `worldClocks`, max 4), a month grid, the per-day meeting list with Join, and refresh/open buttons. Pure logic (grid, grouping, tray title, world clocks, `needsRsvp`) lives in `trayCalendarModel.js` with tests.
- RSVP: pending Google invites show Accept/Maybe/Decline (`RsvpButtons.tsx`) in the popover and the Notes column. `googleCalendarManager.respondToEvent` rewrites the attendee list with only our status changed and `sendUpdates=all`; it needs the `calendar.events` scope (Google OAuth asks for it).
- Credentials: `GOOGLE_CALENDAR_CLIENT_ID/SECRET` and `MICROSOFT_CALENDAR_CLIENT_ID` come from `.env` (see `.env.example`). The OAuth loopback ends on a local "connected" page; nothing goes to OpenWhispr.
- Notes shows upcoming meetings in `src/components/UpcomingMeetings.tsx` (`useUpcomingEvents`). `meetingJoinUrl.js` extracts join links.

## Notes

- `database.js` holds SQLite at `userData/transcriptions.db` (`transcriptions-dev.db` in development) with notes, folders, spaces, calendar and speaker tables. Keep the schema and migrations intact; they carry upstream history.
- Only local, private-space data is visible. Leftover signed-in rows are ignored.
- `markdownMirror.js` optionally mirrors notes to `.md` files. `granolaImport.js` imports a Granola CSV export. `noteSearch.js` does FTS5 search.
- Renderer: `noteStore.ts`, `src/components/notes/*`. The Tiptap editor lives in `src/components/ui/RichTextEditor*.{ts,tsx}` and stores bodies as Markdown.

## Settings storage

- Renderer preferences live in localStorage via `src/stores/settingsStore.ts`, with `useSettings()` as the React context. The transcription settings are the `meeting*` keys.
- Secrets (BYOK keys for OpenAI, Tinfoil, Deepgram, AssemblyAI and the Corti client id/secret) are encrypted with `safeStorage` into `userData/secure-keys/` by `environment.js`. The key list is in `src/config/secretKeys.js`; `preload.js` mirrors it.
- Non-secret env values (`START_MINIMIZED`, `WHISPER_THREADS`) persist to `userData/.env`.
- Models are cached under `~/.cache/openwhispr/` (whisper-models, parakeet-models, diarization-models); `OPENWHISPR_CACHE_ROOT` overrides the location.

## Native binaries

All binaries land in `resources/bin/`, which is gitignored and packaged via `electron-builder.json`:

| Binary                                                    | Source                                                                                                | Built/fetched by                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `macos-mic-listener`                                      | `resources/macos-mic-listener.swift`                                                                  | `npm run compile:mic-listener`                              |
| `macos-calendar-listener`, `macos-disclaim-exec`          | `resources/macos-calendar-listener.swift`, `macos-disclaim-exec.c`                                    | `npm run compile:calendar-listener`                         |
| `macos-audio-tap`                                         | `resources/macos-audio-tap.swift`                                                                     | `npm run compile:audio-tap`                                 |
| `meeting-aec-helper-darwin-*`                             | `native/meeting-aec-helper` (prebuilt download; `scripts/build-meeting-aec-helper.js` builds locally) | `npm run download:meeting-aec-helper`                       |
| `whisper-server-darwin-*`                                 | OpenWhispr/whisper.cpp release                                                                        | `npm run download:whisper-cpp`                              |
| `sherpa-onnx-{ws,online-ws,diarize}-darwin-*` + `*.dylib` | k2-fsa/sherpa-onnx release                                                                            | `npm run download:sherpa-onnx`                              |
| `whisper-vad/`, `diarization-models/`                     | model downloads                                                                                       | `download:whisper-vad-model`, `download:diarization-models` |

`npm run compile:native` builds the three Swift/C helpers. `scripts/afterPack.js` strips non-target onnxruntime binaries, verifies unpacked files, and registers Mach-O resources for signing.

## Development

- **Install**: `npm install` on Node 24. npm 12 only runs install scripts listed under `allowScripts` in `package.json` (electron, esbuild, ffmpeg-static, onnxruntime-node, better-sqlite3; electron-winstaller is denied). Entries are pinned to versions, so after a dependency bump run `npm install-scripts ls` and re-approve with `npm install-scripts approve <pkg>`. Never regenerate `package-lock.json` with another Node major; to update the lockfile only, use `npm install --package-lock-only --ignore-scripts`.
- **Dev**: `npm run dev` runs Vite plus Electron. `predev:main` compiles the native helpers and downloads the runtime binaries.
- **Build**: `npm run build` (alias of `build:mac`; its `prebuild:mac` compiles the helpers, compiles the icon and downloads every binary). `build:mac:arm64`/`build:mac:x64` skip that hook, so run `npm run prebuild:mac` first on a clean checkout. `npm run pack` makes an unsigned `--dir` build.
- **Signing**: no identity is committed. Pass it per build, e.g. `CSC_NAME="Apple Development: <name> (<team>)" npm run build`. A stable identity keeps macOS privacy grants (mic, system audio, calendars) across rebuilds; ad hoc signing re-prompts after every build. Builds are not notarized, which is fine for locally built apps. To update an installed copy, replace `/Applications/Switchboard.app` with `dist/mac-arm64/Switchboard.app` (`ditto`).
- **Checks**:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`, which is `node --import tsx --test --test-timeout=60000 "test/**/*.test.js"`. Always keep `--test-timeout`. DB-backed tests skip locally because better-sqlite3 is built for Electron's ABI. CI rebuilds it for Node and sets `REQUIRE_DB_TESTS=1`.
- **CI**: `.github/workflows/ci.yml` runs `npm ci --ignore-scripts`, typecheck, lint and tests on macOS.
- **Debug logging**: `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug`. Logs go to the app's userData `logs/` folder.

## Conventions

- **i18n (required)**: every user-facing string goes through react-i18next (`useTranslation()` / `t("area.key")`; `i18nMain.t()` in the main process). There is a single locale, `src/locales/en/translation.json`. Add every new key there, group keys by feature area, and remove keys you stop using.
- **IPC**: a new channel needs a handler in `ipcHandlers.js`, a bridge in `preload.js`, and a type in `src/types/electron.ts`.
- **New sidecar**:
  - Spawn it with `detached: true`.
  - Call `sidecarPidFile.write/clear`.
  - Add its binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`.
  - Register a stop function in `registerSidecars()` in `main.js`.
- **Assets**: import images; never use literal paths (the packaged renderer loads from `file://`). The app icon's source is `src/assets/switchboard-art.svg`; `src/assets/switchboard.icon` (Icon Composer) compiles to `Assets.car` via `npm run compile:mac-icon`, and `icon.icns`/`iconTemplate@3x.png` are rendered from the same art. UI icons come from `src/components/icons/` (generated from `nucleo-map.json` by `scripts/sync-nucleo-icons.js`).
- Keep policy in small pure modules with unit tests, and keep `ipcHandlers.js` as thin adapters.
