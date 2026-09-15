import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { imagesApi, type PreparedImage } from "../../services/backend";
import { formatBytes } from "../../lib/files";

/** Image tab: photo preview instead of binary garbage in the editor. */
export function ImagePreview({ path, name }: { path: string; name: string }) {
  const { t } = useTranslation();
  const [img, setImg] = useState<PreparedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);

  useEffect(() => {
    let dead = false;
    setImg(null);
    setError(null);
    setFit(true);
    void imagesApi
      .readFile(path)
      .then((p) => {
        if (!dead) setImg(p);
      })
      .catch((e) => {
        if (!dead) setError(String(e));
      });
    return () => {
      dead = true;
    };
  }, [path]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ background: "#0f0f14" }}>
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]"
        style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
      >
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {name}
        </span>
        {img && (
          <span className="shrink-0 tabular-nums">
            {img.width}×{img.height} · {formatBytes(img.size)}
          </span>
        )}
        {img && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
            title={t("image.toggleZoom", "Вписать / реальный размер")}
            onClick={() => setFit((v) => !v)}
          >
            {fit
              ? t("image.actual", "1:1")
              : t("image.fit", "Вписать")}
          </button>
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
        style={{
          background:
            "repeating-conic-gradient(#23232e 0% 25%, #191920 0% 50%) 0 0 / 22px 22px",
        }}
      >
        {error ? (
          <div className="flex flex-col items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            <ImageOff className="h-8 w-8 opacity-50" />
            {error}
          </div>
        ) : !img ? (
          <div className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            …
          </div>
        ) : (
          <img
            src={`data:${img.mime};base64,${img.data_b64}`}
            alt={name}
            onClick={() => setFit((v) => !v)}
            className="cursor-zoom-in rounded shadow-2xl"
            style={
              fit
                ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                : { maxWidth: "none", cursor: "zoom-out" }
            }
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
