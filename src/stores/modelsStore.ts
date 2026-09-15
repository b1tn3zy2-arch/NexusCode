import { create } from "zustand";
import { persist } from "zustand/middleware";
import { opencode } from "../services/backend";
import { KNOWN_MODELS } from "../lib/models";
import ratingsBundle from "../data/model-ratings.json";
import { logInfo, logWarn } from "./outputStore";

export interface ModelRating {
  /** 0-100 editorial coding-effectiveness estimate */
  score: number;
  tier: "S" | "A" | "B" | "C";
  note?: string;
  /** display-name fragments (lowercased at match time) for fuzzy matching */
  matchNames?: string[];
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Exact id first, then exact alias/core fallback. Never fabricates. */
export function findRating(
  ratings: Record<string, ModelRating>,
  id: string,
  name?: string,
): ModelRating | undefined {
  if (ratings[id]) return ratings[id];
  const lowerId = id.toLowerCase();
  // Exact core match: curated "provider/x" vs live "provider/x"
  // (compared whole, never substring — "qwen" must not match "qwen3").
  const idCore = lowerId.split("/").pop() ?? lowerId;
  for (const [key, r] of Object.entries(ratings)) {
    if (!r) continue;
    const keyCore = key.toLowerCase().split("/").pop() ?? key.toLowerCase();
    if (keyCore === idCore && keyCore.length > 0) return r;
  }
  if (!name) return undefined;
  const n = ` ${normName(name)} `;
  for (const r of Object.values(ratings)) {
    for (const alias of r?.matchNames ?? []) {
      // Word-boundary substring: "mimo v2.5" matches "Mimo V2.5 Free".
      if (alias && n.includes(` ${normName(alias)} `)) return r;
    }
  }
  return undefined;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

function bundledRatings(): Record<string, ModelRating> {
  const raw = (ratingsBundle as { ratings?: Record<string, ModelRating> }).ratings ?? {};
  const out: Record<string, ModelRating> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v.score === "number") out[k] = v;
  }
  return out;
}

export function ratingColor(score: number): string {
  if (score >= 90) return "#22c55e";
  if (score >= 80) return "#a3e635";
  if (score >= 70) return "#eab308";
  return "#8b8b90";
}

export interface LiveModel {
  /** full id in opencode "provider/model" convention */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  providerName: string;
  /** context window in tokens, 0 = unknown */
  context: number;
  outputLimit: number;
  /** USD per 1M tokens */
  costIn: number;
  costOut: number;
  vision: boolean;
  tools: boolean;
  status: string;
  source: "live" | "custom";
}

