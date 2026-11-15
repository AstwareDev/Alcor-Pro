// Swift URL/NSString path-component semantics on plain Windows or POSIX path strings.

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function lastPathComponent(path: string): string {
  const trimmed = stripTrailingSeparators(path);
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** `pathExtension`: text after the last dot of the last component; empty for leading-dot-only or trailing-dot names. */
export function pathExtension(path: string): string {
  const name = lastPathComponent(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** `deletingPathExtension().lastPathComponent` */
export function fileStem(path: string): string {
  const name = lastPathComponent(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** `URL.hasDirectoryPath`: true for a trailing separator, without touching the disk. */
export function hasDirectoryPath(path: string): boolean {
  return /[\\/]$/.test(path);
}

export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

export function parentPath(path: string): string {
  const trimmed = stripTrailingSeparators(path);
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i < 0 ? "" : trimmed.slice(0, i);
}
