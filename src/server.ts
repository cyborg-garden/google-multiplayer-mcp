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

export interface AuthToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ type: "text"; text: string }[]>;
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
      return { content };
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

  try {
    const result = await tool.handler(args ?? {});
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
  { reloadNeeded = true }: { reloadNeeded?: boolean } = {},
): AuthToolDef[] {
  const afterLogin = reloadNeeded
    ? "Reload the MCP (HSM quick-restart) to activate the Google tools."
    : "The Google tools are ready.";
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
        "for tokens and save them. On success the MCP must be reloaded " +
        "(HSM quick-restart) before the Google tools work again.",
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
          const { email } = await exchangeCode(identity, code);
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
