/** OAuth token management and browser-based auth flow. */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { google } from "googleapis";
import type { GlobalConfig, TokenSet } from "./types.js";

const CONFIG_DIR = join(homedir(), ".nimbleco-google");
const TOKEN_DIR = join(CONFIG_DIR, "tokens");
const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];

const REDIRECT_PORT = parseInt(process.env.GOOGLE_AUTH_PORT ?? "8095", 10);
/**
 * Allow overriding the redirect URI for remote setups (e.g. SSH into a Mac Mini
 * where the callback server runs on the remote host but the browser is local).
 * Set GOOGLE_AUTH_HOST to the hostname/IP reachable from the browser.
 * Defaults to "localhost" for local dev.
 */
const REDIRECT_HOST = process.env.GOOGLE_AUTH_HOST ?? "localhost";
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}/callback`;

/** Load global config (client ID/secret). */
function loadGlobalConfig(): GlobalConfig {
  // Env vars override file config
  const envId = process.env.GOOGLE_CLIENT_ID ?? "";
  const envSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    throw new Error(
      `Google MCP not configured. Create ${GLOBAL_CONFIG_PATH} with clientId and clientSecret, ` +
        `or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.`,
    );
  }

  return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
}

/** Get the token file path for an identity. */
function tokenPath(identity: string): string {
  return join(
    process.env.GOOGLE_TOKEN_DIR ?? TOKEN_DIR,
    `${identity}.json`,
  );
}

/** Load saved tokens for an identity. Returns null if not found. */
export function loadTokens(identity: string): TokenSet | null {
  const path = tokenPath(identity);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Save tokens for an identity. */
function saveTokens(identity: string, tokens: TokenSet): void {
  const dir = process.env.GOOGLE_TOKEN_DIR ?? TOKEN_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(identity), JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

/** Create an OAuth2 client for the given identity, loaded with saved tokens. */
export function createAuthClient(
  identity: string,
): InstanceType<typeof google.auth.OAuth2> {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  const tokens = loadTokens(identity);
  if (!tokens?.refresh_token) {
    throw new Error(
      `No tokens for identity "${identity}". Run: google-multiplayer-mcp auth ${identity}`,
    );
  }

  client.setCredentials(tokens);

  // Persist refreshed tokens automatically
  client.on("tokens", (newTokens) => {
    const existing = loadTokens(identity) ?? {};
    // Strip null values so they don't violate TokenSet's undefined-only fields
    const cleaned = Object.fromEntries(
      Object.entries(newTokens).filter(([, v]) => v !== null),
    ) as TokenSet;
    saveTokens(identity, { ...existing, ...cleaned });
  });

  return client;
}

/**
 * Create a client for a service account. It has no login to expire, and Google
 * limits it to what was shared with it.
 */
export function createServiceAccountClient(
  keyFile: string,
  scopes: string[],
): InstanceType<typeof google.auth.OAuth2> {
  const key = JSON.parse(readFileSync(keyFile, "utf-8")) as {
    client_email?: string;
    private_key?: string;
  };
  if (!key.client_email || !key.private_key) {
    throw new Error(`${keyFile} is not a service account key`);
  }
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
  });
}

/** Whether a login belongs to this account. Throws if Google can't say. */
export async function isAccount(
  client: InstanceType<typeof google.auth.OAuth2>,
  expected: string,
): Promise<boolean> {
  let actual: string | null | undefined;
  try {
    const about = await google.drive({ version: "v3", auth: client }).about.get({ fields: "user(emailAddress)" });
    actual = about.data.user?.emailAddress;
  } catch {
    // Some logins have Gmail but not Drive.
    const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
    actual = profile.data.emailAddress;
  }
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

/** Run the OAuth browser flow for an identity. */
export async function runAuthFlow(identity: string): Promise<void> {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log(`Authenticating identity: ${identity}`);
  console.log(`Opening Google OAuth consent flow...\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Authenticated! You can close this tab.</h2></body></html>",
          );
          server.close();
          resolve(code);
        } else {
          const error = url.searchParams.get("error") ?? "No code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Error: ${error}</h2></body></html>`);
          server.close();
          reject(new Error(error));
        }
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${REDIRECT_PORT} is already in use. ` +
              `Kill the process using it or set GOOGLE_AUTH_PORT to a different port.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, "0.0.0.0", () => {
      console.log(`Callback server listening on 0.0.0.0:${REDIRECT_PORT}`);
      console.log(`Redirect URI: ${REDIRECT_URI}`);
      if (REDIRECT_HOST !== "localhost") {
        console.log(
          `(Using custom host "${REDIRECT_HOST}" — ensure Google OAuth redirect URIs include ${REDIRECT_URI})`,
        );
      }
      console.log(`\nOpen this URL in your browser:\n\n  ${authUrl}\n`);

      import("open")
        .then((mod) => mod.default(authUrl))
        .catch(() => {
          // Browser open failed — URL is already printed
        })
        // Also catch unhandled spawn errors from the open child process
        .then((cp: any) => {
          if (cp && typeof cp.on === "function") {
            cp.on("error", () => {
              // Silently ignore — URL is already printed for manual copy
            });
          }
        })
        .catch(() => {});
    });

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 2 minutes"));
    }, 120_000);
  });

  const { tokens } = await client.getToken(code);
  saveTokens(identity, tokens as TokenSet);

  // Get user email for confirmation
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const userInfo = await oauth2.userinfo.get();
  console.log(`\nConnected as ${userInfo.data.email ?? "unknown"}`);
}

