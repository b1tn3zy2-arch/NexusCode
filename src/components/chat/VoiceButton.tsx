import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Mic, MicOff, Loader2, AlertTriangle } from "lucide-react";
/* NOTE: animations are pure CSS (no framer-motion) to keep the bundle lean. */
import { useSettingsStore } from "../../stores/settingsStore";
import { WebSpeechRecognizer } from "../../services/webSpeech";

type Engine = "whisper" | "web" | null;

interface Availability {
  whisper_binary: boolean;
  whisper_model: boolean;
}

export function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const lang = useSettingsStore((s) => s.lang);
  const [engine, setEngine] = useState<Engine>(null);
  const [state, setState] = useState<"idle" | "listening" | "processing">("idle");
  const [error, setError] = useState<string | null>(null);
  const webRec = useRef<WebSpeechRecognizer | null>(null);
  const finalText = useRef("");

  const speechLang = lang === "ru" ? "ru-RU" : "en-US";

  // Detect engine once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const avail = await invoke<Availability>("voice_check_availability");
        if (!cancelled) {
          if (avail.whisper_binary && avail.whisper_model) setEngine("whisper");
          else if (WebSpeechRecognizer.isSupported()) setEngine("web");
        }
      } catch {
        if (!cancelled && WebSpeechRecognizer.isSupported()) setEngine("web");
      }
    })();
    return () => {
      cancelled = true;
      webRec.current?.abort();
    };
  }, []);

  const startWeb = useCallback(() => {
    finalText.current = "";
    webRec.current = new WebSpeechRecognizer();
    setState("listening");
    webRec.current.start(
      speechLang,
      (text, isFinal) => {
        if (isFinal) finalText.current = text;
        else finalText.current = text;
      },
      (err) => {
        setError(err === "not-allowed" ? "Нет доступа к микрофону" : `Ошибка: ${err}`);
        setState("idle");
        webRec.current?.abort();
        webRec.current = null;
      },
    );
  }, [speechLang]);

  const stopWeb = useCallback(async () => {
    setState("processing");
    const rec = webRec.current;
    if (rec) {
      rec.stop();
      webRec.current = null;
    }
    // give onresult a moment to flush the final result
    await new Promise((r) => setTimeout(r, 350));
    const text = finalText.current.trim();
    setState("idle");
    if (text) onTranscript(text);
  }, [onTranscript]);

  const startWhisper = useCallback(async () => {
    setState("listening");
    setError(null);
    try {
      await invoke("voice_start");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }, []);

  const stopWhisper = useCallback(async () => {
    setState("processing");
    try {
      const result = await invoke<{ Done?: string }>("voice_stop");
      const text =
        typeof result === "string"
          ? result
          : ((result as { Done?: string })?.Done ?? "");
      if (text.trim()) onTranscript(text.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setState("idle");
    }
  }, [onTranscript]);

  const handleStart = useCallback(() => {
    if (!engine || state !== "idle") return;
    setError(null);
    if (engine === "whisper") void startWhisper();
    else startWeb();
  }, [engine, state, startWhisper, startWeb]);

  const handleStop = useCallback(() => {
    if (state !== "listening") return;
    if (engine === "whisper") void stopWhisper();
    else void stopWeb();
  }, [state, engine, stopWhisper, stopWeb]);

  if (!engine) return null;

  const recording = state === "listening";

  return (
    <div className="relative">
      {recording && (
        <span className="absolute inset-0 animate-ping rounded-full bg-red-500/30" />
      )}

      <button
        className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 ${
          recording
            ? "bg-red-500 text-white shadow-lg shadow-red-500/30 scale-110"
            : "text-text-secondary hover:text-[var(--text-primary)] hover:bg-[var(--hover)]"
        }`}
        style={{ color: recording ? undefined : "var(--text-secondary)" }}
        onMouseDown={handleStart}
        onMouseUp={handleStop}
        onMouseLeave={handleStop}
        onTouchStart={(e) => {
          e.preventDefault();
          handleStart();
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          handleStop();
        }}
        title={
          engine === "web" && !WebSpeechRecognizer.isSupported()
            ? "Голосовой ввод недоступен"
            : "Голосовой ввод (удерживайте)"
        }
      >
        {state === "processing" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : recording ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>

      {(recording || error) && (
          <div
            className="absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 animate-[fadeIn_150ms_ease-out] whitespace-nowrap"
          >
            {error ? (
              <span
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-red-400"
                style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-default)",
                }}
              >
                <AlertTriangle className="h-3 w-3" /> {error}
              </span>
            ) : (
              <span
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-red-400"
                style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-default)",
                }}
              >
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                Слушаю... отпустите для отправки
              </span>
            )}
          </div>
        )}
    </div>
  );
}
