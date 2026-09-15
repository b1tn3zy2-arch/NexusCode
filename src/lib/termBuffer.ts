/**
 * Ring buffer of raw PTY output chunks per session (base64, as received).
 * Lets a remounted terminal replay visible scrollback instead of showing
 * a blank screen. Bounded per session; cleared only on explicit close.
 */

const MAX_CHARS = 500_000;

interface Buf {
  chunks: string[];
  size: number;
}

const bufs = new Map<string, Buf>();

export function pushTermChunk(session: string, b64: string): void {
  if (!b64) return;
  let b = bufs.get(session);
  if (!b) {
    b = { chunks: [], size: 0 };
    bufs.set(session, b);
  }
  b.chunks.push(b64);
  b.size += b64.length;
  while (b.size > MAX_CHARS && b.chunks.length > 1) {
    const dropped = b.chunks.shift()!;
    b.size -= dropped.length;
  }
}

export function replayTermBuffer(session: string): string[] {
  return bufs.get(session)?.chunks.slice() ?? [];
}

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[()#][0-9A-B]/g;

/** Decoded tail of a session (ANSI stripped), at most `maxLines` lines. */
export function getTermTail(session: string, maxLines = 80): string {
  const chunks = bufs.get(session)?.chunks;
  if (!chunks || chunks.length === 0) return "";
  // Each chunk is an independently padded base64 string (one PTY read), so
  // decode per chunk: joining first breaks atob on interior "=" padding.
  let bin = "";
  try {
    for (const c of chunks.slice(-24)) bin += atob(c);
  } catch {
    return "";
  }
  let text = "";
  try {
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
  const lines = text
    .replace(ANSI_RE, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("\n").slice(-6000);
}

export function clearTermBuffer(session: string): void {
  bufs.delete(session);
}
