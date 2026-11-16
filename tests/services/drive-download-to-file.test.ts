/**
 * drive_download_to_file: streams a Drive file into a download folder taken
 * from config, and returns only the path the caller sees plus metadata.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { PassThrough, Readable } from "stream";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DownloadDir, PermissionConfig } from "../../src/types.js";

/** Points where a test can act, as an agent racing the broker would. */
type Hook = (path: string) => void;
const hooks = vi.hoisted(() => ({}) as {
  beforeOpen?: Hook;
  afterOpen?: Hook;
  beforeRename?: Hook;
  afterRename?: Hook;
  fail?: (fn: string, path: string) => void;
  /** Free bytes the disk reports, in place of the real figure. */
  freeBytes?: number;
  renames: string[];
});

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const failing = <T extends (...a: any[]) => any>(name: string, fn: T) =>
    ((...a: any[]) => {
      hooks.fail?.(name, String(a[0]));
      return fn(...a);
    }) as T;
  const wrapped = {
    ...real,
    openSync: (...a: any[]) => {
      hooks.beforeOpen?.(String(a[0]));
      const fd = (real.openSync as any)(...a);
      hooks.afterOpen?.(String(a[0]));
      return fd;
    },
    renameSync: (from: any, to: any) => {
      // Only the broker's own rename of a temporary file; tests rename folders too.
      if (!String(from).endsWith(".part")) return real.renameSync(from, to);
      hooks.renames.push(String(from));
      hooks.beforeRename?.(String(from));
      real.renameSync(from, to);
      hooks.afterRename?.(String(to));
    },
    statSync: failing("statSync", real.statSync),
    lstatSync: failing("lstatSync", real.lstatSync),
    fstatSync: failing("fstatSync", real.fstatSync),
    realpathSync: failing("realpathSync", real.realpathSync),
    readdirSync: failing("readdirSync", real.readdirSync),
    statfsSync: failing("statfsSync", ((...a: any[]) => {
      const st = (real.statfsSync as any)(...a);
      return hooks.freeBytes === undefined ? st : { ...st, bavail: hooks.freeBytes, bsize: 1 };
    }) as typeof real.statfsSync),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("googleapis", () => {
  const getFn = vi.fn();
  return {
    google: {
      drive: () => ({
        files: { list: vi.fn(), get: getFn, create: vi.fn(), update: vi.fn() },
        permissions: { create: vi.fn() },
      }),
    },
    _mocks: { getFn },
  };
});

const { _mocks } = (await import("googleapis")) as any;
const { getDriveTools } = await import("../../src/services/drive.js");
const { safeFileName, sweepStaleParts } = await import("../../src/services/drive-download.js");

let root: string;
let hostDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["beforeOpen", "afterOpen", "beforeRename", "afterRename", "fail", "freeBytes"] as const) delete hooks[k];
  hooks.renames = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), "drive-dl-")));
  hostDir = join(root, "downloads");
  mkdirSync(hostDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(overrides: Partial<DownloadDir> = {}, folders = ["folder-a"]): PermissionConfig {
  return {
    identity: "test",
    permissions: { drive: { access: "read", folders } },
    downloadDir: {
      hostDir,
      callerDir: "/opt/data/downloads/drive",
      maxBytes: 1024,
      maxTotalBytes: 1_000_000,
      maxConcurrent: 2,
      minFreeBytes: 0,
      ...overrides,
    },
  };
}

interface FakeFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  body?: () => Readable;
}

/** Answer metadata, parent-walk and media requests for one file. */
function serve(file: FakeFile) {
  const meta = {
    id: file.id ?? "file1",
    name: file.name ?? "clip.mp4",
    mimeType: file.mimeType ?? "video/mp4",
    size: file.size,
    parents: file.parents ?? ["folder-a"],
  };
  _mocks.getFn.mockImplementation(async (params: any, options: any) => {
    if (params.alt === "media") {
      expect(options?.responseType).toBe("stream");
      return { data: (file.body ?? (() => Readable.from([Buffer.from("hello "), Buffer.from("world")])))() };
    }
    return { data: meta };
  });
}

