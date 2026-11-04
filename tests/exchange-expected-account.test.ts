import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = { email: "owner@example.com", refresh: "new-refresh" as string | undefined };

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn(() => ({
        getToken: vi.fn(async () => ({ tokens: { access_token: "a", refresh_token: state.refresh } })),
        setCredentials: vi.fn(),
      })),
    },
    drive: () => ({ about: { get: async () => ({ data: { user: { emailAddress: state.email } } }) } }),
    oauth2: () => ({ userinfo: { get: async () => ({ data: { email: state.email } }) } }),
  },
}));

const { exchangeCode, loadTokens } = await import("../src/auth.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exchange-"));
  process.env.GOOGLE_TOKEN_DIR = dir;
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  writeFileSync(join(dir, "p.json"), JSON.stringify({ refresh_token: "human" }));
  state.email = "owner@example.com";
  state.refresh = "new-refresh";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GOOGLE_TOKEN_DIR;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("exchangeCode with an expected account", () => {
  const expected = { expectedAccount: "Owner@example.com" };

  it("saves a login for the right account", async () => {
    await exchangeCode("p", "code", expected);
    expect(loadTokens("p")?.refresh_token).toBe("new-refresh");
  });

  it("keeps the existing login when the account is wrong", async () => {
    state.email = "attacker@evil.example";
    await expect(exchangeCode("p", "code", expected)).rejects.toThrow(/different account/);
    expect(loadTokens("p")?.refresh_token).toBe("human");
  });

  it("keeps the existing login when there's no refresh token", async () => {
    state.refresh = undefined;
    await expect(exchangeCode("p", "code", expected)).rejects.toThrow(/no refresh token/);
    expect(loadTokens("p")?.refresh_token).toBe("human");
  });

  it("keeps stdio's behaviour with no expected account", async () => {
    state.email = "someone@else.example";
    await exchangeCode("p", "code");
    expect(loadTokens("p")?.refresh_token).toBe("new-refresh");
  });
});