/** In-flight headless auth state, keyed by identity. */
const pendingAuth = new Map<
  string,
  { resolve: (v: "ok") => void; reject: (e: Error) => void }
>();

/**
 * Run an OAuth flow without opening a browser.
 *
 * Prints a structured `AUTH_REQUIRED:` line to stdout so a calling process
 * (e.g. an MCP client or Hermes agent) can parse the URL and present it to
 * the user.  The callback server binds to 0.0.0.0 so it is reachable when
 * port-published from a Docker container.
 */
export async function runHeadlessAuthFlow(identity: string): Promise<void> {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  // Structured line for machine parsing
  console.log(`AUTH_REQUIRED: Open this URL to authenticate: ${authUrl}`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Authenticated! You can close this tab.</h2></body></html>",
          );
          server.close();
          resolve(code);
        } else {
          const error = url.searchParams.get("error") ?? "No code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Error: ${error}</h2></body></html>`);
          server.close();
          reject(new Error(error));
        }
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${REDIRECT_PORT} is already in use. ` +
              `Kill the process using it or set GOOGLE_AUTH_PORT to a different port.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    // Bind to 0.0.0.0 so Docker-published ports are reachable from the host
    server.listen(REDIRECT_PORT, "0.0.0.0", () => {
      console.error(
        `Callback server listening on 0.0.0.0:${REDIRECT_PORT} (redirect URI: ${REDIRECT_URI})`,
      );
    });

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 300_000);
  });

  const { tokens } = await client.getToken(code);
  saveTokens(identity, tokens as TokenSet);

  // Get user email for confirmation
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const userInfo = await oauth2.userinfo.get();
  console.log(`\nConnected as ${userInfo.data.email ?? "unknown"}`);
}

// ─── Paste-code auth (remote / headless, no callback server) ──────

/**
 * Generate the OAuth consent URL for an identity WITHOUT starting a callback
 * server. Used for the paste-code flow: the user opens the URL on their phone,
 * consents, and pastes the resulting `code=…` back through Signal. Reachability
 * of the redirect URI doesn't matter — only the code in the URL bar does.
 */
export function generateConsentUrl(identity: string): string {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    // Bind the URL to the identity so a stray paste can't auth the wrong account
    state: identity,
  });
}

/**
 * Exchange a pasted authorization code for tokens and persist them. Stateless —
 * a fresh client per call, using the agent's own GOOGLE_CLIENT_ID/SECRET. After
 * this succeeds the MCP must be reloaded (HSM quick-restart) so the in-memory
 * client picks up the new token from disk.
 */
