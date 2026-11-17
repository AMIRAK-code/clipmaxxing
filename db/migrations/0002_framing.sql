-- How clips of this video are made vertical:
--   speaker  follow the talking person (face tracking)
--   center   fill the screen with the middle of the picture (gameplay, screen recordings)
--   fit      show the whole picture over a blurred copy of itself
alter table source_videos add column framing text not null default 'speaker';
