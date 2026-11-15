// In-memory FileSystem for tests and the browser dev page. Not used by app code.
import type { DirEntry, FileSystem } from "./fileSystem";
import { basename, dirname, normalizePath } from "./projectPaths";

type Node = { dir: true } | { dir: false; data: Uint8Array };

const enc = new TextEncoder();
const dec = new TextDecoder();

export type FsOp = "readText" | "writeText" | "writeBytes" | "exists" | "list" | "mkdir" | "copy" | "rename" | "remove";

export class MemoryFileSystem implements FileSystem {
  private readonly nodes = new Map<string, Node>();
  /** Awaited before every operation; throw or return a pending promise to inject failures or gates. */
  before?: (op: FsOp, path: string) => void | Promise<void>;
  readonly writes: string[] = [];

  private async gate(op: FsOp, path: string): Promise<string> {
    await this.before?.(op, path);
    return normalizePath(path);
  }

  private ensureParents(path: string): void {
    for (let d = dirname(path); d !== "" && !this.nodes.has(d); d = dirname(d)) {
      this.nodes.set(d, { dir: true });
      if (dirname(d) === d) break;
    }
  }

  private put(path: string, data: Uint8Array): void {
    if (this.nodes.get(path)?.dir) throw new Error(`${path}: is a directory`);
    this.ensureParents(path);
    this.nodes.set(path, { dir: false, data });
    this.writes.push(path);
  }

  private file(path: string): Uint8Array {
    const n = this.nodes.get(path);
    if (!n) throw new Error(`${path}: not found`);
    if (n.dir) throw new Error(`${path}: is a directory`);
    return n.data;
  }

  /** Synchronous test seeding and inspection. */
  seedText(path: string, text: string): void {
    this.put(normalizePath(path), enc.encode(text));
  }
  seedBytes(path: string, bytes: Uint8Array): void {
    this.put(normalizePath(path), bytes);
  }
  seedDir(path: string): void {
    const p = normalizePath(path);
    this.ensureParents(p);
    this.nodes.set(p, { dir: true });
  }
  text(path: string): string {
    return dec.decode(this.file(normalizePath(path)));
  }
  bytes(path: string): Uint8Array {
    return this.file(normalizePath(path));
  }
  has(path: string): boolean {
    return this.nodes.has(normalizePath(path));
  }
  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }

  async readText(path: string): Promise<string> {
    return dec.decode(this.file(await this.gate("readText", path)));
  }
  async writeText(path: string, contents: string): Promise<void> {
    this.put(await this.gate("writeText", path), enc.encode(contents));
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.put(await this.gate("writeBytes", path), bytes.slice());
  }
  async exists(path: string): Promise<boolean> {
    return this.nodes.has(await this.gate("exists", path));
  }
  async isDirectory(path: string): Promise<boolean> {
    return this.nodes.get(normalizePath(path))?.dir === true;
  }
  async list(path: string): Promise<DirEntry[]> {
    const p = await this.gate("list", path);
    if (!this.nodes.get(p)?.dir) throw new Error(`${p}: not a directory`);
    const out: DirEntry[] = [];
    for (const [key, node] of this.nodes) {
      if (key !== p && dirname(key) === p) out.push({ name: basename(key), path: key, isDir: node.dir });
    }
    return out;
  }
  async mkdir(path: string): Promise<void> {
    const p = await this.gate("mkdir", path);
    if (this.nodes.has(p) && !this.nodes.get(p)?.dir) throw new Error(`${p}: exists as a file`);
    this.ensureParents(p);
    this.nodes.set(p, { dir: true });
  }
  async copy(from: string, to: string): Promise<void> {
    const dest = await this.gate("copy", to);
    this.put(dest, this.file(normalizePath(from)).slice());
  }
  async rename(from: string, to: string): Promise<void> {
    const src = await this.gate("rename", from);
    const dest = normalizePath(to);
    if (!this.nodes.has(src)) throw new Error(`${src}: not found`);
    this.ensureParents(dest);
    const moved = [...this.nodes.entries()].filter(([k]) => k === src || k.startsWith(src + "/"));
    for (const [k] of moved) this.nodes.delete(k);
    for (const [k, v] of moved) this.nodes.set(dest + k.slice(src.length), v);
  }
  async remove(path: string): Promise<void> {
    const p = await this.gate("remove", path);
    for (const k of [...this.nodes.keys()]) if (k === p || k.startsWith(p + "/")) this.nodes.delete(k);
  }
}