function tool(cfg: PermissionConfig = config()) {
  const t = getDriveTools(cfg, {} as any).find((x) => x.name === "drive_download_to_file");
  if (!t) throw new Error("tool not offered");
  return t;
}

const files = () => readdirSync(hostDir);

/** The stored name: the id, a short hash of the exact id, then the safe name. */
const stored = (id: string, name: string) =>
  `${id}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}-${name}`;
const F1 = stored("file1", "clip.mp4");

/** Swap the download folder for a link to `target`, keeping the real one at `aside`. */
function swapForLink(target: string, aside = join(root, "aside")) {
  renameSync(hostDir, aside);
  symlinkSync(target, hostDir);
}
function swapBack(aside = join(root, "aside")) {
  rmSync(hostDir);
  renameSync(aside, hostDir);
}
function otherFolder() {
  const d = join(root, "other-agent");
  mkdirSync(d);
  return d;
}
const mediaCalls = () => _mocks.getFn.mock.calls.filter((c: any[]) => c[0].alt === "media").length;


describe("drive_download_to_file is offered only with a download folder", () => {
  it("is not offered when no download folder is configured", () => {
    const { downloadDir: _, ...noDir } = config();
    const names = getDriveTools(noDir, {} as any).map((t) => t.name);
    expect(names).toContain("drive_download");
    expect(names).not.toContain("drive_download_to_file");
  });

  it("is offered with read access and a download folder", () => {
    expect(() => tool()).not.toThrow();
  });

  it("takes no path argument", () => {
    const props = Object.keys((tool().inputSchema as any).properties);
    expect(props).toEqual(["fileId"]);
  });
});

describe("drive_download_to_file streaming", () => {
  it("streams the bytes to disk and returns the caller's path", async () => {
    serve({ size: "11" });
    const result = (await tool().handler({ fileId: "file1" })) as any;
    expect(result).toEqual({
      path: `/opt/data/downloads/drive/${F1}`,
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: 11,
    });
    expect(readFileSync(join(hostDir, F1), "utf-8")).toBe("hello world");
    expect(files()).toEqual([F1]);
  });

  it("does not return file content or the host path", async () => {
    serve({ size: "11" });
    const text = JSON.stringify(await tool().handler({ fileId: "file1" }));
    expect(text).not.toContain("hello");
    expect(text).not.toContain(hostDir);
  });

  it("replaces an earlier download of the same file", async () => {
    serve({ size: "11" });
    await tool().handler({ fileId: "file1" });
    serve({ size: "3", body: () => Readable.from([Buffer.from("new")]) });
    await tool().handler({ fileId: "file1" });
    expect(readFileSync(join(hostDir, F1), "utf-8")).toBe("new");
    expect(files()).toEqual([F1]);
  });
});

