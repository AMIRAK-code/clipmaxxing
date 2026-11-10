import type { Clip, Job, Post, Project, Render, SocialAccount, SourceVideo, Word, Sentence } from "@klipz/shared";
import { all, get, newId, row, rows, run } from "./db";

export interface ProjectSummary extends Project {
  source: SourceVideo | null;
  clip_count: number;
  top_score: number | null;
}

export interface Transcript {
  id: string;
  source_video_id: string;
  language: string | null;
  words: Word[];
  segments: Sentence[];
  speakers: string[];
  model: string | null;
}

export function listProjects(): ProjectSummary[] {
  const projects = all<Project>("select * from projects order by created_at desc");
  return projects.map((p) => {
    const source = row<SourceVideo>("source_videos", "select * from source_videos where project_id = ? order by created_at limit 1", p.id) ?? null;
    const agg = get<{ n: number; top: number | null }>(
      "select count(*) as n, max(score) as top from clips where project_id = ? and status <> 'discarded'",
      p.id,
    );
    return { ...p, source, clip_count: agg?.n ?? 0, top_score: agg?.top ?? null };
  });
}

export const getProject = (id: string) => get<Project>("select * from projects where id = ?", id);

export const getSource = (id: string) => row<SourceVideo>("source_videos", "select * from source_videos where id = ?", id);

export const sourceForProject = (projectId: string) =>
  row<SourceVideo>("source_videos", "select * from source_videos where project_id = ? order by created_at limit 1", projectId);

export const getTranscript = (sourceVideoId: string) =>
  row<Transcript>("transcripts", "select * from transcripts where source_video_id = ?", sourceVideoId);

export const clipsForProject = (projectId: string) =>
  rows<Clip>("clips", "select * from clips where project_id = ? order by score desc, start_sec", projectId);

export const getClip = (id: string) => row<Clip>("clips", "select * from clips where id = ?", id);

export const rendersForClip = (clipId: string) =>
  rows<Render>("renders", "select * from renders where clip_id = ? order by created_at desc", clipId);

export const getRender = (id: string) => row<Render>("renders", "select * from renders where id = ?", id);

export const latestReadyRender = (clipId: string) =>
  row<Render>("renders", "select * from renders where clip_id = ? and status = 'ready' order by created_at desc limit 1", clipId);

export const activeJobs = (projectId: string) =>
  rows<Job>("jobs", "select * from jobs where project_id = ? and status in ('queued','running') order by created_at", projectId);

export function createProject(title: string): Project {
  const id = newId();
  run("insert into projects (id, title) values (?, ?)", id, title.slice(0, 160) || "Untitled");
  return getProject(id)!;
}

export function createSource(projectId: string, v: { origin: "upload" | "youtube"; sourceUrl?: string; filename?: string; sizeBytes?: number; status: SourceVideo["status"] }): SourceVideo {
  const id = newId();
  run(
    "insert into source_videos (id, project_id, origin, source_url, filename, size_bytes, status) values (?, ?, ?, ?, ?, ?, ?)",
    id,
    projectId,
    v.origin,
    v.sourceUrl ?? null,
    v.filename ?? null,
    v.sizeBytes ?? null,
    v.status,
  );
  return getSource(id)!;
}

const ACCOUNT_PUBLIC =
  "id, provider, external_account_id, display_name, username, avatar_url, scopes, token_expires_at, status, via_aggregator, meta, last_error";

function toAccount(r: SocialAccount & { via_aggregator: unknown }): SocialAccount {
  return { ...r, via_aggregator: Boolean(r.via_aggregator) };
}

/** Accounts without token columns – safe to send to the browser. */
export const listAccounts = (): SocialAccount[] =>
  rows<SocialAccount>("social_accounts", `select ${ACCOUNT_PUBLIC} from social_accounts where status <> 'revoked' order by provider, display_name`).map(toAccount);

export const getAccount = (id: string): SocialAccount | undefined => {
  const r = row<SocialAccount>("social_accounts", `select ${ACCOUNT_PUBLIC} from social_accounts where id = ?`, id);
  return r ? toAccount(r) : undefined;
};

export const getPost = (id: string) => row<Post>("posts", "select * from posts where id = ?", id);

export const listPosts = (limit = 200) => rows<Post>("posts", "select * from posts order by created_at desc limit ?", limit);

export const postsForClip = (clipId: string) => rows<Post>("posts", "select * from posts where clip_id = ? order by created_at desc", clipId);
