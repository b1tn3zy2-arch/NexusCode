import { create } from "zustand";
import type {
  ImageAttachment,
  Message,
  OcEvent,
  Part,
  Session,
} from "../types/opencode";
import { opencode } from "../services/backend";
import { useSettingsStore } from "./settingsStore";

export interface ChatError {
  message: string;
  raw?: string;
}

export interface PendingReview {
  checkpointId: string;
  files: string[];
  at: number;
}

interface ChatState {
  sessions: Session[];
  activeId: string | null;
  messagesBySession: Record<string, Message[]>;
  busy: Record<string, boolean>;
  errorBanner: ChatError | null;
  initialized: boolean;
  /** model id chosen by the user; applied to new sessions and PATCHed live */
  selectedModel: string | null;
  /** Cursor-style review: set when a run ends with file changes on disk. */
  pendingReview: Record<string, PendingReview>;

  init: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  createSession: () => Promise<Session | null>;
  deleteSession: (id: string) => Promise<void>;
  /** Drop a session from local state only (no server round-trip). */
  removeSessionLocal: (id: string) => void;
  send: (text: string, images?: ImageAttachment[]) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  applyEvent: (event: OcEvent) => void;
  setError: (msg: ChatError | null) => void;
  dismissReview: (sessionId: string) => void;
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.time.updated - a.time.updated);
}

function upsertMessage(list: Message[], msg: Message): Message[] {
  const idx = list.findIndex((m) => m.info.id === msg.info.id);
  if (idx === -1) return [...list, msg];
  const next = [...list];
  const existing = next[idx];
  next[idx] = {
    info: msg.info.id === existing.info.id ? { ...existing.info, ...msg.info } : msg.info,
    parts: mergeParts(existing.parts, msg.parts),
    local: false,
  };
  return next;
}

/**
 * Normalize any error shape (string, Error, JSON string, OpenCode error
 * payload) into a UI-friendly { message, raw? } pair. Avoids dumping raw
 * JSON/stack into the user-facing banner.
 */
export function toChatError(e: unknown): ChatError {
  const raw =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : JSON.stringify(e);

  // Already a plain readable string?
  if (typeof e === "string" && !e.trim().startsWith("{")) {
    return { message: e, raw: e };
  }

  // Try to unwrap a JSON payload (string or object).
  let payload: unknown = e;
  if (typeof e === "string") {
    try {
      payload = JSON.parse(e);
    } catch {
      return { message: e, raw: e };
    }
  }

  const obj = payload as Record<string, unknown> | null;
  if (obj && typeof obj === "object") {
    const message =
      (obj["message"] as string | undefined) ??
      (obj["error"] as string | undefined) ??
      (obj["msg"] as string | undefined) ??
      (obj["detail"] as string | undefined);
    if (message) {
      return { message, raw: typeof e === "string" ? e : JSON.stringify(e) };
    }
  }

  return {
    message: e instanceof Error ? e.message : "Произошла неизвестная ошибка.",
    raw,
  };
}

