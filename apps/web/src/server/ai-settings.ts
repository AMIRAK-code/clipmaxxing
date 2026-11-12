import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decryptToken, encryptToken } from "@klipz/publishers";
import { HttpError } from "./http";
import { dataDir } from "./paths";
import { encryptionKey } from "./social/config";

// AI settings entered on the AI tab. Stored in <data dir>/ai-settings.json, which the Python worker
// re-reads for every job (apps/worker/klipz_worker/ai_settings.py). API keys are sealed with the same
// AES-256-GCM key as the social tokens and are never sent back to the browser.
// Real environment variables / .env.local win over everything here.

type Env = Record<string, string | undefined>;

export const AI_PROVIDERS = ["auto", "anthropic", "openai", "ollama", "none"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

interface AiFile {
  provider?: AiProvider;
  smartEdit?: boolean;
  anthropic?: { keyEnc?: string; model?: string };
  openai?: { keyEnc?: string; baseUrl?: string; model?: string };
  ollama?: { url?: string; model?: string };
  elevenlabs?: { keyEnc?: string };
}

export const DEFAULTS = {
  anthropicModel: "claude-opus-5-5",
  openaiBaseUrl: "https://api.openai.com/v1",
  ollamaUrl: "http://127.0.0.1:11434",
};

const FILE = "ai-settings.json";
const file = (dir = dataDir()): string => path.join(dir, FILE);

function read(dir?: string): AiFile {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file(dir), "utf8"));
    return raw && typeof raw === "object" ? (raw as AiFile) : {};
  } catch {
    return {};
  }
}

