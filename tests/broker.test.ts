import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildAgentTools,
  createBroker,
  cleanErrorText,
  findAgent,
  parseBrokerConfig,
  scopesFor,
  type AgentTools,
  type BrokerAgent,
  type BrokerConfig,
} from "../src/broker.js";
import type { ToolDef } from "../src/types.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function fakeTool(name: string, handler: ToolDef["handler"] = async () => ({ ok: true })): ToolDef {
  return { name, description: name, service: "drive", requiredAccess: "read", inputSchema: { type: "object" }, handler };
}

function agent(name: string, secret: string): BrokerAgent {
  return {
    name,
    secretSha256: hash(secret),
    credential: { type: "oauth", identity: name, expectedAccount: `${name}@example.com` },
    permissions: {},
  };
}

let dir: string;
let server: HttpServer | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "broker-test-"));
});
afterEach(async () => {
  if (server) await new Promise((done) => server!.close(done));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(tools: Record<string, AgentTools>, overrides: Partial<BrokerConfig> = {}) {
  const config: BrokerConfig = {
    host: "127.0.0.1",
    port: 0,
    auditLog: join(dir, "audit.jsonl"),
    maxBodyBytes: 1024 * 1024,
    agents: [agent("alpha", "alpha-secret"), agent("beta", "beta-secret")],
    ...overrides,
  };
  server = createBroker(config, { build: (a) => tools[a.name] });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, config };
}

async function connect(url: string, secret: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  return client;
}

const auditLines = () =>
  readFileSync(join(dir, "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));

describe("broker requests", () => {
  const tools = () => ({
    alpha: { tools: [fakeTool("alpha_tool")], authTools: [] },
    beta: { tools: [fakeTool("beta_tool")], authTools: [] },
  });

  it("gives each agent only its own tools", async () => {
    const { url } = await start(tools());
    const a = await connect(url, "alpha-secret");
    const b = await connect(url, "beta-secret");
    expect((await a.listTools()).tools.map((t) => t.name)).toEqual(["alpha_tool"]);
    expect((await b.listTools()).tools.map((t) => t.name)).toEqual(["beta_tool"]);
    expect((await a.callTool({ name: "alpha_tool", arguments: {} })).isError).toBeFalsy();
    await a.close();
    await b.close();
  });

  it("won't run another agent's tool", async () => {
    const { url } = await start(tools());
    const a = await connect(url, "alpha-secret");
    const result = await a.callTool({ name: "beta_tool", arguments: {} });
    expect(result.isError).toBe(true);
    await a.close();
  });

  it.each([
    ["no header", {}],
    ["wrong secret", { Authorization: "Bearer nope" }],
    ["wrong scheme", { Authorization: "Basic alpha-secret" }],
    ["the stored hash used as a secret", { Authorization: `Bearer ${hash("alpha-secret")}` }],
  ])("refuses %s", async (_label, headers) => {
    const { url } = await start(tools());
    const res = await fetch(`${url}/mcp`, { method: "POST", headers: headers as HeadersInit, body: "{}" });
    expect(res.status).toBe(401);
    expect(auditLines()).toEqual([expect.objectContaining({ event: "denied" })]);
  });

  it("refuses anything but POST, and unknown paths", async () => {
    const { url } = await start(tools());
    const auth = { Authorization: "Bearer alpha-secret" };
    expect((await fetch(`${url}/mcp`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${url}/mcp`, { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await fetch(`${url}/other`, { headers: auth })).status).toBe(404);
  });

  it("refuses bad and oversized bodies", async () => {
    const { url } = await start(tools(), { maxBodyBytes: 100 });
    const auth = { Authorization: "Bearer alpha-secret" };
    expect((await fetch(`${url}/mcp`, { method: "POST", headers: auth, body: "{not json" })).status).toBe(400);
    expect((await fetch(`${url}/mcp`, { method: "POST", headers: auth, body: "x".repeat(200) })).status).toBe(413);
  });

  it("healthz says nothing about agents", async () => {
    const { url } = await start(tools());
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
  });

  it("audits who called what, with ids but never content or secrets", async () => {
    const { url } = await start({
      alpha: { tools: [fakeTool("drive_upload"), fakeTool("boom", async () => { throw new Error("no"); })], authTools: [] },
      beta: { tools: [], authTools: [] },
    });
    const a = await connect(url, "alpha-secret");
    await a.callTool({ name: "drive_upload", arguments: { folderId: "F1", name: "private-name", content: "private-content" } });
    await a.callTool({ name: "boom", arguments: {} });
    await a.close();
    const raw = readFileSync(join(dir, "audit.jsonl"), "utf-8");
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("alpha-secret");
    const [call, done, , failed] = auditLines();
    expect(call).toMatchObject({ event: "call", agent: "alpha", tool: "drive_upload", args: { folderId: "F1" } });
    expect(done).toMatchObject({ event: "done", agent: "alpha", tool: "drive_upload", ok: true });
    expect(failed).toMatchObject({ event: "done", tool: "boom", ok: false });
  });

  it("won't run a call it can't record", async () => {
    let ran = false;
    const { url } = await start(
      { alpha: { tools: [fakeTool("t", async () => { ran = true; return {}; })], authTools: [] } },
      { auditLog: join(dir, "missing", "audit.jsonl") },
    );
    const a = await connect(url, "alpha-secret");
    expect((await a.callTool({ name: "t", arguments: {} })).isError).toBe(true);
    expect(ran).toBe(false);
    await a.close();
  });

  it("records the call before it runs", async () => {
    let seen: any[] = [];
    const { url } = await start({
      alpha: { tools: [fakeTool("t", async () => { seen = auditLines(); return {}; })], authTools: [] },
    });
    const a = await connect(url, "alpha-secret");
    await a.callTool({ name: "t", arguments: {} });
    expect(seen.map((e) => e.event)).toEqual(["call"]);
    await a.close();
  });

  it("won't let an agent stuff the log through an ID", async () => {
    const { url } = await start({ alpha: { tools: [fakeTool("t")], authTools: [] } });
    const a = await connect(url, "alpha-secret");
    await a.callTool({ name: "t", arguments: { fileId: "x".repeat(5000), folderId: "ok-id", email: "a@b.example" } });
    await a.close();
    expect(auditLines()[0].args).toEqual({ folderId: "ok-id", email: "a@b.example" });
  });

  it("logs refused requests, and rate-limits denied ones", async () => {
    const { url } = await start(tools(), { maxBodyBytes: 100 });
    for (let i = 0; i < 5; i++) await fetch(`${url}/mcp`, { method: "POST", body: "{}" });
    await fetch(`${url}/mcp`, { method: "POST", headers: { Authorization: "Bearer alpha-secret" }, body: "{bad" });
    const lines = auditLines();
    expect(lines.filter((l) => l.event === "denied")).toHaveLength(1);
    expect(lines).toContainEqual(expect.objectContaining({ event: "refused", agent: "alpha", status: 400 }));
  });

  it("turns away an agent over its limit, and leaves others working", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const { url } = await start(
      {
        alpha: { tools: [fakeTool("slow", async () => { await gate; return {}; })], authTools: [] },
        beta: { tools: [fakeTool("quick")], authTools: [] },
      },
      { maxInFlightPerAgent: 2, maxInFlightTotal: 3 },
    );
    const a = await connect(url, "alpha-secret");
    const b = await connect(url, "beta-secret");
    const held = [a.callTool({ name: "slow", arguments: {} }), a.callTool({ name: "slow", arguments: {} })];
    await new Promise((done) => setTimeout(done, 50));
    const over = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer alpha-secret", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(over.status).toBe(429);
    expect((await b.callTool({ name: "quick", arguments: {} })).isError).toBeFalsy();
    release();
    await Promise.all(held);
    expect((await a.listTools()).tools).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it("keeps secrets and host paths out of errors", async () => {
    const { url } = await start({
      alpha: {
        tools: [fakeTool("t", async () => { throw new Error("Bearer abc123 at /Users/x/.config/key.json"); })],
        authTools: [],
      },
    });
    const a = await connect(url, "alpha-secret");
    const text = ((await a.callTool({ name: "t", arguments: {} })).content as { text: string }[])[0].text;
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("/Users/x");
    await a.close();
  });

  it("builds an agent's credential once, and rebuilds a login-less agent", async () => {
    let builds = 0;
    const config: BrokerConfig = {
      host: "127.0.0.1", port: 0, auditLog: join(dir, "a.jsonl"), maxBodyBytes: 1024,
      agents: [agent("alpha", "alpha-secret")],
    };
    let loggedIn = false;
    server = createBroker(config, {
      build: () => {
        builds++;
        return {
          tools: loggedIn ? [fakeTool("real")] : [],
          authTools: [{ name: "google_auth_status", description: "", inputSchema: { type: "object" }, handler: async () => [] }],
        };
      },
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const a = await connect(url, "alpha-secret");
    await a.listTools();
    const before = builds;
    await a.listTools();
    expect(builds).toBeGreaterThan(before);
    loggedIn = true;
    expect((await a.listTools()).tools.map((t) => t.name)).toContain("real");
    const settled = builds;
    await a.listTools();
    expect(builds).toBe(settled);
    await a.close();
  });
});

describe("broker errors and re-login", () => {
  it("doesn't send a service account to re-auth tools it lacks", async () => {
    const { url } = await start(
      {
        alpha: {
          tools: [fakeTool("t", async () => { throw new Error("invalid_grant"); })],
          authTools: [],
        },
      },
      {
        agents: [{
          name: "alpha",
          secretSha256: hash("alpha-secret"),
          credential: { type: "service_account", keyFile: "unused" },
          permissions: {},
        }],
      },
    );
    const a = await connect(url, "alpha-secret");
    const result = await a.callTool({ name: "t", arguments: {} });
    const text = (result.content as { text: string }[])[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain("An operator has to fix this");
    expect(text).not.toContain("google_auth_url");
    await a.close();
  });

  it("still sends an OAuth agent to re-auth", async () => {
    const { url } = await start({
      alpha: { tools: [fakeTool("t", async () => { throw new Error("invalid_grant"); })], authTools: [] },
    }, { agents: [agent("alpha", "alpha-secret")] });
    const a = await connect(url, "alpha-secret");
    const text = ((await a.callTool({ name: "t", arguments: {} })).content as { text: string }[])[0].text;
    expect(text).toContain("google_auth_url");
    await a.close();
  });

  it("picks up a new login after an exchange", async () => {
    let builds = 0;
    const config: BrokerConfig = {
      host: "127.0.0.1", port: 0, auditLog: join(dir, "a.jsonl"), maxBodyBytes: 1024,
      agents: [agent("alpha", "alpha-secret")],
    };
    server = createBroker(config, {
      build: () => {
        builds++;
        return {
          tools: [fakeTool("real")],
          authTools: [{
            name: "google_auth_exchange", description: "", inputSchema: { type: "object" },
            handler: async () => [{ type: "text" as const, text: "{}" }],
          }],
        };
      },
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const a = await connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "alpha-secret");
    await a.listTools();
    const before = builds;
    await a.callTool({ name: "google_auth_exchange", arguments: { code: "c" } });
    await a.listTools();
    expect(builds).toBe(before + 1);
    await a.close();
  });
});

describe("cleanErrorText", () => {
  it.each([
    ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "abc"],
    ["token ya29.abc-def", "ya29"],
    ["GOCSPX-abc123", "GOCSPX"],
    ['{"client_secret":"s3cret"}', "s3cret"],
    ['"refresh_token": "1//r3fresh"', "r3fresh"],
    ["Create /Users/juni/.nimbleco-google/config.json first", "/Users/juni"],
  ])("removes the secret from %s", (input, secret) => {
    expect(cleanErrorText(input)).not.toContain(secret);
  });
  it("keeps Drive IDs, and caps length", () => {
    expect(cleanErrorText("File not found: 1UyHc-d_w.")).toContain("1UyHc-d_w");
    expect(cleanErrorText("x".repeat(5000))).toHaveLength(2000);
  });
});

describe("findAgent", () => {
  it("matches only the right secret", () => {
    const agents = [agent("alpha", "a"), agent("beta", "b")];
    expect(findAgent(agents, "b")?.name).toBe("beta");
    expect(findAgent(agents, "c")).toBeNull();
    expect(findAgent(agents, "")).toBeNull();
  });
});

describe("broker config", () => {
  const key = () => {
    const path = join(dir, "key.json");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(path, JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: privateKey }));
    chmodSync(path, 0o600);
    return path;
  };
  const yml = (agentYaml: string) => `audit_log: audit.jsonl\nagents:\n${agentYaml}`;
  const sa = (extra: string, keyFile = "key.json", secret = hash("s")) =>
    `  a:\n    secret_sha256: ${secret}\n    credential: {type: service_account, key_file: ${keyFile}}\n    permissions:\n${extra}`;

  it.each(["false", "{x: 1}", "5", "F1", "['']", "[null]"])("refuses folders: %s", (value) => {
    key();
    expect(() => parseBrokerConfig(yml(sa(`      drive: {access: write, folders: ${value}}\n`)), dir)).toThrow(/list of IDs/);
    const oauth = yml(`  p:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: p, expected_account: a@b.example}\n    allow_whole_account: true\n    permissions:\n      drive: {access: write, folders: ${value}}\n`);
    expect(() => parseBrokerConfig(oauth, dir)).toThrow(/list of IDs/);
  });

  it.each(["no", "None", "off", "false", "owner"])("refuses access: %s", (value) => {
    key();
    expect(() => parseBrokerConfig(yml(sa(`      drive: {access: ${value}, folders: [F1]}\n`)), dir)).toThrow(/access/);
  });

  it("won't let folders stand in for the whole-mailbox gate", () => {
    const y = (extra: string, gmail: string) =>
      yml(`  p:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: p, expected_account: a@b.example}\n${extra}    permissions:\n      gmail: ${gmail}\n`);
    expect(() => parseBrokerConfig(y("", "{access: admin, folders: [x]}"), dir)).toThrow(/Gmail has no folders/);
    expect(() => parseBrokerConfig(y("", "{access: read}"), dir)).toThrow(/allow_whole_account/);
    expect(parseBrokerConfig(y("    allow_whole_account: true\n", "{access: read}"), dir).agents).toHaveLength(1);
  });

  it("refuses shared credentials, and identities that escape the token folder", () => {
    const o = (name: string, secret: string, identity: string) =>
      `  ${name}:\n    secret_sha256: ${hash(secret)}\n    credential: {type: oauth, identity: "${identity}", expected_account: a@b.example}\n`;
    expect(() => parseBrokerConfig(yml(o("a", "1", "same") + o("b", "2", "same")), dir)).toThrow(/shares/);
    expect(() => parseBrokerConfig(yml(o("a", "1", "../../evil")), dir)).toThrow(/identity/);
    key();
    const two = yml(sa("      drive: {access: write, folders: [F1]}\n") + sa("      drive: {access: write, folders: [F1]}\n", "key.json", hash("t")).replace("  a:", "  b:"));
    expect(() => parseBrokerConfig(two, dir)).toThrow(/shares/);
  });

  it("requires the account an OAuth agent may log in to", () => {
    const y = yml(`  p:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: p}\n`);
    expect(() => parseBrokerConfig(y, dir)).toThrow(/expected_account/);
  });

  it("refuses a non-loopback bind unless asked, and bad numbers", () => {
    const base = `agents:\n  p:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: p, expected_account: a@b.example}\naudit_log: a.jsonl\n`;
    expect(() => parseBrokerConfig(base + "host: 0.0.0.0\n", dir)).toThrow(/loopback/);
    expect(parseBrokerConfig(base + "host: 0.0.0.0\nallow_non_loopback: true\n", dir).host).toBe("0.0.0.0");
    expect(() => parseBrokerConfig(base + "max_body_bytes: 64MB\n", dir)).toThrow(/max_body_bytes/);
    expect(() => parseBrokerConfig(base + "port: lots\n", dir)).toThrow(/port/);
  });

  it("loads a service account scoped to folders", () => {
    key();
    const c = parseBrokerConfig(yml(sa("      drive: {access: write, folders: [F1]}\n")), dir);
    expect(c.host).toBe("127.0.0.1");
    expect(c.agents[0].credential).toEqual({ type: "service_account", keyFile: join(dir, "key.json") });
    expect(c.auditLog).toBe(join(dir, "audit.jsonl"));
  });

  it("refuses a service account with an open folder list", () => {
    key();
    expect(() => parseBrokerConfig(yml(sa("      drive: {access: write}\n")), dir)).toThrow(/must list folders/);
  });

  it("refuses Gmail on a service account", () => {
    key();
    expect(() => parseBrokerConfig(yml(sa("      gmail: {access: read}\n")), dir)).toThrow(/no Gmail/);
  });

  it("refuses a key file others can read", () => {
    chmodSync(key(), 0o644);
    expect(() => parseBrokerConfig(yml(sa("      drive: {access: write, folders: [F1]}\n")), dir)).toThrow(/readable/);
  });

  it("refuses a missing key file", () => {
    expect(() => parseBrokerConfig(yml(sa("      drive: {access: write, folders: [F1]}\n")), dir)).toThrow(/missing/);
  });

  it("reads a service with no access level as no access", () => {
    key();
    const c = parseBrokerConfig(yml(sa("      drive: {folders: [F1]}\n      calendar:\n")), dir);
    expect(c.agents[0].permissions.drive?.access).toBe("none");
    expect(c.agents[0].permissions.calendar?.access).toBe("none");
  });

  it("makes OAuth ask for the whole account by name", () => {
    const oauth = (extra = "") =>
      yml(`  p:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: p, expected_account: a@b.example}\n${extra}    permissions:\n      drive: {access: write}\n`);
    expect(() => parseBrokerConfig(oauth(), dir)).toThrow(/allow_whole_account/);
    expect(parseBrokerConfig(oauth("    allow_whole_account: true\n"), dir).agents[0].name).toBe("p");
  });

  it("refuses bad and repeated secrets, and unknown types", () => {
    const bad = yml(`  a:\n    secret_sha256: short\n    credential: {type: oauth, identity: a, expected_account: a@b.example}\n`);
    expect(() => parseBrokerConfig(bad, dir)).toThrow(/secret_sha256/);
    const two = yml(
      `  a:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: a, expected_account: a@b.example}\n` +
      `  b:\n    secret_sha256: ${hash("s")}\n    credential: {type: oauth, identity: b, expected_account: b@b.example}\n`);
    expect(() => parseBrokerConfig(two, dir)).toThrow(/reuses/);
    const type = yml(`  a:\n    secret_sha256: ${hash("s")}\n    credential: {type: magic}\n`);
    expect(() => parseBrokerConfig(type, dir)).toThrow(/unknown credential/);
  });
});

describe("agent tools", () => {
  it("gives a service account no Gmail scope and no auth tools", () => {
    const keyFile = join(dir, "key.json");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(keyFile, JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: privateKey }));
    const permissions = {
      drive: { access: "write" as const, folders: ["F1"] },
      docs: { access: "write" as const, folders: ["F1"] },
      sheets: { access: "none" as const, folders: [] },
    };
    const built = buildAgentTools({
      name: "a",
      secretSha256: hash("s"),
      credential: { type: "service_account", keyFile },
      permissions,
    });
    expect(built.authTools).toEqual([]);
    expect(built.tools.some((t) => t.name === "drive_list")).toBe(true);
    expect(built.tools.some((t) => t.service === "gmail" || t.service === "sheets")).toBe(false);
    const scopes = scopesFor(permissions);
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
    ]);
    expect(scopesFor({ ...permissions, gmail: { access: "write", folders: [] } }).join(" ")).not.toContain("gmail");
  });

  it("asks Google for read-only scopes for a read-only agent", () => {
    const base = "https://www.googleapis.com/auth/";
    expect(scopesFor({
      drive: { access: "read", folders: ["F"] },
      sheets: { access: "read", folders: ["F"] },
      calendar: { access: "read", folders: ["C"] },
    })).toEqual([`${base}drive.readonly`, `${base}spreadsheets.readonly`, `${base}calendar.readonly`]);
    expect(scopesFor({
      drive: { access: "read", folders: ["F"] },
      docs: { access: "write", folders: ["F"] },
    })).toEqual([`${base}drive`, `${base}documents`]);
  });

  it("gives an OAuth agent only the auth tools that work from here", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_TOKEN_DIR = dir;
    try {
      const built = buildAgentTools(agent("nobody", "s"));
      expect(built.tools).toEqual([]);
      expect(built.authTools.map((t) => t.name).sort()).toEqual([
        "google_auth_exchange", "google_auth_status", "google_auth_url",
      ]);
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_TOKEN_DIR;
    }
  });
});
