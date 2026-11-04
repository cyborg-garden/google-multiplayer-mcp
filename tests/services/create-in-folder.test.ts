import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PermissionConfig } from "../../src/types.js";

vi.mock("googleapis", () => {
  const driveCreate = vi.fn(async () => ({ data: { id: "new-id" } }));
  const driveUpdate = vi.fn();
  const docsCreate = vi.fn(async () => ({ data: { documentId: "doc-id" } }));
  const docsBatch = vi.fn(async () => ({ data: {} }));
  const sheetsCreate = vi.fn(async () => ({ data: { spreadsheetId: "sheet-id" } }));
  const valuesUpdate = vi.fn(async () => ({ data: {} }));
  return {
    google: {
      drive: () => ({ files: { create: driveCreate, update: driveUpdate, get: vi.fn(), list: vi.fn() } }),
      docs: () => ({ documents: { create: docsCreate, batchUpdate: docsBatch, get: vi.fn() } }),
      sheets: () => ({ spreadsheets: { create: sheetsCreate, get: vi.fn(), values: { update: valuesUpdate } } }),
    },
    _mocks: { driveCreate, driveUpdate, docsCreate, docsBatch, sheetsCreate, valuesUpdate },
  };
});

const { _mocks } = (await import("googleapis")) as any;
const { getDocsTools } = await import("../../src/services/docs.js");
const { getSheetsTools } = await import("../../src/services/sheets.js");

const scoped = (service: "docs" | "sheets"): PermissionConfig => ({
  identity: "t",
  permissions: { [service]: { access: "write", folders: ["F1"] } },
});
const open = (service: "docs" | "sheets"): PermissionConfig => ({
  identity: "t",
  permissions: { [service]: { access: "write", folders: [] } },
});
const tool = (tools: any[], name: string) => tools.find((t) => t.name === name);

beforeEach(() => vi.clearAllMocks());

describe("creating in a folder", () => {
  it("creates a scoped Doc through Drive, in the folder", async () => {
    const res = await tool(getDocsTools(scoped("docs"), {} as any), "docs_create").handler({ title: "D", content: "hi" });
    expect(_mocks.docsCreate).not.toHaveBeenCalled();
    expect(_mocks.driveCreate.mock.calls[0][0]).toMatchObject({
      requestBody: { name: "D", mimeType: "application/vnd.google-apps.document", parents: ["F1"] },
      supportsAllDrives: true,
    });
    expect(_mocks.docsBatch.mock.calls[0][0].documentId).toBe("new-id");
    expect(res.documentId).toBe("new-id");
  });

  it("creates a scoped Sheet through Drive, in the folder", async () => {
    const res = await tool(getSheetsTools(scoped("sheets"), {} as any), "sheets_create").handler({ title: "S", headers: ["a"] });
    expect(_mocks.sheetsCreate).not.toHaveBeenCalled();
    expect(_mocks.driveCreate.mock.calls[0][0]).toMatchObject({
      requestBody: { name: "S", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["F1"] },
      supportsAllDrives: true,
    });
    expect(_mocks.valuesUpdate.mock.calls[0][0].spreadsheetId).toBe("new-id");
    expect(res.spreadsheetId).toBe("new-id");
  });

  it("refuses a folder outside the grant, creating nothing", async () => {
    await expect(tool(getSheetsTools(scoped("sheets"), {} as any), "sheets_create").handler({ title: "S", folderId: "F2" })).rejects.toThrow(/not in allowed/);
    expect(_mocks.driveCreate).not.toHaveBeenCalled();
    expect(_mocks.sheetsCreate).not.toHaveBeenCalled();
  });

  it("uses the account's own storage when no folder applies", async () => {
    const d = await tool(getDocsTools(open("docs"), {} as any), "docs_create").handler({ title: "D" });
    const s = await tool(getSheetsTools(open("sheets"), {} as any), "sheets_create").handler({ title: "S" });
    expect(_mocks.driveCreate).not.toHaveBeenCalled();
    expect(d.documentId).toBe("doc-id");
    expect(s.spreadsheetId).toBe("sheet-id");
  });
});
