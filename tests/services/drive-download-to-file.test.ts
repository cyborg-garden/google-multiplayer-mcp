/**
 * drive_download_to_file: streams a Drive file into a download folder taken
 * from config, and returns only the path the caller sees plus metadata.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DownloadDir, PermissionConfig } from "../../src/types.js";

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
const { safeFileName } = await import("../../src/services/drive-download.js");

let root: string;
let hostDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), "drive-dl-")));
  hostDir = join(root, "downloads");
  mkdirSync(hostDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(overrides: Partial<DownloadDir> = {}, folders = ["folder-a"]): PermissionConfig {
  return {
    identity: "test",
    permissions: { drive: { access: "read", folders } },
    downloadDir: { hostDir, callerDir: "/opt/data/downloads/drive", maxBytes: 1024, ...overrides },
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
      path: "/opt/data/downloads/drive/file1-clip.mp4",
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: 11,
    });
    expect(readFileSync(join(hostDir, "file1-clip.mp4"), "utf-8")).toBe("hello world");
    expect(files()).toEqual(["file1-clip.mp4"]);
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
    expect(readFileSync(join(hostDir, "file1-clip.mp4"), "utf-8")).toBe("new");
    expect(files()).toEqual(["file1-clip.mp4"]);
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
    expect(files()).toEqual(["file1-clip.mp4"]);
    expect(readFileSync(join(hostDir, "file1-clip.mp4"), "utf-8")).toBe("hello world");
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
