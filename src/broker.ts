/**
 * Broker mode: one HTTP service holding the Google credentials, so an agent
 * holds only a secret that identifies it here and never a Google credential.
 *
 * Each request is authenticated to one agent, and gets that agent's tools and
 * credential. The agent's secret is stored here only as a SHA-256 hash.
 */

import { createHash, timingSafeEqual } from "crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync } from "fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "http";
import { dirname, isAbsolute, resolve } from "path";
import yaml from "js-yaml";
import { google } from "googleapis";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createAuthClient, createServiceAccountClient, isAccount } from "./auth.js";
import { formatToolError, type ToolErrorPayload } from "./auth-errors.js";
import { collectTools, dispatchToolCall, getAuthTools, type AuthToolDef } from "./server.js";
import type { PermissionConfig, ServiceName, ServicePermission, ToolDef } from "./types.js";

const DEFAULT_PORT = 8797;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT_PER_AGENT = 8;
const MAX_IN_FLIGHT_TOTAL = 32;
const GOOGLE_TIMEOUT_MS = 120_000;
/** Covers token calls too, which ignore the Google client timeout. */
const TOOL_DEADLINE_MS = 240_000;
/** A client that stops reading can't hold its place for longer than this. */
const REQUEST_DEADLINE_MS = 270_000;
/** High on purpose: agents share an address, so idle sockets can't be told apart. */
const MAX_CONNECTIONS = 2048;
const MAX_REQUESTS_PER_SECOND = 50;
/** Cap what's searched for addresses, because this runs on the event loop. */
const MAX_RECIPIENT_TEXT = 16_384;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Fields naming people, audited as a list however they were written. */
const AUDITED_RECIPIENTS = new Set(["to", "cc", "bcc", "attendees"]);
/** Audited values must look like an ID, so an agent can't stuff the log. */
const AUDITABLE_VALUE = /^[\w@.+-]{1,128}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_LEVELS = ["none", "read", "write", "admin"];
/** The only OAuth auth tools that work without a callback server in the agent. */
const BROKER_AUTH_TOOLS = new Set(["google_auth_url", "google_auth_exchange", "google_auth_status"]);
/** Tool arguments safe to audit. Everything else, such as content, is left out. */
const AUDITED_ARGS = new Set([
  "fileId", "folderId", "parentId", "destinationFolderId", "documentId", "spreadsheetId",
  "calendarId", "eventId", "messageId", "email", "role",
]);

type ServiceAccountCredential = { type: "service_account"; keyFile: string };
type OAuthCredential = { type: "oauth"; identity: string; expectedAccount: string };

export interface BrokerAgent {
  name: string;
  secretSha256: string;
  credential: ServiceAccountCredential | OAuthCredential;
  permissions: Partial<Record<ServiceName, ServicePermission>>;
}

export interface BrokerConfig {
  host: string;
  port: number;
  auditLog: string;
  maxBodyBytes: number;
  maxInFlightPerAgent?: number;
  maxInFlightTotal?: number;
  toolDeadlineMs?: number;
  maxRequestsPerSecond?: number;
  maxAuditBytes?: number;
  requestDeadlineMs?: number;
  agents: BrokerAgent[];
}

function fail(message: string): never {
  throw new Error(`Broker config: ${message}`);
}

function parsePermissions(agent: string, raw: unknown): BrokerAgent["permissions"] {
  const out: BrokerAgent["permissions"] = {};
  for (const [service, value] of Object.entries((raw ?? {}) as Record<string, Partial<ServicePermission> | null>)) {
    if (!["drive", "calendar", "gmail", "docs", "sheets"].includes(service)) {
      fail(`agent "${agent}" has unknown service "${service}"`);
    }
    // Unlike the stdio config, no access level means no access.
    const access = value?.access ?? "none";
    if (!ACCESS_LEVELS.includes(access)) fail(`agent "${agent}" has unknown access "${String(access)}" for ${service}`);
    // Tools read a non-array here as "no restriction", so refuse it.
    const folders = value?.folders ?? [];
    if (!Array.isArray(folders) || folders.some((f) => typeof f !== "string" || !f.trim())) {
      fail(`agent "${agent}" needs ${service} folders as a list of IDs`);
    }
    if (service === "gmail" && folders.length > 0) {
      fail(`agent "${agent}": Gmail has no folders, so folders can't limit it`);
    }
    out[service as ServiceName] = { access, folders };
  }
  return out;
}

