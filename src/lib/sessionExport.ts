import { invoke } from "@tauri-apps/api/core";
import type { Message, Session } from "../types/opencode";

function short(v: unknown, max = 1200): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

function partText(p: Message["parts"][number]): string {
  if (p.text) return p.text;
  if (p.type === "tool" && p.tool) {
    const st = p.state?.status ?? "";
    const out = [`[tool: ${p.tool}${st ? ` (${st})` : ""}]`];
    if (p.state?.input !== undefined) {
      const input = short(p.state.input);
      if (input) out.push(`input: ${input}`);
    }
    const result = p.state?.error ?? p.state?.output;
    if (result !== undefined) {
      const text = short(result);
      if (text) out.push(`${p.state?.error ? "error" : "output"}: ${text}`);
    }
    return out.join("\n");
  }
  if (p.type === "file" && (p.filename || p.url)) {
    return ` [file: ${p.filename ?? p.url}]`;
  }
  return "";
}

export function formatSessionMarkdown(session: Session, messages: Message[]): string {
  const title = session.title || session.id;
  const when = new Date(session.time.updated).toLocaleString();
  const model = session.model?.id ?? "";
  const lines: string[] = [
    `# ${title}`,
    ``,
    `- session: \`${session.id}\``,
    `- updated: ${when}`,
    ...(model ? [`- model: \`${model}\``] : []),
    ``,
    `---`,
    ``,
  ];
  for (const m of messages) {
    const who = m.info.role === "user" ? "🧑 Пользователь" : "🤖 Ассистент";
    lines.push(`## ${who}`);
    lines.push(``);
    const body = m.parts.map(partText).filter((s) => s.trim()).join("\n\n");
    lines.push(body || "_(пусто)_");
    lines.push(``);
  }
  return lines.join("\n");
}

/** Load (if needed), format and save a session transcript as .md. */
export async function exportSessionMarkdown(sessionId: string): Promise<string | null> {
  const { useChatStore } = await import("../stores/chatStore");
  const chat = useChatStore.getState();
  await chat.selectSession(sessionId);
  const st = useChatStore.getState();
  const session = st.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Сессия не найдена");
  const messages = st.messagesBySession[sessionId] ?? [];
  const md = formatSessionMarkdown(session, messages);
  const { save } = await import("@tauri-apps/plugin-dialog");
  const safe = (session.title || sessionId).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  const picked = await save({
    title: "Экспорт сессии",
    defaultPath: `${safe || "session"}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!picked || typeof picked !== "string") return null;
  await invoke<void>("fs_write_file", { path: picked, content: md });
  return picked;
}