export async function exchangeCode(
  identity: string,
  code: string,
  { expectedAccount }: { expectedAccount?: string } = {},
): Promise<{ email: string }> {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  const { tokens } = await client.getToken(code);

  // Check before saving, so a code for the wrong account changes nothing.
  if (expectedAccount) {
    if (!tokens.refresh_token) {
      throw new Error("Google returned no refresh token, so the existing login was kept.");
    }
    client.setCredentials(tokens);
    if (!(await isAccount(client, expectedAccount))) {
      throw new Error("That login is for a different account, so the existing login was kept.");
    }
  }

  saveTokens(identity, tokens as TokenSet);

  // The token is saved — auth has succeeded. The email lookup is best-effort:
  // our scopes (drive/calendar/gmail/docs/sheets) don't grant openid/email, so
  // userinfo.get() can fail with "missing required authentication credential".
  // A failure here must NOT fail the exchange.
  client.setCredentials(tokens);
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userInfo = await oauth2.userinfo.get();
    return { email: userInfo.data.email ?? "unknown" };
  } catch {
    return { email: "unknown" };
  }
}

// ─── MCP tool helpers ─────────────────────────────────────────────

/**
 * Start a headless auth flow in the background and return the URL immediately.
 * The caller (an MCP tool handler) can return the URL to the agent while the
 * callback server waits for the redirect.
 */
export function startHeadlessAuth(identity: string): {
  authUrl: string;
  done: Promise<"ok">;
} {
  const config = loadGlobalConfig();
  const client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  const done = new Promise<"ok">((resolve, reject) => {
    // Track for status polling
    pendingAuth.set(identity, { resolve, reject });

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Authenticated! You can close this tab.</h2></body></html>",
          );
          server.close();
          try {
            const { tokens } = await client.getToken(code);
            saveTokens(identity, tokens as TokenSet);
            client.setCredentials(tokens);
            pendingAuth.delete(identity);
            resolve("ok");
          } catch (err) {
            pendingAuth.delete(identity);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        } else {
          const error = url.searchParams.get("error") ?? "No code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Error: ${error}</h2></body></html>`);
          server.close();
          pendingAuth.delete(identity);
          reject(new Error(error));
        }
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      pendingAuth.delete(identity);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${REDIRECT_PORT} is already in use. ` +
              `Another auth flow may be running, or the port is occupied.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, "0.0.0.0", () => {
      console.error(
        `google-multiplayer-mcp: auth callback listening on 0.0.0.0:${REDIRECT_PORT} (redirect: ${REDIRECT_URI})`,
      );
    });

    setTimeout(() => {
      server.close();
      pendingAuth.delete(identity);
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 300_000);
  });

  return { authUrl, done };
}

/**
 * Check whether an identity has valid tokens.
 * Returns `"authenticated"` if a refresh token exists,
 * `"pending"` if an auth flow is in progress,
 * or `"unauthenticated"` otherwise.
 */
export function checkAuthStatus(
  identity: string,
): "authenticated" | "pending" | "unauthenticated" {
  const tokens = loadTokens(identity);
  if (tokens?.refresh_token) return "authenticated";
  if (pendingAuth.has(identity)) return "pending";
  return "unauthenticated";
}

/** Print auth status for all known identities. */
export async function printAuthStatus(): Promise<void> {
  const dir = process.env.GOOGLE_TOKEN_DIR ?? TOKEN_DIR;
  if (!existsSync(dir)) {
    console.log("No identities configured.");
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No identities configured.");
    return;
  }

  for (const file of files) {
    const identity = file.replace(".json", "");
    const tokens = loadTokens(identity);
    if (tokens?.refresh_token) {
      try {
        const client = createAuthClient(identity);
        const oauth2 = google.oauth2({ version: "v2", auth: client });
        const info = await oauth2.userinfo.get();
        console.log(`${identity}: connected (${info.data.email})`);
      } catch {
        console.log(`${identity}: token exists but may need refresh`);
      }
    } else {
      console.log(`${identity}: not authenticated`);
    }
  }
}
