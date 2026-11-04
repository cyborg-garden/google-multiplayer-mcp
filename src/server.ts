/** MCP server — dynamic tool registration and call routing. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PermissionConfig, ToolDef } from "./types.js";
import { formatToolError, type ToolErrorPayload } from "./auth-errors.js";
import {
  createAuthClient,
  startHeadlessAuth,
  checkAuthStatus,
  generateConsentUrl,
  exchangeCode,
} from "./auth.js";
import { getDriveTools } from "./services/drive.js";
import { getCalendarTools } from "./services/calendar.js";
import { getGmailTools } from "./services/gmail.js";
import { getDocsTools } from "./services/docs.js";
import { getSheetsTools } from "./services/sheets.js";

/** Collect all tools the agent is allowed to use based on permissions. */
export function collectTools(
  config: PermissionConfig,
  auth: ReturnType<typeof createAuthClient> = createAuthClient(config.identity),
): ToolDef[] {
  return [
    ...getDriveTools(config, auth),
    ...getCalendarTools(config, auth),
    ...getGmailTools(config, auth),
    ...getDocsTools(config, auth),
    ...getSheetsTools(config, auth),
  ];
}

// ─── Auth MCP tool definitions ──────────────────────────────────

/** Auth tools report a failure as `{status: "error"}`, as the re-auth skill expects. */
function authResultFailed(content: { text: string }[]): boolean {
  try {
    return JSON.parse(content[0]?.text ?? "{}").status === "error";
  } catch {
    return false;
  }
}

export interface AuthToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ type: "text"; text: string }[]>;
}

/**
 * Check tool arguments against the tool's schema. The low-level MCP server
 * doesn't, and a wrong type can reach code that fails outside any try/catch.
 *
 * Harmless slips from an LLM are repaired: numbers sent as strings, a single
 * value where a list goes, and an empty optional ID, which means "not given".
 * An ID of `.` or `..` is refused, because in a URL it changes which Google
 * endpoint is called.
 */
export function checkToolArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; problem: string | null } {
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: string; enum?: unknown[]; items?: { type?: string } }
  >;
  const required = (schema.required ?? []) as string[];
  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : typeof v);
  const bad = (problem: string) => ({ args, problem });
  const out: Record<string, unknown> = { ...args };

  for (const [name, original] of Object.entries(args)) {
    const spec = properties[name];
    if (!spec || original === undefined || original === null) continue;
    const isId = /Id$/.test(name);
    let value = original;
    const wanted = spec.type === "integer" ? "number" : spec.type;

    if (wanted === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      value = Number(value);
    }
    if (wanted === "boolean" && (value === "true" || value === "false")) value = value === "true";
    if (wanted === "array" && spec.items?.type === "string" && typeof value === "string") value = [value];
    if (wanted && typeOf(value) !== wanted) return bad(`${name} must be of type ${spec.type}`);
    if (spec.enum && !spec.enum.includes(value)) return bad(`${name} must be one of: ${spec.enum.join(", ")}`);

    if (wanted === "string" && isId) {
      if (value === "" && !required.includes(name)) {
        delete out[name];
        continue;
      }
      if (!(value as string).trim()) return bad(`${name} can't be empty`);
    }
    // `range` also goes into the URL path.
    if (wanted === "string" && (isId || name === "range") && /^\s*\.+\s*$/.test(value as string)) {
      return bad(`${name} isn't valid`);
    }

    if (wanted === "array" && spec.items?.type) {
      const wantedItem = spec.items.type;
      const items = (value as unknown[]).map((v) =>
        wantedItem === "string" && (typeof v === "number" || typeof v === "boolean") ? String(v) : v,
      );
      if (items.some((v) => typeOf(v) !== wantedItem)) return bad(`${name} must only contain type ${wantedItem}`);
      value = items;
    }
    out[name] = value;
  }

  for (const name of required) {
    if (out[name] === undefined || out[name] === null) return bad(`${name} is required`);
  }
  return { args: out, problem: null };
}

