/** Gmail service — tools for Gmail access: list, get, search, send, draft, delete. */

import { google } from "googleapis";
import type { PermissionConfig, ToolDef } from "../types.js";
import { hasAccess } from "../types.js";

type AuthClient = InstanceType<typeof google.auth.OAuth2>;

/** Recursively search MIME payload for a text/plain body part, decoded from base64url. */
function extractBody(payload: Record<string, any>): string {
  if (!payload) return "";

  // Single-part message with body data
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multi-part: recurse into parts
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return "";
}

/** Extract a named header value from a list of message headers. */
function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const found = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

/**
 * Returns an array of ToolDef objects for Gmail, filtered by access level.
 */
/** A line break in a header would add headers, such as a hidden Bcc. */
function refuseHeaderInjection(...fields: string[]): void {
  if (fields.some((f) => /[\r\n]/.test(f))) {
    throw new Error("Recipients and subject can't contain line breaks");
  }
}

export function getGmailTools(
  config: PermissionConfig,
  auth: AuthClient,
): ToolDef[] {
  const gmailAccess = config.permissions.gmail?.access ?? "none";

  if (gmailAccess === "none") return [];

  const gmail = google.gmail({ version: "v1", auth });

  const tools: ToolDef[] = [];

  // ── Read tools ───────────────────────────────────────────────────────────

  tools.push({
    name: "gmail_list",
    description:
      "List Gmail messages with metadata (Subject, From, To, Date). Optionally filter by a Gmail search query and/or label IDs.",
    service: "gmail",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g. 'is:unread from:alice@example.com').",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of messages to return (default 20).",
        },
        labelIds: {
          type: "array",
          items: { type: "string" },
          description: "Filter to messages with these label IDs (e.g. ['INBOX', 'UNREAD']).",
        },
        pageToken: {
          type: "string",
          description: "Token for the next page of results (from a previous gmail_list response).",
        },
      },
    },
    handler: async (args) => {
      const query = args.query as string | undefined;
      const maxResults = (args.maxResults as number | undefined) ?? 20;
      const labelIds = args.labelIds as string[] | undefined;
      const pageToken = args.pageToken as string | undefined;

      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
        labelIds,
        pageToken,
      });

      const messageRefs = listRes.data.messages ?? [];

      // Fetch metadata headers for each message
      const messages = await Promise.all(
        messageRefs.map(async (ref) => {
          if (!ref.id) return { id: ref.id };
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: ref.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "To", "Date"],
          });
          const headers = msg.data.payload?.headers ?? [];
          return {
            id: ref.id,
            threadId: msg.data.threadId,
            subject: getHeader(headers, "Subject"),
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            date: getHeader(headers, "Date"),
            snippet: msg.data.snippet,
          };
        }),
      );

      return {
        messages,
        nextPageToken: listRes.data.nextPageToken,
      };
    },
  });

  tools.push({
    name: "gmail_get",
    description: "Get the full content of a Gmail message including headers and plain-text body.",
    service: "gmail",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: {
          type: "string",
          description: "The ID of the message to retrieve.",
        },
      },
    },
    handler: async (args) => {
      const messageId = args.messageId as string;

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const payload = msg.data.payload as Record<string, any> | undefined;
      const headers = payload?.headers ?? [];

      return {
        id: msg.data.id,
        threadId: msg.data.threadId,
        labelIds: msg.data.labelIds,
        snippet: msg.data.snippet,
        subject: getHeader(headers, "Subject"),
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        date: getHeader(headers, "Date"),
        body: payload ? extractBody(payload) : "",
      };
    },
  });

  tools.push({
    name: "gmail_search",
    description:
      "Search Gmail messages using a query string. Returns message summaries (Subject, From, Date).",
    service: "gmail",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g. 'subject:invoice after:2024/01/01').",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default 20).",
        },
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      const maxResults = (args.maxResults as number | undefined) ?? 20;

      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messageRefs = listRes.data.messages ?? [];

      const messages = await Promise.all(
        messageRefs.map(async (ref) => {
          if (!ref.id) return { id: ref.id };
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: ref.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = msg.data.payload?.headers ?? [];
          return {
            id: ref.id,
            threadId: msg.data.threadId,
            subject: getHeader(headers, "Subject"),
            from: getHeader(headers, "From"),
            date: getHeader(headers, "Date"),
            snippet: msg.data.snippet,
          };
        }),
      );

      return { messages };
    },
  });

  // ── Write tools ──────────────────────────────────────────────────────────

  if (hasAccess(gmailAccess, "write")) {
    tools.push({
      name: "gmail_send",
      description: "Send an email via Gmail.",
      service: "gmail",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: {
            type: "string",
            description: "Recipient email address.",
          },
          subject: {
            type: "string",
            description: "Subject line of the email.",
          },
          body: {
            type: "string",
            description: "Plain-text body of the email.",
          },
        },
      },
      handler: async (args) => {
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        refuseHeaderInjection(to, subject);

        const raw =
          `To: ${to}\r\n` +
          `Subject: ${subject}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n` +
          `\r\n` +
          body;

        const encoded = Buffer.from(raw).toString("base64url");

        const res = await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: encoded },
        });

        return {
          id: res.data.id,
          threadId: res.data.threadId,
          labelIds: res.data.labelIds,
        };
      },
    });

    tools.push({
      name: "gmail_draft",
      description: "Create a draft email in Gmail.",
      service: "gmail",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: {
            type: "string",
            description: "Recipient email address.",
          },
          subject: {
            type: "string",
            description: "Subject line of the draft.",
          },
          body: {
            type: "string",
            description: "Plain-text body of the draft.",
          },
        },
      },
      handler: async (args) => {
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        refuseHeaderInjection(to, subject);

        const raw =
          `To: ${to}\r\n` +
          `Subject: ${subject}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n` +
          `\r\n` +
          body;

        const encoded = Buffer.from(raw).toString("base64url");

        const res = await gmail.users.drafts.create({
          userId: "me",
          requestBody: {
            message: { raw: encoded },
          },
        });

        return {
          draftId: res.data.id,
          messageId: res.data.message?.id,
          threadId: res.data.message?.threadId,
        };
      },
    });
  }

  // ── Admin tools ──────────────────────────────────────────────────────────

  if (hasAccess(gmailAccess, "admin")) {
    tools.push({
      name: "gmail_delete",
      description:
        "Permanently delete a Gmail message. WARNING: This is irreversible — the message cannot be recovered from trash.",
      service: "gmail",
      requiredAccess: "admin",
      inputSchema: {
        type: "object",
        required: ["messageId"],
        properties: {
          messageId: {
            type: "string",
            description: "The ID of the message to permanently delete.",
          },
        },
      },
      handler: async (args) => {
        const messageId = args.messageId as string;

        await gmail.users.messages.delete({
          userId: "me",
          id: messageId,
        });

        return { success: true, messageId };
      },
    });
  }

  return tools;
}
