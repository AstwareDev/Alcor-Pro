import { newId } from "../util/id";
import { asObject, getString, optString } from "../util/jsonDecode";

export interface MediaFolder {
  id: string;
  name: string;
  parentFolderId?: string;
}

export function makeMediaFolder(p: { id?: string; name: string; parentFolderId?: string }): MediaFolder {
  const f: MediaFolder = { id: p.id ?? newId(), name: p.name };
  if (p.parentFolderId !== undefined) f.parentFolderId = p.parentFolderId;
  return f;
}

export function decodeMediaFolder(json: unknown): MediaFolder {
  const c = asObject(json, "MediaFolder");
  return makeMediaFolder({
    id: getString(c, "id"),
    name: getString(c, "name"),
    parentFolderId: optString(c, "parentFolderId"),
  });
}
