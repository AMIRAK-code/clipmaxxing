// Core data model shared by the web app, the Remotion compositions and
// (mirrored in Python) the worker. All times are seconds unless suffixed.

export type Provider = "youtube" | "tiktok" | "instagram" | "facebook" | "x" | "linkedin";
export const PROVIDERS: Provider[] = ["youtube", "tiktok", "instagram", "facebook", "x", "linkedin"];

export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;

// ── transcript ──────────────────────────────────────────────────────────
export interface Word {
  w: string;
  s: number;
  e: number;
  p?: number;
  spk?: string;
}
export interface Sentence {
  s: number;
  e: number;
  text: string;
  spk?: string;
}

// ── reframing ───────────────────────────────────────────────────────────
/** Normalised (0..1) centre of the subject in the source frame at source time t. */
export interface CropKey {
  t: number;
  cx: number;
  cy: number;
}
export type CropLayout = "crop" | "split" | "letterbox";
/**
 * One shot. Keys are interpolated inside a segment and never across segments,
 * which is what produces a hard cut on a shot change.
 */
export interface CropSegment {
  start: number;
  end: number;
  layout: CropLayout;
  keys: CropKey[];
  /** second subject (bottom half) for the stacked `split` layout */
  keys2?: CropKey[];
}
export interface CropTrack {
  version: 1;
  srcW: number;
  srcH: number;
  segments: CropSegment[];
}

// ── captions ────────────────────────────────────────────────────────────
export type CaptionAnim = "none" | "pop" | "bounce" | "fade" | "slide-up";
export type HighlightMode = "none" | "color" | "box" | "karaoke" | "scale";

export interface CaptionStyle {
  id: string;
  name: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number; // px at 1080 wide
  uppercase: boolean;
  letterSpacing: number; // em
  lineHeight: number;
  color: string;
  /** colour of the word being spoken */
  activeColor: string;
  /** colour for LLM/user emphasised keywords */
  emphasisColor: string;
  highlight: HighlightMode;
  /** background of the active word when highlight = "box" */
  boxColor: string;
  boxRadius: number;
  strokeColor: string;
  strokeWidth: number;
  shadow: string; // CSS text-shadow or "none"
  /** background behind the whole page of words, or "transparent" */
  pageBackground: string;
  pagePadding: number;
  anim: CaptionAnim;
  wordsPerPage: 1 | 2 | 3 | 4;
  maxCharsPerLine: number;
  /** vertical centre of the caption block, 0 (top) .. 1 (bottom) */
  position: number;
  emoji: boolean;
}

export interface CaptionWord {
  id: string;
  /** display text – editing this never changes timing */
  w: string;
  /** source-video times */
  s: number;
  e: number;
  spk?: string;
  emph?: boolean;
  emoji?: string;
  hidden?: boolean;
}

// ── editor state ────────────────────────────────────────────────────────
export type TransitionType = "none" | "fade" | "slide" | "zoom" | "flash";

/** A piece of the source placed on the main video track. Output order = array order. */
export interface VideoPiece {
  id: string;
  srcStart: number;
  srcEnd: number;
  transitionIn?: { type: TransitionType; durationSec: number };
}

export interface BrollItem {
  id: string;
  /** storage key or absolute URL of the b-roll video/image */
  src: string;
  kind: "video" | "image";
  /** output-timeline placement */
  start: number;
  duration: number;
  srcOffset: number;
  volume: number;
  /** lower the main audio while this plays */
  duck: boolean;
  fit: "cover" | "pip";
}

export interface AudioItem {
  id: string;
  src: string;
  kind: "music" | "voiceover" | "sfx";
  start: number;
  duration: number;
  srcOffset: number;
  volume: number;
  duck: boolean;
}

export interface TextItem {
  id: string;
  text: string;
  start: number;
  duration: number;
  /** normalised centre position */
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  background: string;
  anim: CaptionAnim;
}

export interface ZoomKey {
  id: string;
  /** output time */
  t: number;
  scale: number;
  ease: "linear" | "ease" | "snap";
}

export type LookId = "none" | "warm" | "cool" | "cinematic" | "bw" | "vivid" | "fade";

export interface EditState {
  version: 1;
  video: VideoPiece[];
  captions: {
    enabled: boolean;
    styleId: string;
    overrides: Partial<CaptionStyle>;
    words: CaptionWord[];
  };
  broll: BrollItem[];
  audio: AudioItem[];
  texts: TextItem[];
  zooms: ZoomKey[];
  look: LookId;
  hook: { enabled: boolean; text: string; durationSec: number };
  progressBar: { enabled: boolean; color: string; position: "top" | "bottom"; height: number };
  volume: number;
  /** main-audio gain while a ducking item plays */
  duckLevel: number;
  safeZone: Provider | "none";
}

// ── rows (JSON columns already parsed) ──────────────────────────────────
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead" | "cancelled";
export type JobType =
  | "import_youtube"
  | "ingest"
  | "transcribe"
  | "analyze"
  | "reframe"
  | "render"
  | "autoclip"
  | "voiceover"
  | "cleanup";

export interface Job {
  id: string;
  project_id: string | null;
  type: JobType;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: JobStatus;
  progress: number;
  stage: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface SourceVideo {
  id: string;
  project_id: string;
  origin: "upload" | "youtube";
  source_url: string | null;
  storage_key: string | null;
  audio_key: string | null;
  filename: string | null;
  size_bytes: number | null;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: "pending" | "uploading" | "importing" | "ready" | "failed" | "deleted";
  error: string | null;
  scene_cuts: number[] | null;
  expires_at: string;
  created_at: string;
}

export interface ScoreBreakdown {
  hook: number;
  context: number;
  emotion: number;
  payoff: number;
  llm: number;
  energy: number;
  cuts: number;
  scorer: string;
}

export interface Clip {
  id: string;
  project_id: string;
  source_video_id: string;
  start_sec: number;
  end_sec: number;
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  title: string | null;
  hook: string | null;
  reason: string | null;
  status: "candidate" | "kept" | "discarded";
  crop_track: CropTrack | null;
  caption_style_id: string | null;
  edit_state: EditState | null;
  edit_version: number;
  created_at: string;
  updated_at: string;
}

export interface Render {
  id: string;
  clip_id: string;
  status: "queued" | "rendering" | "ready" | "failed";
  storage_key: string | null;
  cover_key: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_sec: number | null;
  size_bytes: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  lufs: number | null;
  edit_version: number | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export type PostStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "publishing"
  | "processing"
  | "published"
  | "failed"
  | "cancelled";

export interface Post {
  id: string;
  batch_id: string;
  clip_id: string;
  render_id: string | null;
  social_account_id: string | null;
  provider: Provider;
  caption: string;
  hashtags: string[];
  title: string | null;
  options: Record<string, unknown>;
  cover_timestamp_ms: number | null;
  scheduled_at: string | null;
  timezone: string | null;
  status: PostStatus;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Public view of a connected account – never includes tokens. */
export interface SocialAccount {
  id: string;
  provider: Provider;
  external_account_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  scopes: string[];
  token_expires_at: string | null;
  status: "active" | "needs_reconnect" | "revoked";
  via_aggregator: boolean;
  meta: Record<string, unknown>;
  last_error: string | null;
}
