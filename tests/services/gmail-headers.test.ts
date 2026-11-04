import { describe, expect, it, vi } from "vitest";

vi.mock("googleapis", () => {
  const send = vi.fn(async () => ({ data: { id: "m" } }));
  const create = vi.fn(async () => ({ data: { id: "d" } }));
  return {
    google: { gmail: () => ({ users: { messages: { send }, drafts: { create } } }) },
    _mocks: { send, create },
  };
});

const { _mocks } = (await import("googleapis")) as any;
const { getGmailTools } = await import("../../src/services/gmail.js");
const tools = getGmailTools({ identity: "t", permissions: { gmail: { access: "admin", folders: [] } } }, {} as any);

describe("gmail headers", () => {
  const sending = tools.filter((t: any) => ["gmail_send", "gmail_draft", "gmail_create_draft"].includes(t.name));

  it("covers both ways of composing", () => {
    expect(sending.length).toBe(2);
  });

  it.each([
    { to: "a@b.example", subject: "hi\r\nBcc: attacker@evil.example", body: "x" },
    { to: "a@b.example\nBcc: attacker@evil.example", subject: "hi", body: "x" },
  ])("refuses a line break in %j", async (args) => {
    for (const tool of sending) await expect(tool.handler(args)).rejects.toThrow(/line breaks/);
    expect(_mocks.send).not.toHaveBeenCalled();
    expect(_mocks.create).not.toHaveBeenCalled();
  });

  it("still allows line breaks in the body", async () => {
    await sending[0].handler({ to: "a@b.example", subject: "hi", body: "one\r\ntwo" });
  });
});
