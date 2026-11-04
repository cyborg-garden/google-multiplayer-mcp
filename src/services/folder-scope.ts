/**
 * Folder scoping — shared, recursive folder-tree membership logic.
 *
 * An agent is granted a set of allowed ROOT folders. Everything inside those
 * roots — at any depth — is in scope. Two complementary primitives:
 *
 *   - `isWithinAllowedFolders(drive, fileId, allowed)` — walks UP the parent
 *     chain of an arbitrary file/folder to decide membership. Correct for
 *     access checks on a single known id (drive_get, docs_get, etc.).
 *
 *   - `resolveAllowedFolderTree(drive, allowed)` — walks DOWN from each root,
 *     enumerating every descendant folder id. Used to scope discovery queries
 *     (drive_list / drive_search) and to gate writes into subfolders.
 *
 * Both follow `nextPageToken`, cap depth, and guard against cycles. The
 * downward resolution is cached with a short TTL keyed by the sorted root list,
 * because it can issue many Drive API calls for deep trees.
 */

import { google } from "googleapis";

type DriveClient = ReturnType<typeof google.drive>;

const MAX_DEPTH = 10;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Recursively check whether a file (by ID) lives anywhere within the allowed
 * folder trees, walking up the parent chain via the Drive API.
 *
 * @param drive          Authenticated Drive API client
 * @param fileId         ID of the file or folder to check
 * @param allowedFolders Set of allowed root folder IDs (empty = no restriction)
 * @param visited        (internal) cache of resolved IDs to prevent cycles
 * @param depth          (internal) recursion depth guard
 */
export async function isWithinAllowedFolders(
  drive: DriveClient,
  fileId: string,
  allowedFolders: string[],
  visited: Set<string> = new Set(),
  depth = 0,
): Promise<boolean> {
  if (allowedFolders.length === 0) return true;
  // An allowed root is trivially within itself.
  if (allowedFolders.includes(fileId)) return true;
  if (depth > MAX_DEPTH || visited.has(fileId)) return false;
  visited.add(fileId);

  const meta = await drive.files.get({
    fileId,
    fields: "parents",
    supportsAllDrives: true,
  });

  const parents = meta.data.parents ?? [];
  if (parents.length === 0) return false;

  // Direct match
  if (parents.some((p) => allowedFolders.includes(p))) return true;

  // Recurse up each parent
  for (const parentId of parents) {
    if (await isWithinAllowedFolders(drive, parentId, allowedFolders, visited, depth + 1)) {
      return true;
    }
  }

  return false;
}

interface TreeCacheEntry {
  expires: number;
  promise: Promise<Set<string>>;
  generation: number;
}

const TREE_TTL_MS = 30_000;
const treeCache = new WeakMap<object, Map<string, TreeCacheEntry>>();
let treeGeneration = 0;

/** Clear the resolved-tree cache. Call after creating/moving folders. */
export function invalidateFolderTreeCache(): void {
  treeGeneration++;
}

/**
 * Resolve the full set of folder IDs reachable from the allowed roots,
 * including the roots themselves and every descendant folder (BFS, downward).
 *
 * Returns an empty set when `allowedFolders` is empty — callers MUST treat an
 * empty allowed list as "no restriction" rather than "nothing allowed".
 *
 * Follows pagination, caps depth, and guards cycles. Cached with a short TTL,
 * per client and sorted root list.
 */
export async function resolveAllowedFolderTree(
  drive: DriveClient,
  allowedFolders: string[],
): Promise<Set<string>> {
  if (allowedFolders.length === 0) return new Set();

  const key = [...allowedFolders].sort().join(",");
  const now = Date.now();
  // Each client has its own cache: credentials can see different trees, and
  // one credential's failure must not reach another.
  let cache = treeCache.get(drive);
  if (!cache) {
    cache = new Map();
    treeCache.set(drive, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expires > now && cached.generation === treeGeneration) return cached.promise;

  const promise = bfsFolderTree(drive, allowedFolders);
  cache.set(key, { expires: now + TREE_TTL_MS, promise, generation: treeGeneration });

  try {
    return await promise;
  } catch (err) {
    // Don't cache failures.
    cache.delete(key);
    throw err;
  }
}

async function bfsFolderTree(
  drive: DriveClient,
  roots: string[],
): Promise<Set<string>> {
  const resolved = new Set<string>(roots);
  // Queue of [folderId, depth]
  const queue: Array<[string, number]> = roots.map((id) => [id, 0]);

  while (queue.length > 0) {
    const [folderId, depth] = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='${FOLDER_MIME}' and trashed = false`,
        fields: "nextPageToken, files(id)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const child of res.data.files ?? []) {
        const id = child.id;
        if (!id || resolved.has(id)) continue; // cycle / already-seen guard
        resolved.add(id);
        queue.push([id, depth + 1]);
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return resolved;
}
