import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Trash2 } from "lucide-react";
import { useModelsStore } from "../../stores/modelsStore";

export function AddModelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const custom = useModelsStore((s) => s.custom);
  const addCustom = useModelsStore((s) => s.addCustom);
  const removeCustom = useModelsStore((s) => s.removeCustom);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [costIn, setCostIn] = useState("");
  const [costOut, setCostOut] = useState("");
  const [vision, setVision] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const full = id.trim();
    if (!full || !full.includes("/")) {
      setErr(t("models.badId", "ID вида provider/model, например openrouter/mistral-large"));
      return;
    }
    const num = (v: string): number | undefined => {
      const n = parseFloat(v.replace(",", "."));
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const ctx = num(context);
    addCustom({
      id: full,
      name: name.trim() || undefined,
      context: ctx !== undefined ? Math.round(ctx) : undefined,
      costIn: num(costIn),
      costOut: num(costOut),
      vision,
    });
    onClose();
  };

  const inputCls = "input-field w-full";
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[420px] rounded-xl border p-4 shadow-2xl"
        style={{ background: "var(--bg-primary)", borderColor: "var(--border-default)" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") submit();
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {t("models.addTitle", "Своя модель")}
          </h3>
          <button
            className="rounded-md p-1 hover:bg-[var(--hover)]"
            onClick={onClose}
            aria-label={t("common.close", "Закрыть")}
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-2.5">
          <label className="block text-ui-xs" style={{ color: "var(--text-secondary)" }}>
            ID (provider/model) *
            <input
              autoFocus
              className={`${inputCls} mt-1 font-mono`}
              placeholder="openrouter/mistral-large"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setErr(null);
              }}
            />
          </label>
          <label className="block text-ui-xs" style={{ color: "var(--text-secondary)" }}>
            {t("models.name", "Название")}
            <input
              className={`${inputCls} mt-1`}
              placeholder="Mistral Large"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-ui-xs" style={{ color: "var(--text-secondary)" }}>
              {t("models.context", "Контекст")}
              <input
                className={`${inputCls} mt-1`}
                placeholder="128000"
                inputMode="numeric"
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
            </label>
            <label className="block text-ui-xs" style={{ color: "var(--text-secondary)" }}>
              $/1M in
              <input
                className={`${inputCls} mt-1`}
                placeholder="0"
                inputMode="decimal"
                value={costIn}
                onChange={(e) => setCostIn(e.target.value)}
              />
            </label>
            <label className="block text-ui-xs" style={{ color: "var(--text-secondary)" }}>
              $/1M out
              <input
                className={`${inputCls} mt-1`}
                placeholder="0"
                inputMode="decimal"
                value={costOut}
                onChange={(e) => setCostOut(e.target.value)}
              />
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-ui-xs" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => setVision(e.target.checked)}
            />
            Vision (images input)
          </label>
          {err && <p className="text-ui-xs text-red-500">{err}</p>}
          <button className="btn-primary w-full py-1.5 text-[13px]" onClick={submit}>
            {t("models.add", "Добавить")}
          </button>
        </div>

        {custom.length > 0 && (
          <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
            <p className="mb-1.5 text-ui-xs" style={{ color: "var(--text-tertiary)" }}>
              {t("models.custom", "Добавленные")} ({custom.length})
            </p>
            <div className="max-h-[120px] space-y-1 overflow-y-auto">
              {custom.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono">{c.id}</span>
                  <button
                    className="shrink-0 rounded p-1 hover:bg-[var(--hover)]"
                    title={t("common.delete", "Удалить")}
                    onClick={() => removeCustom(c.id)}
                  >
                    <Trash2 size={13} className="text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
