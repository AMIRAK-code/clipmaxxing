# KLIPZ

KLIPZ turns long videos into captioned 9:16 clips. You give it a video (upload or YouTube URL); it transcribes it, finds the moments most likely to work as short clips, reframes them to vertical, adds animated captions, lets you edit in the browser, renders an MP4, and posts it to TikTok, YouTube Shorts, Instagram Reels, Facebook Reels, X and LinkedIn, now or scheduled. It also pulls basic view/like numbers back.

It is a **personal, local, single-user app**. No accounts, no login, no billing, no cloud database. It runs on your own Windows PC: a web app on `127.0.0.1:3000` plus a Python worker, with one SQLite database and your media under `%USERPROFILE%\.klipz`.

Nothing leaves your PC except:

1. YouTube downloads (if you import by URL).
2. One-time model/tool downloads: the Whisper speech model (Hugging Face), the MediaPipe face model (Google), Chrome Headless Shell for Remotion (first render), and the bundled ffmpeg (installed by pip).
3. Optional AI calls to Anthropic, only if you set `ANTHROPIC_API_KEY` (clip scoring and AI captions), or to ElevenLabs only if you set its key. A local Ollama model is an alternative that stays on your PC.
4. Posting to the platforms you connect, using your own developer apps.

Only use content you own or have the rights to, and follow each platform's terms.

Platform walkthroughs (developer apps, redirect URIs, review checklist): [docs/platform-setup.md](docs/platform-setup.md).

---

## Desktop app (Windows installer)

KLIPZ also ships as a normal Windows program: `KLIPZ-Setup-<version>.exe` installs it per user (no admin prompt) under `%LOCALAPPDATA%\Programs\KLIPZ` with a Start-menu entry and an optional desktop shortcut. It opens in its own window (a native .NET shell hosting the app in Microsoft Edge WebView2, which Windows 11 already has; no browser tab, no Electron). The installer bundles Node.js and the built app; it does not need Node, npm or the repo on the PC.

- **First start** sets up the Python video worker in `%USERPROFILE%\.klipzenv` (a few minutes, about 2 GB of packages). It needs Python 3.11, 3.12 or 3.13; if none is found it offers to install Python 3.12 with winget. Updates that change the worker's requirements re-run this automatically.
- **Connecting TikTok, Instagram, X ...** happens inside the window: on **Accounts**, paste your developer app's keys into the platform's card, press **Connect**, sign in on the platform's own page, approve, and you are back in KLIPZ. A bar at the top shows when you are on a platform's sign-in page, with a way back.
- It listens on `http://localhost:3000` (the redirect URIs you register contain this port). If the port is taken it tells you instead of picking another one; set `KLIPZ_PORT` to change it.
- Closing the window stops the web server, the worker and every render (they run in a Windows job object). Your data stays in `%USERPROFILE%\.klipz`; uninstalling does not delete it.
- Logs: `%USERPROFILE%\.klipz\logs\desktop-web.log` and `desktop-worker.log`.

Building it (needs Node 22.5+, the .NET 10 SDK and Inno Setup 6, `winget install -e --id JRSoftware.InnoSetup`):

```
npm install
npm run desktop:installer      # -> dist\desktop\KLIPZ-Setup-<version>.exe
npm run desktop:stage          # just the runnable folder: dist\desktop\stage\KLIPZ.exe
```

The shell's source is in `apps/desktop` (C#); the installer script is `installer/klipz.iss`.

## 1. Requirements

- Windows 11 (the launcher is written for Windows; the code is mostly portable but only Windows was tested).
- Node.js 20 or newer (24 was used for development), with npm.
- Python 3.11 (3.11.0 was used).
- About 6 GB of free disk for dependencies and models, plus space for your videos and renders.
- An NVIDIA GPU is optional. It only speeds up transcription (CUDA). Without it, transcription runs on the CPU (slower). Reference machine: RTX 3060 6 GB.
- Renders are CPU/GPU-heavy: expect roughly 2 to 4 minutes per clip on the reference machine.

### OneDrive warning

If this project folder sits inside OneDrive (for example `Desktop\...`), OneDrive will try to sync `node_modules` (hundreds of thousands of small files) and `apps\web\.next`. Either move the project outside OneDrive (for example `C:\dev\klipz`), or exclude those folders from sync. All your data lives in `%USERPROFILE%\.klipz`, which is normally not in OneDrive.

