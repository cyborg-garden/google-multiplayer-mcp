import { describe, it, expect, vi } from "vitest";

// Mock the auth module so the tool handlers exercise our paste-code functions
// without touching googleapis or the filesystem.
vi.mock("../src/auth.js", () => ({
  createAuthClient: vi.fn(() => ({})),
  startHeadlessAuth: vi.fn(() => ({ authUrl: "https://callback.example/x" })),
  checkAuthStatus: vi.fn(() => "unauthenticated"),
  generateConsentUrl: vi.fn(
    () => "https://accounts.google.com/o/oauth2/auth?mock=1",
  ),
  exchangeCode: vi.fn(async (_identity: string, code: string) => {
    if (!code) throw new Error("invalid_grant");
    return { email: "paste@example.com" };
  }),
}));

const { getAuthTools } = await import("../src/server.js");

function findTool(identity: string, name: string) {
  const tool = getAuthTools(identity).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("google_auth_url tool", () => {
  it("returns the consent URL for the paste-code flow", async () => {
    const tool = findTool("personal", "google_auth_url");
    const content = await tool.handler({});
    const payload = JSON.parse(content[0].text);
    expect(payload.url).toContain("https://accounts.google.com");
  });
});

describe("google_auth_exchange tool", () => {
  it("exchanges a pasted code and reports the connected email", async () => {
    const tool = findTool("personal", "google_auth_exchange");
    const content = await tool.handler({ code: "pasted-123" });
    const payload = JSON.parse(content[0].text);
    expect(payload.status).toBe("authenticated");
    expect(payload.email).toBe("paste@example.com");
  });

  it("reports an error when no code is provided", async () => {
    const tool = findTool("personal", "google_auth_exchange");
    const content = await tool.handler({ code: "" });
    const payload = JSON.parse(content[0].text);
    expect(payload.status).toBe("error");
  });
});
