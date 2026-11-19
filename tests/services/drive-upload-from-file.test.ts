/**
 * drive_upload_from_file: streams a file from the agent's own folder to Drive,
 * byte for byte. And drive_upload: base64 is decoded, never stored as text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Readable } from "stream";
import { execFileSync } from "child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PermissionConfig, UploadDir } from "../../src/types.js";

/** What the fake Drive received: the request, and every byte of the body. */
const sent = vi.hoisted(() => ({ calls: [] as { params: any; options: any; body: Buffer }[], reportSize: undefined as string | undefined }));

vi.mock("googleapis", () => {
  const createFn = vi.fn(async (params: any, options: any) => {
    const chunks: Buffer[] = [];
    for await (const c of params.media.body as Readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks);
    sent.calls.push({ params, options, body });
    return {
      data: {
        id: "new-id",
        name: params.requestBody.name,
        mimeType: params.media.mimeType,
        parents: params.requestBody.parents,
        size: sent.reportSize ?? String(body.length),
        webViewLink: "https://drive.example/new-id",
      },
    };
  });
  const getFn = vi.fn(async () => ({ data: { parents: [] } }));
  return {
    google: { drive: () => ({ files: { list: vi.fn(), get: getFn, create: createFn, update: vi.fn() }, permissions: { create: vi.fn() } }) },
    _mocks: { createFn, getFn },
  };
});

const { _mocks } = (await import("googleapis")) as any;
const { getDriveTools } = await import("../../src/services/drive.js");
const { folderIdentity, openUpload, UPLOAD_MAX_CONCURRENT } = await import("../../src/services/drive-upload.js");

const CALLER = "/opt/data/uploads/drive";
/** Bytes that are not valid UTF-8, so any text round trip would corrupt them. */
const BINARY = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7 + 131) % 256));

let root: string;
let hostDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  sent.calls = [];
  sent.reportSize = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), "drive-up-")));
  hostDir = join(root, "uploads");
  mkdirSync(hostDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(access: "read" | "write" = "write", overrides: Partial<UploadDir> = {}, folders = ["folder-a"]): PermissionConfig {
  return {
    identity: "test",
    permissions: { drive: { access, folders } },
    // The identity is taken now, as the broker takes it when it loads its config.
    uploadDir: { hostDir, callerDir: CALLER, maxBytes: 1_000_000, ...folderIdentity(hostDir), ...overrides },
  };
}
const find = (cfg: PermissionConfig, name: string) => getDriveTools(cfg, {} as any).find((t) => t.name === name);
function fromFile(cfg: PermissionConfig = config()) {
  const t = find(cfg, "drive_upload_from_file");
  if (!t) throw new Error("tool not offered");
  return t;
}
const put = (name: string, data: Buffer | string = BINARY) => writeFileSync(join(hostDir, name), data);

describe("drive_upload_from_file is offered only where it can work", () => {
  it("needs write access and a folder", () => {
    expect(find(config("write"), "drive_upload_from_file")).toBeDefined();
    expect(find(config("read"), "drive_upload_from_file")).toBeUndefined();
    const { uploadDir: _, ...noDir } = config("write");
    expect(find(noDir, "drive_upload_from_file")).toBeUndefined();
  });

  it("is not switched on by a download folder alone, which the agent may not be able to write", () => {
    const cfg: PermissionConfig = {
      identity: "test",
      permissions: { drive: { access: "write", folders: ["folder-a"] } },
      downloadDir: { hostDir, callerDir: "/opt/data/downloads/drive", maxBytes: 10, maxTotalBytes: 10, maxConcurrent: 1, minFreeBytes: 0 },
    };
    expect(find(cfg, "drive_upload_from_file")).toBeUndefined();
    expect(find(cfg, "drive_download_to_file")).toBeDefined();
  });

  it("tells the agent which folder to put the file in", () => {
    expect(fromFile().description).toContain(CALLER);
  });
});

describe("drive_upload_from_file sends the file's own bytes", () => {
  it("uploads a binary file byte for byte into the requested folder", async () => {
    put("cut.mp4");
    const res: any = await fromFile().handler({ path: `${CALLER}/cut.mp4`, folderId: "folder-a" });

    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].body.equals(BINARY)).toBe(true);
    expect(sent.calls[0].params).toMatchObject({
      requestBody: { name: "cut.mp4", parents: ["folder-a"] },
      media: { mimeType: "video/mp4" },
      supportsAllDrives: true,
    });
    expect(res).toMatchObject({ id: "new-id", name: "cut.mp4", mimeType: "video/mp4", size: BINARY.length });
  });

  it("uploads a file far larger than any pipe buffer, whole and in order", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i += 4093) big.writeUInt32LE(i, Math.min(i, big.length - 4));
    put("long.mov", big);
    const res: any = await fromFile(config("write", { maxBytes: 64 * 1024 * 1024 })).handler({ path: `${CALLER}/long.mov` });
    expect(sent.calls[0].body.length).toBe(big.length);
    expect(sent.calls[0].body.equals(big)).toBe(true);
    expect(res).toMatchObject({ mimeType: "video/quicktime", size: big.length });
  });

  it("takes a name and MIME type from the caller, and guesses the type otherwise", async () => {
    put("notes.pdf");
    put("mystery.bin");
    await fromFile().handler({ path: `${CALLER}/notes.pdf`, name: "Frame Notes.pdf" });
    await fromFile().handler({ path: `${CALLER}/mystery.bin` });
    await fromFile().handler({ path: `${CALLER}/mystery.bin`, mimeType: "image/png" });
    expect(sent.calls.map((c) => [c.params.requestBody.name, c.params.media.mimeType])).toEqual([
      ["Frame Notes.pdf", "application/pdf"],
      ["mystery.bin", "application/octet-stream"],
      ["mystery.bin", "image/png"],
    ]);
  });

  it("falls back to the granted folder when none is named", async () => {
    put("a.png");
    await fromFile().handler({ path: `${CALLER}/a.png` });
    expect(sent.calls[0].params.requestBody.parents).toEqual(["folder-a"]);
  });

  it("uploads an empty file as empty", async () => {
    put("empty.txt", "");
    const res: any = await fromFile().handler({ path: `${CALLER}/empty.txt` });
    expect(sent.calls[0].body.length).toBe(0);
    expect(res.size).toBe(0);
  });

  it("says so when Drive stored a different number of bytes", async () => {
    put("cut.mp4");
    sent.reportSize = "12";
    await expect(fromFile().handler({ path: `${CALLER}/cut.mp4` })).rejects.toThrow(/2048.*12|12.*2048/);
  });
});