## 2. First-time setup

Run these in a terminal (PowerShell or cmd) in the project folder.

```
npm install

python -m venv "%USERPROFILE%\.klipz\venv"
"%USERPROFILE%\.klipz\venv\Scripts\python.exe" -m pip install -r apps/worker/requirements.txt

npm run fonts
npm run build
```

(In PowerShell write `$env:USERPROFILE` instead of `%USERPROFILE%`.)

Notes:

- The venv must be at `%USERPROFILE%\.klipz\venv`, or set `KLIPZ_VENV` to its folder.
- Optional, NVIDIA GPU only: `"%USERPROFILE%\.klipz\venv\Scripts\python.exe" -m pip install -r apps/worker/requirements-gpu.txt` installs the CUDA 12 libraries (cuBLAS/cuDNN) that faster-whisper needs. If CUDA is not usable the worker silently falls back to CPU.
- `npm run fonts` copies the caption fonts from `node_modules` into `apps/web/public/fonts`. The launcher stops with a message if they are missing.
- The first transcription downloads the Whisper model, the first reframe downloads the face model, and the first render downloads Chrome Headless Shell. These happen once and need internet.
- Copy `.env.example` to `.env.local` at the repo root only if you want to change settings; that one file is read by both the web app and the worker. See section 5.

## 3. Start and stop

Double-click **`start-klipz.bat`**, or run:

```
npm start
```

This starts the Python worker and the web app (production build; it builds first if there is no build yet), checks prerequisites and prints what to fix if something is missing. Open **http://localhost:3000**. Logs from both processes appear in the same window with `web |` and `worker |` prefixes.

- Stop everything with **Ctrl+C** in that window (or close the window). If either process dies, the launcher stops the other and exits with an error.
- Developer mode (hot reload, slower): `npm start -- --dev`.
- `npm start -- --no-build` fails instead of building when no build exists.
- Other ports: set `KLIPZ_PORT` (web) and/or `KLIPZ_WORKER_PORT` (worker, default 8787) before starting. `APP_URL` follows `KLIPZ_PORT` unless you set it yourself, and the OAuth redirect URIs follow `APP_URL`.
- After you change code or pull updates, run `npm run build` again.
- The separate scripts `npm run dev` (web only, port `KLIPZ_PORT`, default 3000) and `npm run worker` (worker only) exist for development.

**Scheduled posts and metrics only run while KLIPZ is running.** The scheduler is inside the web app: it checks every 15 seconds for due posts and pulls metrics hourly. If the PC is off or KLIPZ is closed at the scheduled time, the post goes out at the next start (missed posts are published when the app comes back, so a very late post is possible).

### Try it without any video

```
node scripts/seed.mjs
```

Creates a demo project ("KLIPZ demo") with a generated video, transcript and 3 scored clips, without the worker. `python scripts/make-sample.py` (run with the venv python) writes a 75-second speech sample to `<data dir>\samples\sample.mp4` that you can upload (it uses Windows speech synthesis).

### Data location, backup, moving

Everything is in `%USERPROFILE%\.klipz`:

