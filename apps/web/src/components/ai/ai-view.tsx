"use client";

import { Bot, CheckCircle2, Cpu, FolderInput, KeyRound, Loader2, PlugZap, Sparkles, Wand2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Badge, Card, Input, Label, Select } from "@/components/ui/primitives";
import { api, cn } from "@/lib/utils";
import type { AiProvider, AiSettingsPatch, AiSettingsView, AiTestResult } from "@/server/ai-settings";

const ENGINE_LABEL: Record<AiSettingsView["active"], string> = {
  smart: "Smart Edit engine (built in, no AI model)",
  anthropic: "Claude (Anthropic API)",
  gemini: "Gemini (Google AI)",
  openai: "OpenAI API",
  custom: "Custom API",
  ollama: "Local model (Ollama)",
};

/** Ready-made addresses for the Custom API card. Any server that speaks the OpenAI chat API works. */
const CUSTOM_PRESETS: { label: string; url: string }[] = [
  { label: "OpenRouter (hundreds of models)", url: "https://openrouter.ai/api/v1" },
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
  { label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { label: "Mistral", url: "https://api.mistral.ai/v1" },
  { label: "xAI (Grok)", url: "https://api.x.ai/v1" },
  { label: "Together AI", url: "https://api.together.xyz/v1" },
  { label: "LM Studio (this PC)", url: "http://127.0.0.1:1234/v1" },
  { label: "llama.cpp server (this PC)", url: "http://127.0.0.1:8080/v1" },
];

const CHOICES: { id: AiProvider; title: string; text: string }[] = [
  { id: "auto", title: "Automatic", text: "Use an AI model if one is set up below, otherwise the built-in Smart Edit engine." },
  { id: "none", title: "Smart Edit only", text: "Never call an AI model. Everything stays on this PC, free and offline." },
  { id: "anthropic", title: "Claude", text: "Anthropic API key." },
  { id: "gemini", title: "Gemini", text: "Google AI Studio API key (has a free tier)." },
  { id: "openai", title: "OpenAI", text: "OpenAI API key and model." },
  { id: "custom", title: "Custom API", text: "Any other model: OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio ..." },
  { id: "ollama", title: "Local model", text: "A model running on this PC through Ollama (or an imported GGUF file)." },
];

type Test = { busy: boolean; result?: AiTestResult };

export function AiView() {
  const [s, setS] = useState<AiSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const { toast, node } = useToast();

  // form fields (keys are write-only: empty means "keep what is saved")
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiModel, setGeminiModel] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customBase, setCustomBase] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiBase, setOpenaiBase] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [elevenKey, setElevenKey] = useState("");
  const [ggufPath, setGgufPath] = useState("");
  const [ggufName, setGgufName] = useState("");

  const apply = useCallback((v: AiSettingsView) => {
    setS(v);
    setAnthropicModel(v.anthropic.model);
    setGeminiModel(v.gemini.model);
    setCustomBase(v.custom.baseUrl);
    setCustomModel(v.custom.model);
    setOpenaiBase(v.openai.baseUrl);
    setOpenaiModel(v.openai.model);
    setOllamaUrl(v.ollama.url);
    setOllamaModel(v.ollama.model);
  }, []);

  useEffect(() => {
    api<AiSettingsView>("/api/ai-settings").then(apply, (e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load AI settings"));
  }, [apply]);

  const save = async (tag: string, patch: AiSettingsPatch, okMessage: string): Promise<boolean> => {
    setSaving(tag);
    try {
      apply(await api<AiSettingsView>("/api/ai-settings", { method: "PUT", json: patch }));
      toast("success", okMessage);
      return true;
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      setSaving(null);
    }
  };

  const test = async (which: "anthropic" | "gemini" | "openai" | "custom" | "ollama") => {
    setTests((t) => ({ ...t, [which]: { busy: true } }));
    try {
      const result = await api<AiTestResult>("/api/ai-settings/test", { method: "POST", json: { which } });
      setTests((t) => ({ ...t, [which]: { busy: false, result } }));
      // no model chosen yet: pre-select the one the server suggests (saved when the person presses Save)
      if (which === "gemini" && result.ok && result.suggested) setGeminiModel((m) => m || result.suggested!);
    } catch (e) {
      setTests((t) => ({ ...t, [which]: { busy: false, result: { ok: false, message: e instanceof Error ? e.message : "Test failed" } } }));
    }
  };

  const importModel = async () => {
    setSaving("import");
    try {
      const out = await api<{ model: string; settings: AiSettingsView }>("/api/ai-settings/import-model", { method: "POST", json: { path: ggufPath, name: ggufName } });
      apply(out.settings);
      setGgufPath("");
      toast("success", `Imported "${out.model}" and selected it as the local model.`);
      void test("ollama");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Import failed");
    } finally {
      setSaving(null);
    }
  };

  if (loadError) return <p role="alert" className="m-6 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{loadError}</p>;
  if (!s) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const locked = (name: string) => s.envLocked.includes(name);
  const ollamaModels = tests.ollama?.result?.models ?? [];
  const openaiModels = tests.openai?.result?.models ?? [];
  const geminiModels = tests.gemini?.result?.models ?? [];
  const customModels = tests.custom?.result?.models ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight">AI</h1>
        <p className="text-sm text-muted">Choose what finds your clips and writes your captions. Without any AI model, KLIPZ uses its own engine (hook, hype and pacing analysis). API keys are encrypted on this PC and never shown again.</p>
      </header>

      <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="ai-active">
        <Sparkles className="h-5 w-5 text-accent-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Clips are scored by</p>
          <p className="font-bold">{ENGINE_LABEL[s.active]}</p>
        </div>
        <Badge tone={s.smartEdit ? "good" : "default"}>{s.smartEdit ? "Smart Edit on" : "Smart Edit off"}</Badge>
      </Card>

      {s.envLocked.length ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-muted">
          Set by environment variables / .env.local and not changeable here: {s.envLocked.map((n) => <code key={n} className="mr-1 rounded bg-panel-2 px-1 text-fg">{n}</code>)}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Engine</h2>
        <div role="radiogroup" aria-label="AI engine" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={s.provider === c.id}
              disabled={locked("LLM_PROVIDER") || saving === "provider"}
              onClick={() => void save("provider", { provider: c.id }, `Engine set to ${c.title}.`)}
              className={cn("rounded-xl border p-3 text-left transition-colors disabled:opacity-60", s.provider === c.id ? "border-accent bg-accent/10" : "border-line bg-panel hover:bg-panel-2")}
              data-testid={`engine-${c.id}`}
            >
              <p className="text-sm font-bold">{c.title}</p>
              <p className="mt-0.5 text-xs text-muted">{c.text}</p>
            </button>
          ))}
        </div>
      </section>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Wand2 className="mt-0.5 h-5 w-5 shrink-0 text-accent-2" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold">Smart Edit</h2>
            <p className="text-sm text-muted">
              Edits every new clip automatically, with or without an AI model: cuts dead air and “um / uh”, alternates the framing on each cut, punches in on the words that matter, emphasises keywords in the captions, adds the hook card and a progress bar. Everything stays editable in the editor.
            </p>
          </div>
          <Button
            size="sm"
            variant={s.smartEdit ? "secondary" : "default"}
            disabled={locked("KLIPZ_SMART_EDIT") || saving === "smart"}
            onClick={() => void save("smart", { smartEdit: !s.smartEdit }, s.smartEdit ? "Smart Edit turned off. New clips are left uncut." : "Smart Edit turned on.")}
            aria-pressed={s.smartEdit}
            data-testid="smart-edit-toggle"
          >
            {s.smartEdit ? "Turn off" : "Turn on"}
          </Button>
        </div>
        <p className="text-xs text-muted">Without an AI model, clips are found by the built-in engine: hook strength of the opening line (questions, bold claims, numbers, curiosity gaps), whether the passage stands alone and pays off, and hype: how much louder, brighter, faster and more worked-up the delivery is than the rest of the video. An AI model replaces the reading of the words; the hype analysis of the audio is always used. Applies to clips found from now on (use “Find clips” again to redo a video).</p>
      </Card>

      <ProviderCard icon={<Bot className="h-4 w-4" aria-hidden />} title="Claude (Anthropic API)" status={s.anthropic.keySet ? (s.anthropic.keyFromEnv ? "Key from environment" : "Key saved") : "No key"} good={s.anthropic.keySet}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="API key" id="anthropic-key">
            <Input id="anthropic-key" type="password" autoComplete="off" spellCheck={false} placeholder={s.anthropic.keySet ? "Saved. Type to replace" : "sk-ant-..."} value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} disabled={locked("ANTHROPIC_API_KEY")} />
          </Field>
          <Field label="Model" id="anthropic-model">
            <Input id="anthropic-model" spellCheck={false} value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} disabled={locked("ANTHROPIC_MODEL")} />
          </Field>
        </div>
        <Actions
          onSave={async () => {
            if (await save("anthropic", { anthropic: { ...(anthropicKey.trim() ? { apiKey: anthropicKey } : {}), model: anthropicModel } }, "Claude settings saved.")) setAnthropicKey("");
          }}
          saving={saving === "anthropic"}
          onTest={() => void test("anthropic")}
          test={tests.anthropic}
          onRemoveKey={s.anthropic.keySet && !s.anthropic.keyFromEnv ? () => void save("anthropic", { anthropic: { apiKey: null } }, "Anthropic key removed.") : undefined}
        />
      </ProviderCard>

      <ProviderCard icon={<Sparkles className="h-4 w-4" aria-hidden />} title="Gemini (Google AI)" status={s.gemini.keySet ? (s.gemini.model ? `Model: ${s.gemini.model}` : "Key saved, choose a model") : "No key"} good={s.gemini.keySet && Boolean(s.gemini.model)}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="API key" id="gemini-key">
            <Input id="gemini-key" type="password" autoComplete="off" spellCheck={false} placeholder={s.gemini.keySet ? "Saved. Type to replace" : "AIza..."} value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} disabled={locked("GEMINI_API_KEY")} />
          </Field>
          <Field label="Model" id="gemini-model">
            <Input id="gemini-model" list="gemini-models" spellCheck={false} placeholder="Save the key, then press Test to list models" value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} disabled={locked("GEMINI_MODEL")} />
            <datalist id="gemini-models">{geminiModels.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
        </div>
        <p className="text-xs text-muted">
          Get a key at <a className="text-accent-2 underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>. Save it, press Test (it lists the models your key can use and suggests one), then Save again.
        </p>
        <Actions
          onSave={async () => {
            if (await save("gemini", { gemini: { ...(geminiKey.trim() ? { apiKey: geminiKey } : {}), model: geminiModel } }, "Gemini settings saved.")) setGeminiKey("");
          }}
          saving={saving === "gemini"}
          onTest={() => void test("gemini")}
          test={tests.gemini}
          testLabel="Test / list models"
          onRemoveKey={s.gemini.keySet && !s.gemini.keyFromEnv ? () => void save("gemini", { gemini: { apiKey: null } }, "Gemini key removed.") : undefined}
        />
      </ProviderCard>

      <ProviderCard icon={<PlugZap className="h-4 w-4" aria-hidden />} title="Custom API (any other AI model)" status={s.custom.model ? `Model: ${s.custom.model}` : "Not set up"} good={Boolean(s.custom.baseUrl && s.custom.model)}>
        <Field label="Service" id="custom-preset">
          <Select
            id="custom-preset"
            className="w-full"
            value={CUSTOM_PRESETS.some((x) => x.url === customBase) ? customBase : ""}
            onChange={(e) => e.target.value && setCustomBase(e.target.value)}
            disabled={locked("CUSTOM_AI_BASE_URL")}
          >
            <option value="">Other (type the address below)</option>
            {CUSTOM_PRESETS.map((x) => <option key={x.url} value={x.url}>{x.label}</option>)}
          </Select>
        </Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Base URL" id="custom-base">
            <Input id="custom-base" spellCheck={false} placeholder="https://.../v1" value={customBase} onChange={(e) => setCustomBase(e.target.value)} disabled={locked("CUSTOM_AI_BASE_URL")} />
          </Field>
          <Field label="API key (blank for local servers)" id="custom-key">
            <Input id="custom-key" type="password" autoComplete="off" spellCheck={false} placeholder={s.custom.keySet ? "Saved. Type to replace" : "API key"} value={customKey} onChange={(e) => setCustomKey(e.target.value)} disabled={locked("CUSTOM_AI_API_KEY")} />
          </Field>
          <Field label="Model" id="custom-model">
            <Input id="custom-model" list="custom-models" spellCheck={false} placeholder="Press Test to list models" value={customModel} onChange={(e) => setCustomModel(e.target.value)} disabled={locked("CUSTOM_AI_MODEL")} />
            <datalist id="custom-models">{customModels.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
        </div>
        <p className="text-xs text-muted">Works with any service that offers an OpenAI-compatible chat API. Pick a service or type its address, save, press Test to list its models, choose one and save.</p>
        <Actions
          onSave={async () => {
            if (await save("custom", { custom: { ...(customKey.trim() ? { apiKey: customKey } : {}), baseUrl: customBase, model: customModel } }, "Custom API settings saved.")) setCustomKey("");
          }}
          saving={saving === "custom"}
          onTest={() => void test("custom")}
          test={tests.custom}
          testLabel="Test / list models"
          onRemoveKey={s.custom.keySet && !s.custom.keyFromEnv ? () => void save("custom", { custom: { apiKey: null } }, "API key removed.") : undefined}
        />
      </ProviderCard>

      <ProviderCard icon={<PlugZap className="h-4 w-4" aria-hidden />} title="OpenAI API" status={s.openai.model ? `Model: ${s.openai.model}` : "No model chosen"} good={Boolean(s.openai.model)}>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Base URL" id="openai-base">
            <Input id="openai-base" spellCheck={false} value={openaiBase} onChange={(e) => setOpenaiBase(e.target.value)} disabled={locked("OPENAI_BASE_URL")} />
          </Field>
          <Field label="API key (blank for local servers)" id="openai-key">
            <Input id="openai-key" type="password" autoComplete="off" spellCheck={false} placeholder={s.openai.keySet ? "Saved. Type to replace" : "sk-..."} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} disabled={locked("OPENAI_API_KEY")} />
          </Field>
          <Field label="Model" id="openai-model">
            <Input id="openai-model" list="openai-models" spellCheck={false} placeholder="e.g. gpt-4o-mini" value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} disabled={locked("OPENAI_MODEL")} />
            <datalist id="openai-models">{openaiModels.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
        </div>
        <p className="text-xs text-muted">Save, then Test to list the models. For other services (OpenRouter, Groq, a local server ...) use the Custom API card above.</p>
        <Actions
          onSave={async () => {
            if (await save("openai", { openai: { ...(openaiKey.trim() ? { apiKey: openaiKey } : {}), baseUrl: openaiBase, model: openaiModel } }, "OpenAI-compatible settings saved.")) setOpenaiKey("");
          }}
          saving={saving === "openai"}
          onTest={() => void test("openai")}
          test={tests.openai}
          onRemoveKey={s.openai.keySet && !s.openai.keyFromEnv ? () => void save("openai", { openai: { apiKey: null } }, "API key removed.") : undefined}
        />
      </ProviderCard>

      <ProviderCard icon={<Cpu className="h-4 w-4" aria-hidden />} title="Local model (Ollama)" status={s.ollama.model ? `Model: ${s.ollama.model}` : "No model chosen"} good={Boolean(s.ollama.model)}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Ollama address" id="ollama-url">
            <Input id="ollama-url" spellCheck={false} value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} disabled={locked("OLLAMA_URL")} />
          </Field>
          <Field label="Model" id="ollama-model">
            {ollamaModels.length ? (
              <Select id="ollama-model" className="w-full" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} disabled={locked("OLLAMA_MODEL")}>
                <option value="">Choose a model…</option>
                {[...new Set([...(ollamaModel ? [ollamaModel] : []), ...ollamaModels])].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            ) : (
              <Input id="ollama-model" spellCheck={false} placeholder="Press Test to list installed models" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} disabled={locked("OLLAMA_MODEL")} />
            )}
          </Field>
        </div>
        <Actions onSave={() => void save("ollama", { ollama: { url: ollamaUrl, model: ollamaModel } }, "Local model settings saved.")} saving={saving === "ollama"} onTest={() => void test("ollama")} test={tests.ollama} testLabel="Test / list models" />

        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-line bg-bg p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><FolderInput className="h-4 w-4 text-accent-2" aria-hidden /> Import a model file (.gguf)</p>
          <p className="text-xs text-muted">Have a GGUF model on this PC (for example downloaded from Hugging Face)? KLIPZ registers it with Ollama and selects it. Ollama must be installed and running (<a className="text-accent-2 underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>). Large files take a few minutes.</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
            <Field label="Full path to the .gguf file" id="gguf-path">
              <Input id="gguf-path" spellCheck={false} placeholder="C:\Models\my-model.Q4_K_M.gguf" value={ggufPath} onChange={(e) => {
                setGgufPath(e.target.value);
                if (!ggufName) {
                  const base = e.target.value.split(/[\\/]/).pop() ?? "";
                  const guess = base.replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
                  if (/\.gguf$/i.test(base) && guess) setGgufName(guess);
                }
              }} />
            </Field>
            <Field label="Name in KLIPZ" id="gguf-name">
              <Input id="gguf-name" spellCheck={false} placeholder="my-model" value={ggufName} onChange={(e) => setGgufName(e.target.value.toLowerCase())} />
            </Field>
            <div className="flex items-end">
              <Button size="sm" disabled={saving === "import" || !ggufPath.trim() || !ggufName.trim()} onClick={() => void importModel()} data-testid="import-model">
                {saving === "import" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Importing…</> : "Import"}
              </Button>
            </div>
          </div>
        </div>
      </ProviderCard>

      <ProviderCard icon={<KeyRound className="h-4 w-4" aria-hidden />} title="ElevenLabs (voiceover, optional)" status={s.elevenlabs.keySet ? (s.elevenlabs.keyFromEnv ? "Key from environment" : "Key saved") : "No key"} good={s.elevenlabs.keySet}>
        <Field label="API key" id="eleven-key">
          <Input id="eleven-key" type="password" autoComplete="off" spellCheck={false} placeholder={s.elevenlabs.keySet ? "Saved. Type to replace" : "ElevenLabs API key"} value={elevenKey} onChange={(e) => setElevenKey(e.target.value)} disabled={locked("ELEVENLABS_API_KEY")} />
        </Field>
        <Actions
          onSave={async () => {
            if (elevenKey.trim() && (await save("eleven", { elevenlabs: { apiKey: elevenKey } }, "ElevenLabs key saved."))) setElevenKey("");
          }}
          saving={saving === "eleven"}
          onRemoveKey={s.elevenlabs.keySet && !s.elevenlabs.keyFromEnv ? () => void save("eleven", { elevenlabs: { apiKey: null } }, "ElevenLabs key removed.") : undefined}
        />
      </ProviderCard>
      {node}
    </div>
  );
}

function ProviderCard({ icon, title, status, good, children }: { icon: React.ReactNode; title: string; status: string; good: boolean; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="text-accent-2">{icon}</span>
        <h2 className="text-base font-bold">{title}</h2>
        <Badge tone={good ? "good" : "default"} className="ml-auto">{status}</Badge>
      </div>
      {children}
    </Card>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Actions({ onSave, saving, onTest, test, testLabel = "Test", onRemoveKey }: { onSave: () => void | Promise<void>; saving: boolean; onTest?: () => void; test?: Test | undefined; testLabel?: string; onRemoveKey?: (() => void) | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => void onSave()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      {onTest ? (
        <Button size="sm" variant="secondary" onClick={onTest} disabled={test?.busy}>
          {test?.busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Testing…</> : testLabel}
        </Button>
      ) : null}
      {onRemoveKey ? <Button size="sm" variant="ghost" onClick={onRemoveKey}>Remove key</Button> : null}
      {test?.result ? (
        <p role="status" className={cn("flex min-w-0 items-center gap-1.5 text-xs", test.result.ok ? "text-good" : "text-bad")}>
          {test.result.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0">{test.result.message}</span>
        </p>
      ) : null}
    </div>
  );
}
