import type { ClipType } from "../model";
import type { MediaIo } from "./io";
import { clipTypeForPath, isLottieHeader, lottieSniffByteLimit } from "./mediaTypes";
import { fileStem, lastPathComponent } from "./paths";

/** `MediaImportPlan`: what a Finder drop / open panel selection will create. */
export type PlanParent = { kind: "existing"; folderId: string | undefined } | { kind: "planned"; index: number };

export interface PlannedFolder {
  name: string;
  parent: PlanParent;
}

export interface PlannedFile {
  path: string;
  type: ClipType;
  name: string;
  parent: PlanParent;
}

export interface MediaImportPlan {
  folders: PlannedFolder[];
  files: PlannedFile[];
  rejectedUnsupportedNames: string[];
  rejectedLottieNames: string[];
}

export interface ImportRoot {
  path: string;
  parentFolderId: string | undefined;
}

type ScanIo = Pick<MediaIo, "stat" | "list" | "readHead">;

export function emptyImportPlan(): MediaImportPlan {
  return { folders: [], files: [], rejectedUnsupportedNames: [], rejectedLottieNames: [] };
}

const standardCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export async function scanImportRoots(io: ScanIo, roots: readonly ImportRoot[]): Promise<MediaImportPlan> {
  const plan = emptyImportPlan();
  for (const root of roots) {
    const parent: PlanParent = { kind: "existing", folderId: root.parentFolderId };
    const stat = await io.stat(root.path);
    if (stat?.isDir) await scanFolder(io, root.path, parent, plan);
    else await scanFile(io, root.path, parent, true, plan);
  }
  return plan;
}

async function scanFolder(io: ScanIo, path: string, parent: PlanParent, plan: MediaImportPlan): Promise<void> {
  let entries;
  try {
    entries = await io.list(path);
  } catch {
    return; // unreadable directory: no folder is created
  }
  const folderIndex = plan.folders.length;
  plan.folders.push({ name: lastPathComponent(path), parent });
  const visible = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => standardCompare.compare(a.name, b.name));
  const child: PlanParent = { kind: "planned", index: folderIndex };
  for (const entry of visible) {
    if (entry.isDir) await scanFolder(io, entry.path, child, plan);
    else await scanFile(io, entry.path, child, false, plan);
  }
}

export async function isLottieFile(io: ScanIo, path: string): Promise<boolean> {
  try {
    return isLottieHeader(path, await io.readHead(path, lottieSniffByteLimit));
  } catch {
    return false;
  }
}

async function scanFile(io: ScanIo, path: string, parent: PlanParent, isRootItem: boolean, plan: MediaImportPlan): Promise<void> {
  const type = clipTypeForPath(path);
  if (type === undefined) {
    if (isRootItem) plan.rejectedUnsupportedNames.push(lastPathComponent(path));
    return;
  }
  if (type === "lottie" && !(await isLottieFile(io, path))) {
    plan.rejectedLottieNames.push(lastPathComponent(path));
    return;
  }
  plan.files.push({ path, type, name: fileStem(path), parent });
}