| Path | Contents |
|---|---|
| `klipz.db` (+ `-wal`, `-shm`) | the SQLite database |
| `storage\` | uploads, sources, audio, thumbnails, renders, covers |
| `models\` | MediaPipe face model |
| `secret.key`, `state.key` | key that encrypts social tokens, OAuth state secret |
| `logs\` | error log |
| `tmp\`, `samples\` | scratch, sample video |
| `venv\` | Python environment (convention, safe to recreate) |

To back up: close KLIPZ, copy the whole folder (keep `secret.key` with `klipz.db`, otherwise you must reconnect accounts). To move it, copy it to the new place and set `KLIPZ_DATA_DIR` (system environment variable, or in the root `.env.local`) before starting. Whisper models are cached by Hugging Face under `%USERPROFILE%\.cache\huggingface`, not in this folder.

## 4. Using KLIPZ

### New project

On the **Projects** home page: drop a file (MP4, MOV, MKV or WebM, up to 5 GB; uploaded in chunks) or paste a YouTube URL (imported with yt-dlp, up to 1080p). Only use content you have the rights to. The project page shows import progress, then transcription starts as part of the next step.

### Find clips or AutoClip

- **Find clips**: transcribes (if needed), splits the video into candidate windows, scores them, picks the best non-overlapping ones and reframes each to 9:16. You then review them.
- **AutoClip**: does the same, then also adds captions and renders the top clips in one go, ready to post.

### Reviewing clips

Clips are ranked by a 0 to 100 score: green 75 and up, amber 50 to 74, red below 50. The breakdown shows hook, context, emotion, payoff and energy, and which scorer produced it: **Claude** (Anthropic key set), **Ollama** (local), or **Heuristic** (offline default, based on speech/audio/scene-cut signals). Scores are a ranking aid, not a prediction of views. For each clip you can **keep** or **discard** it, play a preview (with the blurred letterbox background if the crop is a letterbox), and **trim** the start/end with handles. Discarded clips stay in a collapsible list so you can bring them back.

### Editor

Open a clip in the editor. The preview is the same Remotion composition that is rendered. Tracks in the timeline:

| Track | What it holds |
|---|---|
| Video | the clip, as pieces you can split, trim and ripple-delete (with transitions); zoom keyframes |
| Captions | the word-timed captions (each word shows its timing) |
| B-roll | images/videos you add over the main video |
| Audio | audio items you add (music, voiceover) over the main audio, with ducking |
| Text | free text overlays |

The right panel has tabs: **Captions** (8 presets: Bold Outline, Karaoke Neon, Yellow Highlight, Minimal, Comic Pop, One-Word Punch, Boxed Subtitle, Gradient Glow; edit font, colours, highlight style, animation, words per page, position, emoji), **Video** (look, selected piece and transition, zoom keyframes, main audio volume and ducking), **Media** (B-roll and audio items), **Text**, **Overlays** (hook title card, progress bar, a safe-zone guide for a platform's UI), **Export**. "Look" filters (warm, cool, cinematic, B/W, vivid, fade) are CSS-filter approximations of colour grades, not real LUTs. Changes autosave ("Saved" in the header); Ctrl+S saves now. Undo/redo cover your edits.

Keyboard shortcuts (press `?` in the editor to show them; they do not fire while you type in a field or use a slider/button that needs the key):

| Keys | Action |
|---|---|
| Space | Play / pause |
| Left / Right | Step one frame (Shift: one second) |
| J / K / L | Reverse (repeat J for faster, up to 4x) / pause / play |
| S | Split the video at the playhead |
| Delete / Backspace | Ripple delete the selected piece (or remove the selected item) |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+S | Save now |
| + / - | Zoom the timeline |
| Ctrl + scroll | Zoom the timeline around the cursor |
| Home / End | Jump to start / end |
| ? | Show shortcut help |

### Export

Editor, **Export** tab: renders a **1080x1920 MP4** (H.264 + AAC, faststart, loudness normalised to about -14 LUFS), with an optional **Denoise audio** switch, and a cover image. The panel shows per-platform checks (duration and size limits) and the render status; earlier renders are listed. If you edit after rendering, the render is marked outdated and you export again. Render failures from Remotion that look transient ("No frame found at position", compositor errors) are retried automatically.

### Composer (posting)

From a rendered clip choose **Post**. Pick the connected accounts, then:

- **Caption**: one base caption plus a per-platform override (hashtags, title for YouTube/Facebook/LinkedIn). Platform limits are validated before you can post (for example X is 280 weighted characters).
- **AI captions**: writes captions for the selected platforms. With `ANTHROPIC_API_KEY` set it calls Claude (paid); without a key it uses an offline template. The page says which generator was used. Always read what it produced.
- **TikTok**: shows your TikTok nickname and the privacy options TikTok allows for you. You must choose who can view (no default), set comment/duet/stitch, say whether the video is commercial content (your brand / branded content, which cannot be private), and tick the TikTok consent line. Unaudited apps can only post privately.
- **Cover frame**: scrub the clip or click a thumbnail to choose the cover.
- **When**: **Post now** or **Schedule for later** with a date, time and **time zone** (defaults to your PC's; the time is stored as UTC). **Best-time suggestions** per platform come from your own published posts once you have at least 5 with metrics, otherwise from generic slots based on public studies. They are heuristics, not guarantees.

### Posts page

Lists every post with status: **Scheduled**, **Queued**, **Publishing**, **Processing** (the platform is still processing the upload; KLIPZ polls), **Published** (with a link), **Failed** (with the reason), **Cancelled**. Filter by status or platform. Per platform you can **Retry** (optionally after editing the caption sent), **Cancel**, **Reschedule** or remove an entry; one platform failing never affects the others posted from the same batch. Failed posts that hit a transient error are retried automatically up to 6 attempts with growing delays (30 s up to 30 min). Posts failing with `needs_reconnect` need you to reconnect the account on the Accounts page. Failures with `uncertain_outcome` mean KLIPZ stopped mid-upload and cannot know whether the platform got the video: check the platform, then retry or delete (see "Publish engine" below).

### Analytics

Views, likes, comments and shares for published posts over 7/30/90 days: totals, views over time, by platform, per clip, with links to the posts. Numbers are pulled hourly while KLIPZ runs. What each platform exposes differs (LinkedIn analytics are mostly unavailable without restricted scopes).

### Settings

- **System status**: worker online, ffmpeg, Node, data folder, which keys are set (names only, never values), which scorer is active.
- **Failed jobs (dead-letter queue)**: background jobs that failed all their attempts, with the error; retry or delete them.
- **Storage**: sizes, and **Run cleanup now**. Cleanup also runs once a day automatically while the worker runs: it removes source video/audio older than `SOURCE_RETENTION_DAYS` (default 30; thumbnails, clips and renders are kept, and sources with queued jobs are skipped), abandoned partial uploads older than 24 h, and finished job records older than 30 days.
- **Error log**: recent server errors.
- **Danger zone**: disconnect all accounts, and **Delete all data** (empties the database tables and everything in `storage`, drops stored tokens; keeps the database file, schema and secret keys; cannot be undone; posts already published stay on the platforms).

### AI tab and Smart Edit

The **AI** page chooses what finds and edits clips, without touching any file:

- **Engine**: Automatic, Smart Edit only (never calls a model), Claude (Anthropic API key), OpenAI-compatible (OpenAI, OpenRouter, Groq, LM Studio, llama.cpp server: base URL + optional key + model), or a Local model through Ollama. Each has a **Test** button; the Ollama one lists the installed models.
- **Import a model file**: give the full path of a `.gguf` file on this PC and a name; KLIPZ registers it with Ollama (`ollama create`) and selects it. Ollama must be installed and running.
- Keys are stored encrypted in `<data dir>i-settings.json` and are never shown again. Environment variables / `.env.local` win over the page and are shown as locked. Changes apply to the next job, no restart.

**Smart Edit** is the built-in automatic editor and is on by default, with or without an AI model. For every new clip it cuts dead air (pauses over 0.45 s) and isolated "um / uh", alternates the framing slightly on each cut, punches in on keywords, numbers and shouted words, emphasises those words in the captions, and turns on the hook card and the progress bar. The result is a normal edit you can change in the editor; a clip you never edited gets a fresh Smart Edit if you trim it or run Find clips again. Without an AI model the clips themselves are chosen by the built-in scorer (hook strength, standalone-ness, emotional intensity, payoff, audio energy, scene cuts).

### Library

The **Library** page lists your files with real names and shows where they are on disk:

- `<data dir>\Library\Raw videos\<title>.mp4`: every uploaded or imported video.
- `<data dir>\Library\Clips\<project>\<clip title>.mp4`: the latest finished export of each clip.

Per file: **Play**, **Show in Explorer**, **Copy file** (puts the file on the clipboard: paste it into WhatsApp, Telegram, Discord, an email or a folder) and, in the desktop app, **Share** (the Windows share sheet). The entries are hard links to the files KLIPZ already stores, so they use no extra disk space; deleting one there does not delete the video in KLIPZ.

## 5. Configuration

KLIPZ works with no configuration. Settings are environment variables. Where to put them:

- **One file is enough:** `.env.local` (or `.env`) at the repo root is read by both the web app and the worker. Real environment variables always win over files.
- `apps/web/.env.local` still works for the web app and wins over the root files for the web app (the worker never reads it). The Settings page reports which keys the web process sees (names only).
- The launcher passes its own environment to both. Restart KLIPZ after changing any file. `.env.example` is a template (it is annotated per file).

### Paid versus free

| Service | Needed? | Free default |
|---|---|---|
| Anthropic API (`ANTHROPIC_API_KEY`) | Optional, **paid** | Offline heuristic scorer and template captions, or a local Ollama model for scoring |
| ElevenLabs (`ELEVENLABS_API_KEY`) | Optional, **paid**, voiceover only | Off |
| Upload-Post / Ayrshare aggregator | Optional, **paid** | Direct platform apps |
| X API paid tier / credits | **Required** to post video to X | Skip X |
| YouTube, TikTok, Meta, LinkedIn developer apps | Free to create | Sandbox mode |
| Whisper, MediaPipe, Remotion, ffmpeg | Free (Remotion: see licence note) | n/a |

### Environment variables

Worker (root `.env.local`):

| Variable | Default | What it does |
|---|---|---|
| `KLIPZ_DATA_DIR` | `%USERPROFILE%\.klipz` | Data folder (also read by the web app and scripts; set it identically for both) |
| `WHISPER_MODEL` | `small` | faster-whisper model name (`tiny`, `base`, `small`, `medium`, `large-v3`, ...). Bigger is slower and more accurate; `small` fits a 6 GB GPU |
| `WHISPER_DEVICE` | `auto` | `auto`, `cuda` or `cpu`. CUDA failures fall back to CPU |
| `TRANSCRIBER` | `auto` | `auto`, `whisperx` or `faster-whisper`. The WhisperX path needs `whisperx` installed (see `requirements-gpu.txt`) |
| `HF_TOKEN` | empty | Hugging Face token, only for WhisperX diarization (speaker labels) |
| `LLM_PROVIDER` | `auto` | Scorer: `auto` (Anthropic if a key is set, else an OpenAI-compatible API if a model is set, else Ollama if a model is set, else the built-in engine), `anthropic`, `openai`, `ollama`, `none` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible chat API: OpenAI, OpenRouter, Groq, LM Studio, llama.cpp server |
| `OPENAI_API_KEY` | empty | Key for that API (leave empty for a local server) |
| `OPENAI_MODEL` | empty | Model name; scoring through this API is off while empty |
| `KLIPZ_SMART_EDIT` | `1` | `0` turns off Smart Edit (automatic jump cuts, punch-ins, emphasis, hook card, progress bar on new clips) |
| `ANTHROPIC_API_KEY` | empty | Enables Claude scoring (worker) and AI captions (web). Paid |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model id for both |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama server |
| `OLLAMA_MODEL` | empty | Ollama model name (e.g. one you pulled); scoring via Ollama is off while empty |
| `ELEVENLABS_API_KEY` | empty | Enables the optional text-to-speech voiceover step. Paid |
| `SOURCE_RETENTION_DAYS` | `30` | Days to keep the source video/audio before cleanup |
| `KLIPZ_RENDER_CONCURRENCY` | Remotion default | Browser tabs used per render; lower it if renders run out of memory |
| `KLIPZ_MODEL_DOWNLOAD` | `1` | `0` stops the one-time face-model download (reframing then falls back) |
| `KLIPZ_MODEL_DIR` | `<data dir>\models` | Where the face model is stored |
| `KLIPZ_POLL_INTERVAL` | `1.0` | Seconds between job-queue polls |
| `KLIPZ_STALE_SECONDS` | `120` | A running job with no heartbeat for this long is reclaimed |
| `KLIPZ_VENV` | `%USERPROFILE%\.klipz\venv` | Python venv location (launcher, worker script, status check) |
| `KLIPZ_WORKER_PORT` | `8787` | Worker health API port (launcher passes it to both; the web app uses it to show "worker online") |

Launcher and web app:

| Variable | Default | What it does |
|---|---|---|
| `KLIPZ_PORT` | `3000` | Web port for `npm start` and `npm run dev` |
| `APP_URL` | `http://localhost:<KLIPZ_PORT>` | Public base URL; builds OAuth redirect URIs and the allowed Host header. Set to your HTTPS tunnel when you need one |
| `FFMPEG_PATH` | bundled static-ffmpeg | Use a different ffmpeg (status check and `seed` script) |
| `KLIPZ_PUBLISH_MOCK` | off | `1`/`true`/`yes`/`on` = sandbox posting (fake accounts and posts) |
| `TOKEN_ENCRYPTION_KEY` | generated in `<data dir>\secret.key` | Key for tokens at rest (set only if you want to manage it yourself; losing it means reconnecting accounts) |
| `OAUTH_STATE_SECRET` | generated in `<data dir>\state.key` | HMAC secret for the OAuth `state` |
| `KLIPZ_POLL_MAX_ATTEMPTS` | adapter default | Max status polls per upload attempt for platforms that process asynchronously |

