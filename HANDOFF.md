# KLIPZ handoff (updated 2026-11-14, version 0.2.0)

Branch `desktop-app` (PR #1 into `main`). Releases: `v0.1.0` (pre-release), `v0.1.1`, `v0.2.0` (this work).
The owner's installed copy was still 0.1.0 on 2026-11-14.

## What exists

### Desktop app (v0.1.0 / v0.1.1)
- `apps/desktop`: .NET 10 WinForms + WebView2 shell (no Electron). Runs the Next standalone server and the
  Python worker in a kill-on-close job object, first-run Python setup, one instance per data folder,
  Windows share sheet (`ShareSheet.cs`), in-window OAuth with a "Back to KLIPZ" bar.
- `installer/klipz.iss` + `scripts/build-desktop.mjs` (`npm run desktop:installer`): per-user Inno Setup
  installer with bundled `node.exe`, standalone web build (`KLIPZ_STANDALONE=1`), prebuilt Remotion bundle
  (`scripts/prebuild-remotion.mjs`), renderer-only `node_modules`.
- Accounts page: developer-app keys in the app (`server/social/app-keys.ts`). TikTok Desktop PKCE (hex).
- AI page (`/ai`, `server/ai-settings.ts`, worker `ai_settings.py`), Library page (`/library`,
  `server/library.ts`), Smart Edit (`steps/smart_edit.py`), transcription through our ffmpeg (PyAV-free).

### New in v0.2.0
1. **Fast renderer** (`apps/worker/klipz_worker/fastrender/`): one FFmpeg run instead of Chrome.
   - `model.py` ports the layout maths of `packages/shared` / `packages/video` (pieces, crop track, zoom,
     caption pagination, entrance curves). `ass.py` writes captions + hook card as absolutely positioned
     ASS events per frame-state. `graph.py` builds inputs + filter graph (spans, per-layout chains, moving
     crops and zoom via `sendcmd`, hook dim via `lutyuv`, progress bar via `overlay`). `engine.py` runs it.
   - `text.py` + `fonts.json` + `fonts/*.ttf`: caption fonts converted from the web's woff2 by
     `scripts/convert-fonts.py` (needs `fonttools brotli`; re-run when fonts change). `presets.json` is a
     generated copy of the TS presets; `packages/shared/src/worker-presets.test.ts` fails when it is stale
     (regenerate: `KLIPZ_WRITE_PRESETS=1 npx vitest run packages/shared`).
   - `steps/render.py::render_video`: fast when `fastrender.unsupported_reason(props)` is None, else
     Remotion; any fast failure falls back to Remotion. `renders.options.rendered_by` / `fast_skipped`
     record what happened. `options.engine = "studio"` (Export panel switch) or `KLIPZ_RENDER_ENGINE`.
   - Unsupported (falls back): b-roll, added audio / voiceover, text overlays, piece transitions, looks,
     emoji captions, non-plain colours, unbundled fonts or glyphs, HDR / BT.2020, clips without edit_state.
   - Measured on the owner's laptop (i7-1255U): 20 s clip, real footage, blurred letterbox: 15 s fast vs
     ~80-100 s Studio. e2e total 443 s -> 167 s.
   - Gotchas found: `drawbox` blends chroma 4x on yuv420p (hence `lutyuv` for the dim); a full-frame
     rectangle in libass costs ~20 ms per frame; cover image time must be < clip length.
2. **Clip finding** (`steps/segment.py`, `analyze.py`, `autoclip.py`, `select.py`):
   - Windows of 15 s to `max_len_for(duration)` = clamp(duration / 4, 20, 60). Padding counts against
     the limit so clips end on sentence boundaries. Pool `pool_size` = duration / 2 (60..600).
   - `auto_clip_count` = duration / 20 (10..50); second selection pass allows 34 % overlap.
     Simulated: 5 min -> 13 clips, 10 min -> 19, 30 min -> 50.
   - AutoClip renders the best `render_clips` (default 10, UI 3..50); others stay candidates with an
     Export button (`clip-card.tsx`). Smart Edit never cuts below 15 s (`fitted_ranges`).
3. **Scoring** (`steps/score.py`, `features.py`, `heuristics.py`, `ffmpeg.audio_energy` v2):
   - final = 0.6 * content (hook/context/emotion/payoff) + 0.3 * hype + 0.1 * cuts.
   - hype = 0.6 * audio (loudness vs the video's median, bursts, brightness, spectral flux, swing,
     opening, build) + 0.4 * text (pace vs the video's median, excitement markers, short sentences).
   - Lexicons / curiosity patterns for en, it, es, fr, de, pt. `H.hook_line()` / `H.punchy()` build the
     on-screen hook from the speaker's own words (<= 60 chars).
   - AI scorers rate at most `LLM_POOL` = 96 windows; the rest keep the heuristic rating.
   - Sources ingested before v2 get their `energy` recomputed on the next analysis.
4. **Framing**: migration `0002_framing.sql` (`source_videos.framing`: speaker | center | fit).
   `steps/reframe.py::static_track` for center / fit (no face detection). Web: `server/framing.ts`,
   `PATCH /api/sources/[id]`, checkbox on the project page.
5. **Manual crop** in the editor (`EditState.frame`, `crop.ts::manualCropTrack / effectiveCropTrack`,
   `ClipComposition.tsx`, `fastrender/model.py::effective_crop_track`, `video-panel.tsx` Framing section).
6. **Providers**: Gemini (OpenAI-compatible endpoint, `GEMINI_BASE_URL` in `score.py` and
   `DEFAULTS.geminiBaseUrl` in `ai-settings.ts`; model chosen from the live list, no default) and a
   Custom API slot. AI captions go through the active engine (`captions.ts::openAiCompatClient`).
7. **Transcription**: `whisper_threads()` (2/3 of logical CPUs, 4..8; measured 54 s -> 30 s for 93 s of
   speech), `merge_split_words()` joins "l'" + "occupazione" style pieces.

## How it was verified (v0.2.0)

- `npx vitest run`: 496 passed. Worker `KLIPZ_SLOW_TESTS=1 pytest`: 193 passed (real Whisper, real FFmpeg
  renders of crop / letterbox / split, worker render step, fallbacks).
- `node scripts/e2e.mjs`: 19/19 in 167 s (fast renderer used for all renders).
- On a copy of a real session (93 s Italian YouTube video): migration applied; Find clips with the
  `small` model (Italian detected, 5 clips, extractive hooks); framing checkbox -> center / fit tracks, no
  face detection; manual crop exported with both renderers and compared (same framing, timing, overlays;
  brightness 80.2 vs 78.2 during the hook); AI page live tests (fake Gemini key rejected, OpenRouter list).
- Fast vs Studio frame comparison on a Smart-Edited clip: SSIM 0.92-0.95 (test pattern), visually equal.

## Not verified / known gaps

- Real sign-in and posting with TikTok / Instagram / X accounts (needs the owner's developer apps).
- Gemini / OpenAI / custom scoring and captions with a real key (only fake clients and the model-list
  endpoints were exercised).
- The Share button and the GGUF import (compiled, not clicked through; Ollama is not installed here).
- The upgrade install over an existing version, and first run on a PC without Python.
- Fast renderer vs Studio for the `split` layout and for caption styles other than `bold-outline` was
  tested for "renders and is refused with a reason", not compared frame by frame.
- Hype scoring was checked on synthetic data and one short real video; no ground truth for "viral".

## Ideas not done

- Prefetch at first run with visible progress: static-ffmpeg binaries, the Whisper model, Chrome Headless
  Shell (they still download inside the first job that needs them).
- Fast renderer: remaining cost is the filter graph (scale / blur single-threaded) and the hook card's
  blurred shadow; `h264_qsv` was not faster than x264 veryfast here.
- A per-user default for the renderer and the framing in Settings (today: per export / per video + env).

## Gotchas

- Never kill node processes by name; stop test servers by port (`netstat -ano` -> launcher parent ->
  `taskkill /PID <launcher> /T`).
- Do not delete `dist/desktop/stage` while a shell's working directory is inside it (EPERM).
- `installer/klipz.iss` is the installer recipe: opening it in Inno Setup recompiles the installer.
- The installer shares its AppId with an installed copy: never test-install it on a PC that has KLIPZ
  installed; run `dist/desktop/stage/KLIPZ.exe` with its own `KLIPZ_DATA_DIR` / `KLIPZ_PORT` instead.
- Shell commands passed through the agent's bash lose backslashes inside heredocs: write patch scripts
  with the file tool.
- The owner's earlier test session (Italian video) is in `%TEMP%\klipz-firstrun`; left in place on purpose.
