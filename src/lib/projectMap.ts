import { invoke } from "@tauri-apps/api/core";

const SKIP = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

const KEY_FILES = [
  "readme.md",
  "package.json",
  "cargo.toml",
  "pyproject.toml",
  "go.mod",
  "dockerfile",
  "docker-compose.yml",
  "agents.md",
  "claude.md",
];

/** Compact project map: tree (depth ≤ 3) + counts + key files. */
export async function buildProjectMap(root: string): Promise<string> {
  const all = await invoke<string[]>("fs_list_all", { path: root, max: 5000 }).catch(
    () => [] as string[],
  );
  const norm = (p: string) => p.replace(/\\/g, "/");
  const rels = all
    .map((p) => {
      const n = norm(p);
      const r = norm(root);
      return n.startsWith(r) ? n.slice(r.length).replace(/^\/+/, "") : null;
    })
    .filter((p): p is string => !!p && !p.split("/").some((s) => SKIP.has(s.toLowerCase())))
    .slice(0, 3000);

  const dirs = new Set<string>();
  const files: string[] = [];
  for (const p of rels) {
    const parts = p.split("/");
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      files.push(p);
    }
  }
  const tree: string[] = [];
  const sortedDirs = [...dirs]
    .filter((d) => d.split("/").length <= 3)
    .sort()
    .slice(0, 120);
  for (const d of sortedDirs) {
    const depth = d.split("/").length - 1;
    tree.push(`${"  ".repeat(depth)}${d.split("/").pop()}/`);
  }
  const topFiles = files
    .filter((f) => f.split("/").length <= 3)
    .sort()
    .slice(0, 60);
  for (const f of topFiles) {
    const depth = f.split("/").length - 1;
    tree.push(`${"  ".repeat(depth)}${f.split("/").pop()}`);
  }
  const key = files.filter((f) =>
    KEY_FILES.includes(f.split("/").pop()!.toLowerCase()),
  );

  return [
    `Дерево проекта (обрезано до 3 уровней, всего файлов: ${files.length}, папок: ${dirs.size}):`,
    "```",
    ...tree.slice(0, 200),
    "```",
    key.length > 0 ? `Ключевые файлы: ${key.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Send the map to chat asking for an onboarding summary. */
export async function sendProjectOverview(root: string): Promise<void> {
  const map = await buildProjectMap(root);
  const { useChatStore } = await import("../stores/chatStore");
  const chat = useChatStore.getState();
  let sid = chat.activeId;
  if (!sid) {
    const created = await chat.createSession().catch(() => null);
    sid = created?.id ?? null;
    if (!sid) throw new Error("no chat session");
  }
  await chat.send(
    `Сделай краткий онбординг по проекту: структура, точка входа, ` +
      `как запустить/собрать, где что лежит. Отвечай по-русски, коротко.\n\n${map}`,
  );
  const { useUiStore } = await import("../stores/uiStore");
  useUiStore.getState().setAiPanelOpen(true);
}
