import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import {
  Brain,
  Check,
  Copy,
  Loader2,
  Paperclip,
  FileText,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Message, Part } from "../../types/opencode";
import { CodeBlock } from "./CodeBlock";
import { useContextMenuStore } from "../../stores/contextMenuStore";
import { copyText } from "../../lib/clipboard";

function MarkdownView({ text }: { text: string }) {
  const theme = useSettingsStore((s) => s.theme);
  const dark =
    theme === "dark" ||
    theme === "oled" ||
    (theme === "system" &&
      (typeof window === "undefined" ||
        (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true)));
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...props }) {
            const raw = String(children);
            const match = /language-(\w+)/.exec(className ?? "");
            const isBlock =
              match !== null || raw.includes("\n") || raw.length > 80;
            if (isBlock) {
              return (
                <CodeBlock
                  code={raw.replace(/\n$/, "")}
                  lang={match?.[1]}
                  dark={dark}
                />
              );
            }
            return (
              <code className="inline-code" {...props}>
                {children}
              </code>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--accent)] underline"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolPartView({ part }: { part: Part }) {
  const state = part.state?.status ?? "pending";
  const color =
    state === "error" ? "#ef4444" : state === "completed" ? "#22c55e" : "#eab308";
  const dur =
    typeof part.time?.start === "number" && typeof part.time?.end === "number"
      ? part.time.end - part.time.start
      : null;
  return (
    <div className="agent-msg-base agent-tool flex items-center gap-2">
      <Terminal className="h-4 w-4 shrink-0 text-blue-400" />
      <span className="tool-label">{part.tool}</span>
      {dur !== null && dur > 0 && state === "completed" && (
        <span className="text-ui-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>
          {fmtDur(dur)}
        </span>
      )}
      <span
        className="flex items-center gap-1 text-ui-xs"
        style={{ color }}
      >
        {state === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : state === "completed" ? (
          <Check className="h-3 w-3" />
        ) : state === "error" ? (
          <X className="h-3 w-3" />
        ) : null}
        {state}
      </span>
    </div>
  );
}

function ReasoningPartView({
  text,
  defaultOpen,
}: {
  text?: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  if (!text) return null;
  return (
    // Auto-expanded while the model is still thinking (mount-time only —
    // the user can collapse it freely afterwards).
    <details className="agent-msg-base agent-thought" {...(defaultOpen ? { open: true } : {})}>
      <summary>
        <Brain className="h-4 w-4 shrink-0" style={{ color: "#a78bfa" }} />
        {t("chat.reasoning")}
        {defaultOpen && (
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
        )}
      </summary>
      <div className="thought-body whitespace-pre-wrap">{text}</div>
    </details>
  );
}

/** +added/−removed estimate from edit/write tool inputs. */
function partDiffStat(part: Part): { add: number; del: number; file: string } | null {
  if (part.type !== "tool") return null;
  const input = part.state?.input;
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const file =
    ["filePath", "path", "file", "filename", "file_path", "filepath"]
      .map((k) => str(o[k]))
      .find((s) => s && s.trim())
      ?.trim()
      ?.split(/[\\/]/)
      .pop() ?? "";
  const oldS = str(o["oldString"]) ?? str(o["old_string"]);
  const newS = str(o["newString"]) ?? str(o["new_string"]);
  if (oldS !== undefined || newS !== undefined) {
    const a = (oldS ?? "").split("\n");
    const b = (newS ?? "").split("\n");
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) {
      suf++;
    }
    return { add: b.length - pre - suf, del: a.length - pre - suf, file };
  }
  const content = str(o["content"]);
  if (content !== undefined) {
    return { add: content.split("\n").length, del: 0, file };
  }
  const diff = str(o["diff"]);
  if (diff !== undefined) {
    let add = 0;
    let del = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) add++;
      else if (line.startsWith("-")) del++;
    }
    if (add + del > 0) return { add, del, file };
  }
  return null;
}

function FilePartView({ part }: { part: Part }) {
  const isImage = part.mime?.startsWith("image/") ?? false;
  if (isImage && part.url) {
    return (
      <img
        src={part.url}
        alt={part.filename ?? "image"}
        className="my-1 max-h-48 max-w-[70%] rounded-lg border"
        style={{ borderColor: "var(--border-color)" }}
        loading="lazy"
      />
    );
  }
  if (part.filename || part.url) {
    return (
      <div className="agent-msg-base agent-file">
        <FileText className="h-4 w-4 shrink-0 text-green-400" />
        <span className="font-medium">{part.filename ?? part.url}</span>
        {part.mime && (
          <span className="text-ui-xs" style={{ color: "var(--text-secondary)" }}>
            {part.mime}
          </span>
        )}
      </div>
    );
  }
  return null;
}