Platform apps (root `.env.local`; details in [docs/platform-setup.md](docs/platform-setup.md)):

| Variable | Default | What it does |
|---|---|---|
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | empty | Google OAuth client |
| `TIKTOK_CLIENT_ID` (client key), `TIKTOK_CLIENT_SECRET` | empty | TikTok app |
| `META_APP_ID`, `META_APP_SECRET` | empty | One Meta app for Instagram and Facebook |
| `META_GRAPH_VERSION` | adapter default (v27.0) | Graph API version |
| `META_CONFIG_ID` | empty | Facebook Login for Business configuration id |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | empty | X OAuth 2.0 client |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | empty | LinkedIn app |
| `LINKEDIN_VERSION` | adapter default (202610) | `Linkedin-Version` header (YYYYMM) |
| `LINKEDIN_EXTRA_SCOPES` | empty | Extra scopes, only if LinkedIn approved them |
| `TIKTOK_SOURCE` | file upload | `pull` = PULL_FROM_URL (needs a public verified URL; not useful locally) |
| `TIKTOK_AUDITED` | none | `true` once your TikTok app passed audit. Otherwise the composer shows the non-blocking warning that TikTok will force non-private posts to private |
| `KLIPZ_UPLOAD_MODE` | streaming above 8 MiB | `buffer` = upload Instagram/Facebook (and aggregator) videos as one in-memory buffer instead of streaming |
| `AGGREGATOR_KIND` | empty | `upload-post` or `ayrshare` (paid) |
| `AGGREGATOR_API_KEY` | empty | Aggregator key |
| `AGGREGATOR_PROVIDERS` | empty | Comma list of platforms routed through it, e.g. `tiktok,instagram` |
| `AGGREGATOR_PROFILE_KEY` | empty | Aggregator profile to post as |
| `AGGREGATOR_BASE_URL` | service default | Aggregator API host override |