function write(data: AiFile, dir?: string): void {
  const f = file(dir);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function unseal(enc: string | undefined, key?: string): string {
  if (!enc) return "";
  try {
    return decryptToken(enc, key ?? encryptionKey());
  } catch {
    return "";
  }
}

/** What the browser may see: no keys, only whether one is saved and where each value comes from. */
export interface AiSettingsView {
  provider: AiProvider;
  smartEdit: boolean;
  /** which engine scores clips right now */
  active: "anthropic" | "openai" | "ollama" | "smart";
  anthropic: { keySet: boolean; keyFromEnv: boolean; model: string };
  openai: { keySet: boolean; keyFromEnv: boolean; baseUrl: string; model: string };
  ollama: { url: string; model: string };
  elevenlabs: { keySet: boolean; keyFromEnv: boolean };
  /** settings pinned by environment variables (the form cannot change these) */
  envLocked: string[];
}

/** Everything resolved (env first, then the file, then defaults). Server-side only: contains keys. */
export function resolveAi(env: Env = process.env, opts: { dir?: string; key?: string } = {}) {
  const f = read(opts.dir);
  const e = (name: string): string => env[name]?.trim() ?? "";
  const provider = (AI_PROVIDERS as readonly string[]).includes(e("LLM_PROVIDER").toLowerCase())
    ? (e("LLM_PROVIDER").toLowerCase() as AiProvider)
    : (f.provider && (AI_PROVIDERS as readonly string[]).includes(f.provider) ? f.provider : "auto");
  const smartEnv = e("KLIPZ_SMART_EDIT").toLowerCase();
  return {
    provider,
    smartEdit: smartEnv ? !["0", "false", "no", "off"].includes(smartEnv) : f.smartEdit !== false,
    anthropicKey: e("ANTHROPIC_API_KEY") || unseal(f.anthropic?.keyEnc, opts.key),
    anthropicModel: e("ANTHROPIC_MODEL") || f.anthropic?.model?.trim() || DEFAULTS.anthropicModel,
    openaiKey: e("OPENAI_API_KEY") || unseal(f.openai?.keyEnc, opts.key),
    openaiBaseUrl: (e("OPENAI_BASE_URL") || f.openai?.baseUrl?.trim() || DEFAULTS.openaiBaseUrl).replace(/\/+$/, ""),
    openaiModel: e("OPENAI_MODEL") || f.openai?.model?.trim() || "",
    ollamaUrl: (e("OLLAMA_URL") || f.ollama?.url?.trim() || DEFAULTS.ollamaUrl).replace(/\/+$/, ""),
    ollamaModel: e("OLLAMA_MODEL") || f.ollama?.model?.trim() || "",
    elevenlabsKey: e("ELEVENLABS_API_KEY") || unseal(f.elevenlabs?.keyEnc, opts.key),
  };
}

/** Mirrors pick_scorer() in apps/worker/klipz_worker/steps/score.py. */
export function activeEngine(r: ReturnType<typeof resolveAi>): AiSettingsView["active"] {
  const p = r.provider;
  if ((p === "anthropic" || p === "auto") && r.anthropicKey) return "anthropic";
  if ((p === "openai" || p === "auto") && r.openaiModel && (r.openaiKey || p === "openai" || !r.openaiBaseUrl.includes("api.openai.com"))) return "openai";
  if ((p === "ollama" || p === "auto") && r.ollamaModel) return "ollama";
  return "smart";
}

export function aiSettingsView(env: Env = process.env, opts: { dir?: string; key?: string } = {}): AiSettingsView {
  const r = resolveAi(env, opts);
  const set = (n: string): boolean => Boolean(env[n]?.trim());
  const locks = ["LLM_PROVIDER", "KLIPZ_SMART_EDIT", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OLLAMA_URL", "OLLAMA_MODEL", "ELEVENLABS_API_KEY"];
  return {
    provider: r.provider,
    smartEdit: r.smartEdit,
    active: activeEngine(r),
    anthropic: { keySet: Boolean(r.anthropicKey), keyFromEnv: set("ANTHROPIC_API_KEY"), model: r.anthropicModel },
    openai: { keySet: Boolean(r.openaiKey), keyFromEnv: set("OPENAI_API_KEY"), baseUrl: r.openaiBaseUrl, model: r.openaiModel },
    ollama: { url: r.ollamaUrl, model: r.ollamaModel },
    elevenlabs: { keySet: Boolean(r.elevenlabsKey), keyFromEnv: set("ELEVENLABS_API_KEY") },
    envLocked: locks.filter(set),
  };
}

/** A key field: a string saves it, null removes it, undefined keeps what is stored. */
export interface AiSettingsPatch {
  provider?: AiProvider;
  smartEdit?: boolean;
  anthropic?: { apiKey?: string | null; model?: string };
  openai?: { apiKey?: string | null; baseUrl?: string; model?: string };
  ollama?: { url?: string; model?: string };
  elevenlabs?: { apiKey?: string | null };
}

export function saveAiSettings(patch: AiSettingsPatch, opts: { dir?: string; key?: string } = {}): void {
  const f = read(opts.dir);
  const seal = (v: string): string => encryptToken(v.trim(), opts.key ?? encryptionKey());
  const applyKey = (section: { keyEnc?: string }, v: string | null | undefined): void => {
    if (v === null) delete section.keyEnc;
    else if (typeof v === "string" && v.trim()) section.keyEnc = seal(v);
  };
  if (patch.provider) f.provider = patch.provider;
  if (typeof patch.smartEdit === "boolean") f.smartEdit = patch.smartEdit;
  if (patch.anthropic) {
    f.anthropic ??= {};
    applyKey(f.anthropic, patch.anthropic.apiKey);
    if (patch.anthropic.model !== undefined) f.anthropic.model = patch.anthropic.model.trim();
  }
  if (patch.openai) {
    f.openai ??= {};
    applyKey(f.openai, patch.openai.apiKey);
    if (patch.openai.baseUrl !== undefined) f.openai.baseUrl = patch.openai.baseUrl.trim();
    if (patch.openai.model !== undefined) f.openai.model = patch.openai.model.trim();
  }
  if (patch.ollama) {
    f.ollama ??= {};
    if (patch.ollama.url !== undefined) f.ollama.url = patch.ollama.url.trim();
    if (patch.ollama.model !== undefined) f.ollama.model = patch.ollama.model.trim();
  }
  if (patch.elevenlabs) {
    f.elevenlabs ??= {};
    applyKey(f.elevenlabs, patch.elevenlabs.apiKey);
  }
  write(f, opts.dir);
}

/** process.env plus the saved Anthropic key/model, for code that reads ANTHROPIC_* (AI captions). */
export function aiEnv(env: Env = process.env): Env {
  const r = resolveAi(env);
  const out: Env = { ...env };
  if (!env.ANTHROPIC_API_KEY?.trim() && r.anthropicKey && r.provider !== "none") out.ANTHROPIC_API_KEY = r.anthropicKey;
  if (!env.ANTHROPIC_MODEL?.trim()) out.ANTHROPIC_MODEL = r.anthropicModel;
  return out;
}

// ── connection tests / model lists ───────────────────────────────────────

export interface AiTestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

const ids = (body: unknown, listKey: string, idKey: string): string[] => {
  const list = (body as Record<string, unknown> | null)?.[listKey];
  return Array.isArray(list) ? list.map((m) => String((m as Record<string, unknown>)[idKey] ?? "")).filter(Boolean).sort() : [];
};

export async function testAi(which: "anthropic" | "openai" | "ollama", env: Env = process.env): Promise<AiTestResult> {
  const r = resolveAi(env);
  try {
    if (which === "anthropic") {
      if (!r.anthropicKey) return { ok: false, message: "No Anthropic API key saved." };
      const { status, body } = await getJson("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": r.anthropicKey, "anthropic-version": "2023-06-01" });
      if (status === 401 || status === 403) return { ok: false, message: "Anthropic rejected the API key." };
      if (status !== 200) return { ok: false, message: `Anthropic answered HTTP ${status}.` };
      const models = ids(body, "data", "id");
      return { ok: true, message: models.includes(r.anthropicModel) || models.length === 0 ? "Key works." : `Key works, but the model "${r.anthropicModel}" is not in your account's model list.`, models };
    }
    if (which === "openai") {
      const { status, body } = await getJson(`${r.openaiBaseUrl}/models`, r.openaiKey ? { authorization: `Bearer ${r.openaiKey}` } : {});
      if (status === 401 || status === 403) return { ok: false, message: "The server rejected the API key." };
      if (status !== 200) return { ok: false, message: `${r.openaiBaseUrl} answered HTTP ${status}.` };
      const models = ids(body, "data", "id");
      return { ok: true, message: `Connected: ${models.length} model${models.length === 1 ? "" : "s"} available.`, models };
    }
    const { status, body } = await getJson(`${r.ollamaUrl}/api/tags`, {}, 4000);
    if (status !== 200) return { ok: false, message: `Ollama answered HTTP ${status}.` };
    const models = ids(body, "models", "name");
    return { ok: true, message: models.length ? `Ollama is running with ${models.length} model${models.length === 1 ? "" : "s"}.` : "Ollama is running but has no models yet. Import a GGUF file below, or run `ollama pull <model>`.", models };
  } catch (e) {
    const what = which === "ollama" ? `Ollama is not reachable at ${r.ollamaUrl}. Install it from ollama.com and make sure it is running.` : which === "openai" ? `Could not reach ${r.openaiBaseUrl}.` : "Could not reach api.anthropic.com.";
    return { ok: false, message: `${what} (${e instanceof Error ? e.name : "error"})` };
  }
}

// ── import a local GGUF model into Ollama ────────────────────────────────

export function findOllama(env: Env = process.env): string | null {
  const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (process.platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Programs", "Ollama"));
    if (env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, "Ollama"));
  }
  for (const d of dirs) {
    const p = path.join(d.replace(/^"|"$/g, ""), exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export const MODEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** `ollama create <name>` from a .gguf file on this PC. Resolves with the model name Ollama now lists. */
export async function importGguf(filePath: string, name: string, env: Env = process.env): Promise<{ model: string; log: string }> {
  const src = path.resolve(filePath.trim().replace(/^"|"$/g, ""));
  if (!/\.gguf$/i.test(src)) throw new HttpError(400, "Choose a .gguf model file");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new HttpError(400, `File not found: ${src}`);
  }
  if (!stat.isFile()) throw new HttpError(400, "That path is not a file");
  if (!MODEL_NAME_RE.test(name)) throw new HttpError(400, "Model name: lowercase letters, digits, dot, dash or underscore");
  const ollama = findOllama(env);
  if (!ollama) throw new HttpError(400, "Ollama is not installed. Get it from https://ollama.com/download, start it, then import again.");

  // The Modelfile only names the file; quotes cannot occur in a Windows path, on other systems refuse them.
  if (src.includes('"') || src.includes("\n")) throw new HttpError(400, "Unsupported characters in the file path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-model-"));
  const modelfile = path.join(dir, "Modelfile");
  fs.writeFileSync(modelfile, `FROM "${src}"\n`);
  try {
    const log = await new Promise<string>((resolve, reject) => {
      execFile(ollama, ["create", name, "-f", modelfile], { timeout: 60 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...env, OLLAMA_HOST: resolveAi(env).ollamaUrl } as unknown as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
        if (err) reject(new HttpError(502, `ollama create failed: ${out.split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || err.message}`));
        else resolve(out);
      });
    });
    return { model: name, log: log.split(/\r?\n/).filter(Boolean).slice(-3).join("\n") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