describe("drive_upload_from_file reads only the agent's own folder", () => {
  const refused = async (path: unknown, cfg = config(), why: RegExp = /./) => {
    await expect(fromFile(cfg).handler({ path })).rejects.toThrow(why);
    expect(sent.calls).toHaveLength(0);
  };

  it("refuses paths outside the folder, in a subfolder, or not a string", async () => {
    mkdirSync(join(hostDir, "sub"));
    writeFileSync(join(hostDir, "sub", "x.mp4"), BINARY);
    await refused("/etc/passwd");
    await refused(`${CALLER}/../../etc/passwd`);
    await refused(`${CALLER}/sub/x.mp4`);
    await refused("cut.mp4");
    await refused(CALLER);
    await refused(42);
  });

  it("refuses a link, even one pointing at a real file", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "other agent's token");
    symlinkSync(secret, join(hostDir, "innocent.txt"));
    await refused(`${CALLER}/innocent.txt`, config(), /Links can't be uploaded/);
  });

  it("uploads a hard link, which can only name a file the agent already holds", async () => {
    put("real.mp4");
    linkSync(join(hostDir, "real.mp4"), join(hostDir, "alias.mp4"));
    await fromFile().handler({ path: `${CALLER}/alias.mp4` });
    expect(sent.calls[0].body.equals(BINARY)).toBe(true);
  });

  it("refuses a pipe at once, without waiting for a writer", async () => {
    execFileSync("mkfifo", [join(hostDir, "pipe.mp4")]);
    const started = Date.now();
    await refused(`${CALLER}/pipe.mp4`, config(), /not a regular file/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses when the folder path now leads to another agent's folder", async () => {
    const cfg = config();
    put("cut.mp4");
    const other = join(root, "other-agent");
    mkdirSync(other);
    writeFileSync(join(other, "cut.mp4"), "theirs");
    renameSync(hostDir, join(root, "aside"));
    symlinkSync(other, hostDir);
    await refused(`${CALLER}/cut.mp4`, cfg, /replaced by a link/);
  });

  it("refuses another folder moved into place, link or not", async () => {
    const cfg = config();
    const other = join(root, "other-agent");
    mkdirSync(other);
    writeFileSync(join(other, "cut.mp4"), "theirs");
    renameSync(hostDir, join(root, "aside"));
    renameSync(other, hostDir);
    await refused(`${CALLER}/cut.mp4`, cfg, /replaced by a link/);
  });

  it("reads from the folder it was given, by identity, not from whatever the path says", async () => {
    // The reader is started inside the folder and opens the file by bare name,
    // so a swap after that point changes nothing it can reach.
    const cfg = config();
    put("cut.mp4");
    const opened = await openUpload(cfg.uploadDir!, `${CALLER}/cut.mp4`);
    const other = join(root, "other-agent");
    mkdirSync(other);
    writeFileSync(join(other, "cut.mp4"), "theirs");
    renameSync(hostDir, join(root, "aside"));
    symlinkSync(other, hostDir);
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(BINARY)).toBe(true);
    await opened.closed;
  });

  it("refuses a missing folder", async () => {
    const cfg = config();
    rmSync(hostDir, { recursive: true });
    await refused(`${CALLER}/cut.mp4`, cfg, /missing or was replaced/);
  });

  it("refuses a folder, a missing file, and a hidden file", async () => {
    mkdirSync(join(hostDir, "dir.mp4"));
    put(".file1.abcdef012345.part");
    await refused(`${CALLER}/dir.mp4`, config(), /not a regular file/);
    await refused(`${CALLER}/nope.mp4`, config(), /No file named nope.mp4/);
    await refused(`${CALLER}/.file1.abcdef012345.part`, config(), /Hidden/);
  });

  it("refuses a file over the size limit, without naming host paths", async () => {
    put("big.mp4");
    const err = await fromFile(config("write", { maxBytes: 100 })).handler({ path: `${CALLER}/big.mp4` }).catch((e) => e);
    expect(err.message).toMatch(/limit/);
    expect(err.message).not.toContain(root);
    expect(sent.calls).toHaveLength(0);
  });

  it("refuses a Drive folder outside the grant", async () => {
    put("cut.mp4");
    await expect(fromFile().handler({ path: `${CALLER}/cut.mp4`, folderId: "folder-z" })).rejects.toThrow(/not in allowed/);
    expect(sent.calls).toHaveLength(0);
  });

  it("does not leak host paths when the file is missing", async () => {
    const err = await fromFile().handler({ path: `${CALLER}/nope.mp4` }).catch((e) => e);
    expect(err.message).not.toContain(root);
  });
});