describe("drive_download_to_file safety", () => {
  it("refuses a file outside the allowed folders", async () => {
    serve({ parents: ["folder-elsewhere"] });
    _mocks.getFn.mockImplementation(async (params: any) => {
      if (params.alt === "media") throw new Error("must not download");
      if (params.fileId === "folder-elsewhere") return { data: { parents: [] } };
      return { data: { id: "file1", name: "x.bin", mimeType: "application/octet-stream", size: "5", parents: ["folder-elsewhere"] } };
    });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/outside allowed folders/);
    expect(files()).toEqual([]);
  });

  it("refuses a file whose stated size is over the cap before downloading", async () => {
    serve({ size: "2048" });
    const get = _mocks.getFn.getMockImplementation();
    _mocks.getFn.mockImplementation(async (params: any, options: any) => {
      if (params.alt === "media") throw new Error("must not download");
      return get(params, options);
    });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/over the .* limit/);
    expect(files()).toEqual([]);
  });

  it("stops and removes the file when the stream runs past the cap", async () => {
    // Drive's stated size can be missing or wrong, so the bytes are counted too.
    serve({ size: undefined, body: () => Readable.from([Buffer.alloc(600), Buffer.alloc(600)]) });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/over the .* limit/);
    expect(files()).toEqual([]);
  });

  it("removes the partial file when the download fails midway", async () => {
    serve({
      size: "100",
      body: () =>
        new Readable({
          read() {
            this.push(Buffer.from("partial"));
            this.destroy(new Error("connection reset"));
          },
        }),
    });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/download failed/i);
    expect(files()).toEqual([]);
  });

  it("stops a download that runs too long and removes the partial file", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      serve({ size: "100", body: () => new Readable({ read() { this.push(Buffer.from("x")); this.pause(); } }) });
      const pending = tool().handler({ fileId: "file1" });
      const outcome = expect(pending).rejects.toThrow(/too long/);
      await vi.advanceTimersByTimeAsync(230_000);
      await outcome;
      expect(files()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the partial file and keeps an earlier copy when a re-download fails", async () => {
    serve({ size: "11" });
    await tool().handler({ fileId: "file1" });
    serve({
      size: "100",
      body: () =>
        new Readable({
          read() {
            this.destroy(new Error("connection reset"));
          },
        }),
    });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow();
    expect(files()).toEqual([F1]);
    expect(readFileSync(join(hostDir, F1), "utf-8")).toBe("hello world");
  });

  it("refuses Google Docs, Sheets and Slides with a pointer to the export tools", async () => {
    for (const mimeType of [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ]) {
      serve({ mimeType, size: undefined });
      await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/drive_get/);
    }
    expect(files()).toEqual([]);
  });

  it("keeps a hostile Drive name inside the folder", async () => {
    for (const name of ["../../escape.txt", "/etc/passwd", "..", "a\\..\\b", "x\u0000y\n.txt", ".hidden"]) {
      serve({ name, size: "11" });
      const result = (await tool().handler({ fileId: "file1" })) as any;
      expect(result.path.startsWith("/opt/data/downloads/drive/file1-")).toBe(true);
      expect(result.path.slice("/opt/data/downloads/drive/".length)).not.toMatch(/[\/\\\u0000-\u001f]/);
    }
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    for (const f of files()) expect(f.startsWith("file1-")).toBe(true);
  });

  it("refuses a file id that could act as a path", async () => {
    serve({ id: "../evil", size: "11" });
    await expect(tool().handler({ fileId: "../evil" })).rejects.toThrow(/file id/i);
    expect(existsSync(join(root, "evil"))).toBe(false);
  });

  it("refuses when the download folder has been replaced by a link", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(hostDir, { recursive: true });
    symlinkSync(elsewhere, hostDir);
    serve({ size: "11" });
    await expect(tool({ ...config(), downloadDir: { ...config().downloadDir!, hostDir: join(root, "downloads") } }).handler({ fileId: "file1" }))
      .rejects.toThrow(/download folder/i);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses when the download folder is missing", async () => {
    rmSync(hostDir, { recursive: true });
    serve({ size: "11" });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/download folder/i);
  });
});


