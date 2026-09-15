/**
 * Curated list of models exposed in the model picker.
 *
 * OpenCode does not expose a models listing endpoint, so we keep a hand-
 * maintained catalog of well-known model IDs (provider/model). The currently
 * active model (from the session) is always merged in at runtime so the picker
 * never hides the model the server is actually using.
 *
 * Model IDs follow OpenCode's "provider/id" convention.
 */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  /** short tag shown next to the label, e.g. "free" / "pro" */
  tag?: "free" | "pro" | "local";
  maxTokens?: string;
  vision?: boolean;
  cost?: string;
  description?: string;
}

export const KNOWN_MODELS: ModelInfo[] = [
  // OpenCode free / contributor
  { id: "opencode/muse-spark-1.2-contributor-free", label: "Muse Spark 1.2", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: true, cost: "free", description: "Best for coding, free tier" },
  { id: "opencode/hy3-free", label: "Hy3", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: true, description: "Hybrid reasoning" },
  { id: "opencode/x-preview-f-free", label: "x-preview-f", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: false, description: "Experimental preview" },
  { id: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: true, description: "Fast responses" },
  { id: "opencode/kimi-k2-free", label: "Kimi K2", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: true, description: "Long context" },
  { id: "opencode/qwen3-coder-free", label: "Qwen3 Coder", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: false, description: "Code specialist" },
  { id: "opencode/llama-3.3-70b-free", label: "Llama 3.3 70B", provider: "OpenCode", tag: "free", maxTokens: "128K", vision: false, description: "Meta open" },
  // OpenAI
  { id: "openai/gpt-5", label: "GPT-5", provider: "OpenAI", tag: "pro", maxTokens: "128K", vision: true, cost: "$5/$15 per 1M", description: "Most capable" },
  { id: "openai/gpt-5-mini", label: "GPT-5 Mini", provider: "OpenAI", tag: "pro", maxTokens: "128K", vision: true, cost: "$0.5/$2 per 1M", description: "Fast & cheap" },
  { id: "openai/gpt-4.1", label: "GPT-4.1", provider: "OpenAI", tag: "pro", maxTokens: "128K", vision: true, cost: "$3/$8 per 1M", description: "Balanced" },
  // Anthropic
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", provider: "Anthropic", tag: "pro", maxTokens: "200K", vision: true, cost: "$3/$15 per 1M", description: "Best for coding" },
  { id: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic", tag: "pro", maxTokens: "200K", vision: true, cost: "$15/$75 per 1M", description: "Most powerful" },
  { id: "anthropic/claude-haiku-4", label: "Claude Haiku 4", provider: "Anthropic", tag: "pro", maxTokens: "200K", vision: true, cost: "$0.8/$4 per 1M", description: "Fastest" },
  // Google
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Google", tag: "pro", maxTokens: "1M", vision: true, cost: "$2/$8 per 1M", description: "Huge context" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "Google", tag: "pro", maxTokens: "1M", vision: true, cost: "$0.3/$1 per 1M", description: "Flash fast" },
  // Local
  { id: "ollama/qwen3:latest", label: "Qwen3", provider: "Ollama", tag: "local", maxTokens: "32K", vision: false, cost: "local", description: "Local, private" },
  { id: "ollama/llama3.1:latest", label: "Llama 3.1", provider: "Ollama", tag: "local", maxTokens: "32K", vision: false, cost: "local", description: "Local, private" },
];

export const PROVIDER_ORDER = ["OpenCode", "OpenAI", "Anthropic", "Google", "Ollama"] as const;

export function groupedModelOptions(activeId?: string): { label: string; options: ModelInfo[] }[] {
  const list = [...KNOWN_MODELS];
  if (activeId && !list.some((m) => m.id === activeId)) {
    list.unshift({ id: activeId, label: activeId, provider: activeId.split("/")[0] || "Other", tag: "pro" });
  }
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const p = m.provider;
    if (!map.has(p)) map.set(p, []);
    map.get(p)!.push(m);
  }
  const groups: { label: string; options: ModelInfo[] }[] = [];
  for (const prov of PROVIDER_ORDER) {
    const opts = map.get(prov);
    if (opts && opts.length) {
      groups.push({ label: prov, options: opts });
      map.delete(prov);
    }
  }
  // any remaining providers (e.g. custom activeId)
  for (const [prov, opts] of map) {
    groups.push({ label: prov, options: opts });
  }
  return groups;
}

/** Build the option list for the picker, ensuring the active model is present. */
export function modelOptions(activeId?: string): ModelInfo[] {
  const list = [...KNOWN_MODELS];
  if (activeId && !list.some((m) => m.id === activeId)) {
    list.unshift({ id: activeId, label: activeId, provider: activeId.split("/")[0] || "Other", tag: "pro" });
  }
  return list;
}

export function modelLabel(id?: string): string {
  if (!id) return "—";
  return KNOWN_MODELS.find((m) => m.id === id)?.label ?? id;
}
