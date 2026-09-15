/**
 * Language registry for the editor.
 *
 * IDs match the grammars bundled with the installed monaco-editor build
 * (`esm/vs/basic-languages/monaco.contribution.js` + the json/css/html/
 * typescript language features). Files whose language Monaco cannot
 * highlight resolve to `undefined` (plaintext) — never to a wrong grammar.
 */

export interface LanguageInfo {
  id: string;
  label: string;
  extensions: string[];
}

/** All languages Monaco can actually highlight in this build. */
export const LANGUAGES: LanguageInfo[] = [
  { id: "abap", label: "ABAP", extensions: ["abap"] },
  { id: "aes", label: "Sophia", extensions: ["aes"] },
  { id: "apex", label: "Apex", extensions: ["cls"] },
  { id: "azcli", label: "Azure CLI", extensions: ["azcli"] },
  { id: "bat", label: "Batch", extensions: ["bat", "cmd"] },
  { id: "bicep", label: "Bicep", extensions: ["bicep"] },
  { id: "c", label: "C", extensions: ["c", "h"] },
  { id: "cameligo", label: "Cameligo", extensions: ["mligo"] },
  { id: "clojure", label: "Clojure", extensions: ["clj", "cljs", "cljc", "edn"] },
  { id: "coffeescript", label: "CoffeeScript", extensions: ["coffee"] },
  { id: "cpp", label: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "cu", "cuh", "ipp", "inl"] },
  { id: "csharp", label: "C#", extensions: ["cs", "csx", "cake"] },
  { id: "csp", label: "CSP", extensions: ["csp"] },
  { id: "css", label: "CSS", extensions: ["css", "pcss", "postcss"] },
  { id: "cypher", label: "Cypher", extensions: ["cypher", "cyp"] },
  { id: "dart", label: "Dart", extensions: ["dart"] },
  { id: "dockerfile", label: "Dockerfile", extensions: ["dockerfile"] },
  { id: "ecl", label: "ECL", extensions: ["ecl"] },
  { id: "elixir", label: "Elixir", extensions: ["ex", "exs"] },
  { id: "flow9", label: "Flow9", extensions: ["flow"] },
  { id: "freemarker2", label: "FreeMarker", extensions: ["ftl", "ftlh", "ftlx"] },
  { id: "fsharp", label: "F#", extensions: ["fs", "fsi", "fsx", "fsscript", "ml", "mli"] },
  { id: "go", label: "Go", extensions: ["go"] },
  { id: "graphql", label: "GraphQL", extensions: ["graphql", "gql"] },
  { id: "handlebars", label: "Handlebars", extensions: ["handlebars", "hbs", "mustache"] },
  { id: "hcl", label: "HCL", extensions: ["tf", "tfvars", "hcl"] },
  { id: "html", label: "HTML", extensions: ["html", "htm", "shtml", "xhtml", "vue", "svelte", "astro", "ejs", "erb", "hta", "asax", "ashx", "asmx"] },
  { id: "ini", label: "Ini", extensions: ["ini", "cfg", "conf", "properties", "gitconfig", "env", "toml", "reg", "url", "iss", "inf"] },
  { id: "java", label: "Java", extensions: ["java", "jav", "jenkinsfile"] },
  { id: "javascript", label: "JavaScript", extensions: ["js", "es6", "mjs", "cjs"] },
  // NOTE: same as tsx — jsx needs the react language id for JSX parsing.
  { id: "javascriptreact", label: "JSX", extensions: ["jsx"] },
  { id: "json", label: "JSON", extensions: ["json", "jsonc", "json5", "jsonl", "ndjson", "avsc", "tfstate", "tfplan", "har", "ipynb", "webmanifest", "tsbuildinfo", "map", "geojson", "topojson"] },
  { id: "julia", label: "Julia", extensions: ["jl"] },
  { id: "kotlin", label: "Kotlin", extensions: ["kt", "kts"] },
  { id: "less", label: "Less", extensions: ["less"] },
  { id: "lexon", label: "Lexon", extensions: ["lex"] },
  { id: "liquid", label: "Liquid", extensions: ["liquid"] },
  { id: "lua", label: "Lua", extensions: ["lua"] },
  { id: "m3", label: "Modula-3", extensions: ["m3", "i3", "mg", "ig"] },
  { id: "markdown", label: "Markdown", extensions: ["md", "markdown", "mdown", "mkdn", "mkd", "mdwn", "mdtxt", "mdtext"] },
  { id: "mdx", label: "MDX", extensions: ["mdx"] },
  { id: "mips", label: "MIPS", extensions: ["s"] },
  { id: "msdax", label: "DAX", extensions: ["dax", "msdax"] },
  { id: "mysql", label: "MySQL", extensions: [] },
  { id: "objective-c", label: "Objective-C", extensions: ["m", "mm"] },
  { id: "pascal", label: "Pascal", extensions: ["pas", "p", "pp"] },
  { id: "pascaligo", label: "Pascaligo", extensions: ["ligo"] },
  { id: "perl", label: "Perl", extensions: ["pl", "pm", "t", "pod"] },
  { id: "pgsql", label: "PostgreSQL", extensions: [] },
  { id: "php", label: "PHP", extensions: ["php", "php4", "php5", "phtml", "ctp"] },
  { id: "pla", label: "Pla", extensions: ["pla"] },
  { id: "postiats", label: "ATS", extensions: ["dats", "sats", "hats"] },
  { id: "powerquery", label: "Power Query", extensions: ["pq", "pqm"] },
  { id: "powershell", label: "PowerShell", extensions: ["ps1", "psm1", "psd1"] },
  { id: "proto", label: "Protocol Buffers", extensions: ["proto"] },
  { id: "pug", label: "Pug", extensions: ["jade", "pug"] },
  { id: "python", label: "Python", extensions: ["py", "pyw", "pyi", "pyx", "pxd", "rpy", "gyp", "gypi", "bzl"] },
  { id: "qsharp", label: "Q#", extensions: ["qs"] },
  { id: "r", label: "R", extensions: ["r", "rhistory", "rmd", "rprofile", "rt"] },
  { id: "razor", label: "Razor", extensions: ["cshtml", "vbhtml"] },
  { id: "redis", label: "Redis", extensions: ["redis"] },
  { id: "redshift", label: "Redshift", extensions: [] },
  { id: "restructuredtext", label: "reStructuredText", extensions: ["rst"] },
  { id: "ruby", label: "Ruby", extensions: ["rb", "rbx", "rjs", "gemspec", "podspec"] },
  { id: "rust", label: "Rust", extensions: ["rs", "rlib"] },
  { id: "sb", label: "Small Basic", extensions: ["sb"] },
  { id: "scala", label: "Scala", extensions: ["scala", "sc", "sbt"] },
  { id: "scheme", label: "Scheme", extensions: ["scm", "ss", "sch", "rkt", "el", "lisp"] },
  { id: "scss", label: "SCSS", extensions: ["scss", "sass"] },
  { id: "shell", label: "Shell Script", extensions: ["sh", "bash", "zsh", "fish", "ksh", "csh", "dash", "zsh-theme"] },
  { id: "sol", label: "Solidity", extensions: ["sol"] },
  { id: "sparql", label: "SPARQL", extensions: ["rq"] },
  { id: "sql", label: "SQL", extensions: ["sql"] },
  { id: "st", label: "Structured Text", extensions: ["st", "iecst", "iecplc", "lc3lib"] },
  { id: "swift", label: "Swift", extensions: ["swift"] },
  { id: "systemverilog", label: "SystemVerilog", extensions: ["sv", "svh"] },
  { id: "tcl", label: "Tcl", extensions: ["tcl"] },
  { id: "twig", label: "Twig", extensions: ["twig", "njk", "nunjucks", "j2", "jinja", "jinja2"] },
  { id: "typescript", label: "TypeScript", extensions: ["ts", "cts", "mts"] },
  // NOTE: tsx MUST map to typescriptreact — plain "typescript" has no JSX
  // parsing and paints the entire file red.
  { id: "typescriptreact", label: "TSX", extensions: ["tsx"] },
  { id: "typespec", label: "TypeSpec", extensions: ["tsp"] },
  { id: "vb", label: "Visual Basic", extensions: ["vb", "vbs", "vba", "bas"] },
  { id: "verilog", label: "Verilog", extensions: ["v", "vh"] },
  { id: "wgsl", label: "WGSL", extensions: ["wgsl"] },
  { id: "xml", label: "XML", extensions: ["xml", "xsd", "dtd", "plist", "iml", "rss", "atom", "fxml", "glade", "ui", "xib", "storyboard", "entitlements", "manifest", "nuspec", "resx", "wsf", "wsc", "svg", "svgz", "xaml", "csproj", "props", "targets", "opf", "xslt", "xsl", "ascx", "config", "wxi", "wxl", "wxs"] },
  { id: "yaml", label: "YAML", extensions: ["yaml", "yml", "eyaml"] },
];