describe("drive_download_to_file folder races", () => {
  it("creates the file before asking Drive, and refuses if it landed elsewhere", async () => {
    // An agent swaps its folder for a link and back around the moment of creation.
    const other = otherFolder();
    hooks.beforeOpen = () => swapForLink(other);
    hooks.afterOpen = () => swapBack();
    serve({ size: "11" });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/download folder/i);
    expect(mediaCalls()).toBe(0);
    for (const f of readdirSync(other)) expect(statSync(join(other, f)).size).toBe(0);
    expect(files()).toEqual([]);
  });

  it("refuses a link planted where the temporary file goes", async () => {
    const other = otherFolder();
    writeFileSync(join(other, "victim"), "keep me");
    hooks.beforeOpen = (path) => symlinkSync(join(other, "victim"), path);
    serve({ size: "11" });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow();
    expect(mediaCalls()).toBe(0);
    expect(readFileSync(join(other, "victim"), "utf-8")).toBe("keep me");
  });

  it("never opens a hard link planted where the temporary file goes", async () => {
    // A hard link passes an inode check, so only O_EXCL stops this one.
    const other = otherFolder();
    writeFileSync(join(other, "victim"), "keep me");
    hooks.beforeOpen = (path) => linkSync(join(other, "victim"), path);
    serve({ size: "11" });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow();
    expect(readFileSync(join(other, "victim"), "utf-8")).toBe("keep me");
  });

  it("checks the folder again before moving the file into place", async () => {
    const other = otherFolder();
    serve({
      size: "11",
      body: () => {
        swapForLink(other);
        return Readable.from([Buffer.from("hello world")]);
      },
    });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/download folder/i);
    expect(hooks.renames).toEqual([]);
    expect(readdirSync(other)).toEqual([]);
  });

  it("checks the folder after moving the file into place", async () => {
    const other = otherFolder();
    hooks.afterRename = () => swapForLink(other);
    serve({ size: "11" });
    const err = await tool().handler({ fileId: "file1" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/download folder/i);
    // The file is already in place, so the caller isn't told nothing was kept.
    expect((err as Error).message).not.toMatch(/nothing was kept/);
  });

  it("never shows a host path in a file-system error", async () => {
    for (const fn of ["statSync", "lstatSync", "fstatSync", "realpathSync", "readdirSync", "statfsSync"]) {
      hooks.fail = (name, path) => {
        if (name !== fn) return;
        throw Object.assign(new Error(`EIO: i/o error, ${name} '${path}'`), { code: "EIO" });
      };
      serve({ size: "11" });
      const outcome = await tool().handler({ fileId: "file1" }).catch((e: Error) => e);
      if (outcome instanceof Error) expect(outcome.message, fn).not.toContain(root);
    }
  });
});

