# KLIPZ handoff (updated 2026-11-12, after release v0.1.1)

State of the work on branch `desktop-app` (PR #1 into `main`). Releases: `v0.1.0` (pre-release, slow first
build) and `v0.1.1` (current). Everything listed below is committed and in `v0.1.1`.

## Already shipped (committed + in release v0.1.0)

- Native Windows desktop shell (`apps/desktop`, .NET 10 WinForms + WebView2, no Electron), Inno Setup
  installer (`installer/klipz.iss`, `scripts/build-desktop.mjs`, `npm run desktop:installer`).
- Developer-app keys entered on the Accounts page (`apps/web/src/server/social/app-keys.ts`,
  `/api/platform-keys/[provider]`, `components/accounts/app-keys-form.tsx`).
- TikTok Desktop Login Kit PKCE (hex SHA-256 challenge, `pkceEncoding` on publishers).

## In v0.1.1 (all tests green)

Tests: `npx vitest run` = 482 passed. Worker: `KLIPZ_SLOW_TESTS=1 <venv python> -m pytest -q` in
`apps/worker` = 138 passed, 1 skipped (venv = `%USERPROFILE%\.klipz\venv`). `npm run typecheck` clean.

1. **Startup / size (measured)**
   - `apps/web/next.config.ts`: `output: "standalone"` + `outputFileTracingRoot` (also fixes Next picking
     `C:\Users\<user>\package-lock.json` as workspace root).
   - `scripts/build-desktop.mjs` stages the standalone server, a prebuilt Remotion bundle
     (`scripts/prebuild-remotion.mjs` -> `app/packages/video/prebuilt`) and only the dependency closure of
     `@remotion/renderer`. `packages/video/render.mjs` uses `prebuilt/` when present.
   - `apps/desktop/Backend.cs`: runs `node server.js` (PORT/HOSTNAME env) when `apps/web/server.js` exists,
     else `next start`.
   - Result: stage 803 MB -> 355 MB (5,125 files); server "Ready" 32 s (user's installed v0.1.0) -> ~0.8 s,
     first page ~2.3 s.
2. **YouTube import speed** (`apps/worker/klipz_worker/steps/youtube.py`, `requirements.txt`)
   - `concurrent_fragment_downloads: 8`, `http_chunk_size` 10 MiB, `noprogress`, Node as yt-dlp JS runtime
     (`js_runtimes`), `yt-dlp[default]` (brings yt-dlp-ejs). Measured on a fragmented stream: 4.0 -> 7.3 MB/s.
3. **Transcription crash fix** ("open() got an unexpected keyword argument 'metadata_errors'")
   - Cause: faster-whisper 1.2.1 decodes through PyAV; PyAV 19 removed that argument.
   - Fix: `ffmpeg.decode_mono_16k()` decodes with our ffmpeg; `FasterWhisperTranscriber` passes samples
     (`steps/transcribe.py`). Verified with the real tiny model on PyAV 19.
4. **AI tab** (`/ai`, sidebar entry "AI")
   - Web: `apps/web/src/server/ai-settings.ts` (store `<data dir>/ai-settings.json`, keys sealed with
     `secret.key`), routes `/api/ai-settings` (GET/PUT), `/api/ai-settings/test`,
     `/api/ai-settings/import-model` (GGUF -> `ollama create`), UI `components/ai/ai-view.tsx`.
     AI captions read the saved Anthropic key (`aiEnv()` in `social/captions.ts`).
   - Worker: `klipz_worker/ai_settings.py` (`effective(settings)`, applied per job in `runner.py`; needs
     `cryptography`, added to requirements), new `OpenAICompatScorer` + provider `openai` in `steps/score.py`,
     new Settings fields (`openai_*`, `smart_edit`) in `config.py`.
   - Env vars always win over the file. Provider values: auto | anthropic | openai | ollama | none.
5. **Smart Edit engine** (default, no AI needed): `klipz_worker/steps/smart_edit.py`
   - Jump cuts (silence > 0.45 s, isolated um/uh), alternating framing per cut, punch-in on
     keywords/numbers/shouted words, caption emphasis, hook card, progress bar. Returns an EditState with
     `"auto": true`.
   - `steps/analyze.py` stores it on new clips (when `settings.smart_edit`); clips whose edit is `auto` and
     `edit_version == 0` are replaceable on re-analysis. `steps/reframe.py::_refresh_smart_edit` rebuilds it
     after a trim; web `server/clips.ts` clears an untouched auto edit when the range changes.
   - Tests: `apps/worker/tests/test_smart_edit.py`, updated `tests/test_analyze.py`.

6. **Library page** (`/library`, sidebar "Library"): `apps/web/src/server/library.ts` keeps
   `<data dir>\Library\Raw videos\<title>.mp4` and `Library\Clips\<project>\<clip>.mp4` as hard links
   (manifest `.klipz-links.json`, only its own links are ever removed). Routes `/api/library` (GET) and
   `/api/library/action` (reveal | open | copy, targets are ids, never paths). UI
   `components/library/library-view.tsx`. Native Windows share sheet: `apps/desktop/ShareSheet.cs`, called
   from the page via `window.chrome.webview.postMessage({type:"share", path, title})`; the shell accepts it
   only from localhost pages and only for files under `<data dir>\Library` or `\storage`.
   The desktop project now targets `net10.0-windows10.0.19041.0` (WinRT share APIs).
7. Web tests: `server/library.test.ts`, `server/ai-settings.test.ts`, trim rule in `server/server.test.ts`.
8. Docs: README sections "AI tab and Smart Edit" and "Library", new env vars in `.env.example`.
9. Version 0.1.1 (root `package.json`, `apps/desktop/KlipzDesktop.csproj`).

Verified on the staged build (`dist/desktop/stage`): server start ~0.8 s, `/library` and `/ai` pages,
AI settings save/test (key never in file or response), library copy/reveal, cross-site requests blocked,
and a real render through `packages/video/prebuilt` (1080x1920 H.264/AAC, captions + hook card drawn).

10. Desktop shell: one instance per data folder (`Program.cs`: default folder keeps the legacy mutex name,
    a custom `KLIPZ_DATA_DIR` gets its own), WebView2 starts while the server boots (`MainForm.cs`).
11. `output: "standalone"` only when `KLIPZ_STANDALONE=1` (set by `scripts/build-desktop.mjs`), so
    `npm run build` / `npm start` (`next start`) behave as before.

### How v0.1.1 was verified

- `npx vitest run`: 482 passed. Worker `pytest` with `KLIPZ_SLOW_TESTS=1`: 138 passed (real Whisper tiny).
- `node scripts/e2e.mjs`: 19/19 steps (upload, ingest, transcription, AutoClip + Smart Edit, reframe,
  three renders, edit + re-export, sandbox posting to six platforms, scheduling, analytics).
- First run of the staged `KLIPZ.exe` (the folder the installer packages) on an empty data folder, own
  ports: found Python 3.12, created the venv, installed the new requirements, both services up (260 s,
  web "Ready in 328 ms"). Then through its HTTP API: upload -> AutoClip -> Smart Edit (8 pieces, 28.1 s
  -> 21.1 s, 14 zoom keys) -> 1080x1920 render -> Library files on disk. The owner also ran a real
  YouTube import + AutoClip (Italian video, 4 clips) in that instance: import 36 s, analysis 27 s.
- Closing the window stopped both services (ports closed).
- NOT done: running `KLIPZ-Setup-0.1.1.exe` itself. It shares its AppId with the owner's installed 0.1.0,
  so a test install would have repointed their Start-menu shortcut / uninstall entry. The 0.1.0 installer
  (same script) was install/launch/uninstall tested earlier.

## Next: fast renderer (FFmpeg, no Chrome)

Rendering is now the slow part: 71-117 s per ~20 s clip on the owner's laptop (i7-1255U, Intel UHD).
Measured on the same Smart-Edited clip (21.1 s, 8 pieces, 14 zoom keys):

| Renderer | Time |
|---|---|
| Remotion/Chrome, PNG frames (current) | 100 s |
| Remotion/Chrome, JPEG frames | 86 s |
| Remotion/Chrome, PNG + `gl: angle` | 99 s |
| Remotion/Chrome, JPEG + `gl: angle` | 79 s |
| FFmpeg only, libx264 medium crf 18 | 11.2 s |
| FFmpeg only, libx264 veryfast crf 18 | 5.3 s |
| FFmpeg only, h264_qsv | 6.8 s |

Tuning Chrome is not worth it (max 21 %, and JPEG frames come out full-range, which is why PNG was chosen).
The FFmpeg timing came from a throwaway script (trim+concat of the pieces, static 9:16 crop, word captions
burned in with libass, progress bar via `overlay` with a time expression); it is not in the repo.

Plan for a real "Fast render" engine in the worker (`steps/render_ffmpeg.py`), chosen per render:

- Input is the same props as `build_props()` (EditState + crop track). Output must pass the same checks as
  the Remotion path (1080x1920, yuv420p limited range, 30 fps, faststart, loudness pass unchanged).
- Pieces: `trim`/`atrim` + `concat`. Crop track: per-segment crop or letterbox with blurred background
  (`split`, `boxblur`, `overlay`), keyframes as piecewise-linear `x`/`y` expressions (or `sendcmd`).
- Zoom keys: `scale` with `eval=frame` + centred `crop`, honouring `snap` / `ease` like `zoomAt()`.
- Captions: generate ASS from `captionWordsOnTimeline()` semantics and the caption style (font, size,
  colours, outline/box, highlight colour, words per page, position; pop-in via `	` scale). Fonts are in
  `apps/web/public/fonts` (woff2: ship TTF copies or use `fontsdir` with converted files).
- Hook card: ASS drawing (`\p1`) rounded box + text. Progress bar: `color` source + `overlay` x expression.
- Fall back to the Remotion renderer whenever the edit uses something the fast engine does not do yet:
  b-roll, audio items, text overlays, piece transitions, looks, emoji captions, gradient/glow presets.
- UI: Export panel choice "Fast" (default when supported) / "Studio (Chrome)"; show which engine rendered.
- Tests: golden-frame comparisons against the Remotion output at a few timestamps (SSIM threshold), plus
  the existing e2e with the fast engine.

## Small follow-ups

- `apps/desktop/PythonEnv.cs` says "~2 GB download"; measured: about 440 MB of wheels, 885 MB installed.
  Change the text on the next shell build (README already says about 1 GB).
- First use still downloads silently inside jobs: ffmpeg binaries (static-ffmpeg, first job), the Whisper
  model (first transcription, ~460 MB for `small`), Chrome Headless Shell (first render). Prefetching them
  in the first-run screen with visible progress would remove those stalls.
- With a custom `KLIPZ_DATA_DIR` the web status looks for ffmpeg in `~/.klipz/venv`
  (`server/data-admin.ts::findStaticFfmpeg`) while the shell puts the venv in `<data dir>env`; pass
  `KLIPZ_VENV` from `Backend.cs`.
- The owner's test session (Italian video, 4 clips) is in `%TEMP%\klipz-firstrun` (data folder of the
  first-run test). It was left in place on purpose.

