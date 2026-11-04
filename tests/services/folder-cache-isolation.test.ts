import { describe, expect, it, vi } from "vitest";
import { invalidateFolderTreeCache, resolveAllowedFolderTree } from "../../src/services/folder-scope.js";

const client = (children: string[]) => {
  const list = vi.fn(async ({ q }: { q: string }) => ({
    data: { files: q.startsWith("'ROOT'") ? children.map((id) => ({ id })) : [] },
  }));
  return { files: { list } } as any;
};

describe("folder tree cache", () => {
  it("keeps agents with the same root apart", async () => {
    const a = await resolveAllowedFolderTree(client(["SUB_A"]), ["ROOT"]);
    const b = await resolveAllowedFolderTree(client(["SUB_B"]), ["ROOT"]);
    expect(a.has("SUB_A")).toBe(true);
    expect(b.has("SUB_B")).toBe(true);
    expect(b.has("SUB_A")).toBe(false);
  });

  it("doesn't pass one agent's failure to another", async () => {
    const bad = { files: { list: vi.fn(() => new Promise((_, no) => setTimeout(() => no(new Error("invalid_grant")), 10))) } } as any;
    const failing = resolveAllowedFolderTree(bad, ["ROOT"]);
    const good = await resolveAllowedFolderTree(client(["SUB"]), ["ROOT"]);
    await expect(failing).rejects.toThrow("invalid_grant");
    expect(good.has("SUB")).toBe(true);
  });

  it("caches per client, and invalidation still works", async () => {
    const c = client(["S"]);
    await resolveAllowedFolderTree(c, ["ROOT"]);
    const calls = c.files.list.mock.calls.length;
    await resolveAllowedFolderTree(c, ["ROOT"]);
    expect(c.files.list.mock.calls.length).toBe(calls);
    invalidateFolderTreeCache();
    await resolveAllowedFolderTree(c, ["ROOT"]);
    expect(c.files.list.mock.calls.length).toBeGreaterThan(calls);
  });
});