export interface CustomModel {
  /** full "provider/model" id */
  id: string;
  name?: string;
  context?: number;
  costIn?: number;
  costOut?: number;
  vision?: boolean;
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp", "llama.cpp"]);

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function hasVision(input: unknown): boolean {
  if (Array.isArray(input)) return input.includes("image");
  if (input && typeof input === "object") {
    return (input as Record<string, unknown>).image === true;
  }
  return false;
}

function parseCost(cost: unknown): { costIn: number; costOut: number } {
  const c = Array.isArray(cost) ? cost[0] : cost;
  if (!c || typeof c !== "object") return { costIn: 0, costOut: 0 };
  const o = c as Record<string, unknown>;
  return { costIn: num(o.input), costOut: num(o.output) };
}

function parseTokens(s: string | undefined): number {
  if (!s) return 0;
  const m = s.trim().match(/^([\d.]+)\s*([KM])?$/i);
  if (!m) return 0;
  const base = parseFloat(m[1]);
  const mult = (m[2] ?? "").toUpperCase() === "M" ? 1_000_000 : 1_000;
  return Math.round(base * mult);
}

function knownFallback(): LiveModel[] {
  return KNOWN_MODELS.map((m) => {
    const [providerID, ...rest] = m.id.split("/");
    return {
      id: m.id,
      providerID,
      modelID: rest.join("/"),
      name: m.label,
      providerName: m.provider,
      context: parseTokens(m.maxTokens),
      outputLimit: 0,
      costIn: 0,
      costOut: 0,
      vision: m.vision ?? false,
      tools: true,
      status: "active",
      source: "live" as const,
    };
  });
}

function customToLive(c: CustomModel): LiveModel {
  const [providerID, ...rest] = c.id.split("/");
  return {
    id: c.id,
    providerID,
    modelID: rest.join("/"),
    name: c.name?.trim() || c.id,
    providerName: providerID || "Custom",
    context: c.context ?? 0,
    outputLimit: 0,
    costIn: c.costIn ?? 0,
    costOut: c.costOut ?? 0,
    vision: c.vision ?? false,
    tools: true,
    status: "active",
    source: "custom",
  };
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

export function fmtContext(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  return `${Math.round(n / 1_000)}K`;
}

export function fmtCost(costIn: number, costOut: number): string {
  if (costIn <= 0 && costOut <= 0) return "free";
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return `$${f(costIn)}/$${f(costOut)}`;
}

/** one-line params for the picker: "1M context · $2/$8 · vision". */
export function describeModel(m: LiveModel): string {
  const parts: string[] = [];
  const ctx = fmtContext(m.context);
  if (ctx) parts.push(`${ctx} context`);
  parts.push(fmtCost(m.costIn, m.costOut));
  if (m.vision) parts.push("vision");
  return parts.join(" · ");
}

export function modelTag(m: LiveModel): "free" | "pro" | "local" {
  if (LOCAL_PROVIDERS.has(m.providerID.toLowerCase())) return "local";
  return m.costIn <= 0 && m.costOut <= 0 ? "free" : "pro";
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

interface ModelsState {
  providers: { id: string; name: string }[];
  models: LiveModel[];
  updatedAt: number | null;
  loading: boolean;
  error: string | null;
  custom: CustomModel[];
  ratings: Record<string, ModelRating>;
  ratingsUpdatedAt: number | null;
  ratingsLoading: boolean;
  refresh: () => Promise<void>;
  /** Refresh live pricing/context from OpenRouter (ratings stay bundled). */
  refreshPricing: (force?: boolean) => Promise<void>;
  addCustom: (m: CustomModel) => void;
  removeCustom: (id: string) => void;
}

export const useModelsStore = create<ModelsState>()(
  persist(
    (set, get) => ({
      providers: [],
      models: [],
      updatedAt: null,
      loading: false,
      error: null,
      custom: [],
      ratings: bundledRatings(),
      ratingsUpdatedAt: null,
      ratingsLoading: false,

      refresh: async () => {
        if (get().loading) return;
        set({ loading: true, error: null });
        try {
          const res = await opencode.getProviders();
          const providers: { id: string; name: string }[] = [];
          const live: LiveModel[] = [];
          for (const p of res.providers ?? []) {
            providers.push({ id: p.id, name: p.name ?? p.id });
            const entries = p.models ?? {};
            for (const [key, raw] of Object.entries(entries)) {
              const providerID = raw.providerID ?? p.id;
              const modelID = raw.id ?? key;
              const { costIn, costOut } = parseCost(raw.cost);
              live.push({
                id: `${providerID}/${modelID}`,
                providerID,
                modelID,
                name: raw.name ?? modelID,
                providerName: p.name ?? p.id,
                context: num(raw.limit?.context),
                outputLimit: num(raw.limit?.output),
                costIn,
                costOut,
                vision: hasVision(raw.capabilities?.input),
                tools:
                  raw.capabilities?.tools ??
                  (raw.capabilities as { toolcall?: boolean } | undefined)
                    ?.toolcall ??
                  true,
                status: raw.status ?? "active",
                source: "live",
              });
            }
          }
          // custom models override same-id live entries
          const customs = get().custom.map(customToLive);
          const ids = new Set(customs.map((c) => c.id));
          set({
            providers,
            models: [...customs, ...live.filter((m) => !ids.has(m.id))],
            updatedAt: Date.now(),
            loading: false,
            error: null,
          });
          // Weekly ratings refresh rides along (no-op when fresh).
          void get().refreshPricing().catch(() => {});
        } catch (e) {
          // keep stale data; fall back to curated list only when empty
          const has = get().models.length > 0;
          const customs = get().custom.map(customToLive);
          set({
            models: has
              ? get().models
              : [...customs, ...knownFallback()],
            loading: false,
            error: has ? null : String(e),
          });
        }
      },

      refreshPricing: async (force = false) => {
        const st = get();
        if (st.ratingsLoading) return;
        if (
          !force &&
          st.ratingsUpdatedAt &&
          Date.now() - st.ratingsUpdatedAt < WEEK_MS
        ) {
          return;
        }
        set({ ratingsLoading: true });
        try {
          // Via Rust net_fetch: honors the VPN kill-switch for LLM domains.
          const { fetchLlmJson } = await import("../lib/net");
          const data = await fetchLlmJson<{
            data?: {
              id?: string;
              name?: string;
              context_length?: number;
              pricing?: { prompt?: string; completion?: string };
            }[];
          }>("https://openrouter.ai/api/v1/models");
          const list = Array.isArray(data.data) ? data.data : [];
          logInfo("models", `OpenRouter: получено ${list.length} моделей`);
          // Merge live pricing/context into stored models where ids match
          // (OpenRouter ids usually mirror the provider/model convention).
          if (list.length > 0) {
            const byId = new Map<string, (typeof list)[number]>();
            for (const m of list) {
              if (m?.id) byId.set(m.id, m);
            }
            set((s) => {
              const models = s.models.map((m) => {
                const live =
                  byId.get(m.id) ??
                  byId.get(`${m.providerID}/${m.modelID}`);
                if (!live) return m;
                const per1M = (v: string | undefined) => {
                  const n = parseFloat(v ?? "");
                  return Number.isFinite(n) ? n * 1_000_000 : 0;
                };
                return {
                  ...m,
                  context:
                    typeof live.context_length === "number" && live.context_length > 0
                      ? live.context_length
                      : m.context,
                  costIn: per1M(live.pricing?.prompt) || m.costIn,
                  costOut: per1M(live.pricing?.completion) || m.costOut,
                };
              });
              return {
                models,
                ratingsUpdatedAt: Date.now(),
                ratingsLoading: false,
              };
            });
          } else {
            set({ ratingsLoading: false, ratingsUpdatedAt: Date.now() });
            logWarn("models", "OpenRouter вернул пустой список");
          }
        } catch (e) {
          // offline or blocked — bundled scores stay, stamp stays stale
          set({ ratingsLoading: false });
          logWarn("models", `OpenRouter недоступен: ${e instanceof Error ? e.message : String(e)}`);
        }
      },

      addCustom: (m) => {
        const id = m.id.trim();
        if (!id || !id.includes("/")) return;
        const next = [
          ...get().custom.filter((c) => c.id !== id),
          { ...m, id },
        ];
        set({ custom: next });
        // reflect immediately without a server round-trip
        const live = customToLive({ ...m, id });
        set((st) => ({
          models: [live, ...st.models.filter((x) => x.id !== id)],
        }));
      },

      removeCustom: (id) =>
        set((st) => ({
          custom: st.custom.filter((c) => c.id !== id),
          models: st.models.filter((x) => x.id !== id),
        })),
    }),
    {
      name: "nexuscode-models",
      partialize: (s) =>
        ({
          custom: s.custom,
          ratings: s.ratings,
          ratingsUpdatedAt: s.ratingsUpdatedAt,
        }) as Partial<ModelsState>,
    },
  ),
);

export function findModel(models: LiveModel[], id: string | null | undefined): LiveModel | undefined {
  if (!id) return undefined;
  return models.find((m) => m.id === id);
}

export interface PickerOption {
  value: string;
  label: string;
  tag?: "free" | "pro" | "local";
  description?: string;
  badge?: string;
  badgeTitle?: string;
  badgeColor?: string;
}

/** One-line rating suffix for the picker description. */
export function describeRating(rating: ModelRating | undefined): string {
  if (!rating) return "";
  return `★${rating.score}${rating.tier !== "C" ? ` ${rating.tier}` : ""}`;
}

/** Tooltip body for a rating badge. */
export function ratingTitle(rating: ModelRating | undefined, updatedAt: number | null): string {
  if (!rating) return "Нет оценки";
  const when = updatedAt
    ? new Date(updatedAt).toLocaleDateString()
    : "комплект";
  return `Эффективность в коде: ${rating.score}/100 (${rating.tier})${rating.note ? ` — ${rating.note}` : ""}\nДанные: ${when}`;
}

export interface PickerGroup {
  label: string;
  options: PickerOption[];
}

/** Group live models by provider (first-seen order), ensuring active is present. */
export function toSelectGroups(
  models: LiveModel[],
  activeId?: string,
  ratings?: Record<string, ModelRating>,
  ratingsUpdatedAt?: number | null,
): PickerGroup[] {
  const list = [...models];
  if (activeId && !list.some((m) => m.id === activeId)) {
    const [providerID, ...rest] = activeId.split("/");
    list.unshift({
      id: activeId,
      providerID,
      modelID: rest.join("/"),
      name: activeId,
      providerName: providerID || "Other",
      context: 0,
      outputLimit: 0,
      costIn: 0,
      costOut: 0,
      vision: false,
      tools: true,
      status: "active",
      source: "live",
    });
  }
  const map = new Map<string, LiveModel[]>();
  for (const m of list) {
    const key = m.providerName || m.providerID;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  return [...map.entries()].map(([label, opts]) => ({
    label,
    options: opts.map((m) => {
      const rating = ratings ? findRating(ratings, m.id, m.name) : undefined;
      // Chip carries the score; description stays clean (no duplication).
      const badge = rating ? describeRating(rating) : "NEW";
      return {
        value: m.id,
        label: m.name,
        tag: modelTag(m),
        description: describeModel(m),
        badge,
        badgeTitle: rating
          ? ratingTitle(rating, ratingsUpdatedAt ?? null)
          : "Пока без оценки — появится с обновлением каталога",
        badgeColor: rating ? ratingColor(rating.score) : "#8b8b90",
      };
    }),
  }));
}

export function fmtTokens(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}K`;
  }
  return String(Math.round(n));
}