Test/script variables: `E2E_WEB_PORT` (3100), `E2E_WORKER_PORT` (8797), `E2E_TIMEOUT_MIN` (20) for `npm run e2e`; `KLIPZ_SLOW_TESTS=1`, `KLIPZ_E2E=1`, `KLIPZ_E2E_KEEP` for opt-in worker tests; `KLIPZ_SMOKE_DIR`, `FFMPEG`, `FFPROBE`, `KLIPZ_PYTHON` for the `packages/video` smoke scripts.

## 6. Connecting platforms

Short version: for each platform you want, create your own developer app, register the redirect URI shown on the **Accounts** page, paste the client id/secret into that platform's card on the **Accounts** page (or put them in `.env.local` and restart), and press Connect: the platform's own sign-in page opens, and after you approve you land back on Accounts with the account connected. Keys entered in the app are stored in `<data dir>\platform-keys.json` with the secret encrypted by `secret.key`; environment variables / `.env.local` win over them. Before the platform reviews your app, expect limits: YouTube uploads are locked private, TikTok is private only until audited (register the TikTok app as a Desktop app so the localhost redirect is accepted), Meta works only for accounts with a role on your app, X needs a paid tier for video, LinkedIn posts to your profile. Full steps, scopes, the app-review checklist and the aggregator fallback are in [docs/platform-setup.md](docs/platform-setup.md).