/** Parse and validate broker YAML. Anything risky stops startup. */
export function parseBrokerConfig(yamlStr: string, baseDir: string): BrokerConfig {
  const raw = yaml.load(yamlStr) as Record<string, any> | null;
  if (!raw || !raw.agents || typeof raw.agents !== "object") fail("agents is required");
  if (typeof raw.audit_log !== "string" || !raw.audit_log) fail("audit_log is required");

  const inBase = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const seen = new Set<string>();
  const seenCredentials = new Set<string>();
  const once = (agent: string, credential: string) => {
    if (seenCredentials.has(credential)) fail(`agent "${agent}" shares another agent's credential`);
    seenCredentials.add(credential);
  };
  const agents: BrokerAgent[] = Object.entries(raw.agents as Record<string, any>).map(([name, a]) => {
    const secretSha256 = String(a?.secret_sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(secretSha256)) fail(`agent "${name}" needs a 64-character hex secret_sha256`);
    if (seen.has(secretSha256)) fail(`agent "${name}" reuses another agent's secret`);
    seen.add(secretSha256);

    const permissions = parsePermissions(name, a.permissions);
    const open = (Object.entries(permissions) as [ServiceName, ServicePermission][])
      .filter(([, p]) => p.access !== "none" && (p.folders ?? []).length === 0)
      .map(([s]) => s);
    const type = a?.credential?.type;

    if (type === "service_account") {
      if (typeof a.credential.key_file !== "string") fail(`agent "${name}" needs credential.key_file`);
      if ((permissions.gmail?.access ?? "none") !== "none") fail(`agent "${name}": a service account has no Gmail`);
      if (open.length > 0) fail(`agent "${name}" must list folders for: ${open.join(", ")}`);
      const keyFile = inBase(a.credential.key_file);
      let mode: number;
      try {
        mode = statSync(keyFile).mode;
      } catch {
        fail(`agent "${name}" key file is missing`);
      }
      if (mode & 0o077) fail(`agent "${name}" key file must not be readable by group or others`);
      once(name, `key:${realpathSync(keyFile)}`);
      return { name, secretSha256, credential: { type, keyFile }, permissions };
    }

    if (type === "oauth") {
      const identity = a.credential.identity;
      if (typeof identity !== "string" || !SAFE_IDENTITY.test(identity)) {
        fail(`agent "${name}" needs a credential.identity of letters, numbers, - or _`);
      }
      // Re-login is agent-driven, so pin the account it must log in to.
      const expectedAccount = a.credential.expected_account;
      if (typeof expectedAccount !== "string" || !expectedAccount.includes("@")) {
        fail(`agent "${name}" needs credential.expected_account`);
      }
      // Case can differ on a case-insensitive disk and still be one token file.
      once(name, `identity:${identity.toLowerCase()}`);
      // An empty folder list means the whole account, so each service asks for it by name.
      const whole = a.allow_whole_account ?? [];
      if (!Array.isArray(whole)) fail(`agent "${name}": allow_whole_account must list services, such as [gmail]`);
      const unasked = open.filter((svc) => !whole.includes(svc));
      if (unasked.length > 0) {
        fail(`agent "${name}" has no folders for ${unasked.join(", ")}; list them or add to allow_whole_account`);
      }
      return { name, secretSha256, credential: { type, identity, expectedAccount }, permissions };
    }

    fail(`agent "${name}" has unknown credential type "${String(type)}"`);
  });

  if (agents.length === 0) fail("no agents");
  const host = raw.host ?? "127.0.0.1";
  if (typeof host !== "string") fail("host must be a string");
  if (!LOOPBACK.has(host) && raw.allow_non_loopback !== true) {
    fail(`host ${host} isn't loopback; secrets travel unencrypted, so set allow_non_loopback only if something else protects them`);
  }
  const port = raw.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("port must be a port number");
  const maxBodyBytes = raw.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) fail("max_body_bytes must be a positive whole number");
  return {
    host,
    port,
    auditLog: inBase(raw.audit_log),
    maxBodyBytes,
    agents,
  };
}