function PartView({ part, liveThinking, streaming }: { part: Part; liveThinking?: boolean; streaming?: boolean }) {
  switch (part.type) {
    case "text":
      if (!part.text) return null;
      // While streaming, skip Markdown parsing (expensive per token) and
      // show raw text; the full render happens once when done.
      if (streaming) {
        return (
          <div className="markdown-body whitespace-pre-wrap break-words text-[14.5px] leading-[1.65]">
            {part.text}
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-[1px] bg-[var(--accent-400)] align-[-2px]" />
          </div>
        );
      }
      return <MarkdownView text={part.text} />;
    case "reasoning":
      return <ReasoningPartView text={part.text} defaultOpen={liveThinking} />;
    case "tool":
      return <ToolPartView part={part} />;
    case "file":
      return <FilePartView part={part} />;
    default:
      return null;
  }
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    liveThinking,
    streaming,
  }: {
    message: Message;
    /** true while this (last) assistant message is still streaming */
    liveThinking?: boolean;
    /** true while streaming: text renders plain, Markdown parses once on done */
    streaming?: boolean;
  }) {
    const { t } = useTranslation();
    const isUser = message.info.role === "user";

    const stats = message.parts
      .map((p) => partDiffStat(p))
      .filter((s): s is { add: number; del: number; file: string } => !!s && s.add + s.del > 0);
    const totalAdd = stats.reduce((n, s) => n + s.add, 0);
    const totalDel = stats.reduce((n, s) => n + s.del, 0);

    const copyWhole = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = message.parts
        .filter((p) => (p.type === "text" || p.type === "reasoning") && p.text)
        .map((p) => p.text as string)
        .join("\n\n");
      if (!text) return;
      useContextMenuStore.getState().show(e.clientX, e.clientY, [
        {
          id: "copy-msg",
          label: t("ctx.copyMessage"),
          action: () => void copyText(text),
        },
      ]);
    };

    const wholeText = message.parts
      .filter((p) => (p.type === "text" || p.type === "reasoning") && p.text)
      .map((p) => p.text as string)
      .join("\n\n");
    const copyBtn = wholeText ? (
      <button
        className="rounded p-1 opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover:opacity-100"
        title={t("ctx.copyMessage", "Копировать сообщение")}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(wholeText);
        }}
      >
        <Copy className="h-3.5 w-3.5 opacity-60" />
      </button>
    ) : null;

    if (isUser) {
      const textParts = message.parts.filter((p) => p.type === "text" && p.text);
      const fileParts = message.parts.filter((p) => p.type === "file");
      return (
        <div className="group flex flex-col items-end" onContextMenu={copyWhole}>
          {fileParts.length > 0 && (
            <div className="mb-1 flex max-w-[85%] flex-wrap justify-end gap-2">
              {fileParts.map((p) =>
                p.mime?.startsWith("image/") && p.url ? (
                  <img
                    key={p.id}
                    src={p.url}
                    alt={p.filename ?? "image"}
                    className="max-h-40 rounded-lg border"
                    style={{ borderColor: "var(--border-color)" }}
                  />
                ) : (
                  <span key={p.id} className="agent-msg-base agent-file">
                    <Paperclip className="h-4 w-4 shrink-0 text-green-400" />
                    {p.filename ?? "file"}
                  </span>
                ),
              )}
            </div>
          )}
          {textParts.length > 0 && (
            <div
              className="user-msg relative max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] border px-[18px] py-[14px] text-[15px] leading-[1.6]"
              style={{
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
                borderRadius: "16px 16px 4px 16px",
                margin: "8px 0 8px auto",
              }}
            >
              {textParts.map((p) => (
                <span key={p.id}>{p.text}</span>
              ))}
              <span className="absolute right-2 top-2">{copyBtn}</span>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="group flex flex-col" style={{ margin: "8px auto 8px 0", maxWidth: "90%" }} onContextMenu={copyWhole}>
        <div className="mb-1.5 flex items-center gap-2 section-header !justify-start">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ background: "var(--ai-subtle)", border: "1px solid var(--ai-border)" }}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: "#6366f1" }} />
          </div>
          {t("chat.agent")}
          {message.info.modelID && (
            <span className="badge">{message.info.modelID}</span>
          )}
          {stats.length > 0 && (
            <span
              className="badge font-mono"
              title={stats
                .map((s) => `${s.file || "?"}: +${s.add} −${s.del}`)
                .join("\n")}
            >
              <span style={{ color: "#22c55e" }}>+{totalAdd}</span>
              {" "}
              <span style={{ color: "#ef4444" }}>−{totalDel}</span>
            </span>
          )}
          <span className="flex-1" />
          {copyBtn}
        </div>
        <div className="flex flex-col gap-1">
          {message.parts.map((p) => (
            <PartView key={p.id} part={p} liveThinking={liveThinking} streaming={streaming} />
          ))}
        </div>
      </div>
    );
  },
  // NOTE: compare content too — part objects are replaced on every
  // `message.part.updated` event, and id-only comparison freezes live
  // streaming text / thinking / tool status.
  (prev, next) =>
    prev.liveThinking === next.liveThinking &&
    prev.streaming === next.streaming &&
    prev.message.info.id === next.message.info.id &&
    prev.message.info.time.end === next.message.info.time.end &&
    prev.message.info.modelID === next.message.info.modelID &&
    prev.message.parts.length === next.message.parts.length &&
    prev.message.parts.every((p, i) => {
      const q = next.message.parts[i];
      return (
        p.id === q.id &&
        p.text === q.text &&
        p.state?.status === q.state?.status &&
        p.time?.end === q.time?.end
      );
    }),
);