To try the whole flow with no platform app, set `KLIPZ_PUBLISH_MOCK=1` (in `.env.local`), restart, and on the Accounts page press **Add sandbox account** for each platform.

## 7. How it works

```
apps/web        Next.js 15 app (UI + API routes + in-process scheduler), reads/writes SQLite
apps/worker     Python 3.11 worker: job runner + FastAPI health (127.0.0.1:8787)
packages/shared types, caption presets, timeline/crop maths shared by web, worker data and video
packages/video  Remotion composition used by both the editor preview and the final render
packages/publishers  per-platform publish adapters + aggregator
db/migrations   SQLite schema (applied automatically at start)
scripts         launcher, worker runner, seed, fonts, sample video, e2e
```

Data flow: upload or YouTube URL -> `ingest`/`import_youtube` (ffmpeg, thumbnails, audio) -> `transcribe` (faster-whisper, word timestamps) -> `analyze` (candidate windows from pauses/sentences, features, scoring, selection) -> `reframe` (MediaPipe faces, speaker matching, smoothed crop track, split/letterbox fallbacks) -> editor (edit state saved as JSON with versioning) -> `render` (Remotion + ffmpeg, loudness) -> composer -> posts -> publish engine -> metrics. The browser gets live updates over server-sent events.

### Job queue (worker)

