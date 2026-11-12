# KLIPZ handoff: work in progress (updated 2026-11-12)

State of the work on branch `desktop-app` (PR #1 into `main`, release `v0.1.0` pre-release).
Everything under "Done, NOT yet committed" is in the working tree only.

## Already shipped (committed + in release v0.1.0)

- Native Windows desktop shell (`apps/desktop`, .NET 10 WinForms + WebView2, no Electron), Inno Setup
  installer (`installer/klipz.iss`, `scripts/build-desktop.mjs`, `npm run desktop:installer`).
- Developer-app keys entered on the Accounts page (`apps/web/src/server/social/app-keys.ts`,
  `/api/platform-keys/[provider]`, `components/accounts/app-keys-form.tsx`).
- TikTok Desktop Login Kit PKCE (hex SHA-256 challenge, `pkceEncoding` on publishers).

## Done, NOT yet committed (all tests green at time of writing)

Tests: `npx vitest run` = 473 passed. Worker: `KLIPZ_SLOW_TESTS=1 <venv python> -m pytest -q` in
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

## Still to do (in this order)

1. **Library / folders page** (requested, not started): a page that shows where raw (imported/downloaded)
   videos and rendered (edited) clips are stored, lists them, and for each file/folder offers
   "Show in Explorer", "Open", "Copy file" and "Share" (Windows share sheet / other apps).
   - Storage: `<data dir>\storage\` (`sources/<id>/source.*` raw, renders under `renders/`; check
     `apps/web/src/server/paths.ts` and the `renders` / `source_videos` tables for keys).
   - Plan: server routes that only accept storage keys (resolve with `storagePath()`, never raw paths) and
     run `explorer.exe /select,<path>`; share through the desktop shell (WebView2
     `window.chrome.webview.postMessage` -> C# share UI / "Open with"), with copy-to-clipboard as fallback
     when running in a plain browser.
2. **Web tests** for `ai-settings.ts` (store round trip, view never contains keys, `activeEngine`) and the
   new `planClipPatch` rule (auto edit cleared on range change only at version 0).
3. **Look at the AI tab in the real UI** (browser pane) and fix layout issues.
4. **Desktop shell**: start WebView2 initialisation in parallel with the backend (small win).
5. **Docs**: README (AI tab, Smart Edit, standalone build, new env vars `OPENAI_*`, `KLIPZ_SMART_EDIT`),
   `.env.example`, `docs/platform-setup.md` unchanged.
6. **Rebuild + verify**: `node scripts/build-desktop.mjs` (stage + installer), silent install to a temp dir,
   launch, check `/ai`, `/accounts`, a render with the prebuilt bundle (NOT yet verified end to end: the
   prebuilt Remotion bundle and the renderer-only `node_modules` have only been built, not rendered with).
7. **Commit + push** to `desktop-app` (commit trailer: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`),
   then replace the release asset: `gh release upload v0.1.0 dist/desktop/KLIPZ-Setup-0.1.0.exe --clobber`
   (or cut `v0.1.1`: bump `version` in root `package.json` and `apps/desktop/KlipzDesktop.csproj`).

## Not verified / known gaps

- Real sign-in and posting with TikTok / Instagram / X accounts (needs the owner's developer apps).
- First-run Python setup on a clean PC. The user's PC has Python 3.12 venv at `%USERPROFILE%\.klipz\venv`;
  requirements changed (yt-dlp[default], cryptography), so the app re-runs pip on next start.
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
