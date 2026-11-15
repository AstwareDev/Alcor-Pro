// In-memory MediaIo for tests (only imported by *.test.ts).
import type { FsEntry, MediaIo } from "./io";
import { lastPathComponent, parentPath } from "./paths";

interface Node {
  isDir: boolean;
  bytes: Uint8Array;
  modifiedMs: number;
}

export interface FakeIo extends MediaIo {
  addFile(path: string, bytes?: Uint8Array | string, modifiedMs?: number): void;
  addDir(path: string): void;
  denyList(path: string): void;
  has(path: string): boolean;
}

export function makeFakeIo(): FakeIo {
  const nodes = new Map<string, Node>();
  const denied = new Set<string>();

  const entry = (path: string, node: Node): FsEntry => ({
    name: lastPathComponent(path), path, isDir: node.isDir, size: node.bytes.length, modifiedMs: node.modifiedMs,
  });
  const ensureDirs = (path: string) => {
    for (let p = parentPath(path); p !== "" && !nodes.has(p); p = parentPath(p)) {
      nodes.set(p, { isDir: true, bytes: new Uint8Array(0), modifiedMs: 0 });
    }
  };
  const toBytes = (b: Uint8Array | string | undefined) =>
    b === undefined ? new Uint8Array(0) : typeof b === "string" ? new TextEncoder().encode(b) : b;

  return {
    addFile(path, bytes, modifiedMs = 1000) {
      ensureDirs(path);
      nodes.set(path, { isDir: false, bytes: toBytes(bytes), modifiedMs });
    },
    addDir(path) {
      ensureDirs(path);
      nodes.set(path, { isDir: true, bytes: new Uint8Array(0), modifiedMs: 0 });
    },
    denyList(path) {
      denied.add(path);
    },
    has: (path) => nodes.has(path),
    async stat(path) {
      const n = nodes.get(path);
      return n ? entry(path, n) : null;
    },
    async list(path) {
      if (denied.has(path) || !nodes.get(path)?.isDir) throw new Error(`cannot read ${path}`);
      return [...nodes].filter(([p]) => parentPath(p) === path).map(([p, n]) => entry(p, n));
    },
    async writeBytes(path, bytes) {
      ensureDirs(path);
      nodes.set(path, { isDir: false, bytes, modifiedMs: 2000 });
    },
    async readHead(path, length) {
      const n = nodes.get(path);
      if (!n) throw new Error(`missing ${path}`);
      return n.bytes.subarray(0, length);
    },
    async readAll(path) {
      const n = nodes.get(path);
      if (!n) throw new Error(`missing ${path}`);
      return n.bytes;
    },
    async copy(from, to) {
      const n = nodes.get(from);
      if (!n) throw new Error(`missing ${from}`);
      ensureDirs(to);
      nodes.set(to, { ...n });
    },
    async rename(from, to) {
      const n = nodes.get(from);
      if (!n) throw new Error(`missing ${from}`);
      ensureDirs(to);
      nodes.delete(from);
      nodes.set(to, n);
    },
    async mkdir(path) {
      if (!nodes.has(path)) nodes.set(path, { isDir: true, bytes: new Uint8Array(0), modifiedMs: 0 });
      ensureDirs(path);
    },
    async remove(path) {
      nodes.delete(path);
    },
    cacheDir: async () => "/cache",
    tempDir: async () => "/tmp",
  };
}
