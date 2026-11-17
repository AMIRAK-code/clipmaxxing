import fs from "node:fs";
import path from "node:path";
import type { Project } from "@klipz/shared";
import type { PlanVideo } from "@/lib/gemini-plan";
import { run } from "./db";
import { HttpError } from "./http";
import { storagePath } from "./paths";
import { getProject, montageInputs } from "./repo";

/** Where Manual AI Mode puts the files for Gemini (storage key folder), as the worker writes them. */
export const manualDir = (projectId: string) => `projects/${projectId}/manual`;

/** The order files are listed in: transcript, the light videos, then the prompt. */
const rank = (name: string) => (name === "video_transcript.txt" ? 0 : name === "gemini_prompt.txt" ? 2 : 1);

export interface ManualFile {
  name: string;
  /** storage key, for /api/files */
  key: string;
  sizeBytes: number;
}

export function manualFiles(projectId: string): { folder: string; files: ManualFile[] } {
  const key = manualDir(projectId);
  const folder = storagePath(key);
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder).filter((n) => !n.includes(".part.") && (n.endsWith(".txt") || n.endsWith(".mp4")));
  } catch {
    names = [];
  }
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
  return {
    folder,
    files: names.map((name) => ({ name, key: `${key}/${name}`, sizeBytes: fs.statSync(path.join(folder, name)).size })),
  };
}

/** The project's videos as the JSON refers to them: numbered like the transcript (import order). */
export function planVideos(projectId: string): PlanVideo[] {
  return montageInputs(projectId)
    .filter((s) => s.status !== "failed" && s.status !== "uploading")
    .map((s, i) => ({ id: s.id, name: s.filename ?? `Video ${i + 1}`, durationSec: s.duration_sec ?? 0 }));
}

export function setEngine(project: Project, engine: "builtin" | "manual"): void {
  run("update projects set options = ? where id = ?", JSON.stringify({ ...project.options, engine }), project.id);
}

export function requireProject(id: string): Project {
  const p = getProject(id);
  if (!p) throw new HttpError(404, "Project not found");
  return p;
}