export function loadBrokerConfig(path: string): BrokerConfig {
  return parseBrokerConfig(readFileSync(path, "utf-8"), dirname(resolve(path)));
}

/** The narrowest Google scopes covering the access a service account was given. */
export function scopesFor(permissions: BrokerAgent["permissions"]): string[] {
  const level = (svc: ServiceName) => permissions[svc]?.access ?? "none";
  const base = "https://www.googleapis.com/auth/";
  const scope = (name: string, ...services: ServiceName[]): string[] => {
    const levels = services.map(level).filter((l) => l !== "none");
    if (levels.length === 0) return [];
    return [levels.some((l) => l !== "read") ? `${base}${name}` : `${base}${name}.readonly`];
  };
  return [
    // Docs and Sheets create and check files through Drive.
    ...scope("drive", "drive", "docs", "sheets"),
    ...scope("documents", "docs"),
    ...scope("spreadsheets", "sheets"),
    ...scope("calendar", "calendar"),
  ];
}

export interface AgentTools {
  tools: ToolDef[];
  authTools: AuthToolDef[];
}

/** Whether an OAuth agent's saved login is the account it's pinned to. */
async function savedLoginMatches(agent: BrokerAgent): Promise<boolean> {
  if (agent.credential.type !== "oauth") return true;
  return isAccount(createAuthClient(agent.credential.identity), agent.credential.expectedAccount);
}

/** Build an agent's tools against its own credential. */
export function buildAgentTools(agent: BrokerAgent): AgentTools {
  const config: PermissionConfig = {
    identity: agent.credential.type === "oauth" ? agent.credential.identity : agent.name,
    permissions: agent.permissions,
  };
  if (agent.credential.type === "service_account") {
    const auth = createServiceAccountClient(agent.credential.keyFile, scopesFor(agent.permissions));
    return { tools: collectTools(config, auth), authTools: [] };
  }
  const authTools = getAuthTools(config.identity, {
    reloadNeeded: false,
    expectedAccount: agent.credential.expectedAccount,
  }).filter((t) =>
    BROKER_AUTH_TOOLS.has(t.name),
  );
  try {
    return { tools: collectTools(config, createAuthClient(config.identity)), authTools };
  } catch (err) {
    // No token yet: the auth tools alone let the agent ask for a login.
    console.error(`broker: "${agent.name}" has no usable login: ${err instanceof Error ? err.message : String(err)}`);
    return { tools: [], authTools };
  }
}

/** Re-auth tools don't exist for a service account, so don't point at them. */
function serviceAccountError(err: unknown): ToolErrorPayload {
  const payload = formatToolError(err);
  if (payload.status !== "auth_expired") return payload;
  return {
    status: "error",
    message: "Google rejected this agent's service account. An operator has to fix this; logging in won't help.",
    detail: payload.detail,
  };
}

const SECRET_KEY = /^(client_?secret|refresh_?token|access_?token|id_?token|private_?key|assertion)$/i;

