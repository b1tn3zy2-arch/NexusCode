import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Settings,
  SunMoon,
  Globe,
  ArrowLeftRight,
  Square,
} from "lucide-react";
import { usePaletteStore } from "../stores/paletteStore";
import { useSettingsStore, type Theme } from "../stores/settingsStore";
import { useChatStore } from "../stores/chatStore";
import { loopApi } from "../services/backend";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function openSettings() {
  window.dispatchEvent(new CustomEvent("ocgui:open-settings"));
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Cmd[] = useMemo(() => {
    const theme = useSettingsStore.getState().theme;
    const lang = useSettingsStore.getState().lang;
    const mode = useSettingsStore.getState().mode;
    const nextTheme: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";

    return [
      {
        id: "new-session",
        label: t("sidebar.newSession"),
        hint: "Ctrl+N",
        icon: <Plus className="h-4 w-4" />,
        run: () => void useChatStore.getState().createSession(),
      },
      {
        id: "settings",
        label: t("settings.title"),
        hint: "Ctrl+,",
        icon: <Settings className="h-4 w-4" />,
        run: () => openSettings(),
      },
      {
        id: "theme",
        label: `${t("settings.theme")}: ${t(`theme.${nextTheme}`)}`,
        icon: <SunMoon className="h-4 w-4" />,
        run: () => useSettingsStore.getState().setTheme(nextTheme),
      },
      {
        id: "lang",
        label: `${t("settings.language")}: ${lang === "ru" ? "English" : "Русский"}`,
        icon: <Globe className="h-4 w-4" />,
        run: () =>
          useSettingsStore.getState().setLang(lang === "ru" ? "en" : "ru"),
      },
      {
        id: "mode",
        label:
          mode === "native"
            ? t("cmd.switchToPty")
            : t("cmd.switchToNative"),
        icon: <ArrowLeftRight className="h-4 w-4" />,
        run: () => {
          useSettingsStore
            .getState()
            .setMode(mode === "native" ? "pty" : "native");
          window.setTimeout(() => window.location.reload(), 100);
        },
      },
      {
        id: "stop-loop",
        label: t("cmd.stopLoop"),
        icon: <Square className="h-4 w-4" />,
        run: () => void loopApi.stop().catch(() => {}),
      },
      {
        id: "stop-cont",
        label: t("cmd.stopContinuous"),
        icon: <Square className="h-4 w-4" />,
        run: () =>
          invoke("continuous_stop").catch(() => {}),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const filtered = commands.filter(
    (c) =>
      query.trim() === "" ||
      c.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  const exec = (cmd?: Cmd) => {
    setOpen(false);
    cmd?.run();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(0,0,0,.4)" }}
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        className="anim-pop-in w-[520px] max-w-[92vw] overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <input
          ref={inputRef}
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
          style={{ borderColor: "var(--border-color)" }}
          placeholder={t("cmd.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              exec(filtered[index]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <div className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
              —
            </p>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className="pressable flex cursor-pointer items-center gap-3 px-4 py-2 text-sm transition-colors"
              style={{
                background:
                  i === index
                    ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                    : undefined,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                exec(c);
              }}
              onMouseEnter={() => setIndex(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void import("../lib/ctx").then(({ showCtx }) =>
                  showCtx(e, [
                    {
                      id: "run",
                      label: t("cmd.run", "Выполнить"),
                      hint: "Enter",
                      action: () => exec(c),
                    },
                    {
                      id: "copy",
                      label: t("cmd.copyName", "Копировать название"),
                      action: () =>
                        void import("../lib/clipboard").then(({ copyText }) =>
                          copyText(c.label),
                        ),
                    },
                  ]),
                );
              }}
            >
              <span className="flex w-5 justify-center" style={{ color: "var(--text-secondary)" }}>{c.icon}</span>
              <span className="flex-1">{c.label}</span>
              {c.hint && (
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  {c.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