/**
 * Central tool-call dispatcher. Routes a tool call to the matching auth tool
 * or service tool and normalises the result/error shape.
 *
 * Service-tool failures are wrapped by `formatToolError`, so an expired or
 * revoked Google grant surfaces to the agent as a structured `auth_expired`
 * payload (with the recovery action) instead of a raw googleapis stack trace.
 * This is the single place errors are wrapped — service handlers stay free to
 * just `throw`.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  tools: ToolDef[],
  authTools: AuthToolDef[],
  formatError: (err: unknown) => ToolErrorPayload = formatToolError,
): Promise<CallToolResult> {
  // Auth tools first — these manage the auth flow itself and own their error
  // shape, so they are not run through the auth-expired wrapper.
  const authTool = authTools.find((t) => t.name === name);
  if (authTool) {
    try {
      const content = await authTool.handler(args ?? {});
      return { content, isError: authResultFailed(content) || undefined };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const { args: checked, problem } = checkToolArgs(tool.inputSchema, args ?? {});
  if (problem) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message: `Invalid arguments: ${problem}` }, null, 2) }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(checked);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (err: unknown) {
    const payload = formatError(err);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ],
      isError: true,
    };
  }
}

export function getAuthTools(
  identity: string,
  { reloadNeeded = true, expectedAccount }: { reloadNeeded?: boolean; expectedAccount?: string } = {},
): AuthToolDef[] {
  const afterLogin = reloadNeeded
    ? "After this, reload the MCP (HSM quick-restart) so the Google tools work again."
    : "No reload is needed afterwards.";
  return [
    {
      name: "google_auth_url",
      description:
        "Get the Google OAuth consent URL for the paste-code re-auth flow " +
        "(remote/Signal). Send this URL to the user; they open it on their " +
        "phone, consent, then copy the `code=…` value from the redirected URL " +
        "and paste it back. Pass that code to google_auth_exchange. Use this " +
        "instead of google_auth_start when there is no reachable callback " +
        "server (e.g. the agent runs on a remote host).",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      handler: async () => {
        const url = generateConsentUrl(identity);
        return [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "auth_required",
              url,
              message:
                "Send this URL to the user. After they consent, they copy the " +
                "`code=…` value from the redirected URL (the page may show an " +
                "error — that's fine) and paste it back. Then call " +
                "google_auth_exchange with that code.",
            }),
          },
        ];
      },
    },
    {
      name: "google_auth_exchange",
      description:
        "Exchange a pasted Google OAuth authorization code (from google_auth_url) " +
        `for tokens and save them. ${afterLogin}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          code: {
            type: "string",
            description:
              "The authorization code the user pasted (the `code=…` value " +
              "from the redirected URL).",
          },
        },
        required: ["code"],
      },
      handler: async (args) => {
        const code = typeof args.code === "string" ? args.code.trim() : "";
        try {
          const { email } = await exchangeCode(identity, code, { expectedAccount });
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "authenticated",
                email,
                message: `Authenticated as ${email}. ${afterLogin}`,
              }),
            },
          ];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: `Code exchange failed: ${message}`,
              }),
            },
          ];
        }
      },
    },
    {
      name: "google_auth_start",
      description:
        "Start a Google OAuth authentication flow. Returns a URL that the user " +
        "must open in their browser to grant access. After calling this, poll " +
        "google_auth_status until it returns 'authenticated'.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      handler: async () => {
        // If already authenticated, short-circuit
        const status = checkAuthStatus(identity);
        if (status === "authenticated") {
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "already_authenticated",
                message: `Identity "${identity}" is already authenticated.`,
              }),
            },
          ];
        }
        if (status === "pending") {
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "pending",
                message:
                  "An auth flow is already in progress. Poll google_auth_status for updates.",
              }),
            },
          ];
        }

        const { authUrl } = startHeadlessAuth(identity);
        return [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "auth_required",
              url: authUrl,
              message:
                "Send this URL to the user. Once they complete authentication in their browser, " +
                "call google_auth_status to confirm.",
            }),
          },
        ];
      },
    },
    {
      name: "google_auth_status",
      description:
        "Check whether Google OAuth authentication has completed for the configured identity. " +
        "Returns 'authenticated', 'pending', or 'unauthenticated'.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      handler: async () => {
        const status = checkAuthStatus(identity);
        return [
          {
            type: "text" as const,
            text: JSON.stringify({ status, identity }),
          },
        ];
      },
    },
  ];
}

/** Start the MCP server over stdio. */
export async function startServer(config: PermissionConfig): Promise<void> {
  let tools: ToolDef[] = [];
  try {
    tools = collectTools(config);
  } catch (e) {
    // Auth not configured — server starts with auth tools only so the
    // agent can trigger the OAuth flow from chat.
    const detail = e instanceof Error ? e.message : String(e);
    console.error(
      `google-multiplayer-mcp: failed to load tools for "${config.identity}" (${detail}) — ` +
      `starting with auth tools only. Use google_auth_start to authenticate.`
    );
  }
  const authTools = getAuthTools(config.identity);

  const server = new Server(
    { name: "google-multiplayer-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools — return service tools + auth tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      ...authTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ],
  }));

  // Call tool — route through the central dispatcher (wraps auth-expired
  // errors into a structured, actionable payload).
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(name, args, tools, authTools);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
