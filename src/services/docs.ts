/** Docs service — tools for Google Docs access with folder filtering. */

import { google } from "googleapis";
import type { PermissionConfig, ToolDef } from "../types.js";
import { hasAccess } from "../types.js";
import { getAllowedFolders } from "../permissions.js";
import { isWithinAllowedFolders } from "./folder-scope.js";

type AuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Walk the document body content and extract plain text.
 */
function extractDocText(doc: Record<string, any>): string {
  const content: string[] = [];
  const bodyContent: any[] = doc.body?.content ?? [];

  for (const element of bodyContent) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    for (const el of paragraph.elements ?? []) {
      const text = el.textRun?.content;
      if (text) content.push(text);
    }
  }

  return content.join("");
}

/**
 * Returns an array of ToolDef objects for Google Docs, filtered by access level.
 */
export function getDocsTools(
  config: PermissionConfig,
  auth: AuthClient,
): ToolDef[] {
  const docsAccess = config.permissions.docs?.access ?? "none";

  if (docsAccess === "none") return [];

  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const allowedFolders = getAllowedFolders(config, "docs");

  const tools: ToolDef[] = [];

  // ── Read tools ──────────────────────────────────────────────────────────

  tools.push({
    name: "docs_get",
    description: "Get the content of a Google Doc as plain text.",
    service: "docs",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["documentId"],
      properties: {
        documentId: {
          type: "string",
          description: "The ID of the Google Doc to retrieve.",
        },
      },
    },
    handler: async (args) => {
      const documentId = args.documentId as string;

      // Check folder access via Drive API — recursive, so docs nested in
      // subfolders of an allowed root are reachable, not just direct children.
      if (!(await isWithinAllowedFolders(drive, documentId, allowedFolders))) {
        throw new Error("Item is outside allowed folders");
      }

      const res = await docs.documents.get({ documentId });
      const doc = res.data as Record<string, any>;
      const text = extractDocText(doc);

      return {
        documentId: doc.documentId,
        title: doc.title,
        text,
      };
    },
  });

  // ── Write tools ─────────────────────────────────────────────────────────

  if (hasAccess(docsAccess, "write")) {
    tools.push({
      name: "docs_create",
      description: "Create a new Google Doc, optionally with content and in a specific folder.",
      service: "docs",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "Title of the new Google Doc.",
          },
          content: {
            type: "string",
            description: "Initial text content to insert into the document.",
          },
          folderId: {
            type: "string",
            description: "Drive folder ID to place the document in.",
          },
        },
      },
      handler: async (args) => {
        const title = args.title as string;
        const content = args.content as string | undefined;
        const folderId = args.folderId as string | undefined;

        if (folderId && allowedFolders.length > 0 && !allowedFolders.includes(folderId)) {
          throw new Error(`Folder ${folderId} is not in allowed folders`);
        }

        // With a folder, create it there through Drive. A service account has
        // no storage of its own, so docs.documents.create would be refused.
        const targetFolder = folderId || (allowedFolders.length > 0 ? allowedFolders[0] : null);
        let documentId: string;
        if (targetFolder) {
          const createRes = await drive.files.create({
            requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: [targetFolder] },
            fields: "id",
            supportsAllDrives: true,
          });
          documentId = createRes.data.id!;
        } else {
          const createRes = await docs.documents.create({
            requestBody: { title },
          });
          documentId = createRes.data.documentId!;
        }

        // Insert content if provided
        if (content) {
          await docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [
                {
                  insertText: {
                    location: { index: 1 },
                    text: content,
                  },
                },
              ],
            },
          });
        }

        return {
          documentId,
          title,
          folderId: folderId ?? null,
        };
      },
    });

    tools.push({
      name: "docs_update",
      description: "Append text to an existing Google Doc.",
      service: "docs",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["documentId", "text"],
        properties: {
          documentId: {
            type: "string",
            description: "The ID of the Google Doc to update.",
          },
          text: {
            type: "string",
            description: "Text to append to the document.",
          },
        },
      },
      handler: async (args) => {
        const documentId = args.documentId as string;
        const text = args.text as string;

        // Check folder access via Drive API (recursive ancestor walk).
        if (!(await isWithinAllowedFolders(drive, documentId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        // Get current document to find end index
        const docRes = await docs.documents.get({ documentId });
        const doc = docRes.data as Record<string, any>;
        const bodyContent: any[] = doc.body?.content ?? [];

        // The last element in body.content has the end index
        let endIndex = 1;
        if (bodyContent.length > 0) {
          const last = bodyContent[bodyContent.length - 1];
          endIndex = (last.endIndex ?? 1) - 1;
        }

        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: { index: endIndex },
                  text,
                },
              },
            ],
          },
        });

        return { documentId, appended: text.length };
      },
    });

    tools.push({
      name: "docs_batch_update",
      description:
        "Perform structural edits on a Google Doc: insert, delete, or replace text at specific positions; apply formatting; insert tables, page breaks, or section breaks; manage named ranges and headers/footers. Accepts an array of requests matching the Google Docs API batchUpdate format.",
      service: "docs",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["documentId", "requests"],
        properties: {
          documentId: {
            type: "string",
            description: "The ID of the Google Doc.",
          },
          requests: {
            type: "array",
            items: { type: "object" },
            description:
              "Array of request objects per the Google Docs API batchUpdate spec. Common types: insertText, deleteContentRange, replaceAllText, updateTextStyle, insertTable, insertPageBreak, createNamedRange.",
          },
        },
      },
      handler: async (args) => {
        const documentId = args.documentId as string;
        const requests = args.requests as object[];

        if (!(await isWithinAllowedFolders(drive, documentId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests },
        });

        return {
          documentId,
          replies: res.data.replies ?? [],
          writeControl: res.data.writeControl ?? null,
        };
      },
    });
  }

  // ── Admin tools ──────────────────────────────────────────────────────────

  if (hasAccess(docsAccess, "admin")) {
    tools.push({
      name: "docs_delete",
      description: "Move a Google Doc to trash.",
      service: "docs",
      requiredAccess: "admin",
      inputSchema: {
        type: "object",
        required: ["documentId"],
        properties: {
          documentId: {
            type: "string",
            description: "The ID of the Google Doc to delete (move to trash).",
          },
        },
      },
      handler: async (args) => {
        const documentId = args.documentId as string;

        // Check folder access via Drive API (recursive ancestor walk).
        if (!(await isWithinAllowedFolders(drive, documentId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        await drive.files.update({
          fileId: documentId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });

        return { success: true, documentId };
      },
    });
  }

  return tools;
}
