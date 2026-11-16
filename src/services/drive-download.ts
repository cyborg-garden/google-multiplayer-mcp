/**
 * Streaming a Drive file to disk for drive_download_to_file.
 *
 * The folder comes only from operator config. If the caller can write into it
 * or its parent (for example its own mounted data folder), it could swap the
 * folder for a link at any moment. So the file name is built here, the file is
 * created before any network wait, and the open file is matched by device and
 * inode against the expected entry before the download, before the rename and
 * after it.
 */

import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  type Stats,
} from "fs";
import { dirname, join, posix } from "path";
import { Transform, type Readable } from "stream";
import { pipeline } from "stream/promises";
import type { DownloadDir } from "../types.js";

const GB = 1024 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 2 * GB;
export const DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES = 10 * GB;
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT = 2;
export const DEFAULT_DOWNLOAD_MIN_FREE_BYTES = 5 * GB;
/** Under the broker's four-minute tool limit, so a slow download is stopped and cleaned up here. */
export const DOWNLOAD_TIMEOUT_MS = 220_000;
/** Drive IDs are letters, numbers, - and _. Capped so the stored name stays under 255 bytes. */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_BYTES = 150;
const NOT_KEPT = "nothing was kept";

/** A refusal whose message is safe to show the caller as is. */
class Refused extends Error {}