/** Exact filename (lowercase basename, incl. dotfiles) -> language id. */
const FILE_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  jenkinsfile: "java",
  gemfile: "ruby",
  rakefile: "ruby",
  guardfile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  vagrantfile: "ruby",
  brewfile: "ruby",
  dangerfile: "ruby",
  berksfile: "ruby",
  "flake.lock": "json",
  "pipfile.lock": "json",
  "composer.lock": "json",
  "deno.lock": "json",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".containerignore": "ini",
  ".gitattributes": "ini",
  ".gitmodules": "ini",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".env": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".babelrc": "json",
  ".prettierrc": "json",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
};

/** Extension (lowercase, no dot) -> language id. Built from LANGUAGES. */
const EXT_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const lang of LANGUAGES) {
    for (const ext of lang.extensions) {
      if (!(ext in map)) map[ext] = lang.id;
    }
  }
  return map;
})();

export function languageLabel(id: string | undefined): string {
  if (!id) return "Plain Text";
  const found = LANGUAGES.find((l) => l.id === id);
  return found ? found.label : id;
}

/**
 * Map a file name to a Monaco language id.
 * Returns undefined for plain text / unknown.
 */
export function langFromName(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!base) return undefined;
  const exact = FILE_MAP[base];
  if (exact) return exact;
  if (base.startsWith("dockerfile.")) return "dockerfile";
  // dotfiles like ".gitconfig" have no real extension — try the name itself
  const ext = base.startsWith(".") && base.indexOf(".", 1) === -1
    ? base.slice(1)
    : base.slice(base.lastIndexOf(".") + 1);
  if (!ext || ext === base) return undefined;
  return EXT_MAP[ext];
}
