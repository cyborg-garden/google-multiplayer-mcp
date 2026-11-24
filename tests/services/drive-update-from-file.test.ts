/** Binary updates preserve a Drive object and never pass through text encoding. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Readable } from "stream";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PermissionConfig } from "../../src/types.js";

const sent = vi.hoisted(() => ({
  calls: [] as { params: any; options: any; body: Buffer }[],
  reportSize: undefined as string | undefined,
}));

vi.mock("googleapis", () => {
  const updateFn = vi.fn(async (params: any, options: any) => {
    const chunks: Buffer[] = [];
    for await (const c of params.media.body as Readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks);
    sent.calls.push({ params, options, body });
    return {
      data: {
        id: params.fileId,
        name: "queue.xlsx",
        mimeType: params.media.mimeType,
        parents: ["folder-a"],
        modifiedTime: "2026-11-24T16:00:00Z",
        size: sent.reportSize ?? String(body.length),
        md5Checksum: createHash("md5").update(body).digest("base64"),
      },
    };
  });
  const getFn = vi.fn(async () => ({
    data: { id: "existing-id", name: "queue.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", parents: ["folder-a"] },
  }));
  return {
    google: { drive: () => ({ files: { list: vi.fn(), get: getFn, create: vi.fn(), update: updateFn }, permissions: { create: vi.fn() } }) },
    _mocks: { getFn, updateFn },
  };
});

const { _mocks } = (await import("googleapis")) as any;
const { getDriveTools } = await import("../../src/services/drive.js");
const { folderIdentity } = await import("../../src/services/drive-upload.js");
const CALLER = "/opt/data/uploads/drive";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
let root: string;
let hostDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  sent.calls = [];
  sent.reportSize = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), "drive-update-")));
  hostDir = join(root, "uploads");
  mkdirSync(hostDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(withUpload = true): PermissionConfig {
  return {
    identity: "test",
    permissions: { drive: { access: "write", folders: ["folder-a"] } },
    ...(withUpload ? { uploadDir: { hostDir, callerDir: CALLER, maxBytes: 1_000_000, ...folderIdentity(hostDir) } } : {}),
  };
}
const find = (cfg: PermissionConfig, name: string) => getDriveTools(cfg, {} as any).find((t) => t.name === name);
function update(cfg = config()) {
  const t = find(cfg, "drive_update_from_file");
  if (!t) throw new Error("tool not offered");
  return t;
}

describe("drive_update_from_file", () => {
  it("sends exact bytes to the same Drive ID and retains metadata", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    const res: any = await update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` });
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].body.equals(BINARY)).toBe(true);
    expect(sent.calls[0].params).toMatchObject({ fileId: "existing-id", media: { mimeType: XLSX }, supportsAllDrives: true });
    expect(sent.calls[0].params).not.toHaveProperty("requestBody");
    expect(res).toMatchObject({ id: "existing-id", name: "queue.xlsx", parents: ["folder-a"], size: BINARY.length });
  });

  it("allows a MIME override and detects a stored-size mismatch", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    sent.reportSize = "3";
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx`, mimeType: " application/octet-stream " }))
      .rejects.toThrow(/10.*3|3.*10/);
    expect(sent.calls[0].params.media.mimeType).toBe("application/octet-stream");
  });

  it("rejects same-length different bytes and unverified responses", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    sent.reportSize = String(BINARY.length);
    _mocks.updateFn.mockResolvedValueOnce({ data: { id: "existing-id", size: String(BINARY.length), md5Checksum: createHash("md5").update("not the bytes").digest("base64") } });
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/MD5/);
    _mocks.updateFn.mockResolvedValueOnce({ data: { id: "existing-id", size: String(BINARY.length) } });
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/MD5/);
    _mocks.updateFn.mockResolvedValueOnce({ data: { id: "existing-id", md5Checksum: createHash("md5").update(BINARY).digest("base64") } });
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/no stored size/);
  });

  it("does not replace an inaccessible Drive file", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    _mocks.getFn.mockImplementation(async (params: any) => ({
      data: params.fields === "parents" ? { parents: ["outside"] } : { id: "existing-id", parents: ["outside"] },
    }));
    try {
      await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/outside allowed/);
      expect(sent.calls).toHaveLength(0);
    } finally {
      _mocks.getFn.mockImplementation(async () => ({
        data: { id: "existing-id", name: "queue.xlsx", mimeType: XLSX, parents: ["folder-a"] },
      }));
    }
  });

  it("is offered only when the byte-safe folder is configured", async () => {
    expect(find(config(false), "drive_update_from_file")).toBeUndefined();
    await expect(find(config(false), "drive_update")!.handler({ fileId: "existing-id", content: "UEsDBA==", mimeType: XLSX }))
      .rejects.toThrow(/supported UTF-8 text.*not configured.*Nothing was updated/is);
    expect(sent.calls).toHaveLength(0);
  });
});

describe("drive_update text safety", () => {
  it("refuses an XLSX text payload before writing and points to the file method", async () => {
    await expect(find(config(), "drive_update")!.handler({ fileId: "existing-id", content: "UEsDBA==", mimeType: XLSX }))
      .rejects.toThrow(/supported UTF-8 text.*drive_update_from_file.*Nothing was updated/is);
    expect(sent.calls).toHaveLength(0);
  });

  it("still writes text", async () => {
    const res: any = await find(config(), "drive_update")!.handler({ fileId: "existing-id", content: "kia ora — tūī", mimeType: "text/plain" });
    expect(sent.calls[0].body.toString("utf8")).toBe("kia ora — tūī");
    expect(res.id).toBe("existing-id");
  });

  it("refuses binary types with whitespace, blank values, or omitted MIME", async () => {
    for (const mimeType of [` ${XLSX} `, "", "application/x-sqlite3", "application/vnd.apple.numbers", undefined]) {
      await expect(find(config(), "drive_update")!.handler({ fileId: "existing-id", content: "UEsDBA==", ...(mimeType === undefined ? {} : { mimeType }) }))
        .rejects.toThrow(/supported UTF-8 text.*Nothing was updated/is);
    }
    expect(sent.calls).toHaveLength(0);
  });

  it("still writes text when MIME is omitted", async () => {
    _mocks.getFn.mockImplementation(async () => ({ data: { id: "existing-id", mimeType: "text/plain", parents: ["folder-a"] } }));
    const res: any = await find(config(), "drive_update")!.handler({ fileId: "existing-id", content: "hello" });
    expect(sent.calls[0].body.toString("utf8")).toBe("hello");
    expect(sent.calls[0].params.media.mimeType).toBe("text/plain");
    expect(res.id).toBe("existing-id");
  });

  it("keeps read-only callers away and rejects unsafe paths before Drive writes", async () => {
    const readOnly = config();
    readOnly.permissions.drive!.access = "read";
    expect(find(readOnly, "drive_update")).toBeUndefined();
    expect(find(readOnly, "drive_update_from_file")).toBeUndefined();
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/../private.xlsx` })).rejects.toThrow(/directly inside/);
    writeFileSync(join(root, "private.xlsx"), BINARY);
    symlinkSync(join(root, "private.xlsx"), join(hostDir, "linked.xlsx"));
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/linked.xlsx` })).rejects.toThrow(/Links can't be uploaded/);
    expect(sent.calls).toHaveLength(0);
  });

  it("passes an abort signal to Drive and permits a retry after rejection", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    _mocks.updateFn.mockImplementationOnce(async (_params: any, options: any) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      for await (const _ of _params.media.body) { /* consume the actual bytes */ }
      throw new Error("Drive stopped the request");
    });
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/Drive stopped/);
    const res: any = await update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` });
    expect(res.id).toBe("existing-id");
    expect(sent.calls).toHaveLength(1);
  });

  it("releases the upload slot after a Drive rejection", async () => {
    writeFileSync(join(hostDir, "replacement.xlsx"), BINARY);
    _mocks.updateFn.mockRejectedValueOnce(new Error("Drive rejected the upload"));
    await expect(update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` })).rejects.toThrow(/Drive rejected/);
    const res: any = await update().handler({ fileId: "existing-id", path: `${CALLER}/replacement.xlsx` });
    expect(res.id).toBe("existing-id");
    // The rejected mock throws before recording a completed Drive request.
    expect(sent.calls).toHaveLength(1);
    expect(_mocks.updateFn).toHaveBeenCalledTimes(2);
  });
});
