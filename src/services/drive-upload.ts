/**
 * Opening a local file for drive_upload_from_file.
 *
 * The agent names a file in its upload folder (the one `upload_dir` maps), and
 * this process reads it on the agent's behalf. The agent can write to that
 * folder and often to its parents, so it can swap the folder for a link to
 * someone else's at any instant. No sequence of checks made by path survives
 * that: each check can be answered by a different folder.
 *
 * So the file is never opened by its full path. A short-lived reader process
 * is started inside the folder. Its working directory is a hold on one
 * directory, whatever happens to the path afterwards. The reader confirms
 * that directory is the one recorded when the config was loaded (device and
 * inode), then opens the file by bare name, relative to it, without following
 * links. Whatever it opens is an entry of the real upload folder.
 */

import { spawn } from "child_process";
import { statSync } from "fs";
import { posix } from "path";
import { PassThrough, type Readable } from "stream";
import type { UploadDir } from "../types.js";
import { formatLimit } from "./drive-download.js";

/** Chosen from the file name when the caller gives no MIME type. */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", ogg: "audio/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip", json: "application/json",
  csv: "text/csv", txt: "text/plain", md: "text/markdown", html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessMimeType(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase();
  return (ext && MIME_BY_EXTENSION[ext]) || "application/octet-stream";
}

/** The folder's identity, to record in config and compare on every upload. */
export function folderIdentity(path: string): { dev: string; ino: string } {
  const stat = statSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** Most uploads running at once from one folder. Each holds a process and a Drive connection. */
export const UPLOAD_MAX_CONCURRENT = 2;
/** Opening a local file takes milliseconds. Past this, the reader is stuck and is stopped. */
const OPEN_TIMEOUT_MS = 15_000;
const running = new Map<string, number>();

/**
 * The reader. Arguments: device, inode, file name, size limit. It answers on
 * descriptor 3 with one JSON line, then writes exactly `size` bytes to stdout.
 */
const READER = `
const fs = require("fs");
const [dev, ino, name, max] = process.argv.slice(1);
const answer = (o) => fs.writeSync(3, JSON.stringify(o) + "\\n");
try {
  const here = fs.statSync(".", { bigint: true });
  if (String(here.dev) !== dev || String(here.ino) !== ino) { answer({ refused: "moved" }); process.exit(0); }
  const c = fs.constants;
  let fd;
  try {
    fd = fs.openSync(name, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | c.O_NOCTTY);
  } catch (e) {
    answer({ refused: e.code === "ENOENT" ? "missing" : e.code === "ELOOP" || e.code === "EMLINK" ? "link" : "open", code: e.code });
    process.exit(0);
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) { answer({ refused: "kind" }); process.exit(0); }
  if (stat.size > Number(max)) { answer({ refused: "size" }); process.exit(0); }
  answer({ size: stat.size });
  if (stat.size === 0) process.exit(0);
  // "end" pins the upload to the size just reported, even if the file grows.
  fs.createReadStream("", { fd, start: 0, end: stat.size - 1 }).pipe(process.stdout);
} catch (e) {
  try { answer({ refused: "open", code: e && e.code }); } catch (_) {}
  process.exit(0);
}
`;

export interface OpenedUpload {
  /** The file's last path segment, as the agent named it. */
  name: string;
  size: number;
  /** Exactly `size` bytes. */
  stream: Readable;
  /** Stop reading and give back the upload slot. Call when the upload ends, however it ends. */
  close: () => void;
  /** Settles once the reader process has gone. */
  closed: Promise<void>;
}

/**
 * Open `callerPath` for reading, if it is a regular file sitting directly in
 * the upload folder. Every refusal is worded for the agent and names only the
 * path the agent itself uses.
 */
export async function openUpload(dir: UploadDir, callerPath: unknown): Promise<OpenedUpload> {
  const where = `a file directly inside ${dir.callerDir}`;
  if (typeof callerPath !== "string" || !posix.isAbsolute(callerPath) || callerPath.includes("\0")) {
    throw new Error(`path must be the full path of ${where}`);
  }
  const name = posix.basename(callerPath);
  // Compared as written: `..` segments are never resolved on the agent's behalf.
  if (callerPath !== posix.join(dir.callerDir, name) || name === "." || name === "..") {
    throw new Error(`path must be ${where}; copy the file there first`);
  }
  if (name.startsWith(".")) throw new Error("Hidden and unfinished files can't be uploaded");

  const active = running.get(dir.hostDir) ?? 0;
  if (active >= UPLOAD_MAX_CONCURRENT) {
    throw new Error(`Only ${UPLOAD_MAX_CONCURRENT} uploads can run at once; try again when one finishes.`);
  }
  running.set(dir.hostDir, active + 1);

  const moved = "Your upload folder is missing or was replaced by a link, so nothing was uploaded.";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["-e", READER, dir.dev, dir.ino, name, String(dir.maxBytes)], {
      cwd: dir.hostDir,
      env: {},
      stdio: ["ignore", "pipe", "ignore", "pipe"],
    });
  } catch {
    running.set(dir.hostDir, (running.get(dir.hostDir) ?? 1) - 1);
    throw new Error(moved);
  }

  // Node throws away whatever a finished child left unread on its stdout, and a
  // small file is written and the reader gone before anyone asks for it. Piping
  // from the start keeps every byte; the pipe's own limit holds a large file back.
  const out = new PassThrough();
  child.stdout?.pipe(out);

  const closed = new Promise<void>((done) => {
    child.once("exit", () => done());
    // A folder that is gone fails the spawn itself; there is no exit after that.
    child.once("error", () => done());
  });
  let released = false;
  const close = () => {
    if (!released) {
      released = true;
      running.set(dir.hostDir, (running.get(dir.hostDir) ?? 1) - 1);
    }
    out.destroy();
    child.stdout?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  try {
    const answer = await new Promise<{ size?: number; refused?: string; code?: string }>((resolve) => {
      let text = "";
      const control = child.stdio[3] as Readable;
      control.setEncoding("utf8");
      const settle = () => {
        try {
          resolve(JSON.parse(text.split("\n")[0]));
        } catch {
          // No answer at all: the reader never started, as when the folder is not a folder.
          resolve({ refused: "moved" });
        }
      };
      control.on("data", (d: string) => {
        text += d;
        // One line is the whole answer. Waiting for the reader to finish would
        // wait forever on a large file, which it can't finish until it is read.
        if (text.includes("\n") || text.length > 4096) settle();
      });
      control.once("close", settle);
      setTimeout(() => resolve({ refused: "open", code: "ETIMEDOUT" }), OPEN_TIMEOUT_MS).unref();
      child.once("error", () => resolve({ refused: "moved" }));
    });

    if (typeof answer.size === "number" && Number.isSafeInteger(answer.size) && answer.size >= 0 && answer.size <= dir.maxBytes) {
      return { name, size: answer.size, stream: out as Readable, close, closed };
    }
    switch (answer.refused) {
      case "missing":
        throw new Error(`No file named ${name} in ${dir.callerDir}`);
      case "link":
        throw new Error("Links can't be uploaded; copy the real file into the folder.");
      case "kind":
        throw new Error(`${name} is not a regular file`);
      case "size":
        throw new Error(`File is over the ${formatLimit(dir.maxBytes)} upload limit`);
      case "moved":
        throw new Error(moved);
      default: {
        const code = typeof answer.code === "string" && /^E[A-Z]+$/.test(answer.code) ? answer.code : "file error";
        throw new Error(`The file couldn't be opened (${code}).`);
      }
    }
  } catch (err) {
    close();
    throw err;
  }
}
