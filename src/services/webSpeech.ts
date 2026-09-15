// Web Speech API fallback when local Whisper is unavailable.

type SpeechRecognitionCtor = new () => SpeechRecognition;

interface SpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export class WebSpeechRecognizer {
  private recognition: SpeechRecognition | null = null;

  static isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)
    );
  }

  start(
    lang: string,
    onResult: (text: string, isFinal: boolean) => void,
    onError: (error: string) => void,
    onEnd?: () => void,
  ): void {
    if (!WebSpeechRecognizer.isSupported()) {
      onError("not-supported");
      return;
    }
    const Ctor =
      (window.SpeechRecognition ?? window.webkitSpeechRecognition)!;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) finalText += t;
        else interim += t;
      }
      onResult(finalText || interim, Boolean(finalText));
    };
    rec.onerror = (e) => onError(e.error);
    rec.onend = () => onEnd?.();

    this.recognition = rec;
    rec.start();
  }

  stop(): void {
    this.recognition?.stop();
    this.recognition = null;
  }

  abort(): void {
    try {
      this.recognition?.abort();
    } catch {
      /* ignore */
    }
    this.recognition = null;
  }
}