Jobs live in the `jobs` table; the web app enqueues, the worker claims.

- **Idempotent**: a job with a dedupe key is not added again while one with that key is queued or running (clicking twice does not do the work twice).
- **Retries with backoff**: a failing job is retried with exponential backoff (base 5 s) up to `max_attempts` (3 by default). Errors marked permanent (bad input, missing file) go straight to dead.
- **Dead-letter**: out of attempts means status `dead`; it shows on Settings with the error so you can retry or delete.
- **Heartbeat reclaim**: a running job refreshes a heartbeat every 5 s. If the worker crashes, the job is reclaimed after `KLIPZ_STALE_SECONDS` (or dead-lettered if no attempts are left).
- Cancelling a job stops it at the next progress call.

### Publish engine (web)

Runs every 15 s inside the web app: promotes due scheduled posts, reclaims stale locks, claims due posts and processes up to 3 at a time, each independently.

- **At most once**: just before the platform call the post is marked in flight. If KLIPZ dies between the call and saving the result, the post becomes `failed` with `uncertain_outcome` and is never re-sent automatically, because the platform may already have it. You decide.
- A post that already has a platform id is only polled, never re-published. While a long upload runs the lock is refreshed so it is not reclaimed.
- Retryable errors (429, 5xx, network) back off from 30 s up to 30 min, at most 6 attempts, honouring `Retry-After`. Auth errors mark the account `needs_reconnect`. Processing posts are polled and time out after 6 hours.

### Where things live

`klipz.db` has projects, source_videos, transcripts, clips, renders, social_accounts (encrypted tokens), posts, post_metrics, jobs, settings. Files are under `storage\` addressed by key; the API serves them with Range support. Secrets: `secret.key`, `state.key` (0600 where the OS supports it). The web app only accepts requests whose Host is loopback or `APP_URL`, and changing requests must be same-origin.

## 8. Testing

```
npm test                 # vitest: web, shared, video, publishers (about 460 tests)
npm run test:worker      # pytest in the worker venv (about 130 tests)
npm run typecheck        # tsc in every workspace
npm run e2e              # full end-to-end run, about 7 to 10 minutes (see below)
```

Opt-in worker tests that load real models (run from `apps/worker` with the venv python, or set the variables then `npm run test:worker`):

- `KLIPZ_SLOW_TESTS=1` runs `test_slow_whisper.py` (real Whisper).
- `KLIPZ_E2E=1` (with `WHISPER_MODEL=tiny`) runs the full pipeline with real Whisper, MediaPipe and Remotion.

`npm run e2e` starts the launcher on ports 3100/8797 with a temporary data dir and sandbox posting, then drives the HTTP API like the browser: chunked upload, ingest, AutoClip with 2 clips over SSE, render checks (1080x1920, h264+aac, faststart, about -14 LUFS), an edit and re-export (outdated flag), posting to all six sandbox accounts, a fail-once retry, a scheduled batch and reschedule, analytics, status, delete-all. It cleans up and never touches `%USERPROFILE%\.klipz`. `--keep` keeps the temp dir, `--dev` uses next dev.

## 9. Troubleshooting

| Problem | What to do |
|---|---|
| Banner or status says **worker offline** | Start with `npm start` (not only `npm run dev`). Check the `worker |` lines for errors; confirm `http://127.0.0.1:8787/health` answers. The venv must exist (see setup) |
| Launcher says venv/fonts/deps missing | Do exactly what the message says (`pip install`, `npm run fonts`, `npm install`) |
| **CUDA not found** / transcription slow | The worker falls back to CPU automatically. For GPU, install `requirements-gpu.txt`, update the NVIDIA driver, or set `WHISPER_DEVICE=cpu` to stop trying |
| First render takes minutes and downloads | Remotion downloads Chrome Headless Shell once. Needs internet |
| Render fails with **No frame found at position** | A known transient Remotion error. It is retried automatically; if it persists lower `KLIPZ_RENDER_CONCURRENCY` (try 2) and retry from the Export tab |
| **YouTube import fails** | YouTube changes often. Update yt-dlp: `"%USERPROFILE%\.klipz\venv\Scripts\python.exe" -m pip install -U yt-dlp`. Some videos (private, age-limited, region-locked) cannot be downloaded; upload the file instead |
| **Port in use** | Find the owner: `netstat -ano \| findstr :3000`, then `tasklist /fi "PID eq <pid>"`. Close that program or use `KLIPZ_PORT=3001` (and `KLIPZ_WORKER_PORT`). Remember the OAuth redirect URIs follow the port |
| **redirect_uri_mismatch** / "invalid redirect" on connect | The URI registered in the platform console must equal the one on the Accounts page character for character (scheme, host `localhost` vs `127.0.0.1`, port, no trailing slash). TikTok needs HTTPS |
| Account shows **needs reconnect** | Token expired or revoked (YouTube Testing mode: every 7 days). Press Connect again |
| "Cross-site request blocked" / "Unexpected Host header" | Open the app at `http://localhost:3000` or `127.0.0.1`, or set `APP_URL` to the host you use |
| Scheduled post did not go out | KLIPZ was not running. Start it; due posts are picked up within about 15 s |
| Everything is slow / disk full | Run cleanup in Settings; lower `SOURCE_RETENTION_DAYS`; delete old projects |

