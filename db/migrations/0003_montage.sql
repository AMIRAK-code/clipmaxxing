-- Montage projects: several uploaded videos, their exciting moments mixed into short videos.
--   projects.kind           clips (one video cut into clips) | montage
--   projects.options        JSON, montage: {count, minSec, maxSec}
--   source_videos.role      input (a video the person added) | pool (the scenes a montage job cut out of
--                           the inputs, joined into one video that the montages are edits of)
--   source_videos.scenes    JSON, pool: [{id, s, e, from, name, score}] in pool seconds; from = input source id
alter table projects add column kind text not null default 'clips';
alter table projects add column options text;
alter table source_videos add column role text not null default 'input';
alter table source_videos add column scenes text;