describe("drive_upload_from_file cleans up after itself", () => {
  it("frees the reader when the caller stops early", async () => {
    put("cut.mp4");
    const opened = await openUpload(config().uploadDir!, `${CALLER}/cut.mp4`);
    opened.close();
    await opened.closed;
  });

  it("frees the reader when Drive refuses the upload, so the next one can run", async () => {
    put("cut.mp4");
    for (let i = 0; i < UPLOAD_MAX_CONCURRENT + 2; i++) {
      _mocks.createFn.mockRejectedValueOnce(new Error("Drive said no"));
      await expect(fromFile().handler({ path: `${CALLER}/cut.mp4` })).rejects.toThrow("Drive said no");
    }
    await fromFile().handler({ path: `${CALLER}/cut.mp4` });
    expect(sent.calls).toHaveLength(1);
  });

  it("runs only a few uploads at once from one folder", async () => {
    put("cut.mp4");
    const cfg = config();
    const held = [];
    for (let i = 0; i < UPLOAD_MAX_CONCURRENT; i++) held.push(await openUpload(cfg.uploadDir!, `${CALLER}/cut.mp4`));
    await expect(openUpload(cfg.uploadDir!, `${CALLER}/cut.mp4`)).rejects.toThrow(/at once/);
    for (const h of held) h.close();
    await Promise.all(held.map((h) => h.closed));
    (await openUpload(cfg.uploadDir!, `${CALLER}/cut.mp4`)).close();
  });

  it("sends only the size it reported, even if the file grows", async () => {
    put("cut.mp4");
    const opened = await openUpload(config().uploadDir!, `${CALLER}/cut.mp4`);
    writeFileSync(join(hostDir, "cut.mp4"), Buffer.concat([BINARY, BINARY]));
    let n = 0;
    for await (const c of opened.stream) n += (c as Buffer).length;
    expect(n).toBe(opened.size);
    expect(opened.size).toBe(BINARY.length);
  });
});

describe("drive_upload never stores base64 as text", () => {
  const upload = (cfg = config()) => find(cfg, "drive_upload")!;

  it("decodes base64 when told to", async () => {
    await upload().handler({ name: "a.png", content: BINARY.toString("base64"), mimeType: "image/png", encoding: "base64" });
    expect(sent.calls[0].body.equals(BINARY)).toBe(true);
  });

  it("refuses binary types sent without an encoding, pointing at the file tool", async () => {
    for (const mimeType of [
      "video/mp4", "Video/MP4", "application/pdf", "image/png", "audio/wav", "application/zip", "application/octet-stream",
      "application/x-7z-compressed", "application/vnd.rar", "application/epub+zip", "application/wasm",
      "application/vnd.oasis.opendocument.text",
    ]) {
      await expect(upload().handler({ name: "x", content: BINARY.toString("base64"), mimeType })).rejects.toThrow(/drive_upload_from_file/);
    }
    expect(sent.calls).toHaveLength(0);
  });

  it("refuses content that is not base64 when base64 is claimed", async () => {
    await expect(upload().handler({ name: "a.png", content: "not base64 at all!!", mimeType: "image/png", encoding: "base64" })).rejects.toThrow(/base64/);
    expect(sent.calls).toHaveLength(0);
  });

  it("refuses content that is not a string", async () => {
    await expect(upload().handler({ name: "a.png", content: null, mimeType: "image/png", encoding: "base64" })).rejects.toThrow(/string/);
    expect(sent.calls).toHaveLength(0);
  });

  it("still uploads text as text", async () => {
    await upload().handler({ name: "n.md", content: "kia ora — tūī", mimeType: "text/markdown" });
    await upload().handler({ name: "n.txt", content: "plain" });
    await upload().handler({ name: "d.svg", content: "<svg/>", mimeType: "image/SVG+XML" });
    await upload().handler({ name: "doc", content: "to convert", mimeType: "application/vnd.google-apps.document" });
    expect(sent.calls.map((c) => c.body.toString("utf8"))).toEqual(["kia ora — tūī", "plain", "<svg/>", "to convert"]);
  });
});