describe("drive_download_to_file disk limits", () => {
  it("refuses when the folder's quota would be exceeded", async () => {
    writeFileSync(join(hostDir, "old-download"), Buffer.alloc(15));
    serve({ size: "11" });
    await expect(tool(config({ maxTotalBytes: 20 })).handler({ fileId: "file1" })).rejects.toThrow(/quota/);
    expect(mediaCalls()).toBe(0);
  });

  it("enforces the quota while streaming when Drive gives no size", async () => {
    writeFileSync(join(hostDir, "old-download"), Buffer.alloc(15));
    serve({ size: undefined });
    await expect(tool(config({ maxTotalBytes: 20 })).handler({ fileId: "file1" })).rejects.toThrow(/quota|limit/);
    expect(files()).toEqual(["old-download"]);
  });

  it("counts downloads still running against the quota", async () => {
    const first = new PassThrough();
    serve({ id: "big", size: "15", body: () => first });
    const cfg = config({ maxTotalBytes: 20 });
    const running = tool(cfg).handler({ fileId: "big" });
    await vi.waitFor(() => expect(mediaCalls()).toBe(1));
    serve({ size: "11" });
    await expect(tool(cfg).handler({ fileId: "file1" })).rejects.toThrow(/quota/);
    first.end(Buffer.alloc(15));
    await running;
  });

  it("stops a download that sends more than Drive's stated size", async () => {
    // The stated size is what was reserved, so more bytes would overshoot the quota.
    serve({ size: "10", body: () => Readable.from([Buffer.alloc(90)]) });
    await expect(tool().handler({ fileId: "file1" })).rejects.toThrow(/stated size/);
    expect(files()).toEqual([]);
  });

  it("reserves the whole per-file cap for a download with no stated size", async () => {
    const first = new PassThrough();
    serve({ id: "nosize", size: undefined, body: () => first });
    const cfg = config({ maxBytes: 1024, maxTotalBytes: 1030 });
    const running = tool(cfg).handler({ fileId: "nosize" });
    await vi.waitFor(() => expect(mediaCalls()).toBe(1));
    serve({ size: "11" });
    await expect(tool(cfg).handler({ fileId: "file1" })).rejects.toThrow(/quota/);
    first.end(Buffer.alloc(5));
    await running;
  });

  it("counts downloads still running against the free-space floor", async () => {
    hooks.freeBytes = 100;
    const first = new PassThrough();
    serve({ id: "big", size: "40", body: () => first });
    const cfg = config({ minFreeBytes: 50 });
    const running = tool(cfg).handler({ fileId: "big" });
    await vi.waitFor(() => expect(mediaCalls()).toBe(1));
    serve({ size: "40" });
    await expect(tool(cfg).handler({ fileId: "file1" })).rejects.toThrow(/disk/i);
    first.end(Buffer.alloc(40));
    await running;
  });

  it("clears stale partial files left by a crash before checking the quota", async () => {
    const stale = join(hostDir, ".old.abcdef.part");
    writeFileSync(stale, Buffer.alloc(15));
    const hourAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(stale, hourAgo, hourAgo);
    serve({ size: "11" });
    await expect(tool(config({ maxTotalBytes: 20 })).handler({ fileId: "file1" })).resolves.toBeTruthy();
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps a recent partial file and counts it", async () => {
    const fresh = join(hostDir, ".new.abcdef.part");
    writeFileSync(fresh, Buffer.alloc(15));
    serve({ size: "11" });
    await expect(tool(config({ maxTotalBytes: 20 })).handler({ fileId: "file1" })).rejects.toThrow(/quota/);
    expect(existsSync(fresh)).toBe(true);
  });

  it("sweeps stale partial files on demand, and nothing else", () => {
    const stale = join(hostDir, ".old.abcdef.part");
    const other = join(hostDir, "old-download");
    for (const f of [stale, other]) {
      writeFileSync(f, "x");
      const hourAgo = new Date(Date.now() - 2 * 3600_000);
      utimesSync(f, hourAgo, hourAgo);
    }
    sweepStaleParts(hostDir);
    expect(files()).toEqual(["old-download"]);
  });

  it("lets a re-download replace its earlier copy within the quota", async () => {
    serve({ size: "11" });
    const cfg = config({ maxTotalBytes: 15 });
    await tool(cfg).handler({ fileId: "file1" });
    await expect(tool(cfg).handler({ fileId: "file1" })).resolves.toBeTruthy();
  });

  it("limits how many downloads one caller runs at once", async () => {
    const streams = [new PassThrough(), new PassThrough()];
    let n = 0;
    serve({ size: "5", body: () => streams[n++] });
    const cfg = config({ maxConcurrent: 2 });
    const a = tool(cfg).handler({ fileId: "file1" });
    const b = tool(cfg).handler({ fileId: "file2" });
    await vi.waitFor(() => expect(mediaCalls()).toBe(2));
    await expect(tool(cfg).handler({ fileId: "file3" })).rejects.toThrow(/at once/);
    for (const s of streams) s.end(Buffer.from("12345"));
    await Promise.all([a, b]);
    // A finished download frees its place.
    serve({ size: "5", body: () => Readable.from([Buffer.from("12345")]) });
    await expect(tool(cfg).handler({ fileId: "file3" })).resolves.toBeTruthy();
  });

  it("refuses when the disk would drop below the free-space floor", async () => {
    serve({ size: "11" });
    await expect(tool(config({ minFreeBytes: Number.MAX_SAFE_INTEGER })).handler({ fileId: "file1" }))
      .rejects.toThrow(/disk/i);
    expect(mediaCalls()).toBe(0);
    expect(files()).toEqual([]);
  });
});

describe("drive_download_to_file names", () => {
  it("gives ids that differ only by case different names", async () => {
    serve({ id: "abcDEF", size: "11" });
    const a = (await tool().handler({ fileId: "abcDEF" })) as any;
    serve({ id: "ABCdef", size: "11" });
    const b = (await tool().handler({ fileId: "ABCdef" })) as any;
    expect(a.path.toLowerCase()).not.toBe(b.path.toLowerCase());
    expect(files()).toHaveLength(2);
  });
});

describe("safeFileName", () => {
  it("strips separators and control characters", () => {
    expect(safeFileName("a/b\\c\u0001d\u007f.txt")).toBe("a_b_c_d_.txt");
  });

  it("never returns a name that means a directory", () => {
    for (const n of ["", ".", "..", "...", "   "]) {
      const s = safeFileName(n);
      expect(s).not.toMatch(/^\.*$/);
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it("caps the length in bytes, without splitting a character", () => {
    const s = safeFileName("é".repeat(500) + ".mp4");
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(150);
    expect(s).not.toContain("�");
    expect(s.endsWith(".mp4")).toBe(true);
  });
});
