# KLIPZ handoff (updated 2026-11-17, version 0.2.3)

Branch `desktop-app` (PR #1 into `main`). Releases: `v0.1.0` (pre-release), `v0.1.1`, `v0.2.0`, `v0.2.1`, `v0.2.2`, `v0.2.3`
(hook card styles, smarter Smart Edit cuts and clip boundaries, Montage, Manual AI Mode: see "New in v0.2.3").
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

### New in v0.2.2: right-to-left captions
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

### New in v0.2.3: hook card text styles
- Editor → Overlays → "Hook text style": six presets (`HOOK_PRESETS` in `packages/shared/src/presets.ts`:
  Purple Card = the old card, Yellow Box, Clean White, Midnight, Red Alert, Outline), then font (the seven
  bundled caption fonts, each in its one weight via `fontWeightOf()`), size 40-180, text colour, box on/off +
  colour, outline width + colour, uppercase, Reset. Tiles: `hook-mini.tsx`.
- Saved like caption styles: `edit.hook.styleId` + `edit.hook.overrides` (ops `setHookStyle`,
  `setHookOverride`, `resetHookOverrides`). Neither field is written for new clips; `resolveHookStyle()`
  falls back to Purple Card, so old edits draw exactly as before (Latin + Persian edits: ASS scripts
  byte-identical to 0.2.2 for every caption preset x safe zone x hook).
- Studio: `hookCardLayout()` in `Overlays.tsx` (pure, unit-tested). Padding 28/40, corners 32 and the shadow
  scale with `fontSize / HOOK_BASE_SIZE` (92); no box = no shadow; outline = `-webkit-text-stroke` with
  `paint-order: stroke fill` like captions.
- Fast: `ass._hook_look()` / `add_hook()` port the same rules (outline = ASS `\bord` of half the CSS width).
  The worker reads the presets from `presets.json` (`hookPresets`, `hookBaseSize`; regenerate with
  `KLIPZ_WRITE_PRESETS=1 npx vitest run packages/shared`). Refused with a reason, so Studio renders it:
  colours that are not plain (gradients, `var()`, `hsl()`), fonts that are not bundled, sizes outside
  8-400 px / outlines over 60 px.
- Verified: every preset + a custom override + a Persian hook rendered by both renderers on a flat test
  clip, settled frame (30): card and text edges within 0-2 px of Studio. Editor preview checked in an
  isolated data folder (choices show at once and survive a reload). Tests: `packages/shared/src/hook-style.test.ts`,
  `packages/video/src/hook-card.test.ts`, store test, `apps/worker/tests/test_hook_style.py`.

### New in v0.2.3: Smart Edit cuts and clip boundaries
- `smart_edit.keep_ranges`: pauses over 0.7 s are cut (was 0.45), keeping 0.28 s after speech and 0.15 s
  before it (was 0.12 both sides); cuts removing under 0.25 s are skipped; the air never reaches into a cut
  filler. On the owner's 33 min English video: 2,581 cuts -> 1,387, cuts closer than 0.2 s to a word 100 % -> 0.
- `segment.boundaries()`: a clip starts only where a sentence starts and ends only on a finished thought
  (full stop / long pause; no punctuation in the transcript -> pauses decide), never on a question answered
  within 3 s; windows run past their target length to finish the sentence. The air around a clip stops
  half way to the neighbouring speech.
- `heuristics`: Unicode word tokens (accented Latin words were split; Persian / Arabic had no words at all),
  `؟ ۔ 。` end sentences, Persian / Arabic / Urdu weak openers. Side effect: Smart Edit now emphasises
  Persian keywords like Latin ones (test_fastrender adjusted).

### New in v0.2.3: Montage
Several uploaded videos -> their exciting scenes -> N short videos in random order (`/montage`).
- Data: migration `0003_montage.sql`: `projects.kind` (`clips` | `montage`), `projects.options`
  (`{count, minSec, maxSec, poolInputs}`), `source_videos.role` (`input` | `pool`), `source_videos.scenes`.
- Worker `steps/montage.py`, job `montage` (`{project_id, count, minSec, maxSec}`): ingests + transcribes every
  input, `find_scenes()` (phrases split on 0.35 s pauses scored on lively words + the video's own loudness
  baseline; 2.5 s windows scored on sound bursts + shot changes, snapped to cuts, never splitting a word),
  then cuts all scenes into ONE "scene pool" video (`pool_args`: fill-crop to the most common shape, 30 fps,
  48 kHz) registered as a source with role `pool`, its scene list and the inputs' words moved to pool time.
  Every montage is an ordinary clip of the pool (start 0, end = pool length; edit pieces = scenes, `auto:
  false`, captions off but all words present, hook off) so the editor, both renderers, captions and the
  hook card work unchanged. One crop track (face tracking over the pool) is shared by all its montages.
  `compose()` draws scenes weighted by score and lower use, spreads videos, shortens the last scene to fit
  the maximum, never repeats a scene set, and orders them so a video never follows itself when avoidable.
  "Make more" reuses the pool while `poolInputs` matches; new videos -> a new pool (old montages keep theirs).
  A video of another shape than the pool (a phone video among landscape ones) is put whole in the middle of
  the pool frame over a blurred copy (`pool_args`), its scenes are marked `fit`, and their pieces get a
  centred `frame` (`CENTRE_CROP`; the editor's "add scene" does the same), so they fill the 9:16 screen
  instead of being letterboxed by the face tracking. No video gets more scenes in a montage than all the
  others plus one (`_pick`), so they can always alternate.
- Web: `/montage` page (`new-montage.tsx`: multi-file upload, count + length range), API `POST /api/montages`
  (create) and `POST /api/montages/[id]` (queue the job; 409 while uploading), sidebar entry. The project page
  shows `montage-panel.tsx` (videos, Add videos, Make more montages, job progress) instead of Find clips /
  AutoClip / framing, hides trim, and previews montages by their render. `sourceForProject()` returns the
  newest pool for montage projects; project delete removes every source folder. Editor: a **Scenes** tab
  (`scenes-panel.tsx`, montage clips only) to reorder / delete / add scenes, mute (`lib/montage.ts`
  recipes), captions on/off and hook text. The home page lists clip projects only.
- Tests: `apps/worker/tests/test_montage.py` (scene finding, composing, pool words, the whole job on two
  synthetic videos incl. "make more"), `apps/web/src/server/montage.test.ts` (API + editor recipes).
- Verified in an isolated data folder through the real API (upload in chunks -> job -> renders): three
  40 s clips of a real video + a synthetic vertical one -> 28 scenes, pool cut in ~25 s, 3 montages of
  13-20 s rendered by the fast renderer, whole job ~3.5 min (mostly Whisper on CPU). In the editor: Scenes
  tab, add scene, mute (export measured silent), captions on (Persian, right to left) and a hook card, all
  saved and drawn in the export.
- Not done: the Studio renderer was not compared frame by frame on a montage (same edit features as any
  clip); montage scenes are found without an AI model (the AI scorer is not used); no thumbnails in the
  Scenes tab; the installer was not rebuilt.

### New in v0.2.3: Manual AI Mode
Engine choice after import, then "export for Gemini, paste its JSON back".
- `projects.options.engine` (`builtin` | `manual`, absent = not asked yet). `engine-choice.tsx` (modal) shows
  on the project page when the video(s) are in, there are no clips and nothing is running; PATCH
  `/api/projects/[id]` `{engine}` records it. The Montage form no longer starts the job itself: the modal's
  built-in answer does.
- Worker `steps/manual_ai.py`: job `manual_export` writes `storage/projects/<id>/manual/`:
  `video_transcript.txt` (lines of at most 10 s, seconds, one block per video numbered like the JSON's
  `video`), `video_light.mp4` (`scale=-2:360,fps=1`, CRF 32, AAC 64k; `_N` per video), `gemini_prompt.txt`.
  Job `manual_clips` takes the parsed plan: segments snapped out of words (`montage._word_edges`), touching
  ones joined; one-video projects get clips of the original source (pieces = segments, captions on, hook
  `text_on_screen` for 4 s, progress bar, `auto: false`), reframed and rendered one by one; montage projects
  cut every segment once into a pool (the montage pipeline, shared crop track, centre crop for off-shape).
- Web: `lib/gemini-plan.ts` (`parsePlan`: code fences / text around the JSON, bare arrays, other key names,
  `h:mm:ss,ms` times, video by number / file name / `video_light_2`, clamps to the video, warnings),
  `POST /api/projects/[id]/manual` (`export` | `open` = Explorer), `GET` (file list), `POST .../manual/clips`
  (`{json}` -> 400 with the reason, or the job + warnings). `manual-panel.tsx`: progress, files with Download,
  Open folder, Copy prompt, the paste box, Generate. A clip joined from several segments shows its segment
  count and real length, previews its render and has no trim (trim would drop the segments).
- Verified in an isolated data folder through the UI: upload -> modal -> Manual AI Mode -> 40 s video gave a
  560 KB proxy (480x360, 1 fps, AAC 65 kb/s) -> pasted a fenced 2-clip JSON -> 3 segments joined into 11.7 s
  at 1080x1920 by the fast renderer, hook for exactly 4 s, Persian captions.
- Tests: `apps/worker/tests/test_manual_ai.py`, `apps/web/src/lib/gemini-plan.test.ts`,
  `apps/web/src/server/manual-ai.test.ts`. Not done: talking to Gemini from the app (by design manual).

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

- Right-to-left captions (see "New in v0.2.2"): Hebrew has no bundled font (Studio draws it, in the right
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
