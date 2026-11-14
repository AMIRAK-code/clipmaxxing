import { aiEnv, chatEngine, type ChatEngine } from "../ai-settings";
import { z } from "zod";
import type { Clip, Provider } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import { PLATFORM_LIMITS, captionLength, composeCaptionUntruncated, normalizeHashtag, truncateText } from "@klipz/publishers";
import { HttpError } from "../http";
import { getClip, getTranscript } from "../repo";

export const CaptionRequestSchema = z.object({
  clipId: z.string().min(1),
  providers: z.array(z.enum(PROVIDERS as [Provider, ...Provider[]])).min(1).max(6),
  tone: z.string().max(60).optional(),
});
export type CaptionRequest = z.infer<typeof CaptionRequestSchema>;

export interface CaptionSuggestion {
  caption: string;
  hashtags: string[];
  title?: string;
}

export interface CaptionResponse {
  generator: CaptionGenerator;
  model?: string;
  /** Why Claude was not used / partly not used (never contains the API key). */
  note?: string;
  captions: Partial<Record<Provider, CaptionSuggestion>>;
}

/** The small slice of the Anthropic SDK used here, so tests can inject a fake. */
export type CaptionGenerator = "claude" | "gemini" | "openai" | "custom" | "ollama" | "heuristic";

export const GENERATOR_LABEL: Record<CaptionGenerator, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  custom: "the custom AI",
  ollama: "the local model",
  heuristic: "the offline generator",
};

export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: { type: string; name?: string; input?: unknown; text?: string }[] }>;
  };
}

const TAGS: Record<Provider, number> = { tiktok: 5, instagram: 5, youtube: 3, facebook: 3, x: 2, linkedin: 3 };
const MAX_TAGS: Record<Provider, number> = { tiktok: 6, instagram: 6, youtube: 5, facebook: 4, x: 3, linkedin: 4 };

const STOP = new Set(
  "about above after again also always because been before being between both could does doing down during each even every from further have having here into just like make many more most much must only other over really same should since some such than that their them then there these they this those through very want were what when where which while will with would your you and are but for not the was can get got its let our out say she him her his how new now one own too use way yes".split(" "),
);

export interface ClipContext {
  title: string;
  hook: string;
  reason: string;
  keywords: string[];
  text: string;
}

export function clipContext(clip: Clip): ClipContext {
  const t = getTranscript(clip.source_video_id);
  const text = (t?.words ?? [])
    .filter((w) => w.e > clip.start_sec && w.s < clip.end_sec)
    .map((w) => w.w)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sb = clip.score_breakdown as unknown as { keywords?: unknown } | null;
  const fromScore = Array.isArray(sb?.keywords) ? sb!.keywords.filter((k): k is string => typeof k === "string") : [];
  return {
    title: clip.title?.trim() ?? "",
    hook: clip.hook?.trim() ?? "",
    reason: clip.reason?.trim() ?? "",
    keywords: fromScore.length ? fromScore : topWords(`${clip.title ?? ""} ${text}`, 8),
    text,
  };
}

export function topWords(text: string, n: number): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}']{3,}/gu) ?? []) {
    const word = w.replace(/'s$/, "");
    if (STOP.has(word) || word.length < 4) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, n).map(([w]) => w);
}

const sentence = (s: string): string => s.replace(/\s+/g, " ").trim();
const firstSentence = (text: string): string => sentence(text.split(/(?<=[.!?])\s+/)[0] ?? "");
const cap1 = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function heuristicCaption(provider: Provider, ctx: ClipContext, tone?: string): CaptionSuggestion {
  const hookRaw = ctx.hook || ctx.title || firstSentence(ctx.text) || "Watch this";
  const hook = cap1(sentence(hookRaw).replace(/[.]+$/, ""));
  const detail = ctx.reason || firstSentence(ctx.text) || "";
  const casual = /casual|fun|friend|punchy|funny/i.test(tone ?? "");
  const tags = ctx.keywords.map((k) => normalizeHashtag(k)).filter((t): t is string => Boolean(t)).slice(0, TAGS[provider]).map((t) => `#${t}`);
  let out: CaptionSuggestion;
  switch (provider) {
    case "youtube":
      out = {
        title: hook,
        caption: [detail && detail !== hook ? cap1(detail) : "", casual ? "Like and subscribe for more!" : "Subscribe for more clips like this."].filter(Boolean).join("\n\n"),
        hashtags: tags,
      };
      break;
    case "x":
      out = { caption: hook, hashtags: tags };
      break;
    case "linkedin":
      out = {
        caption: [hook + ".", detail && detail !== hook ? `Key takeaway: ${cap1(detail)}` : "", "What is your take? Share your thoughts below."].filter(Boolean).join("\n\n"),
        hashtags: tags,
      };
      break;
    case "facebook":
      out = { caption: [hook, detail && detail !== hook ? cap1(detail) : ""].filter(Boolean).join("\n\n"), hashtags: tags };
      break;
    default:
      // tiktok / instagram: hook first, short, call to action.
      out = { caption: [hook, casual ? "Wait for it." : "Follow for more."].join("\n"), hashtags: tags };
  }
  return clampSuggestion(provider, out);
}

