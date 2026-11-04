import { describe, expect, it, vi } from "vitest";
import { checkToolArgs, dispatchToolCall } from "../src/server.js";
import type { ToolDef } from "../src/types.js";

const schema = {
  type: "object",
  required: ["name", "content"],
  properties: {
    name: { type: "string" },
    content: { type: "string" },
    folderId: { type: "string" },
    pageSize: { type: "number" },
    headers: { type: "array", items: { type: "string" } },
    role: { type: "string", enum: ["reader", "writer"] },
  },
};
const ok = { name: "n", content: "c" };

describe("checkToolArgs", () => {
  it.each([
    [{ name: "n" }, /content is required/],
    [{ name: "n", content: null }, /content is required/],
    [{ name: "n", content: 123 }, /content must be/],
    [{ name: "n", content: {} }, /content must be/],
    [{ ...ok, folderId: "" }, /folderId can't be empty/],
    [{ ...ok, folderId: " " }, /folderId can't be empty/],
    [{ ...ok, folderId: 0 }, /folderId must be/],
    [{ ...ok, pageSize: "5" }, /pageSize must be/],
    [{ ...ok, headers: "a" }, /headers must be/],
    [{ ...ok, headers: [1] }, /headers must only/],
    [{ ...ok, role: "owner" }, /role must be one of/],
  ])("refuses %j", (args, message) => {
    expect(checkToolArgs(schema, args as Record<string, unknown>)).toMatch(message);
  });

  it("accepts good arguments, an empty body, and null for optional ones", () => {
    expect(checkToolArgs(schema, ok)).toBeNull();
    expect(checkToolArgs(schema, { name: "n", content: "" })).toBeNull();
    expect(checkToolArgs(schema, { ...ok, folderId: null, pageSize: 5, headers: ["a"], role: "writer" })).toBeNull();
  });
});

describe("dispatchToolCall", () => {
  it("doesn't run a tool with bad arguments", async () => {
    const handler = vi.fn(async () => ({}));
    const tool: ToolDef = { name: "t", description: "", service: "drive", requiredAccess: "write", inputSchema: schema, handler };
    const result = await dispatchToolCall("t", { name: "n", content: 123 }, [tool], []);
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("marks a failed auth tool as an error, and keeps its payload", async () => {
    const auth = {
      name: "a", description: "", inputSchema: {},
      handler: async () => [{ type: "text" as const, text: JSON.stringify({ status: "error", message: "no" }) }],
    };
    const result = await dispatchToolCall("a", {}, [], [auth]);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text).status).toBe("error");
  });
});
