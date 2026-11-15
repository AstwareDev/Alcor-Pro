// Path-string helpers for Windows or POSIX paths. Identity is separator- and (Windows) case-insensitive.

/** `URL.standardizedFileURL.path`: forward slashes, `.`/`..` resolved, no trailing separator. */
export function normalizePath(path: string): string {
  const s = path.replace(/\\/g, "/");
  const unc = s.startsWith("//");
  const drive = /^[a-zA-Z]:/.exec(s)?.[0] ?? "";
  const rest = s.slice(drive.length);
  const absolute = rest.startsWith("/");
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  const prefix = unc ? "//" : drive + (absolute ? "/" : "");
  return prefix + parts.join("/");
}

/** Equality key for "same file" comparisons. */
export function pathKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export function joinPath(base: string, component: string): string {
  return normalizePath(`${base}/${component}`);
}

export function basename(path: string): string {
  const n = normalizePath(path);
  return n.slice(n.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  const n = normalizePath(path);
  const i = n.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 || n[i - 1] === ":" ? n.slice(0, i + 1) : n.slice(0, i);
}

/** `deletingPathExtension().lastPathComponent` */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Display name of a project package: `deletingPathExtension().lastPathComponent`. */
export function projectNameFromPath(path: string): string {
  return stem(path);
}

/** The Windows spelling used when handing a path to the OS shell. */
export function nativePath(path: string): string {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("//") ? path.replace(/\//g, "\\") : path;
}
