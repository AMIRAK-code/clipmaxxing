import type { Job, Provider, Render } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import { getPublisher, type RenderAsset, type ValidationIssue } from "@klipz/publishers";
import { newId, rows, run, tx } from "./db";
import { HttpError } from "./http";
import { enqueueJob } from "./jobs";
import { storagePath } from "./paths";
import { getClip, getRender, rendersForClip } from "./repo";

export interface RenderOptions {
  denoise?: boolean;
}

export interface CreateRenderResult {
  render: Render;
  job: Job | null;
  /** true when an in-flight render of the same edit version was returned instead of a new one */
  reused: boolean;
}

/**
 * Queue a render of the clip's current edit version. If a queued/rendering
 * render of the same edit_version and options already exists it is returned
 * instead (the editor can be double-clicked safely).
 */
export function createRender(clipId: string, opts: RenderOptions = {}): CreateRenderResult {
  const options = { denoise: Boolean(opts.denoise) };
  const created = tx(() => {
    const clip = getClip(clipId);
    if (!clip) throw new HttpError(404, "Clip not found");
    const live = rendersForClip(clipId).find(
      (r) =>
        (r.status === "queued" || r.status === "rendering") &&
        r.edit_version === clip.edit_version &&
        Boolean((r as Render & { options?: RenderOptions }).options?.denoise) === options.denoise,
    );
    if (live) return { render: live, projectId: clip.project_id, reused: true, job: null as Job | null };
    const id = newId();
    run("insert into renders (id, clip_id, status, edit_version, options) values (?, ?, 'queued', ?, ?)", id, clipId, clip.edit_version, JSON.stringify(options));
    // Same transaction as the insert: there is never a queued render without its job (or the reverse).
    const job = enqueueJob("render", { render_id: id }, { projectId: clip.project_id, dedupeKey: `render:${id}` });
    return { render: getRender(id)!, projectId: clip.project_id, reused: false, job };
  });
  if (created.reused) {
    // Return the live job of the in-flight render too (idempotent; dedupe key returns the existing one).
    const job = enqueueJob("render", { render_id: created.render.id }, { projectId: created.projectId, dedupeKey: `render:${created.render.id}` });
    return { render: created.render, job, reused: true };
  }
  return { render: created.render, job: created.job, reused: false };
}

export interface PlatformCheck {
  provider: Provider;
  ok: boolean;
  /** blocking problems about the file itself (duration, size, aspect, fps, codec) */
  errors: string[];
  warnings: string[];
}

/** Issues about the missing caption / options / title are not the file's fault. */
const FILE_FIELDS = /^(render|video|duration|size|aspect|fps|codec|resolution|width|height|container|audio)/i;

export function filterFileIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => FILE_FIELDS.test(i.field) && i.code !== "asset_missing");
}

export function renderAssetOf(r: Render, filePath?: string): RenderAsset | null {
  if (r.status !== "ready" || !r.storage_key) return null;
  return {
    filePath: filePath ?? storagePath(r.storage_key),
    sizeBytes: r.size_bytes ?? 0,
    durationSec: r.duration_sec ?? 0,
    width: r.width ?? 1080,
    height: r.height ?? 1920,
    fps: r.fps ?? 30,
    videoCodec: r.video_codec ?? "h264",
    audioCodec: r.audio_codec ?? "aac",
    mimeType: "video/mp4",
  };
}

export function platformChecks(asset: RenderAsset, providers: Provider[] = PROVIDERS): PlatformCheck[] {
  return providers.map((provider) => {
    const issues = filterFileIssues(getPublisher(provider).validate(asset, { caption: "", hashtags: [], options: {} }));
    const errors = issues.filter((i) => i.severity === "error").map((i) => i.message);
    const warnings = issues.filter((i) => i.severity !== "error").map((i) => i.message);
    return { provider, ok: errors.length === 0, errors, warnings };
  });
}

export type RenderView = Render & { options: RenderOptions; platforms: PlatformCheck[] | null; outdated: boolean };

export function renderViews(clipId: string): RenderView[] {
  const clip = getClip(clipId);
  if (!clip) throw new HttpError(404, "Clip not found");
  return rendersForClip(clipId).map((r) => {
    const asset = renderAssetOf(r);
    return {
      ...(r as Render & { options: RenderOptions }),
      options: (r as Render & { options?: RenderOptions }).options ?? {},
      platforms: asset ? platformChecks(asset) : null,
      outdated: r.edit_version != null && r.edit_version !== clip.edit_version,
    };
  });
}

/** Newest render of every clip in a project (for the clip cards). */
export function latestRenderByClip(projectId: string): Record<string, Render> {
  const out: Record<string, Render> = {};
  const all = rows<Render>(
    "renders",
    "select r.* from renders r join clips c on c.id = r.clip_id where c.project_id = ? order by r.created_at desc",
    projectId,
  );
  for (const r of all) if (!out[r.clip_id]) out[r.clip_id] = r;
  return out;
}
