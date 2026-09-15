export type DiagSeverity = "error" | "warning" | "info";

export interface FileDiagnostic {
  /** absolute file path */
  file: string;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  col: number;
  /** 1-based end column (exclusive) */
  endCol?: number;
  severity: DiagSeverity;
  message: string;
  source: string;
  code?: string;
}

const MAX_FILE_BYTES = 400_000;
const MAX_DIAGS_PER_FILE = 100;

const KNOWN_ENTITIES = new Set(
  (
    "amp lt gt quot apos nbsp copy reg trade hellip mdash ndash laquo raquo " +
    "bull middot para sect deg plusmn times divide frac12 frac14 frac34 " +
    "iexcl iquest agrave aacute acirc atilde auml aring aelig ccedil egrave " +
    "eacute ecirc euml igrave iacute icirc iuml ntilde ograve oacute ocirc " +
    "otilde ouml oslash ugrave uacute ucirc uuml yuml szlig euro " +
    "alpha beta gamma delta pi sigma omega infin rarr larr uarr darr crarr"
  )
    .split(/\s+/)
    .filter(Boolean),
);

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return dp[n];
}

function suggestEntity(name: string): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const known of KNOWN_ENTITIES) {
    const d = editDistance(name.toLowerCase(), known);
    if (d < bestDist && d <= 2) {
      bestDist = d;
      best = known;
    }
  }
  return best;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

/** Replace matched ranges with spaces, keeping newlines so line numbers survive. */
function blankRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < chars.length; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function stripComments(text: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return blankRanges(text, ranges);
}

function stripScriptStyle(text: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // keep the tags themselves, blank only the inner content
    const openEnd = m[0].indexOf(">") + 1;
    const closeStart = m[0].lastIndexOf("<");
    ranges.push({ start: m.index + openEnd, end: m.index + closeStart });
  }
  return blankRanges(text, ranges);
}

function checkHtmlEntities(file: string, text: string, starts: number[], out: FileDiagnostic[]) {
  const re = /&([A-Za-z][A-Za-z0-9]+|#[0-9]+|#x[0-9A-Fa-f]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name.startsWith("#")) continue;
    if (KNOWN_ENTITIES.has(name) || KNOWN_ENTITIES.has(name.toLowerCase())) continue;
    const { line, col } = offsetToLineCol(starts, m.index);
    const suggestion = suggestEntity(name);
    out.push({
      file,
      line,
      col,
      endCol: col + m[0].length,
      severity: "warning",
      message: suggestion
        ? `Unknown entity "&${name};" — did you mean "&${suggestion};"?`
        : `Unknown entity "&${name};"`,
      source: "html",
      code: "unknown-entity",
    });
    if (out.length >= MAX_DIAGS_PER_FILE) return;
  }
}

function checkHtmlTags(file: string, text: string, starts: number[], out: FileDiagnostic[]) {
  const stack: Array<{ tag: string; line: number; col: number }> = [];
  const re = /<\/?([A-Za-z][A-Za-z0-9-]*)(\s[^<>]*?)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const isClose = full.startsWith("</");
    const selfClosing = full.endsWith("/>") || VOID_ELEMENTS.has(tag);
    // skip doctype / processing instructions (regex already limits to letters)
    const { line, col } = offsetToLineCol(starts, m.index);
    if (selfClosing) continue;
    if (!isClose) {
      // implicit close like browsers do: <p><p>, <li><li>
      const top = stack[stack.length - 1];
      if ((tag === "p" || tag === "li") && top?.tag === tag) stack.pop();
      stack.push({ tag, line, col });
    } else {
      if (stack.length === 0) {
        out.push({
          file,
          line,
          col,
          endCol: col + full.length,
          severity: "error",
          message: `Unexpected closing tag "</${m[1]}>" with no open tag`,
          source: "html",
          code: "unexpected-close",
        });
      } else {
        const top = stack[stack.length - 1];
        if (top.tag === tag) {
          stack.pop();
        } else {
          const idx = stack.map((s) => s.tag).lastIndexOf(tag);
          if (idx === -1) {
            out.push({
              file,
              line,
              col,
              endCol: col + full.length,
              severity: "error",
              message: `Mismatched closing tag "</${m[1]}>" — expected "</${top.tag}>"`,
              source: "html",
              code: "mismatched-tag",
            });
          } else {
            // unclosed inner tags
            for (let i = stack.length - 1; i > idx; i--) {
              const unclosed = stack.pop()!;
              out.push({
                file,
                line: unclosed.line,
                col: unclosed.col,
                severity: "error",
                message: `Unclosed tag "<${unclosed.tag}>"`,
                source: "html",
                code: "unclosed-tag",
              });
            }
            stack.pop();
          }
        }
      }
    }
    if (out.length >= MAX_DIAGS_PER_FILE) return;
  }
  for (const unclosed of stack.splice(-5)) {
    out.push({
      file,
      line: unclosed.line,
      col: unclosed.col,
      severity: "error",
      message: `Unclosed tag "<${unclosed.tag}>"`,
      source: "html",
      code: "unclosed-tag",
    });
    if (out.length >= MAX_DIAGS_PER_FILE) return;
  }
}

function checkJson(file: string, text: string, starts: number[], out: FileDiagnostic[]) {
  if (!text.trim()) return;
  try {
    JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const posMatch = /position\s+(\d+)/i.exec(msg);
    let line = 1;
    let col = 1;
    if (posMatch) {
      const pos = Math.min(parseInt(posMatch[1], 10), text.length);
      const lc = offsetToLineCol(starts, pos);
      line = lc.line;
      col = lc.col;
    }
    out.push({
      file,
      line,
      col,
      severity: "error",
      message: `Invalid JSON: ${msg.slice(0, 200)}`,
      source: "json",
      code: "parse",
    });
  }
}

function checkNoteMarkers(file: string, text: string, starts: number[], out: FileDiagnostic[]) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const marker = /\b(FIXME|XXX|HACK)\b/.exec(lineText);
    if (marker) {
      out.push({
        file,
        line: i + 1,
        col: (marker.index ?? 0) + 1,
        severity: "warning",
        message: `${marker[1]}: ${lineText.trim().slice(0, 120)}`,
        source: "notes",
        code: "marker",
      });
    } else {
      const todo = /\bTODO\b/.exec(lineText);
      if (todo) {
        out.push({
          file,
          line: i + 1,
          col: (todo.index ?? 0) + 1,
          severity: "info",
          message: `TODO: ${lineText.trim().slice(0, 120)}`,
          source: "notes",
          code: "marker",
        });
      }
    }
    if (out.length >= MAX_DIAGS_PER_FILE) return;
  }
  void starts;
}

/** Analyze file content. Returns diagnostics sorted by line/col. Never throws. */
export function analyzeFile(path: string, content: string): FileDiagnostic[] {
  const out: FileDiagnostic[] = [];
  try {
    if (content.length > MAX_FILE_BYTES) return out;
    if (content.includes("\0")) return out; // binary
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const starts = lineStarts(content);

    if (ext === "json" || ext === "jsonc") {
      checkJson(path, content, starts, out);
    }
    if (ext === "html" || ext === "htm" || ext === "xhtml" || ext === "vue" || ext === "svelte") {
      const clean = stripScriptStyle(stripComments(content));
      checkHtmlEntities(path, clean, starts, out);
      checkHtmlTags(path, clean, starts, out);
    }
    checkNoteMarkers(path, content, starts, out);

    out.sort((a, b) => a.line - b.line || a.col - b.col);
    return out.slice(0, MAX_DIAGS_PER_FILE);
  } catch {
    return out;
  }
}
