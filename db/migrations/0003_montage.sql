-- Montage: several uploaded videos -> short mixes of their best scenes.
--
-- A montage project's uploads are source_videos with role 'input'. The worker cuts the chosen scenes
-- of all of them into one vertical, normalised video (role 'pool'); every montage is an ordinary clip
-- on that pool whose pieces jump between scenes, so the editor and both renderers work unchanged.

-- 'clips' = the usual one-video project, 'montage' = the multi-video kind
alter table projects add column kind text not null default 'clips';
-- montage settings: JSON {count, minSec, maxSec, seed}
alter table projects add column settings text;

-- 'input' = an uploaded video, 'pool' = the scene pool a montage worker built from the inputs
alter table source_videos add column role text not null default 'input';

create table montage_scenes (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  input_source_id text references source_videos (id) on delete set null,
  pool_source_id text not null references source_videos (id) on delete cascade,
  idx integer not null,            -- order in the pool
  src_start real not null,         -- the scene in its upload (seconds)
  src_end real not null,
  pool_start real not null,        -- the scene in the pool video
  pool_end real not null,
  pool_min real not null,          -- with the extra footage kept around it (trim limits in the editor)
  pool_max real not null,
  score real not null default 0,
  breakdown text,                  -- JSON {audio, motion, speech}
  text text,                       -- what is said in the scene
  has_speech integer not null default 0,
  thumb_key text,
  input_name text,                 -- the upload's file name, for the editor's scene list
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index montage_scenes_project_idx on montage_scenes (project_id, idx);
create index montage_scenes_pool_idx on montage_scenes (pool_source_id);
create index projects_kind_idx on projects (kind, created_at);
