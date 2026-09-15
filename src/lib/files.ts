const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "svg",
  "ico",
  "avif",
]);

/** True for raster/vector images that should preview, not open as text. */
export function isImageFile(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTS.has(base.slice(dot + 1).toLowerCase());
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
