import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  useSettingsStore,
  type AaProfile,
} from "../stores/settingsStore";
import type { TermProfile } from "../lib/shell";
import { backend } from "../services/backend";
import { UpdaterSection } from "./UpdaterSection";
import { Select } from "./Select";

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function SettingsModal({
  open: isOpen,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const store = useSettingsStore();

  const [binaryPath, setBinaryPath] = useState(store.binaryPath);
  const [workDir, setWorkDir] = useState(store.workDir);
  const [portText, setPortText] = useState(
    store.port === null ? "" : String(store.port),
  );
  const [error, setError] = useState<string | null>(null);
  const [aaEnabled, setAaEnabled] = useState(store.autoApprove.enabled);
  const [aaProfile, setAaProfile] = useState<AaProfile>(store.autoApprove.profile);
  const [aaDelay, setAaDelay] = useState(String(store.autoApprove.delayMs));
  const [aaWhitelist, setAaWhitelist] = useState(store.autoApprove.whitelist.join("\n"));
  const [aaBlacklist, setAaBlacklist] = useState(store.autoApprove.blacklist.join("\n"));
  const [aaProtected, setAaProtected] = useState(store.autoApprove.protectedFiles.join("\n"));
  const [fontSize, setFontSize] = useState(String(store.fontSize));
  const [shell, setShell] = useState(store.shell);
  const [streamSpeed, setStreamSpeed] = useState(String(store.streamSpeed));
  const [autoCheck, setAutoCheck] = useState(store.autoCheckUpdates);
  const [channel, setChannel] = useState<"stable" | "prerelease">(store.updateChannel);
  const [q, setQ] = useState("");
  const [profiles, setProfiles] = useState<TermProfile[]>(store.terminalProfiles);
  const [defProfile, setDefProfile] = useState(store.defaultProfileId);
  const [pName, setPName] = useState("");
  const [pShell, setPShell] = useState("");
  const [pArgs, setPArgs] = useState("");
  const [activeSec, setActiveSec] = useState("common");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setBinaryPath(store.binaryPath);
      setWorkDir(store.workDir);
      setPortText(store.port === null ? "" : String(store.port));
      setAaEnabled(store.autoApprove.enabled);
      setAaProfile(store.autoApprove.profile);
      setAaDelay(String(store.autoApprove.delayMs));
      setAaWhitelist(store.autoApprove.whitelist.join("\n"));
      setAaBlacklist(store.autoApprove.blacklist.join("\n"));
      setAaProtected(store.autoApprove.protectedFiles.join("\n"));
      setFontSize(String(store.fontSize));
      setShell(store.shell);
      setStreamSpeed(String(store.streamSpeed));
      setAutoCheck(store.autoCheckUpdates);
      setChannel(store.updateChannel);
      setProfiles(store.terminalProfiles);
      setDefProfile(store.defaultProfileId);
      setPName("");
      setPShell("");
      setPArgs("");
      setError(null);
      setActiveSec("common");
      scrollRef.current?.scrollTo({ top: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const detect = async () => {
    try {
      const found = await backend.resolveBinary(binaryPath || undefined);
      setBinaryPath(found);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const browse = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setWorkDir(dir);
  };

  const save = async () => {
    let port: number | null = null;
    if (portText.trim() !== "") {
      const n = Number(portText);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        setError("Port must be an integer in [1..65535]");
        return;
      }
      port = n;
    }
    let delayMs = Number(aaDelay);
    if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = 1000;

    store.setBinaryPath(binaryPath.trim());
    store.setWorkDir(workDir.trim());
    store.setPort(port);
    store.setFontSize(Number(fontSize));
    store.setShell(shell.trim());
    store.setStreamSpeed(Number(streamSpeed));
    store.setAutoCheckUpdates(autoCheck);
    store.setUpdateChannel(channel);
    store.setTerminalProfiles(profiles);
    store.setDefaultProfileId(
      profiles.some((p) => p.id === defProfile) ? defProfile : (profiles[0]?.id ?? "powershell"),
    );
    store.setAutoApprove({
      enabled: aaEnabled,
      profile: aaProfile,
      delayMs,
      whitelist: lines(aaWhitelist),
      blacklist: lines(aaBlacklist),
      protectedFiles: lines(aaProtected),
    });
    onSaved();
    onClose();
  };

  // VS Code-like sections: sidebar nav + search filter (User scope only).
  const SECTIONS = [
    { id: "common", title: t("settings.secCommon", "Общие"), keys: "общие general binary workdir папка порт port тема theme язык language режим mode анимации animations" },
    { id: "chat", title: t("settings.secChat", "Чат"), keys: "чат chat русский russian ревью review автопринятие подсветка" },
    { id: "editor", title: t("settings.secEditor", "Редактор"), keys: "редактор editor шрифт font стрим stream скорость" },
    { id: "terminal", title: t("settings.secTerminal", "Терминал"), keys: "терминал terminal шелл shell профиль profile powershell cmd python repl" },
    { id: "agents", title: t("settings.secAgents", "Агенты"), keys: "агенты agents approve автоодобрение" },
    { id: "updates", title: t("settings.secUpdates", "Обновления"), keys: "обновления update канал channel sidecar" },
  ];
  const qn = q.trim().toLowerCase();
  const visibleSecs = !qn
    ? SECTIONS
    : SECTIONS.filter((s) =>
        qn.split(/\s+/).every((w) => s.keys.includes(w)),
      );
  const showSec = (id: string) => visibleSecs.some((s) => s.id === id);
  const secTitle = (id: string) =>
    SECTIONS.find((s) => s.id === id)?.title ?? id;
  // Paginated: without a search query only the active section is shown.
  // With a query, all matching sections stack (scrollspy highlights nav).
  // Derived (no effect): if the active section is filtered out, fall back
  // to the first visible one.
  const paged = qn.length === 0;
  const effActive =
    paged && !visibleSecs.some((s) => s.id === activeSec)
      ? (visibleSecs[0]?.id ?? "common")
      : activeSec;
  const showPage = (id: string) => (paged ? effActive === id : showSec(id));
  const scrollSec = (id: string) => {
    setActiveSec(id);
    if (paged) scrollRef.current?.scrollTo({ top: 0 });
    else
      document
        .getElementById(`ncset-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scrollspy (search mode only): highlight the section at the top.
  const onScrollSpy = () => {
    if (paged) return;
    const box = scrollRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let current = SECTIONS[0]?.id ?? "common";
    for (const s of SECTIONS) {
      const el = document.getElementById(`ncset-${s.id}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= 48) current = s.id;
      else break;
    }
    setActiveSec((prev) => (prev === current ? prev : current));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={scrollRef}
        onScroll={onScrollSpy}
        className="anim-pop-in max-h-[88vh] w-[760px] max-w-[94vw] overflow-y-auto rounded-xl border p-5 shadow-2xl"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <h2 className="mb-3 text-lg font-semibold">{t("settings.title")}</h2>
        <div className="relative mb-4">
          <input
            className="input-field w-full pr-8 text-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("settings.search", "Поиск настроек…")}
          />
          {q && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 opacity-60 hover:opacity-100"
              onClick={() => setQ("")}
              aria-label="Очистить"
            >
              ✕
            </button>
          )}
        </div>
        {error && (
          <p className="mb-3 text-xs text-red-500">Error: {error}</p>
        )}

        <div className="flex min-h-0 items-start gap-5">
          <nav className="sticky top-0 flex w-36 shrink-0 flex-col gap-0.5">
            {visibleSecs.map((s) => {
              const active = s.id === effActive;
              return (
                <button
                  key={s.id}
                  className="rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--hover)]"
                  style={
                    active
                      ? {
                          background: "color-mix(in srgb, var(--accent-500) 16%, transparent)",
                          color: "var(--text-primary)",
                          boxShadow: "inset 2px 0 0 var(--accent-500)",
                        }
                      : { color: "var(--text-secondary)" }
                  }
                  onClick={() => scrollSec(s.id)}
                >
                  {s.title}
                </button>
              );
            })}
            {visibleSecs.length === 0 && (
              <p className="px-2.5 py-1.5 text-[12px] opacity-60">
                {t("settings.noMatch", "Ничего не найдено")}
              </p>
            )}
          </nav>

          <div className="min-w-0 flex-1 space-y-5">
          {showPage("common") && (
          <div id="ncset-common" className="scroll-mt-2 space-y-4">
            <h3 className="text-[15px] font-semibold">{secTitle("common")}</h3>
          <label className="block">
            <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              {t("settings.binaryPath")}
            </span>
            <div className="flex gap-2">
              <input
                className="input-field min-w-0 flex-1 text-sm"
                value={binaryPath}
                onChange={(e) => setBinaryPath(e.target.value)}
                placeholder="C:\Users\…\.opencode\bin\opencode.exe"
              />
              <button className="btn-secondary" onClick={() => void detect()}>
                {t("settings.detect")}
              </button>
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              {t("settings.workDir")}
            </span>
            <div className="flex gap-2">
              <input
                className="input-field min-w-0 flex-1 text-sm"
                value={workDir}
                onChange={(e) => setWorkDir(e.target.value)}
              />
              <button className="btn-secondary" onClick={() => void browse()}>
                {t("settings.browse")}
              </button>
            </div>
          </label>

          <div className="flex flex-wrap items-end gap-4">
            <label className="block min-w-[140px] flex-1">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {t("settings.mode")}
              </span>
              <Select
                className="w-full"
                value={store.mode}
                onChange={(v) => store.setMode(v)}
                options={[
                  { value: "native", label: t("settings.modeNative") },
                  { value: "pty", label: t("settings.modePty") },
                ]}
              />
            </label>

            <label className="block min-w-[110px] flex-1">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {t("settings.port")}
              </span>
              <input
                className="input-field w-full text-sm"
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                placeholder={t("settings.portAuto")}
              />
            </label>

            <label className="block min-w-[130px] flex-1">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {t("settings.theme")}
              </span>
              <Select
                className="w-full"
                value={store.theme}
                onChange={(v) => store.setTheme(v)}
                options={[
                  { value: "system", label: t("theme.system") },
                  { value: "light", label: t("theme.light") },
                  { value: "dark", label: t("theme.dark") },
                  { value: "oled", label: "OLED" },
                ]}
              />
            </label>

            <label className="block min-w-[120px] flex-1">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {t("settings.language")}
              </span>
              <Select
                className="w-full"
                value={store.lang}
                onChange={(v) => store.setLang(v)}
                options={[
                  { value: "ru", label: "Русский" },
                  { value: "en", label: "English" },
                ]}
              />
            </label>

          </div>
          <label className="checkbox-row mt-3 max-w-[420px] break-words leading-snug" title={t("settings.animationsHint", "Выкл — убирает все анимации интерфейса независимо от настроек Windows")}>
            <input
              type="checkbox"
              checked={store.animations}
              onChange={(e) => store.setAnimations(e.target.checked)}
            />
            {t("settings.animations", "Анимации интерфейса")}
          </label>
          </div>
          )}

          {showPage("chat") && (
          <div id="ncset-chat" className="scroll-mt-2 space-y-2">
            <h3 className="text-[15px] font-semibold">{secTitle("chat")}</h3>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="checkbox-row max-w-[320px] break-words leading-snug" title={t("settings.respondRussianHint", "Префикс «Отвечай на русском» к каждому промпту")}>
              <input
                type="checkbox"
                checked={store.respondRussian}
                onChange={(e) => store.setRespondRussian(e.target.checked)}
              />
              {t("settings.respondRussian", "Нейронки отвечают на русском")}
            </label>
            <label className="checkbox-row max-w-[320px] break-words leading-snug" title={t("settings.notifyOnDoneHint", "Системное уведомление, когда агент закончил работу")}>
              <input
                type="checkbox"
                checked={store.notifyOnDone}
                onChange={(e) => store.setNotifyOnDone(e.target.checked)}
              />
              {t("settings.notifyOnDone", "Уведомлять о завершении агента")}
            </label>
            <label className="checkbox-row max-w-[320px] break-words leading-snug" title={t("settings.autoAcceptReviewHint")}>
              <input
                type="checkbox"
                checked={store.autoAcceptReview}
                onChange={(e) => store.setAutoAcceptReview(e.target.checked)}
              />
              {t("settings.autoAcceptReview")}
            </label>
            <label className="checkbox-row max-w-[320px] break-words leading-snug" title={t("settings.reviewDecorationsHint")}>
              <input
                type="checkbox"
                checked={store.reviewDecorations}
                onChange={(e) => store.setReviewDecorations(e.target.checked)}
              />
              {t("settings.reviewDecorations")}
            </label>
            </div>
          </div>
          )}

          {showPage("editor") && (
          <div id="ncset-editor" className="scroll-mt-2 space-y-2">
            <h3 className="text-[15px] font-semibold">{secTitle("editor")}</h3>
          <fieldset
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--border-color)" }}
          >
            <legend className="px-1 text-xs font-semibold">{t("settings.secEditor", "Редактор")}</legend>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block min-w-[110px] flex-1">
                <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                  {t("settings.fontSize", "Шрифт редактора")}
                </span>
                <input
                  className="input-field w-full text-sm"
                  inputMode="numeric"
                  value={fontSize}
                  onChange={(e) => setFontSize(e.target.value)}
                  placeholder="14"
                />
              </label>
              <label className="block min-w-[130px] flex-1">
                <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                  {t("settings.streamSpeed", "Скорость стрима")}
                </span>
                <Select
                  className="w-full"
                  value={streamSpeed}
                  onChange={(v) => setStreamSpeed(v)}
                  options={[
                    { value: "0.5", label: t("settings.slow", "Медленно") },
                    { value: "1", label: t("settings.normal", "Обычно") },
                    { value: "2", label: t("settings.fast", "Быстро") },
                  ]}
                />
              </label>
            </div>
            <label className="checkbox-row mt-3 max-w-[320px] break-words leading-snug" title={t("settings.minimapHint", "Второй слой рендера — выключение экономит GPU")}>
              <input
                type="checkbox"
                checked={store.minimap}
                onChange={(e) => store.setMinimap(e.target.checked)}
              />
              {t("settings.minimap", "Миникарта редактора")}
            </label>
          </fieldset>

          </div>
          )}

          {showPage("terminal") && (
          <div id="ncset-terminal" className="scroll-mt-2 space-y-2">
            <h3 className="text-[15px] font-semibold">{secTitle("terminal")}</h3>
            <label className="block">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                {t("settings.shell", "Шелл терминала (когда нет профиля)")}
              </span>
              <input
                className="input-field w-full font-mono text-sm"
                value={shell}
                onChange={(e) => setShell(e.target.value)}
                placeholder="powershell.exe"
              />
            </label>
          <fieldset
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--border-color)" }}
          >
            <legend className="px-1 text-xs font-semibold">{t("settings.termProfiles", "Профили терминала")}</legend>
            <div className="space-y-1.5">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 text-[13px]"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void import("../lib/ctx").then(({ showCtx }) =>
                      showCtx(e, [
                        {
                          id: "default",
                          label: t("settings.setDefaultProfile", "Профиль по умолчанию"),
                          action: () => setDefProfile(p.id),
                        },
                        {
                          id: "copy",
                          label: t("settings.copyShell", "Копировать команду"),
                          action: () =>
                            void import("../lib/clipboard").then(({ copyText }) =>
                              copyText(`${p.shell} ${(p.args ?? []).join(" ")}`.trim()),
                            ),
                        },
                        {
                          id: "delete",
                          label: t("settings.deleteProfile", "Удалить профиль"),
                          danger: true,
                          action: () => setProfiles((ps) => ps.filter((x) => x.id !== p.id)),
                        },
                      ]),
                    );
                  }}
                >
                  <input
                    type="radio"
                    name="def-profile"
                    checked={defProfile === p.id}
                    onChange={() => setDefProfile(p.id)}
                    title={t("settings.defaultProfile", "Профиль по умолчанию")}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium" title={`${p.shell} ${(p.args ?? []).join(" ")}`}>
                    {p.name}
                    <span className="ml-2 font-mono text-[11px] opacity-60">
                      {p.shell} {(p.args ?? []).join(" ")}
                    </span>
                  </span>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-[12px] opacity-60 hover:bg-[var(--hover)] hover:opacity-100"
                    title={t("settings.deleteProfile", "Удалить профиль")}
                    onClick={() => setProfiles((ps) => ps.filter((x) => x.id !== p.id))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {profiles.length === 0 && (
                <p className="text-[12px] opacity-60">{t("settings.noProfiles", "Нет профилей — добавьте ниже")}</p>
              )}
              <div className="flex flex-wrap items-end gap-2 pt-1">
                <label className="block min-w-[110px] flex-1">
                  <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                    {t("settings.profileName", "Название")}
                  </span>
                  <input
                    className="input-field w-full text-sm"
                    value={pName}
                    onChange={(e) => setPName(e.target.value)}
                    placeholder="NuShell"
                  />
                </label>
                <label className="block min-w-[130px] flex-[2]">
                  <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                    {t("settings.profileShell", "Команда")}
                  </span>
                  <input
                    className="input-field w-full font-mono text-sm"
                    value={pShell}
                    onChange={(e) => setPShell(e.target.value)}
                    placeholder="nu.exe"
                  />
                </label>
                <label className="block min-w-[100px] flex-1">
                  <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                    {t("settings.profileArgs", "Аргументы")}
                  </span>
                  <input
                    className="input-field w-full font-mono text-sm"
                    value={pArgs}
                    onChange={(e) => setPArgs(e.target.value)}
                    placeholder="--login -i"
                  />
                </label>
                <button
                  className="btn-secondary shrink-0 px-3 py-1.5 text-[13px]"
                  onClick={() => {
                    const name = pName.trim();
                    const shell = pShell.trim();
                    if (!name || !shell) {
                      setError(t("settings.profileNeedName", "Укажите название и команду"));
                      return;
                    }
                    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
                    setProfiles((ps) => [
                      ...ps,
                      {
                        id,
                        name,
                        shell,
                        args: pArgs.split(/\s+/).map((a) => a.trim()).filter(Boolean),
                        icon: "terminal",
                      },
                    ]);
                    setPName("");
                    setPShell("");
                    setPArgs("");
                    setError(null);
                  }}
                >
                  +
                </button>
              </div>
            </div>
          </fieldset>
          </div>
          )}

          {showPage("agents") && (
          <div id="ncset-agents" className="scroll-mt-2 space-y-2">
            <h3 className="text-[15px] font-semibold">{secTitle("agents")}</h3>
          <fieldset
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--border-color)" }}
          >
            <legend className="px-1 text-xs font-semibold">{t("aa.title")}</legend>
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={aaEnabled}
                    onChange={(e) => setAaEnabled(e.target.checked)}
                  />
                  {aaEnabled ? t("aa.on") : t("aa.off")}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <span style={{ color: "var(--text-secondary)" }}>{t("settings.theme")}:</span>
                  <span>—</span>
                </label>
                <Select
                  className="min-w-[120px]"
                  value={aaProfile}
                  onChange={setAaProfile}
                  options={[
                    { value: "paranoid", label: "Paranoid" },
                    { value: "developer", label: "Developer" },
                    { value: "autopilot", label: "Autopilot" },
                  ]}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <span style={{ color: "var(--text-secondary)" }}>delay, ms</span>
                  <input
                    className="w-20 rounded-md border bg-transparent px-2 py-1 text-xs"
                    style={{ borderColor: "var(--border-color)" }}
                    value={aaDelay}
                    onChange={(e) => setAaDelay(e.target.value)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    whitelist (regex)
                  </span>
                  <textarea
                    className="h-24 w-full rounded-md border bg-transparent p-2 font-mono text-[13px]"
                    style={{ borderColor: "var(--border-color)" }}
                    value={aaWhitelist}
                    onChange={(e) => setAaWhitelist(e.target.value)}
                    placeholder={"^docker\\s+compose\n^make\\s+test"}
                    onContextMenu={(e) =>
                      void import("../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    blacklist (regex)
                  </span>
                  <textarea
                    className="h-24 w-full rounded-md border bg-transparent p-2 font-mono text-[13px]"
                    style={{ borderColor: "var(--border-color)" }}
                    value={aaBlacklist}
                    onChange={(e) => setAaBlacklist(e.target.value)}
                    placeholder={"git\\s+push\\s+--force"}
                    onContextMenu={(e) =>
                      void import("../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    protected files (glob)
                  </span>
                  <textarea
                    className="h-24 w-full rounded-md border bg-transparent p-2 font-mono text-[13px]"
                    style={{ borderColor: "var(--border-color)" }}
                    value={aaProtected}
                    onChange={(e) => setAaProtected(e.target.value)}
                    onContextMenu={(e) =>
                      void import("../lib/ctx").then(({ textAreaMenu }) => textAreaMenu(e))
                    }
                  />
                </label>
              </div>
            </div>
          </fieldset>

          </div>
          )}

          {showPage("updates") && (
          <div id="ncset-updates" className="scroll-mt-2 space-y-2">
            <h3 className="text-[15px] font-semibold">{secTitle("updates")}</h3>
          <fieldset
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--border-color)" }}
          >
            <legend className="px-1 text-xs font-semibold">{t("settings.updates", "Обновления")}</legend>
            <div className="flex flex-wrap items-end gap-4">
              <label className="checkbox-row mb-2 max-w-[260px] break-words leading-snug">
                <input
                  type="checkbox"
                  checked={autoCheck}
                  onChange={(e) => setAutoCheck(e.target.checked)}
                />
                {t("settings.autoCheck", "Проверять обновления при открытии")}
              </label>
              <label className="block min-w-[140px] flex-1">
                <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                  {t("settings.channel", "Канал")}
                </span>
                <Select
                  className="w-full"
                  value={channel}
                  onChange={(v) => setChannel(v as "stable" | "prerelease")}
                  options={[
                    { value: "stable", label: t("settings.stable", "Стабильный") },
                    { value: "prerelease", label: "Pre-release" },
                  ]}
                />
              </label>
            </div>
          </fieldset>

          <UpdaterSection />
          </div>
          )}

          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-primary" onClick={() => void save()}>
            {t("settings.saveRestart")}
          </button>
        </div>
      </div>
    </div>
  );
}