/** Enforce platform limits: title, tag count/format, and caption + tags within the caption limit. */
export function clampSuggestion(provider: Provider, s: CaptionSuggestion): CaptionSuggestion {
  const limits = PLATFORM_LIMITS[provider];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of s.hashtags ?? []) {
    const t = normalizeHashtag(String(raw));
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    tags.push(`#${t}`);
    if (tags.length >= MAX_TAGS[provider]) break;
  }
  let caption = (s.caption ?? "").trim();
  let title = s.title?.trim();
  if (provider === "youtube" || provider === "facebook" || provider === "linkedin") {
    const max = (limits.titleMax ?? 100) - (provider === "youtube" ? " #Shorts".length : 0);
    title = title ? truncateText(title.replace(/[<>]/g, ""), max) : undefined;
  } else title = undefined;

  const measure = (c: string, t: string[]) => captionLength(provider, composeCaptionUntruncated(provider, { caption: c, hashtags: t, options: {} }));
  while (tags.length > 0 && measure(caption, tags) > limits.captionMax && measure("", tags) > limits.captionMax * 0.5) tags.pop();
  if (measure(caption, tags) > limits.captionMax) {
    // Cut the caption so that caption + required tags fit.
    const tagLen = measure("", tags) + 2;
    caption = truncateText(caption, Math.max(0, limits.captionMax - tagLen), (x) => captionLength(provider, x));
  }
  while (tags.length > 0 && measure(caption, tags) > limits.captionMax) tags.pop();
  if (measure(caption, tags) > limits.captionMax) caption = truncateText(caption, limits.captionMax, (x) => captionLength(provider, x));
  return { caption, hashtags: tags, ...(title ? { title } : {}) };
}

const SuggestionSchema = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()).default([]),
  title: z.string().optional(),
});

const GUIDE: Record<Provider, string> = {
  youtube: "YouTube Shorts: title <= 100 chars (hook), description with 1-2 sentences and a call to subscribe, 2-4 hashtags.",
  tiktok: "TikTok: hook-first, 1-2 short lines, casual, 3-6 hashtags, caption <= 2200 chars.",
  instagram: "Instagram Reels: hook-first, 1-3 short lines, 3-6 hashtags, caption <= 2200 chars.",
  facebook: "Facebook Reel: friendly, 1-2 sentences, 1-3 hashtags.",
  x: "X: ONE post of <= 280 characters INCLUDING hashtags (put at most 2 hashtags in the hashtags array). Punchy.",
  linkedin: "LinkedIn: professional, insight-led, 2-4 short paragraphs or lines, 2-4 relevant hashtags, no clickbait.",
};

export interface CaptionDeps {
  client?: AnthropicLike;
  env?: Record<string, string | undefined>;
}

async function makeClient(env: Record<string, string | undefined>): Promise<AnthropicLike | undefined> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  return new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 }) as unknown as AnthropicLike;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

function parseJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) return JSON.parse(m[0]);
    throw new Error("the model did not return JSON");
  }
}

/**
 * The same `messages.create` shape the caption code uses for Claude, answered by any OpenAI-compatible
 * chat API (Gemini, OpenAI, a custom API, Ollama): the tool's schema goes into the prompt, the reply is
 * read as JSON and handed back as the tool call.
 */