## Not verified / known gaps

- Real sign-in and posting with TikTok / Instagram / X accounts (needs the owner's developer apps).
- First-run Python setup on a PC with no Python at all (the winget install path). With Python 3.12
  present it is verified (see "How v0.1.1 was verified").
- The upgrade install of `KLIPZ-Setup-0.1.1.exe` over an installed 0.1.0 (the owner does this). On the
  first start after upgrading, the app re-runs pip because the requirements changed.
- The Windows share sheet (`ShareSheet.cs`) compiles but has not been clicked through in the running
  desktop window (no way to drive the native window from the build session).
- GGUF import was not run against a real Ollama install (Ollama is not installed on this PC).
- OpenAI-compatible scorer tested only against a fake client.

## Gotchas

- Never kill node processes by name/command match; stop test servers by port
  (`netstat -ano | grep <port>` -> `taskkill /PID`).
- Do not delete `dist/desktop/stage` while a shell's working directory is inside it (EPERM).
- `installer/klipz.iss` is the installer recipe: opening it in Inno Setup recompiles and overwrites
  `dist/desktop/KLIPZ-Setup-<ver>.exe`.
- Standalone build: `next.config.ts` is not evaluated at runtime, so the root `.env.local` loader does not
  run in the installed app (keys come from the Accounts / AI pages).
