/**
 * Streaming a Drive file to disk for drive_download_to_file.
 *
 * The folder comes only from operator config, and the caller may be able to
 * write into it (it is usually the caller's own mounted data folder). So the
 * file name is built here, never taken as given, and the folder is checked for
 * links before and after writing.
 */

import { randomBytes } from "crypto";
import { constants, createWriteStream, openSync, realpathSync, renameSync, statSync, unlinkSync } from "fs";
import { dirname, join, posix } from "path";
import { Transform, type Readable } from "stream";
import { pipeline } from "stream/promises";
import type { DownloadDir } from "../types.js";

export const DEFAULT_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Under the broker's four-minute tool limit, so a slow download is stopped and cleaned up here. */
export const DOWNLOAD_TIMEOUT_MS = 220_000;
/** Drive IDs are letters, numbers, - and _. Capped so name + ID stays under 255 bytes. */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_BYTES = 150;

class TooLarge extends Error {}
class FolderChanged extends Error {}

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

/** The download folder, as long as it is still the real folder that was configured. */
function checkedFolder(dir: DownloadDir): string {
  let real: string;
  try {
    real = realpathSync(dir.hostDir);
  } catch {
    throw new FolderChanged("The download folder is missing, so nothing was written. An operator has to recreate it.");
  }
  if (real !== dir.hostDir || !statSync(real).isDirectory()) {
    throw new FolderChanged("The download folder was moved or replaced by a link, so nothing was written.");
  }
  return real;
}

/**
 * Stream `open()`'s body into `<fileId>-<safe name>` in the download folder.
 * Writes to a temporary file first, so a failed download leaves nothing and a
 * failed re-download keeps the earlier copy. Returns the caller-visible path.
 */
export async function writeDownload(
  dir: DownloadDir,
  fileId: string,
  name: string,
  open: (signal: AbortSignal) => Promise<Readable>,
): Promise<{ path: string; size: number }> {
  if (!DRIVE_FILE_ID.test(fileId)) throw new Error("Drive returned a file id that can't be used in a file name");
  const folder = checkedFolder(dir);
  const fileName = `${fileId}-${safeFileName(name)}`;
  const target = join(folder, fileName);
  if (dirname(target) !== folder) throw new Error("Refusing a file name that leaves the download folder");
  const temp = join(folder, `.${fileId}.${randomBytes(6).toString("hex")}.part`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let written = 0;
  let body: Readable | undefined;
  try {
    body = await open(controller.signal);
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written > dir.maxBytes) done(new TooLarge());
        else done(null, chunk);
      },
    });
    // O_EXCL and O_NOFOLLOW: never write through a link or into an existing file.
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    const out = createWriteStream(temp, { fd });
    await pipeline(body, count, out, { signal: controller.signal });
    if (checkedFolder(dir) !== folder) throw new FolderChanged("The download folder changed while writing.");
    renameSync(temp, target);
  } catch (err) {
    body?.destroy();
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already gone.
    }
    if (err instanceof TooLarge) throw new Error(`File is over the ${formatLimit(dir.maxBytes)} download limit`);
    if (err instanceof FolderChanged) throw new Error(err.message);
    if (controller.signal.aborted) throw new Error("The download took too long and was stopped; nothing was kept.");
    // A file-system code, not the message, which names host paths.
    const code = (err as NodeJS.ErrnoException)?.code;
    const reason = code && /^E[A-Z]+$/.test(code) ? code : err instanceof Error ? err.message : String(err);
    throw new Error(`Download failed (${reason}); nothing was kept.`);
  } finally {
    clearTimeout(timer);
  }
  return { path: posix.join(dir.callerDir, fileName), size: written };
}