function cleanString(text: string): string {
  return text
    .replace(/-----BEGIN[\s\S]*?(-----END[^-]*-----|$)/g, "<redacted>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\bBasic\s+(?=[\w+/=-]*[0-9+/=A-Z])[\w+/=-]{8,}/gi, "Basic <redacted>")
    .replace(/\b(ya29\.|GOCSPX-)[\w./-]+/g, "<redacted>")
    .replace(/\b(1\/\/|4\/[01])[\w./-]{10,}/g, "<redacted>")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "<redacted>")
    .replace(
      /"?\b(client_?secret|refresh_?token|access_?token|id_?token|private_?key|assertion|code)\b"?\s*(=\s*[^\s",&}]+|:\s*"[^"]*"|:\s*'[^']*'|:\s*[^\s",}]{16,})/gi,
      "$1: <redacted>",
    )
    .replace(/(^|[\s"'(=:])\/(?:[\w.-]+\/)+[\w.-]*/g, "$1<path>")
    .replace(/\b[A-Za-z]:\\[^\s"')]+/g, "<path>")
    .slice(0, 2000);
}

function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "<redacted>" : cleanValue(v)]),
    );
  }
  return value;
}

/**
 * Error text reaches an agent, so it carries no secret, host path or bulk.
 * A JSON payload is cleaned field by field, so it stays readable.
 */
export function cleanErrorText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return JSON.stringify(cleanValue(parsed), null, 2);
  } catch {
    // Plain text.
  }
  return cleanString(text);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compare against every agent, so timing doesn't reveal which one matched. */
export function findAgent(agents: BrokerAgent[], secret: string): BrokerAgent | null {
  const hash = sha256(secret);
  let found: BrokerAgent | null = null;
  for (const agent of agents) {
    if (timingSafeEqual(hash, Buffer.from(agent.secretSha256, "hex"))) found = agent;
  }
  return found;
}

function auditArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (AUDITED_ARGS.has(k) && typeof v === "string" && AUDITABLE_VALUE.test(v)) out[k] = v;
    if (AUDITED_RECIPIENTS.has(k) && (typeof v === "string" || Array.isArray(v))) {
      // Addresses only, so a recipient field can't carry content into the log.
      const items = Array.isArray(v) ? v.slice(0, 256).filter((i) => typeof i === "string") : [v];
      const text = items.map((i) => (i as string).slice(0, 1024)).join(" ").slice(0, MAX_RECIPIENT_TEXT);
      const people = text.match(/[\p{L}\p{N}.+_-]{1,64}@[\p{L}\p{N}.-]{1,190}/gu) ?? [];
      out[k] = { count: people.length, chars: text.length, first: people.slice(0, 5) };
    }
  }
  return out;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((done, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      reject(new BodyTooLarge());
      return;
    }
    let chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks = [];
        req.off("data", onData);
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  // Close afterwards, or an unread body can hold the connection open.
  const headers: Record<string, string> = { "Content-Type": "application/json", Connection: "close" };
  if (status === 429) headers["Retry-After"] = "1";
  res.writeHead(status, headers);
  res.end(JSON.stringify(body), () => res.socket?.destroy());
}

export interface BrokerOptions {
  /** Replaces the Google-backed tool builder in tests. */
  build?: (agent: BrokerAgent) => AgentTools;
  /** Replaces the check of an OAuth agent's saved login in tests. */
  verifyLogin?: (agent: BrokerAgent) => Promise<boolean>;
}