export function formatLimit(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${+(mb / 1024).toFixed(2)} GB` : `${+mb.toFixed(2)} MB`;
}

/** Cut a string to a byte budget without splitting a character. */
function takeBytes(text: string, budget: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * A Drive name made safe as one path segment: no separators, no control
 * characters, no leading dots, at most MAX_NAME_BYTES, extension kept.
 */
export function safeFileName(name: string): string {
  let s = name
    .normalize("NFC")
    .replace(/[/\\\u0000-\u001f\u007f-\u009f]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (!s) s = "file";
  if (Buffer.byteLength(s) <= MAX_NAME_BYTES) return s;
  const ext = /\.[A-Za-z0-9]{1,16}$/.exec(s)?.[0] ?? "";
  return takeBytes(s.slice(0, s.length - ext.length), MAX_NAME_BYTES - ext.length) + ext;
}

/**
 * `<id>-<hash>-<safe name>`. The hash is of the exact id, so two ids that
 * differ only by case still get different names on a case-insensitive disk.
 */
export function storedFileName(fileId: string, name: string): string {
  const tag = createHash("sha256").update(fileId).digest("hex").slice(0, 8);
  return `${fileId}-${tag}-${safeFileName(name)}`;
}

interface Folder {
  path: string;
  dev: number;
  ino: number;
}

/** The download folder, as long as it is still the real folder that was configured. */
function checkedFolder(dir: DownloadDir): Folder {
  let real: string;
  let stat: Stats;
  try {
    real = realpathSync(dir.hostDir);
    stat = statSync(real);
  } catch {
    throw new Refused(`The download folder is missing, so ${NOT_KEPT}. An operator has to recreate it.`);
  }
  if (real !== dir.hostDir || !stat.isDirectory()) {
    throw new Refused(`The download folder was moved or replaced by a link, so ${NOT_KEPT}.`);
  }
  return { path: real, dev: stat.dev, ino: stat.ino };
}

/** The folder is unchanged, and `entry` in it is the very file we hold open. */
function verifyEntry(dir: DownloadDir, folder: Folder, entry: string, opened: Stats): void {
  const now = checkedFolder(dir);
  const changed = new Refused(`The download folder changed during the download, so ${NOT_KEPT}.`);
  if (now.dev !== folder.dev || now.ino !== folder.ino) throw changed;
  let stat: Stats;
  try {
    stat = lstatSync(join(folder.path, entry));
  } catch {
    throw changed;
  }
  if (!stat.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) throw changed;
}

interface Activity {
  count: number;
  /** Bytes held back for each running download, by temporary file name. */
  reserved: Map<string, number>;
}

/** Downloads running now, per download folder. */
const activity = new Map<string, Activity>();

/** Our temporary files: `.<id>.<hex>.part`. */
const PART_FILE = /^\.[A-Za-z0-9_-]+\.[0-9a-f]+\.part$/;
/** Far longer than any download may run, so an older partial file is left from a crash. */
const STALE_PART_MS = 60 * 60 * 1000;

function isStalePart(name: string, stat: Stats, now: number): boolean {
  return PART_FILE.test(name) && stat.isFile() && now - stat.mtimeMs > STALE_PART_MS;
}

/**
 * Remove partial files a crashed broker left behind. A caller with a
 * read-only mount can't remove them, and they count against its quota.
 */
export function sweepStaleParts(folder: string, skip: ReadonlySet<string> | Map<string, number> = new Set()): void {
  const now = Date.now();
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || skip.has(entry.name)) continue;
    const path = join(folder, entry.name);
    try {
      if (isStalePart(entry.name, lstatSync(path), now)) unlinkSync(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** Bytes in regular files directly in the folder, leaving out running downloads. */
function folderUsage(folder: string, running: Activity): number {
  sweepStaleParts(folder, running.reserved);
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || running.reserved.has(entry.name)) continue;
    try {
      total += lstatSync(join(folder, entry.name)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return total;
}

function sizeIfFile(path: string): number {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Stream `open()`'s body into the download folder and return the
 * caller-visible path. Writes to a temporary file first, so a failed download
 * leaves nothing and a failed re-download keeps the earlier copy.
 */
export async function writeDownload(
  dir: DownloadDir,
  fileId: string,
  name: string,
  statedSize: number | undefined,
  open: (signal: AbortSignal) => Promise<Readable>,
): Promise<{ path: string; size: number }> {
  if (!DRIVE_FILE_ID.test(fileId)) throw new Error("Drive returned a file id that can't be used in a file name");
  if (statedSize !== undefined && statedSize > dir.maxBytes) {
    throw new Error(`File is over the ${formatLimit(dir.maxBytes)} download limit`);
  }

  const running = activity.get(dir.hostDir) ?? { count: 0, reserved: new Map<string, number>() };
  activity.set(dir.hostDir, running);
  if (running.count >= dir.maxConcurrent) {
    throw new Error(`Only ${dir.maxConcurrent} downloads can run at once; try again when one finishes.`);
  }
  running.count++;

  const fileName = storedFileName(fileId, name);
  const tempName = `.${fileId}.${randomBytes(6).toString("hex")}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let fd: number | undefined;
  /** Only once the temporary file is proven to be ours is it removed by path. */
  let ownTemp = false;
  let body: Readable | undefined;
  let written = 0;

  try {
    const folder = checkedFolder(dir);
    const temp = join(folder.path, tempName);
    const target = join(folder.path, fileName);
    if (dirname(target) !== folder.path) throw new Refused("Refusing a file name that leaves the download folder");

    // Quota and free space, counting downloads that are still running.
    const others = [...running.reserved.values()].reduce((a, b) => a + b, 0);
    const used = folderUsage(folder.path, running) - sizeIfFile(target);
    const limit = Math.min(dir.maxBytes, dir.maxTotalBytes - used - others);
    const overQuota = new Refused(
      `This would take the download folder over its ${formatLimit(dir.maxTotalBytes)} quota; remove old downloads first.`,
    );
    if (limit <= 0 || (statedSize !== undefined && statedSize > limit)) throw overQuota;
    // What's reserved is exactly what may be written: Drive's stated size,
    // or the whole remaining allowance when it states none.
    const reserve = statedSize ?? limit;
    const disk = statfsSync(folder.path);
    if (Number(disk.bavail) * Number(disk.bsize) - others - reserve < dir.minFreeBytes) {
      throw new Refused("The disk is nearly full, so the download wasn't started.");
    }
    running.reserved.set(tempName, reserve);

    // Create the file before any network wait. O_EXCL and O_NOFOLLOW: never
    // write through a link or into an existing file.
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    const opened = fstatSync(fd);
    verifyEntry(dir, folder, tempName, opened);
    ownTemp = true;

    body = await open(controller.signal);
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written <= reserve) return done(null, chunk);
        if (statedSize !== undefined) return done(new Refused(`Drive sent more than the file's stated size, so ${NOT_KEPT}.`));
        done(limit < dir.maxBytes ? overQuota : new Refused(`File is over the ${formatLimit(dir.maxBytes)} download limit`));
      },
    });
    await pipeline(body, count, createWriteStream(temp, { fd, autoClose: false }), { signal: controller.signal });
    closeSync(fd);
    fd = undefined;

    verifyEntry(dir, folder, tempName, opened);
    renameSync(temp, target);
    ownTemp = false;
    try {
      verifyEntry(dir, folder, fileName, opened);
    } catch {
      // The file was moved into place, so don't claim nothing was kept.
      throw new Refused(
        "The download folder changed as the file was moved into place. The file may be in the folder, but it couldn't be confirmed; check before using it.",
      );
    }
  } catch (err) {
    body?.destroy();
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    if (ownTemp) {
      // If the folder was swapped, this finds nothing; the partial file stays
      // in the caller's own, moved folder.
      try {
        unlinkSync(join(dir.hostDir, tempName));
      } catch {
        // Already gone.
      }
    }
    if (err instanceof Refused) throw new Error(err.message);
    if (controller.signal.aborted) throw new Error(`The download took too long and was stopped; ${NOT_KEPT}.`);
    // A file-system error names host paths, so give only its code.
    const e = err as NodeJS.ErrnoException;
    const fsError = e?.syscall || e?.path || (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code));
    const reason = fsError ? (e.code ?? "file error") : err instanceof Error ? err.message : String(err);
    throw new Error(`Download failed (${reason}); ${NOT_KEPT}.`);
  } finally {
    clearTimeout(timer);
    running.count--;
    running.reserved.delete(tempName);
  }
  return { path: posix.join(dir.callerDir, fileName), size: written };
}
