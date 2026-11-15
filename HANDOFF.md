# KLIPZ handoff (updated 2026-11-15, version 0.2.1)

Branch `desktop-app` (PR #1 into `main`). Releases: `v0.1.0` (pre-release), `v0.1.1`, `v0.2.0`. `v0.2.1` is built (see below), not published yet.
The owner runs the app from `dist\desktop\stage\KLIPZ.exe` (0.2.0, default data folder `%USERPROFILE%\.klipz`):
never delete or rebuild that folder while it runs. Build with `KLIPZ_STAGE_DIR=dist/desktop/stage-next`.

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
     emoji captions, non-plain colours, unbundled fonts or glyphs (Arabic script is bundled since the
     right-to-left work below), HDR / BT.2020, clips without edit_state.
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

### New in v0.2.1
1. **Speech model folder** (`whisper_model.py`, `steps/transcribe.py`): the model lives in
   `<data dir>/models/whisper-<name>/` as real files (adopted from the Hugging Face cache by hard link,
   else downloaded as plain files, rebuilt when incomplete). Fixes "Unable to open file 'model.bin'" in
   the running app (the cache's symlink chain was unreadable for that process; cause never found).
2. **Import speed and honesty**:
   - The "upload timeout" for videos over ~3 minutes was not the upload (1.5 GB goes through in 8 s in
     the packaged app's WebView2): the video then sat on "Queued" while shot detection decoded every
     frame without progress (143 s for 5 min of 4K 60 fps HEVC; 26 s for a 2.7 min AV1 download).
   - `ffmpeg.quick_scene_cuts`: keyframes only (`-discard nokey` + `scdet`), 1-3 s for those files; full
     scan (now with live progress) only when keyframes are rarer than one per 8 s. The cuts are coarse
     (pacing score). Exact cuts are found per clip in `steps/ingest.py::clip_cuts` (used by reframe) and
     cached in `sources/<id>/cuts.json` (`mode: coarse|full`, `windows`). No file = pre-0.2.1 exact cuts.
   - `steps/youtube.py::DownloadProgress`: one fraction across picture + sound files, text with MB,
     speed and time left, then "Joining picture and sound". Download speed itself was already the
     line's limit (31 MB/s on one connection, 38 with 8 parallel ranges: not worth parallelising).
   - Quality choice on the import form (`quality` in `POST /api/projects` -> job payload):
     auto (1080p, 720p over an hour) / 1080 / 720 / 480.
   - `source-card.tsx`: "Importing" + stage + progress bar instead of "Queued" while the job runs.
   - Project delete: files removed in the background with retries (`api/projects/[id]/route.ts`);
     `steps/cleanup.py` sweeps `storage/sources|clips/<id>` folders whose row is gone (older than 1 h).
3. **Per-piece edits** (`VideoPiece.frame / look / volume`): `crop.ts::pieceCropTrack`,
   `timeline.ts::pieceLook / pieceVolume`, `splitAt` and `rippleDeleteRange` keep them, ops
   `setPieceFrame / patchPieceFrame / setPieceLook / setPieceVolume`, `video-panel.tsx` Selected piece,
   badge in `tracks.tsx`. `MainTrack.tsx` resolves them per piece; `fastrender/graph.py` starts a new
   chain when the crop window size changes and applies the level per piece (`model.py::piece_*`); a
   piece with its own look is rendered by Studio.

### After v0.2.1 (not released): right-to-left captions
Persian / Arabic / Urdu / Kurdish clips are now drawn by the fast renderer, and the Studio renderer orders
their words correctly (it used to lay Persian words out left to right, in a system font).
- **Font**: `FALLBACK_FONT` in `packages/shared/src/presets.ts` = Vazirmatn 900 (OFL, `@fontsource/vazirmatn`
  arabic subset; `scripts/copy-fonts.mjs` -> `apps/web/public/fonts/vazirmatn-900.woff2`,
  `scripts/convert-fonts.py` -> `fastrender/fonts/vazirmatn-900.ttf` + `"fallback": true` in `fonts.json`).
  Used per character for what the caption font lacks, like a browser does: `fontStack()` in the Studio
  components, `text.split_runs()` in the worker. `fonts.ts` loads it for every weight.
- **Word order**: `packages/shared/src/bidi.ts` and its port `fastrender/bidi.py` (same test cases on both
  sides). One reading direction per clip (majority of the caption letters; the hook card decides for
  itself), words placed right to left, a run of Latin words / their numbers keeps its own order.
  `Captions.tsx` renders the flex children in that order with `direction: rtl` per word; `ass.py` puts
  the words at the same places. Joined scripts get no letter-spacing in either renderer.
- **Shaping**: text that needs the fallback font makes the whole ASS script "shaped" (`Script.shaped`):
  widths come from HarfBuzz (`text.shaped_width`, Python package `uharfbuzz`, new in `requirements.txt`),
  the header gets `Kerning: yes`, right-to-left events carry `\fe-1` + a leading RLM, and
  `graph.build_plan(shaping=True)` draws the script with `ass=...:shaping=complex` instead of `subtitles=`.
  Scripts without such text are byte-identical to 0.2.1 (same filter, same header, same numbers).
- Refused as before (Studio renders them): characters in neither font (CJK, Hebrew ...), reason
  "characters not in the caption font X or its fallback Vazirmatn"; and Arabic script when `uharfbuzz`
  cannot be imported (reason names the package).
- Findings worth keeping: ffmpeg's `subtitles` filter always uses libass's simple (FriBidi) shaper: it
  leaves a blank the width of `.notdef` after every lam-alef and has no contextual forms; only the `ass`
  filter takes `shaping=complex`. libass ignores RLE / RLI / RLM for the base direction unless `\fe-1` is
  set, and kerning is off unless the header says `Kerning: yes`. Pillow in the venv has no raqm.
- **The venv needs `uharfbuzz`**: the packaged app re-runs pip when `requirements.txt` changes; for
  `npm start` / tests run `%USERPROFILE%\.klipz\venv\Scripts\python -m pip install -r apps\worker\requirements.txt`
  once (not done here: that venv belongs to the running app). Without it the new shaping tests skip and
  Persian clips keep going to Studio.
- Verified: the owner's link `https://youtu.be/d7NED6aq7aQ` in an isolated data folder (ports 3210 / 8911,
  `uharfbuzz` on `PYTHONPATH`): 5 clips, all `rendered_by: fast` (~27 s each). One of them was also exported
  with Studio (85 s): same lines, order, highlight and hook card; SSIM 0.96 over the clip (the video encode).
  Synthetic Persian clips in 4 caption styles: text edges within 1-2 px of Studio on steady frames (up to 7 px
  for a frame or two at page changes and entrance animations). Latin edits: ASS script + filter graph
  byte-identical to 0.2.1 for every preset x safe zone x hook (48 edits). `npx vitest run` 506 passed;
  worker `pytest` 226 passed with `uharfbuzz`, 223 passed + 3 skipped without.
- `convert-fonts.py` now writes the same bytes on every run; its first re-run rewrites the seven Latin TTFs
  once (timestamp only), which is why they were left untouched in this change.

## How it was verified (v0.2.1)

- `npx vitest run`: 501 passed. Worker `pytest`: 218 passed, 2 skipped (the slow real-Whisper tests were not run this time).
- Owner's link `https://youtu.be/d7NED6aq7aQ` (2.7 min, Persian): import 11 s (lookup 7 s, download 1 s,
  ingest 2 s), transcription works from the adopted model folder, AutoClip 4 clips, 3 rendered.
- Packaged 0.2.0 app driven over the WebView2 debug port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=9333`, CDP `DOM.setFileInputFiles`): 404 MB / 7 min and 1.4 GB / 5 min 4K60
  uploads work; the second showed the 143 s "Queued" stall that 0.2.1 removes.
- Per-piece crop set in the editor (browser), saved, exported with Studio: piece 1 automatic framing,
  piece 2 at its own 2.5x crop. Fast-renderer path covered by `test_fastrender.py`.

## Known gaps after v0.2.1

- Right-to-left captions (see "After v0.2.1"): Hebrew has no bundled font (Studio draws it, in the right
  order, with a system font). Text overlays (Studio only) get the fallback font but no direction handling.
  A word that starts with Latin letters and ends in Persian ones without a space is drawn right to left
  as a whole. The editor's style thumbnails (`caption-mini.tsx`) do not use the fallback font.
- Transcription of music / long videos is slow on this CPU (120 s for 88 s of sung Persian) and its
  progress moves in 30 s windows.

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