export function createBroker(config: BrokerConfig, options: BrokerOptions = {}): HttpServer {
  const build = options.build ?? buildAgentTools;
  const verifyLogin = options.verifyLogin ?? savedLoginMatches;
  const toolDeadline = config.toolDeadlineMs ?? TOOL_DEADLINE_MS;
  const requestDeadline = config.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  const cache = new Map<string, AgentTools>();

  const maxPerAgent = config.maxInFlightPerAgent ?? MAX_IN_FLIGHT_PER_AGENT;
  const maxTotal = config.maxInFlightTotal ?? MAX_IN_FLIGHT_TOTAL;
  const inFlight = new Map<string, number>();
  let totalInFlight = 0;
  const lastLogged = new Map<string, { at: number; suppressed: number }>();

  const maxAuditBytes = config.maxAuditBytes ?? MAX_AUDIT_BYTES;
  let auditBytes = existsSync(config.auditLog) ? statSync(config.auditLog).size : 0;
  const recent = new Map<string, { second: number; count: number }>();

  /** No agent can drive the broker, or the log, faster than this. */
  const overRate = (name: string): boolean => {
    const second = Math.floor(Date.now() / 1000);
    const entry = recent.get(name);
    if (!entry || entry.second !== second) {
      recent.set(name, { second, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > (config.maxRequestsPerSecond ?? MAX_REQUESTS_PER_SECOND);
  };

  const audit = (event: Record<string, unknown>): boolean => {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
      // Keep one old file, so the log can't fill the disk.
      const size = Buffer.byteLength(line);
      if (auditBytes + size > maxAuditBytes) {
        try {
          renameSync(config.auditLog, `${config.auditLog}.1`);
        } catch (err) {
          // If the log was deleted, there's nothing to move aside.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        auditBytes = 0;
      }
      appendFileSync(config.auditLog, line, { mode: 0o600 });
      auditBytes += size;
      return true;
    } catch (err) {
      console.error(`broker: audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  // A caller can repeat a refused request as fast as it likes.
  const auditLimited = (key: string, event: Record<string, unknown>) => {
    const now = Date.now();
    const entry = lastLogged.get(key) ?? { at: 0, suppressed: 0 };
    if (now - entry.at < 1000) {
      entry.suppressed++;
      lastLogged.set(key, entry);
      return;
    }
    audit({ ...event, suppressed: entry.suppressed });
    lastLogged.set(key, { at: now, suppressed: 0 });
  };

  /** A place in the limits, held until the response and the tool have both finished. */
  const takeSlot = (name: string) => {
    inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
    totalInFlight++;
    let holds = 1;
    const release = () => {
      if (--holds === 0) {
        inFlight.set(name, (inFlight.get(name) ?? 1) - 1);
        totalInFlight--;
      }
    };
    return {
      release,
      hold: () => {
        // The client left before the tool started, so this is a fresh place.
        if (holds === 0) {
          inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
          totalInFlight++;
        }
        holds++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            release();
          }
        };
      },
    };
  };

  const toolsFor = async (agent: BrokerAgent): Promise<AgentTools> => {
    const cached = cache.get(agent.name);
    if (cached) return cached;
    const built = build(agent);
    if (built.tools.length > 0 && agent.credential.type === "oauth") {
      // A token file can be replaced outside the broker, so check who it's for.
      let matches = false;
      try {
        matches = await verifyLogin(agent);
      } catch (err) {
        console.error(`broker: couldn't check "${agent.name}" login: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!matches) {
        audit({ event: "login_refused", agent: agent.name });
        return { tools: [], authTools: built.authTools };
      }
    }
    // A login-less OAuth agent gets rebuilt until a token appears.
    if (built.tools.length > 0 || built.authTools.length === 0) cache.set(agent.name, built);
    return built;
  };

  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    agent: BrokerAgent,
    body: unknown,
    slot: ReturnType<typeof takeSlot>,
  ) => {
    const { tools, authTools } = await toolsFor(agent);
    if (res.destroyed || res.closed) return;
    const server = new Server(
      { name: "google-multiplayer-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools, ...authTools].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const started = Date.now();
      const tool = name.slice(0, 128);
      if (![...tools, ...authTools].some((t) => t.name === name)) {
        auditLimited(`unknown:${agent.name}`, { event: "unknown_tool", agent: agent.name, tool });
        return { content: [{ type: "text" as const, text: `Unknown tool: ${tool}` }], isError: true };
      }
      // Record the call before it runs, and don't run what can't be recorded.
      if (!audit({ event: "call", agent: agent.name, tool, args: auditArgs(args) })) {
        return {
          content: [{ type: "text" as const, text: "The broker can't record this call, so it wasn't run." }],
          isError: true,
        };
      }
      const formatError = agent.credential.type === "service_account" ? serviceAccountError : undefined;
      // Keep the place until the work ends, even if the client has gone.
      const done = slot.hold();
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<CallToolResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ content: [{ type: "text" as const, text: "The call took too long and was abandoned." }], isError: true });
        }, toolDeadline);
      });
      let result: CallToolResult;
      try {
        result = await Promise.race([dispatchToolCall(name, args, tools, authTools, formatError), deadline]);
      } finally {
        clearTimeout(timer);
        done();
      }
      // Only a real new login needs a fresh check.
      if (name === "google_auth_exchange" && !result.isError) cache.delete(agent.name);
      audit({ event: "done", agent: agent.name, tool, ok: !result.isError, ms: Date.now() - started });
      if (result.isError) {
        result.content = result.content.map((c) =>
          c.type === "text" ? { ...c, text: cleanErrorText(c.text) } : c,
        );
      }
      return result;
    });

    // Stateless: every request stands alone, so a restart loses nothing.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer({ connectionsCheckingInterval: 1000 }, (req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz") return reply(res, 200, { ok: true });
      if (path !== "/mcp") return reply(res, 404, { error: "not found" });

      const header = req.headers.authorization ?? "";
      const agent = header.startsWith("Bearer ") ? findAgent(config.agents, header.slice(7)) : null;
      if (!agent) {
        auditLimited("denied", { event: "denied" });
        req.resume();
        return reply(res, 401, { error: "unauthorized" });
      }
      // Stateless, so there is no stream to open and no session to end.
      if (req.method !== "POST") {
        req.resume();
        return reply(res, 405, { error: "method not allowed" });
      }

      // One agent can't use up the service for the others.
      if (overRate(agent.name) || (inFlight.get(agent.name) ?? 0) >= maxPerAgent || totalInFlight >= maxTotal) {
        auditLimited(`busy:${agent.name}`, { event: "refused", agent: agent.name, status: 429 });
        req.resume();
        return reply(res, 429, { error: "too many requests" });
      }
      const slot = takeSlot(agent.name);
      res.once("close", slot.release);
      const deadline = setTimeout(() => req.socket.destroy(), requestDeadline);
      deadline.unref();
      res.once("close", () => clearTimeout(deadline));

      let body: unknown;
      try {
        body = JSON.parse((await readBody(req, config.maxBodyBytes)).toString("utf-8"));
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          // Don't keep reading, or holding memory for, a body we've refused.
          auditLimited(`big:${agent.name}`, { event: "refused", agent: agent.name, status: 413 });
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "body too large" }), () => req.socket.destroy());
          return;
        }
        auditLimited(`bad:${agent.name}`, { event: "refused", agent: agent.name, status: 400 });
        return reply(res, 400, { error: "invalid JSON" });
      }
      // One request, one message: a batch would run past the limits above.
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        auditLimited(`bad:${agent.name}`, { event: "refused", agent: agent.name, status: 400 });
        return reply(res, 400, { error: "send one JSON-RPC message per request" });
      }
      await handleMcp(req, res, agent, body, slot);
    })().catch((err) => {
      console.error(`broker: request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) reply(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  // Connections with no secret are limited too, and don't get to wait around.
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 3_000;
  server.requestTimeout = 60_000;
  return server;
}

/** Google client settings for the broker. A retry would multiply the timeout. */
export function configureGoogleClients(): void {
  google.options({ timeout: GOOGLE_TIMEOUT_MS, retry: false });
}

export async function startBroker(configPath: string): Promise<void> {
  const config = loadBrokerConfig(configPath);
  // Check every credential now, not on an agent's first call.
  for (const agent of config.agents) {
    if (agent.credential.type === "service_account") {
      createServiceAccountClient(agent.credential.keyFile, []);
    }
  }
  // Refuse to start with no audit log, rather than run unrecorded.
  appendFileSync(config.auditLog, "", { mode: 0o600 });
  configureGoogleClients();
  const server = createBroker(config);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      // A later error, such as running out of file handles, mustn't end the service.
      server.on("error", (err) => console.error(`broker: server error: ${err.message}`));
      done();
    });
  });
  console.error(`google-multiplayer-mcp broker: ${config.agents.length} agents on ${config.host}:${config.port}`);
}
