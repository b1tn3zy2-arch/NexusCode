import { useTranslation } from "react-i18next";
import { FolderOpen, Command } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";
import { EditorPane } from "../components/editor/EditorPane";

export function EditorArea() {
  const { t } = useTranslation();
  const tabs = useEditorStore((s) => s.tabs);

  const hasTabs = tabs.length > 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {hasTabs ? (
        <EditorPane />
      ) : (
        <>
          {/* empty state */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
            {/* ambient mesh glow */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(600px 300px at 50% 38%, var(--ai-subtle), transparent 70%)",
              }}
            />

            <div className="relative z-10 flex flex-col items-center gap-5 text-center">
              <LogoMark size={72} />
              <div>
                <h1 className="text-2xl font-bold tracking-tight">NexusCode</h1>
                <p
                  className="mt-1 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {t("welcome.slogan")}
                </p>
              </div>

              <p
                className="max-w-[320px] text-[13px]"
                style={{ color: "var(--text-secondary)" }}
              >
                Откройте файл в Проводнике слева — он появится здесь во встроенном редакторе.
              </p>

              <button
                className="mt-1 flex items-center gap-1.5 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                <Command size={13} />
                Ctrl+K — {t("cmd.placeholder")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="nc-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="220" fill="url(#nc-bg)" />
      <line x1="300" y1="700" x2="724" y2="324" stroke="#fff" strokeWidth="46" strokeLinecap="round" />
      <line x1="300" y1="324" x2="300" y2="700" stroke="rgba(238,242,255,.8)" strokeWidth="40" strokeLinecap="round" />
      <line x1="724" y1="324" x2="724" y2="700" stroke="rgba(238,242,255,.8)" strokeWidth="40" strokeLinecap="round" />
      <circle cx="300" cy="700" r="95" fill="#fff" />
      <circle cx="724" cy="324" r="95" fill="#fff" />
      <text x="300" y="712" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, Segoe UI, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">N</text>
      <text x="724" y="336" textAnchor="middle" dominantBaseline="middle" fontFamily="Geist Variable, Segoe UI, sans-serif" fontWeight="800" fontSize="150" fill="#4f46e5">C</text>
    </svg>
  );
}
