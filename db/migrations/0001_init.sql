-- KLIPZ local schema (SQLite). Single user, one machine: no tenants, no auth.
-- IDs are UUID text, JSON is stored as text, timestamps are ISO-8601 UTC text.
-- Applied by both the web app and the Python worker (see PRAGMA user_version).

create table projects (
  id text primary key,
  title text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table source_videos (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  origin text not null check (origin in ('upload', 'youtube')),
  source_url text,
  storage_key text,          -- relative to <data dir>/storage
  audio_key text,            -- 16 kHz mono wav
  filename text,
  size_bytes integer,
  duration_sec real,
  width integer,
  height integer,
  fps real,
  status text not null default 'pending'
    check (status in ('pending', 'uploading', 'importing', 'ready', 'failed', 'deleted')),
  error text,
  scene_cuts text,           -- JSON number[] (seconds)
  energy text,               -- JSON {hop: seconds, rms: number[]} normalised 0..1
  expires_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index source_videos_project_idx on source_videos (project_id);

create table transcripts (
  id text primary key,
  source_video_id text not null unique references source_videos (id) on delete cascade,
  language text,
  words text not null default '[]',     -- JSON [{w, s, e, p?, spk?}]
  segments text not null default '[]',  -- JSON [{s, e, text, spk?}] sentence level
  speakers text not null default '[]',  -- JSON string[]
  model text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table caption_styles (             -- user-saved styles; built-ins live in code
  id text primary key,
  name text not null,
  style text not null,                    -- JSON CaptionStyle
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table clips (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  source_video_id text not null references source_videos (id) on delete cascade,
  start_sec real not null,
  end_sec real not null,
  score real,
  score_breakdown text,                   -- JSON {hook, context, emotion, payoff, energy, cuts, llm}
  title text,
  hook text,
  reason text,
  status text not null default 'candidate' check (status in ('candidate', 'kept', 'discarded')),
  crop_track text,                        -- JSON CropTrack
  caption_style_id text,
  edit_state text,                        -- JSON EditState
  edit_version integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check (end_sec > start_sec)
);
create index clips_project_idx on clips (project_id, score desc);

create table renders (
  id text primary key,
  clip_id text not null references clips (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed')),
  storage_key text,
  cover_key text,
  width integer,
  height integer,
  fps real,
  duration_sec real,
  size_bytes integer,
  video_codec text,
  audio_codec text,
  lufs real,
  edit_version integer,
  options text not null default '{}',     -- JSON {denoise, voiceover...}
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at text
);
create index renders_clip_idx on renders (clip_id, created_at desc);

create table social_accounts (
  id text primary key,
  provider text not null check (provider in ('youtube', 'tiktok', 'instagram', 'facebook', 'x', 'linkedin')),
  external_account_id text not null,
  display_name text not null,
  username text,
  avatar_url text,
  scopes text not null default '[]',      -- JSON string[]
  access_token_enc text,                  -- AES-256-GCM, key in <data dir>/secret.key
  refresh_token_enc text,
  token_expires_at text,
  status text not null default 'active' check (status in ('active', 'needs_reconnect', 'revoked')),
  via_aggregator integer not null default 0,
  meta text not null default '{}',
  last_error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (provider, external_account_id)
);

create table posts (
  id text primary key,
  batch_id text not null,                 -- one composer submit fans out to N posts
  clip_id text not null references clips (id) on delete cascade,
  render_id text references renders (id) on delete set null,
  social_account_id text references social_accounts (id) on delete set null,
  provider text not null,
  caption text not null default '',
  hashtags text not null default '[]',    -- JSON string[]
  title text,
  options text not null default '{}',     -- JSON provider-specific
  cover_timestamp_ms integer,
  scheduled_at text,
  timezone text,
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'queued', 'publishing', 'processing', 'published', 'failed', 'cancelled')),
  external_id text,
  external_url text,
  error text,
  error_code text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  next_attempt_at text,
  locked_at text,
  published_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index posts_clip_idx on posts (clip_id);
create index posts_due_idx on posts (status, next_attempt_at);

create table post_metrics (
  id integer primary key autoincrement,
  post_id text not null references posts (id) on delete cascade,
  captured_on text not null default (date('now')),
  views integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  impressions integer,
  watch_time_sec real,
  raw text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (post_id, captured_on)
);

create table jobs (
  id text primary key,
  project_id text references projects (id) on delete cascade,
  type text not null,
  payload text not null default '{}',
  result text,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  progress real not null default 0,
  stage text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  dedupe_key text,                        -- same key = same logical work
  parent_job_id text references jobs (id) on delete set null,
  run_after text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_by text,
  heartbeat_at text,
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at text,
  finished_at text
);
-- Idempotency: at most one live job per dedupe key.
create unique index jobs_dedupe_live_idx on jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');
create index jobs_claim_idx on jobs (status, run_after, created_at);
create index jobs_project_idx on jobs (project_id, created_at desc);
create index jobs_updated_idx on jobs (updated_at);

create table settings (
  key text primary key,
  value text not null
);