Logs: the launcher window, Settings, Error log, and `%USERPROFILE%\.klipz\logs`.

## 10. Known limitations and what is not verified

Be aware of these before you rely on it:

- **No real platform API or OAuth flow has been exercised.** All publishers were tested against scripted mocks and sandbox mode only. Endpoints follow the platforms' documentation as of 2026-11-11 and may need fixing on first real use. Streaming uploads (large files to Meta and Upload-Post) were verified only against a local loopback server and mock fetch.
- **Instagram**: after a successful publish the media id is best-effort (newest reel); a container already PUBLISHED is never published twice.
- **WhisperX / diarization** path is untested (needs `whisperx`, `HF_TOKEN`). The default faster-whisper path is what was exercised.
- **Claude and Ollama scorers** were tested with fakes only, never with a live API/model. The heuristic scorer is the one used end to end.
- The **letterbox/split heuristic** was tuned on synthetic footage, so real-world videos may pick the wrong layout; trim/reframe in the editor if so.
- **Look filters** are CSS-filter approximations, not LUTs.
- Only Windows 11 was tested. The Ctrl+C shutdown path of the launcher was not tested interactively (killing the worker and web processes was).
- A browser pass covered the main screens in dev mode with sandbox posting; the native file picker was not driven and accessibility was checked only for obvious problems.
- Renders are heavy; a 6 GB GPU is not used for rendering, only for transcription.

### What replaced the original SaaS design

This is a personal tool, so these parts of the original SaaS spec were intentionally dropped:

| Dropped | Local replacement |
|---|---|
| Stripe credits / billing | Nothing; you pay platforms/APIs directly, if at all |
| Supabase auth, RLS, realtime | No login (loopback only, Host/same-origin checks); SQLite; server-sent events |
| Cloudflare R2 object storage | Files under `%USERPROFILE%\.klipz\storage`, served with Range support |
| Vercel hosting / cron | `npm start` on your PC; in-app scheduler and worker cleanup |
| Sentry | Local error log (`logs\`, shown in Settings) |
| Rate limiting | Not needed for one local user; adapters honour platform 429/Retry-After |

### Licences and terms

- **Remotion** is used for rendering. It is free for individuals and small teams but has its own licence; check https://www.remotion.dev/license before using KLIPZ commercially or in a larger company.
- Other dependencies keep their own licences (faster-whisper, MediaPipe, yt-dlp, ffmpeg, Next.js, ...).
- Respect each platform's terms and developer policies, YouTube's terms when downloading, and the copyright of any content you process or post.
