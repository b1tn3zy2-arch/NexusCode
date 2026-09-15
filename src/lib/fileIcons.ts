import type { LucideIcon } from "lucide-react";
import {
  Binary,
  BookOpen,
  Braces,
  Container,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  GitBranch,
  Globe,
  Hammer,
  KeyRound,
  Lock,
  Palette,
} from "lucide-react";
import { langFromName } from "./languages";

/**
 * VS Code (Seti UI) inspired file colors.
 * Resolved through the Monaco language id so every supported language gets
 * its own color; unknown files fall back to the default icon color.
 */
const LANG_COLORS: Record<string, string> = {
  typescript: "#519aba",
  typescriptreact: "#519aba",
  javascript: "#cbcb41",
  javascriptreact: "#cbcb41",
  json: "#cbcb41",
  html: "#e37933",
  css: "#8dc149",
  scss: "#CD6799",
  less: "#557796",
  python: "#3572A5",
  rust: "#dea584",
  go: "#00ADD8",
  java: "#CC3E44",
  kotlin: "#7F52FF",
  swift: "#F05138",
  dart: "#0175C2",
  scala: "#DC322F",
  liquid: "#67b8de",
  mdx: "#519aba",
  mysql: "#e38c00",
  pgsql: "#e38c00",
  redshift: "#e38c00",
  graphql: "#E10098",
  restructuredtext: "#326795",
  c: "#A8B9CC",
  cpp: "#f34b7d",
  csharp: "#178600",
  vb: "#945db7",
  fsharp: "#378bba",
  "objective-c": "#438eff",
  pascal: "#E3C000",
  php: "#777BB4",
  ruby: "#CC342D",
  perl: "#3949AB",
  lua: "#2C2D72",
  r: "#276DC3",
  julia: "#9558B2",
  haskell: "#5e5086",
  elixir: "#6e4a7e",
  erlang: "#B83998",
  clojure: "#5881D8",
  powershell: "#5391FE",
  shell: "#89e051",
  bat: "#C1F12E",
  sql: "#e38c00",
  yaml: "#CB171E",
  toml: "#9c4221",
  ini: "#8b8b90",
  markdown: "#519aba",
  xml: "#E37933",
  dockerfile: "#384d54",
  gitignore: "#F14E32",
  solidity: "#8a8a8a",
  hcl: "#5C4EE5",
  bicep: "#3a9cdf",
  pug: "#A86454",
  handlebars: "#f0772b",
  twig: "#8ac149",
  razor: "#512bd4",
  proto: "#6d9dc5",
};

/** Exact filename (lowercase) -> color, for special files without extension. */
const FILE_COLORS: Record<string, string> = {
  dockerfile: "#384d54",
  containerfile: "#384d54",
  makefile: "#427819",
  cmakelists: "#d23f31",
  jenkinsfile: "#4298B8",
  gemfile: "#CC342D",
  rakefile: "#CC342D",
  vagrantfile: "#CC342D",
  brewfile: "#CC342D",
  ".gitignore": "#F14E32",
  ".dockerignore": "#F14E32",
  ".gitattributes": "#F14E32",
  ".editorconfig": "#8b8b90",
  ".env": "#eedc82",
};

/** Extension (lowercase, no dot) -> icon. */
const EXT_ICONS: Record<string, LucideIcon> = {
  ts: FileCode2,
  tsx: FileCode2,
  mts: FileCode2,
  cts: FileCode2,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  json: FileJson2,
  jsonc: FileJson2,
  json5: FileJson2,
  html: Globe,
  htm: Globe,
  xhtml: Globe,
  css: Palette,
  scss: Palette,
  sass: Palette,
  less: Palette,
  py: FileCode,
  pyw: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  kt: FileCode,
  kts: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cc: FileCode,
  cs: FileCode,
  php: FileCode,
  rb: FileCode,
  swift: FileCode,
  lua: FileCode,
  pl: FileCode,
  r: FileCode,
  jl: FileCode,
  hs: FileCode,
  ex: FileCode,
  exs: FileCode,
  erl: FileCode,
  clj: FileCode,
  pas: FileCode,
  vb: FileCode,
  fs: FileCode,
  m: FileCode,
  mm: FileCode,
  scala: FileCode,
  sol: FileCode,
  proto: FileCode,
  graphql: Braces,
  gql: Braces,
  md: BookOpen,
  mdx: BookOpen,
  markdown: BookOpen,
  rst: BookOpen,
  txt: FileText,
  log: FileText,
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  ini: FileCog,
  cfg: FileCog,
  conf: FileCog,
  sql: Database,
  db: Database,
  sqlite: Database,
  sqlite3: Database,
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  ps1: FileTerminal,
  psm1: FileTerminal,
  bat: FileTerminal,
  cmd: FileTerminal,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  ico: FileImage,
  bmp: FileImage,
  mp4: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  mov: FileVideo,
  avi: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  flac: FileAudio,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
  ttf: FileType,
  otf: FileType,
  woff: FileType,
  woff2: FileType,
  exe: Binary,
  msi: Binary,
  dll: Binary,
  so: Binary,
  dylib: Binary,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xml: FileCode,
  vue: FileCode2,
  svelte: FileCode2,
  pug: FileCode,
  hbs: FileCode,
  twig: FileCode,
  razor: FileCode,
  cshtml: FileCode,
  liquid: FileCode,
  tf: FileCode,
  hcl: FileCode,
  bicep: FileCode,
  plsql: Database,
};

/** Exact filename (lowercase) -> icon, for special files without extension. */
const FILE_ICONS: Record<string, LucideIcon> = {
  dockerfile: Container,
  containerfile: Container,
  makefile: Hammer,
  cmakelists: Hammer,
  jenkinsfile: Hammer,
  gemfile: FileCode,
  rakefile: FileCode,
  vagrantfile: FileCode,
  brewfile: FileCode,
  ".gitignore": GitBranch,
  ".dockerignore": GitBranch,
  ".gitattributes": GitBranch,
  ".editorconfig": FileCog,
  ".env": KeyRound,
  "package.json": FileJson2,
  "tsconfig.json": FileJson2,
};

/**
 * Icon component for a file, VS Code Seti style (distinct glyph per type).
 * Directories are handled by the caller.
 */
export function fileIcon(name: string): LucideIcon {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!base) return File;
  const special = FILE_ICONS[base];
  if (special) return special;
  if (base.startsWith("dockerfile")) return Container;
  if (base.startsWith(".env")) return KeyRound;
  if (base.endsWith(".lock") || base.endsWith("-lock.json")) return Lock;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1);
    const icon = EXT_ICONS[ext];
    if (icon) return icon;
  }
  return File;
}

/**
 * Color for a file icon, VS Code Seti style.
 * Returns undefined for default (theme) color.
 */
export function fileColor(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!base) return undefined;
  const special = FILE_COLORS[base];
  if (special) return special;
  if (base.startsWith("dockerfile.")) return FILE_COLORS["dockerfile"];
  const lang = langFromName(name);
  if (lang && LANG_COLORS[lang]) return LANG_COLORS[lang];
  return undefined;
}