function mergeParts(existing: Part[], incoming: Part[]): Part[] {
  const map = new Map<string, Part>();
  for (const p of existing) map.set(p.id, p);
  for (const p of incoming) {
    const old = map.get(p.id);
    map.set(p.id, old ? { ...old, ...p } : p);
  }
  return [...map.values()].sort((a, b) => {
    const at = a.time?.start ?? Number.MAX_SAFE_INTEGER;
    const bt = b.time?.start ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
}

function messageFromPartsFallback(sessionId: string, part: Part): Message {
  return {
    info: {
      id: `pending-${part.messageID ?? part.id}`,
      role: "assistant",
      sessionID: sessionId,
      time: { created: Date.now() },
    },
    parts: [part],
  };
}

// Events for sessions whose messages aren't loaded yet (background agents).
// Buffered module-side (no re-renders) and replayed on selectSession.
const eventBuffer = new Map<string, OcEvent[]>();
const MAX_BUFFERED_PER_SESSION = 200;

function bufferEvent(sessionId: string, event: OcEvent) {
  const list = eventBuffer.get(sessionId) ?? [];
  list.push(event);
  while (list.length > MAX_BUFFERED_PER_SESSION) list.shift();
  eventBuffer.set(sessionId, list);
}

function takeBufferedEvents(sessionId: string): OcEvent[] {
  const list = eventBuffer.get(sessionId) ?? [];
  eventBuffer.delete(sessionId);
  return list;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeId: null,
  messagesBySession: {},
  busy: {},
  errorBanner: null,
  initialized: false,
  selectedModel: null,
  pendingReview: {},

  init: async () => {
    try {
      const sessions = sortSessions(await opencode.listSessions());
      const workDir = useSettingsStore.getState().workDir;
      let activeId = get().activeId;
      if (!activeId || !sessions.some((s) => s.id === activeId)) {
        const projectMatch = workDir
          ? sessions.find((s) => sameDir(s.directory, workDir))
          : undefined;
        activeId = projectMatch?.id ?? sessions[0]?.id ?? null;
      }
      set({ sessions, activeId, initialized: true, errorBanner: null });
      if (activeId) await get().selectSession(activeId);
    } catch (e) {
      set({ initialized: true, errorBanner: toChatError(e) });
    }
  },

  selectSession: async (id) => {
    set({ activeId: id });
    if (id) {
      const session = get().sessions.find((s) => s.id === id);
      if (session?.model?.id) set({ selectedModel: session.model.id });
    }
    if (!id || get().messagesBySession[id]) {
      // Cached: still drain anything buffered (cheap no-op when empty).
      if (id) for (const ev of takeBufferedEvents(id)) get().applyEvent(ev);
      return;
    }
    try {
      const rows = await opencode.getMessages(id);
      const messages = rows.map((r) => ({ info: r.info, parts: r.parts }));
      set((st) => ({
        messagesBySession: { ...st.messagesBySession, [id]: messages },
      }));
      // Replay events that arrived while the session wasn't loaded.
      for (const ev of takeBufferedEvents(id)) get().applyEvent(ev);
    } catch (e) {
      set({ errorBanner: toChatError(e) });
    }
  },

  createSession: async () => {
    try {
      const session = await opencode.createSession();
      set((st) => ({ sessions: [session, ...st.sessions], activeId: session.id }));
      const model = get().selectedModel;
      if (model) {
        try {
          await opencode.setSessionModel(session.id, model);
          session.model = { id: model, providerID: model.split("/")[0] ?? "" };
        } catch {
          /* model applied on next setModel attempt */
        }
      }
      if (session.model?.id) set({ selectedModel: session.model.id });
      await get().selectSession(session.id);
      return session;
    } catch (e) {
      set({ errorBanner: toChatError(e) });
      return null;
    }
  },

  setModel: async (model) => {
    const sessionId = get().activeId;
    set({ selectedModel: model });
    if (!sessionId) return;
    try {
      await opencode.setSessionModel(sessionId, model);
      // reflect the change in the session list immediately
      set((st) => ({
        sessions: st.sessions.map((s) =>
          s.id === sessionId
            ? { ...s, model: { id: model, providerID: model.split("/")[0] ?? "" } }
            : s,
        ),
      }));
    } catch (e) {
      set({ errorBanner: toChatError(e) });
    }
  },

  deleteSession: async (id) => {
    try {
      await opencode.deleteSession(id);
      get().removeSessionLocal(id);
    } catch (e) {
      set({ errorBanner: toChatError(e) });
    }
  },

  removeSessionLocal: (id) => {
    eventBuffer.delete(id);
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      const messagesBySession = { ...st.messagesBySession };
      delete messagesBySession[id];
      const pendingReview = { ...st.pendingReview };
      delete pendingReview[id];
      const busy = { ...st.busy };
      delete busy[id];
      const activeId =
        st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId;
      return { sessions, messagesBySession, activeId, pendingReview, busy };
    });
  },

  send: async (text, images) => {
    let trimmed = (text ?? "").trim();
    const imgs = images ?? [];
    if (!trimmed && imgs.length === 0) return;

    // Answer-in-Russian default (settings toggle). Plain-text prefix so it
    // works with every model without API support for system prompts.
    if (useSettingsStore.getState().respondRussian && trimmed) {
      const marker = "Отвечай на русском языке.";
      if (!trimmed.startsWith(marker)) trimmed = `${marker}\n\n${trimmed}`;
    }

    const { activeId, createSession } = get();
    let sessionId = activeId;
    if (!sessionId) {
      const created = await createSession();
      if (!created) return;
      sessionId = created.id;
    }

    const parts: Part[] = [];
    if (trimmed) {
      parts.push({ id: `prt-${Date.now()}`, type: "text", text: trimmed });
    }
    imgs.forEach((img, i) => {
      parts.push({
        id: `prt-img-${Date.now()}-${i}`,
        type: "file",
        mime: img.mime,
        url: `data:${img.mime};base64,${img.b64}`,
        filename: img.name,
      });
    });

    const localMsg: Message = {
      info: {
        id: `local-${Date.now()}`,
        role: "user",
        sessionID: sessionId,
        time: { created: Date.now() },
      },
      parts,
      local: true,
    };

    set((st) => {
      // A new run supersedes any unreviewed result.
      const pendingReview = { ...st.pendingReview };
      delete pendingReview[sessionId!];
      return {
        messagesBySession: {
          ...st.messagesBySession,
          [sessionId!]: [...(st.messagesBySession[sessionId!] ?? []), localMsg],
        },
        busy: { ...st.busy, [sessionId!]: true },
        errorBanner: null,
        pendingReview,
      };
    });

    // Cursor-style safety net: snapshot the *session's* repo BEFORE the agent
    // runs so ReviewBanner diffs against the true pre-run state. Awaited on
    // purpose — a fire-and-forget snapshot races the agent's first write.
    // Single choke point: every sender (input, overview, review) is covered.
    try {
      const session = get().sessions.find((s) => s.id === sessionId);
      const root =
        session?.directory || useSettingsStore.getState().workDir;
      if (root) {
        const { ensurePreRunSnapshot, setPreRunCheckpoint } = await import(
          "../lib/checkpoints"
        );
        const cpId = await ensurePreRunSnapshot(root, trimmed || "(images)");
        // null clears a stale id: a clean tree means "nothing to review".
        setPreRunCheckpoint(sessionId!, cpId);
      }
    } catch {
      /* review is best-effort; the prompt must still go out */
    }

    try {
      await opencode.promptAsync(sessionId, parts);
    } catch (e) {
      set((st) => ({
        busy: { ...st.busy, [sessionId!]: false },
        errorBanner: toChatError(e),
      }));
    }
  },

  abort: async () => {
    const sessionId = get().activeId;
    if (!sessionId) return;
    try {
      await opencode.abortSession(sessionId);
      set((st) => ({ busy: { ...st.busy, [sessionId]: false } }));
    } catch (e) {
      set({ errorBanner: toChatError(e) });
    }
  },

  setError: (msg) => set({ errorBanner: msg }),

  dismissReview: (sessionId) =>
    set((st) => {
      if (!(sessionId in st.pendingReview)) return st;
      const pendingReview = { ...st.pendingReview };
      delete pendingReview[sessionId];
      return { pendingReview };
    }),

  applyEvent: (event) => {
    const state = get();

    switch (event.type) {
      case "session.updated": {
        const info = event.properties["info"] as Session | undefined;
        if (!info) return;
        set((st) => {
          const exists = st.sessions.some((s) => s.id === info.id);
          return {
            sessions: exists
              ? st.sessions.map((s) => (s.id === info.id ? info : s))
              : [info, ...st.sessions],
          };
        });
        break;
      }

      case "session.deleted": {
        const props = event.properties as { sessionID?: string };
        if (!props.sessionID) return;
        // Already gone server-side — drop locally, no second DELETE.
        get().removeSessionLocal(props.sessionID);
        break;
      }

      case "session.idle":
      case "session.error": {
        const props = event.properties as { sessionID?: string; error?: unknown };
        if (!props.sessionID) return;
        const wasBusy = !!get().busy[props.sessionID];
        set((st) => ({ busy: { ...st.busy, [props.sessionID!]: false } }));
        const errText =
          event.type === "session.error" && props.error
            ? typeof props.error === "string"
              ? props.error
              : JSON.stringify(props.error)
            : null;
        if (errText) {
          // Own abort → no red banner, just stop.
          if (!/abort/i.test(errText)) {
            set({ errorBanner: toChatError(props.error) });
          }
        }
        // Agent finished on its own (own abort already cleared busy above).
        if (wasBusy && (!errText || !/abort/i.test(errText))) {
          const s = get().sessions.find((x) => x.id === props.sessionID);
          const title = s?.title || props.sessionID.slice(0, 8);
          void import("../lib/notify").then(({ notifyDone }) =>
            errText
              ? notifyDone("Агент: ошибка", `${title} — ${errText.slice(0, 200)}`)
              : notifyDone("Агент закончил", title),
          );
          // Cursor-style review: if this run changed files vs the pre-run
          // snapshot, offer Accept (default) / Revert. Fire-and-forget.
          void (async () => {
            try {
              const { takePreRunCheckpoint, checkpointsApi } = await import(
                "../lib/checkpoints"
              );
              const sid = props.sessionID!;
              const cpId = takePreRunCheckpoint(sid);
              if (!cpId) return;
              const root = useSettingsStore.getState().workDir;
              if (!root) return;
              const files = await checkpointsApi.diff(root, cpId);
              if (files.length === 0) return;
              set((st) => ({
                pendingReview: {
                  ...st.pendingReview,
                  [sid]: { checkpointId: cpId, files, at: Date.now() },
                },
              }));
            } catch {
              /* review is best-effort */
            }
          })();
        }
        break;
      }

      case "message.updated": {
        const info = event.properties["info"] as Message["info"] | undefined;
        if (!info) return;
        const list = state.messagesBySession[info.sessionID];
        if (!list) {
          bufferEvent(info.sessionID, event);
          return;
        }
        let next = list.map((m) =>
          m.info.id === info.id ? { ...m, info: { ...m.info, ...info } } : m,
        );
        if (info.role === "user") {
          next = next.filter((m) => !(m.local && m.info.role === "user"));
        }
        if (
          info.role === "assistant" &&
          (typeof info.time?.completed === "number" ||
            typeof info.time?.end === "number")
        ) {
          set((st) => ({ busy: { ...st.busy, [info.sessionID]: false } }));
        }
        set((st) => ({
          messagesBySession: { ...st.messagesBySession, [info.sessionID]: next },
        }));
        break;
      }

      case "message.part.updated": {
        const raw = event.properties["part"] as Part | undefined;
        if (!raw) return;
        const explicitId =
          raw.sessionID ??
          (event.properties["sessionID"] as string | undefined);
        const sessionId = explicitId ?? state.activeId;
        if (!sessionId) return;
        const loaded = state.messagesBySession[sessionId];
        if (!loaded) {
          bufferEvent(sessionId, event);
          return;
        }
        // No explicit id: only the busy (streaming) session may claim it.
        // Otherwise a part arriving mid-switch lands in the wrong chat.
        if (!explicitId && !state.busy[sessionId]) return;
        const list = loaded;
        const targetId = raw.messageID;
        let next: Message[];

        const ownerIdx = targetId
          ? list.findIndex(
              (m) => m.info.id === targetId || m.info.id === `pending-${targetId}`,
            )
          : -1;

        if (ownerIdx >= 0) {
          next = [...list];
          const owner = next[ownerIdx];
          next[ownerIdx] = { ...owner, parts: mergeParts(owner.parts, [raw]) };
        } else {
          const fallback = messageFromPartsFallback(sessionId, raw);
          next = upsertMessage(list, fallback);
        }

        set((st) => ({
          messagesBySession: { ...st.messagesBySession, [sessionId]: next },
        }));
        break;
      }

      case "bridge.connected":
      case "bridge.disconnected":
      case "bridge.fatal":
      case "bridge.raw":
        break;

      default:
        break;
    }
  },
}));