export function openAiCompatClient(engine: ChatEngine, fetchImpl: typeof fetch = fetch): AnthropicLike {
  return {
    messages: {
      async create(params) {
        const tool = (params.tools as { name: string; input_schema: unknown }[])[0]!;
        const user = (params.messages as { content: string }[])[0]!.content;
        const base = {
          model: engine.model,
          messages: [
            { role: "system", content: `Answer with ONE JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(tool.input_schema)}` },
            { role: "user", content: user },
          ],
        };
        const call = (body: Record<string, unknown>) =>
          fetchImpl(`${engine.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(engine.apiKey ? { authorization: `Bearer ${engine.apiKey}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
        let res = await call({ ...base, response_format: { type: "json_object" } });
        if (res.status === 400) res = await call(base); // servers without JSON mode: the prompt still asks for JSON
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return { content: [{ type: "tool_use", name: tool.name, input: parseJsonObject(data.choices?.[0]?.message?.content ?? "") }] };
      },
    },
  };
}

export async function generateCaptions(req: CaptionRequest, deps: CaptionDeps = {}): Promise<CaptionResponse> {
  const env = deps.env ?? aiEnv();
  const clip = getClip(req.clipId) ?? (() => { throw new HttpError(404, "Clip not found"); })();
  const ctx = clipContext(clip);
  const providers = [...new Set(req.providers)];
  const heuristic = (): CaptionResponse["captions"] => Object.fromEntries(providers.map((p) => [p, heuristicCaption(p, ctx, req.tone)]));

  let client: AnthropicLike | undefined = deps.client;
  let generator: CaptionGenerator = "claude";
  let model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  // The engine chosen on the AI page writes the captions too (tests inject a client / env and skip this).
  const engine = !deps.client && !deps.env ? chatEngine() : null;
  if (engine) {
    client = openAiCompatClient(engine);
    generator = engine.kind;
    model = engine.model;
  }
  try {
    client ??= await makeClient(env);
  } catch (e) {
    return { generator: "heuristic", note: `Claude client unavailable: ${(e as Error).message}`.slice(0, 200), captions: heuristic() };
  }
  if (!client) return { generator: "heuristic", captions: heuristic() };
  const who = GENERATOR_LABEL[generator];

  try {
    const props = Object.fromEntries(
      providers.map((p) => [
        p,
        {
          type: "object",
          properties: { caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, ...(p === "youtube" || p === "linkedin" || p === "facebook" ? { title: { type: "string" } } : {}) },
          required: ["caption", "hashtags"],
        },
      ]),
    );
    const prompt = [
      "Write social captions for a short vertical video clip. Return them by calling the tool.",
      `Tone: ${req.tone?.trim() || "natural, engaging"}.`,
      `Clip title: ${ctx.title || "(none)"}`,
      `Hook: ${ctx.hook || "(none)"}`,
      `Why it is good: ${ctx.reason || "(none)"}`,
      `Keywords: ${ctx.keywords.join(", ") || "(none)"}`,
      `Transcript of the clip:\n${ctx.text.slice(0, 6000) || "(not available)"}`,
      "Platform rules:",
      ...providers.map((p) => `- ${p}: ${GUIDE[p]}`),
      "Hashtags go in the hashtags array without the caption repeating them. Do not invent facts that are not in the transcript.",
    ].join("\n");
    const res = await client.messages.create({
      model,
      max_tokens: 2000,
      tools: [{ name: "submit_captions", description: "Submit one caption suggestion per platform", input_schema: { type: "object", properties: props, required: providers } }],
      tool_choice: { type: "tool", name: "submit_captions" },
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content.find((b) => b.type === "tool_use" && b.name === "submit_captions");
    if (!block || typeof block.input !== "object" || block.input === null) throw new Error("model returned no structured output");
    const input = block.input as Record<string, unknown>;
    const captions: CaptionResponse["captions"] = {};
    const missing: Provider[] = [];
    for (const p of providers) {
      const parsed = SuggestionSchema.safeParse(input[p]);
      if (parsed.success && parsed.data.caption.trim()) captions[p] = clampSuggestion(p, parsed.data);
      else {
        captions[p] = heuristicCaption(p, ctx, req.tone);
        missing.push(p);
      }
    }
    return { generator, model, ...(missing.length ? { note: `Fell back to the offline generator for: ${missing.join(", ")}` } : {}), captions };
  } catch (e) {
    console.warn(`[captions] ${generator} failed, using offline generator:`, (e as Error).message);
    const label = who.charAt(0).toUpperCase() + who.slice(1);
    return { generator: "heuristic", note: `${label} request failed (${(e as Error).message.slice(0, 120)}); used the offline generator`, captions: heuristic() };
  }
}

