/** Drive service — tools for Google Drive access with folder filtering. */

import { Readable } from "stream";
import { createHash } from "crypto";
import { google } from "googleapis";
import type { PermissionConfig, ToolDef } from "../types.js";
import { hasAccess } from "../types.js";
import { getAllowedFolders } from "../permissions.js";
import {
  isWithinAllowedFolders,
  resolveAllowedFolderTree,
  invalidateFolderTreeCache,
} from "./folder-scope.js";
import { DOWNLOAD_TIMEOUT_MS, DRIVE_FILE_ID, formatLimit, writeDownload } from "./drive-download.js";
import { guessMimeType, openUpload } from "./drive-upload.js";

const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** Types whose content can never be sent as plain text by the legacy upload tool. */
const BINARY_MIME =
  /^(video|audio|font|model)\/|^image\/(?!svg\+xml)|^application\/(pdf|zip|gzip|zstd|octet-stream|wasm|msword|ogg|mp4|java-archive|epub\+zip|x-(tar|gzip|bzip2?|xz|zip|rar|7z-compressed|zip-compressed|rar-compressed)|vnd\.(rar|openxmlformats-|ms-|oasis\.opendocument\.))/i;

/** Text updates are deliberately limited to types whose bytes are UTF-8 text. */
const TEXT_MIME = new Set([
  "text/plain", "text/markdown", "text/html", "text/css", "text/csv", "text/xml",
  "application/json", "application/ld+json", "application/xml", "application/xhtml+xml",
  "application/javascript", "application/x-javascript", "application/x-sh",
  "application/x-python", "application/toml", "application/sql", "image/svg+xml",
]);
const TEXT_MIME_SUFFIX = /\+(?:json|xml)$/i;
function isTextMime(mimeType: string): boolean {
  const normalized = mimeType.trim().split(";", 1)[0].trim().toLowerCase();
  return normalized.startsWith("text/") || TEXT_MIME.has(normalized) || TEXT_MIME_SUFFIX.test(normalized);
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type AuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Returns an array of ToolDef objects for Google Drive, filtered by access level.
 */
export function getDriveTools(
  config: PermissionConfig,
  auth: AuthClient,
): ToolDef[] {
  const driveAccess = config.permissions.drive?.access ?? "none";

  if (driveAccess === "none") return [];

  const drive = google.drive({ version: "v3", auth });
  const allowedFolders = getAllowedFolders(config, "drive");

  const tools: ToolDef[] = [];
  const uploadDir = config.uploadDir;

  // ── Read tools ──────────────────────────────────────────────────────────

  tools.push({
    name: "drive_list",
    description: "List files in Google Drive, optionally filtered by folder.",
    service: "drive",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      properties: {
        folderId: {
          type: "string",
          description: "Folder ID to list files from.",
        },
        pageSize: {
          type: "number",
          description: "Maximum number of files to return (default 50).",
        },
        pageToken: {
          type: "string",
          description: "Token for the next page of results.",
        },
      },
    },
    handler: async (args) => {
      const folderId = args.folderId as string | undefined;
      const pageSize = (args.pageSize as number | undefined) ?? 50;
      const pageToken = args.pageToken as string | undefined;

      // Resolve the full allowed folder tree (roots + all descendant folders).
      // Empty set means "no restriction" (allowedFolders is empty).
      const scoped = allowedFolders.length > 0;
      const allowedTree = scoped
        ? await resolveAllowedFolderTree(drive, allowedFolders)
        : new Set<string>();

      // Build query
      let q = "trashed = false";

      if (folderId) {
        // Verify requested folder is anywhere within the allowed tree.
        if (scoped && !allowedTree.has(folderId)) {
          throw new Error(`Folder ${folderId} is not in allowed folders`);
        }
        q += ` and '${folderId}' in parents`;
      } else if (scoped) {
        // Restrict to every folder in the allowed tree.
        const folderClauses = [...allowedTree]
          .map((id) => `'${id}' in parents`)
          .join(" or ");
        q += ` and (${folderClauses})`;
      }

      const res = await drive.files.list({
        q,
        pageSize,
        pageToken,
        fields: "nextPageToken, files(id, name, mimeType, parents, modifiedTime, size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = (res.data.files ?? []).map((f) => ({
        ...f,
        parents: f.parents ?? undefined,
      }));
      // Post-filter by tree membership (a file is in scope if any parent is in
      // the resolved tree). Cheap, in-memory — no extra API calls.
      const filtered = scoped
        ? files.filter((f) => f.parents?.some((p) => allowedTree.has(p)) ?? false)
        : files;

      return {
        files: filtered,
        nextPageToken: res.data.nextPageToken,
      };
    },
  });

  tools.push({
    name: "drive_get",
    description: "Get metadata and content of a file in Google Drive.",
    service: "drive",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: {
          type: "string",
          description: "The ID of the file to retrieve.",
        },
      },
    },
    handler: async (args) => {
      const fileId = args.fileId as string;

      // Get file metadata first to check folder access
      const meta = await drive.files.get({
        fileId,
        fields: "id, name, mimeType, parents, modifiedTime, size",
        supportsAllDrives: true,
      });

      if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
        throw new Error("Item is outside allowed folders");
      }

      const mimeType = meta.data.mimeType ?? "";

      // Export Google Workspace files as plain text / CSV
      let content: string | undefined;
      if (mimeType === "application/vnd.google-apps.document") {
        const exported = await drive.files.export(
          { fileId, mimeType: "text/plain" },
          { responseType: "text" },
        );
        content = exported.data as string;
      } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
        const exported = await drive.files.export(
          { fileId, mimeType: "text/csv" },
          { responseType: "text" },
        );
        content = exported.data as string;
      } else if (mimeType === "application/vnd.google-apps.presentation") {
        const exported = await drive.files.export(
          { fileId, mimeType: "text/plain" },
          { responseType: "text" },
        );
        content = exported.data as string;
      }

      return { ...meta.data, content };
    },
  });

  tools.push({
    name: "drive_search",
    description: "Search for files in Google Drive using a query string.",
    service: "drive",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Full-text search query.",
        },
        pageSize: {
          type: "number",
          description: "Maximum number of results (default 20).",
        },
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      const pageSize = (args.pageSize as number | undefined) ?? 20;

      // NOTE: deliberately do NOT add a per-folder OR-clause to the query.
      // Drive's `q` has a length limit and the allowed tree can contain many
      // folders; instead we post-filter results by tree membership. Search is
      // already bounded by pageSize.
      const q = `fullText contains '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;

      const scoped = allowedFolders.length > 0;
      const allowedTree = scoped
        ? await resolveAllowedFolderTree(drive, allowedFolders)
        : new Set<string>();

      const res = await drive.files.list({
        q,
        pageSize,
        fields: "files(id, name, mimeType, parents, modifiedTime, size)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = (res.data.files ?? []).map((f) => ({
        ...f,
        parents: f.parents ?? undefined,
      }));
      const filtered = scoped
        ? files.filter((f) => f.parents?.some((p) => allowedTree.has(p)) ?? false)
        : files;

      return { files: filtered };
    },
  });

  tools.push({
    name: "drive_download",
    description: "Download the raw binary content of a file.",
    service: "drive",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: {
          type: "string",
          description: "The ID of the file to download.",
        },
      },
    },
    handler: async (args) => {
      const fileId = args.fileId as string;

      // Check folder access via metadata
      const meta = await drive.files.get({
        fileId,
        fields: "id, name, mimeType, parents, size",
        supportsAllDrives: true,
      });

      if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
        throw new Error("Item is outside allowed folders");
      }

      // The file is held in memory and returned as text.
      if (Number(meta.data.size ?? 0) > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File is over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB download limit`);
      }

      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );

      const buffer = Buffer.from(res.data as ArrayBuffer);
      return {
        name: meta.data.name,
        mimeType: meta.data.mimeType,
        content: buffer.toString("base64"),
        encoding: "base64",
      };
    },
  });

  // Offered only when the operator has set a download folder for this caller.
  const downloadDir = config.downloadDir;
  if (downloadDir) {
    tools.push({
      name: "drive_download_to_file",
      description:
        "Save a Drive file, such as a video, to your download folder and return its path, " +
        `name, MIME type and size. The content is not returned. Up to ${formatLimit(downloadDir.maxBytes)}. ` +
        "Google Docs, Sheets and Slides have no file to save: read them with drive_get, docs_get or sheets_get.",
      service: "drive",
      requiredAccess: "read",
      inputSchema: {
        type: "object",
        required: ["fileId"],
        properties: {
          fileId: {
            type: "string",
            description: "The ID of the file to save.",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId;
        if (typeof fileId !== "string" || !DRIVE_FILE_ID.test(fileId)) {
          throw new Error("fileId must be a Drive file id");
        }

        const meta = await drive.files.get({
          fileId,
          fields: "id, name, mimeType, parents, size",
          supportsAllDrives: true,
        });

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        const mimeType = meta.data.mimeType ?? "application/octet-stream";
        // Docs, Sheets, Slides, folders and shortcuts have no binary content.
        if (mimeType.startsWith("application/vnd.google-apps.")) {
          throw new Error(
            "This is a Google Workspace item with no file to download. " +
              "Read it as text with drive_get, or use docs_get for a Doc and sheets_get for a Sheet.",
          );
        }

        const id = meta.data.id ?? fileId;
        const name = meta.data.name ?? id;
        const statedSize = meta.data.size ? Number(meta.data.size) : undefined;
        const { path, size } = await writeDownload(downloadDir, id, name, statedSize, async (signal) => {
          const res = await drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            // Replaces the general Google timeout, which would cut off a long download.
            { responseType: "stream", signal, timeout: DOWNLOAD_TIMEOUT_MS },
          );
          return res.data as unknown as Readable;
        });
        return { path, name, mimeType, size };
      },
    });
  }

  // ── Write tools ─────────────────────────────────────────────────────────

  if (hasAccess(driveAccess, "write")) {
    tools.push({
      name: "drive_upload",
      description:
        "Create a Drive file from content you pass in: text, or a small binary file as base64 with " +
        'encoding "base64".' +
        (uploadDir ? " For a video, PDF, image or anything large, use drive_upload_from_file instead." : ""),
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["name", "content"],
        properties: {
          name: {
            type: "string",
            description: "Name of the file to create.",
          },
          content: {
            type: "string",
            description: "File content: text, or base64 when encoding is base64.",
          },
          encoding: {
            type: "string",
            enum: ["text", "base64"],
            description: 'How content is encoded (default: text). Binary files need "base64".',
          },
          mimeType: {
            type: "string",
            description: "MIME type of the file (default: text/plain).",
          },
          folderId: {
            type: "string",
            description: "Parent folder ID to upload into.",
          },
        },
      },
      handler: async (args) => {
        const name = args.name as string;
        const content = args.content as string;
        if (typeof content !== "string") throw new Error("content must be a string");
        const mimeType = (typeof args.mimeType === "string" && args.mimeType.trim()) || "text/plain";
        const folderId = args.folderId as string | undefined;
        const encoding = (args.encoding as string | undefined) ?? "text";

        let data: string | Buffer = content;
        if (encoding === "base64") {
          const compact = content.replace(/\s+/g, "");
          if (!BASE64.test(compact) || compact.length % 4 === 1) {
            throw new Error("content is not valid base64, so nothing was uploaded");
          }
          data = Buffer.from(compact, "base64");
        } else if (encoding !== "text") {
          throw new Error('encoding must be "text" or "base64"');
        } else if (BINARY_MIME.test(mimeType)) {
          // Stored as given, this would be a text file with a binary type: a broken file.
          throw new Error(
            `${mimeType} is a binary type, so its content can't be sent as text. ` +
              (uploadDir
                ? `Copy the file into ${uploadDir.callerDir} and use drive_upload_from_file`
                : 'Pass the content as base64 with encoding "base64"') +
              ". Nothing was uploaded.",
          );
        }

        if (
          folderId &&
          allowedFolders.length > 0 &&
          !(await isWithinAllowedFolders(drive, folderId, allowedFolders))
        ) {
          throw new Error(`Folder ${folderId} is not in allowed folders`);
        }

        const requestBody: Record<string, unknown> = { name, mimeType };
        const targetFolder = folderId || (allowedFolders.length > 0 ? allowedFolders[0] : null);
        if (targetFolder) requestBody.parents = [targetFolder];

        const res = await drive.files.create({
          requestBody,
          media: {
            mimeType,
            body: Readable.from([data]),
          },
          fields: "id, name, mimeType, parents",
          supportsAllDrives: true,
        });

        return res.data;
      },
    });

    // Offered only when the operator has set a folder the caller writes and this process reads.
    if (uploadDir) {
      tools.push({
        name: "drive_upload_from_file",
        description:
          `Upload a file from ${uploadDir.callerDir} to Google Drive, byte for byte: a video, PDF, image, ` +
          "audio or any other file. Copy the file into that folder first, then pass its full path. " +
          `Up to ${formatLimit(uploadDir.maxBytes)}. The content never passes through the conversation.`,
        service: "drive",
        requiredAccess: "write",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: `Full path of a file directly inside ${uploadDir.callerDir}.`,
            },
            name: {
              type: "string",
              description: "Name for the file in Drive (default: the file's own name).",
            },
            mimeType: {
              type: "string",
              description: "MIME type (default: chosen from the file name).",
            },
            folderId: {
              type: "string",
              description: "Parent folder ID to upload into.",
            },
          },
        },
        handler: async (args) => {
          const folderId = args.folderId as string | undefined;
          if (
            folderId &&
            allowedFolders.length > 0 &&
            !(await isWithinAllowedFolders(drive, folderId, allowedFolders))
          ) {
            throw new Error(`Folder ${folderId} is not in allowed folders`);
          }

          const file = await openUpload(uploadDir, args.path);
          const name = typeof args.name === "string" && args.name.trim() ? args.name : file.name;
          const mimeType = typeof args.mimeType === "string" && args.mimeType ? args.mimeType : guessMimeType(name);
          const requestBody: Record<string, unknown> = { name };
          const targetFolder = folderId || (allowedFolders.length > 0 ? allowedFolders[0] : null);
          if (targetFolder) requestBody.parents = [targetFolder];

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
          try {
            const res = await drive.files.create(
              {
                requestBody,
                media: { mimeType, body: file.stream },
                fields: "id, name, mimeType, parents, size, webViewLink",
                supportsAllDrives: true,
              },
              // Replaces the general Google timeout, which would cut off a long upload.
              { signal: controller.signal, timeout: DOWNLOAD_TIMEOUT_MS },
            );
            const stored = Number(res.data.size);
            if (res.data.size != null && stored !== file.size) {
              throw new Error(
                `Drive stored ${stored} bytes but the file is ${file.size} bytes, so the upload is not a true copy ` +
                  `(Drive file ${res.data.id}). Check it before sharing.`,
              );
            }
            return { ...res.data, size: file.size };
          } catch (err) {
            if (controller.signal.aborted) throw new Error("The upload took too long and was stopped.");
            throw err;
          } finally {
            clearTimeout(timer);
            file.close();
          }
        },
      });
    }

    tools.push({
      name: "drive_create_folder",
      description: "Create a new folder in Google Drive.",
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Name of the folder to create.",
          },
          parentId: {
            type: "string",
            description: "Parent folder ID (optional).",
          },
        },
      },
      handler: async (args) => {
        const name = args.name as string;
        const parentId = args.parentId as string | undefined;

        if (
          parentId &&
          allowedFolders.length > 0 &&
          !(await isWithinAllowedFolders(drive, parentId, allowedFolders))
        ) {
          throw new Error(`Folder ${parentId} is not in allowed folders`);
        }

        const requestBody: Record<string, unknown> = {
          name,
          mimeType: "application/vnd.google-apps.folder",
        };
        const targetParent = parentId || (allowedFolders.length > 0 ? allowedFolders[0] : null);
        if (targetParent) requestBody.parents = [targetParent];

        const res = await drive.files.create({
          requestBody,
          fields: "id, name, mimeType, parents",
          supportsAllDrives: true,
        });

        // A new subfolder changes the allowed tree; drop the cache so the next
        // discovery query sees it immediately.
        invalidateFolderTreeCache();

        return res.data;
      },
    });

    tools.push({
      name: "drive_rename",
      description: "Rename a file or folder in Google Drive.",
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["fileId", "newName"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file or folder to rename.",
          },
          newName: {
            type: "string",
            description: "The new name for the file or folder.",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;
        const newName = args.newName as string;

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        const res = await drive.files.update({
          fileId,
          requestBody: { name: newName },
          fields: "id, name, mimeType, parents, modifiedTime",
          supportsAllDrives: true,
        });

        return res.data;
      },
    });

    tools.push({
      name: "drive_move",
      description: "Move a file or folder to a different parent folder in Google Drive.",
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["fileId", "destinationFolderId"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file or folder to move.",
          },
          destinationFolderId: {
            type: "string",
            description: "ID of the destination folder.",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;
        const destinationFolderId = args.destinationFolderId as string;

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        if (allowedFolders.length > 0 && !allowedFolders.includes(destinationFolderId)) {
          if (!(await isWithinAllowedFolders(drive, destinationFolderId, allowedFolders))) {
            throw new Error("Destination folder is outside allowed folders");
          }
        }

        // Get current parents to remove them
        const meta = await drive.files.get({
          fileId,
          fields: "parents",
          supportsAllDrives: true,
        });
        const previousParents = (meta.data.parents ?? []).join(",");

        const res = await drive.files.update({
          fileId,
          addParents: destinationFolderId,
          removeParents: previousParents,
          fields: "id, name, mimeType, parents, modifiedTime",
          supportsAllDrives: true,
        });

        // Moving an item (possibly a folder) restructures the tree.
        invalidateFolderTreeCache();

        return res.data;
      },
    });

    tools.push({
      name: "drive_copy",
      description: "Copy a file in Google Drive. Optionally specify a new name and destination folder.",
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["fileId"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file to copy.",
          },
          name: {
            type: "string",
            description: "Name for the copy (defaults to 'Copy of <original>').",
          },
          folderId: {
            type: "string",
            description: "Destination folder ID for the copy.",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;
        const name = args.name as string | undefined;
        const folderId = args.folderId as string | undefined;

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        if (folderId && allowedFolders.length > 0 && !allowedFolders.includes(folderId)) {
          if (!(await isWithinAllowedFolders(drive, folderId, allowedFolders))) {
            throw new Error("Destination folder is outside allowed folders");
          }
        }

        const requestBody: Record<string, unknown> = {};
        if (name) requestBody.name = name;
        if (folderId) requestBody.parents = [folderId];

        const res = await drive.files.copy({
          fileId,
          requestBody,
          fields: "id, name, mimeType, parents, modifiedTime",
          supportsAllDrives: true,
        });

        // A copied folder adds new ids to the tree.
        invalidateFolderTreeCache();

        return res.data;
      },
    });

    tools.push({
      name: "drive_update",
      description: "Update an existing file's text content. Binary updates need drive_update_from_file, which preserves the Drive file ID.",
      service: "drive",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["fileId", "content"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file to update.",
          },
          content: {
            type: "string",
            description: "New UTF-8 text content.",
          },
          mimeType: {
            type: "string",
            description: "MIME type (default: the file's current type).",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;
        const content = args.content as string;

        // Check folder access first
        const meta = await drive.files.get({
          fileId,
          fields: "id, name, mimeType, parents",
          supportsAllDrives: true,
        });

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        if (typeof content !== "string") throw new Error("content must be a string");
        const requestedMime = typeof args.mimeType === "string" ? args.mimeType.trim() : "";
        const mimeType = requestedMime || meta.data.mimeType || "text/plain";
        if (!isTextMime(mimeType)) {
          throw new Error(
            `${mimeType} isn't a supported UTF-8 text type. ` +
              (uploadDir
                ? `For a binary file, copy it into ${uploadDir.callerDir} and use drive_update_from_file`
                : "A byte-safe file update is not configured for this agent") +
              ". Nothing was updated.",
          );
        }

        const res = await drive.files.update({
          fileId,
          media: {
            mimeType,
            body: Readable.from([content]),
          },
          fields: "id, name, mimeType, parents, modifiedTime",
          supportsAllDrives: true,
        });

        return res.data;
      },
    });

    // Unlike a new upload, this keeps the existing Drive object, name and parents.
    if (uploadDir) {
      tools.push({
        name: "drive_update_from_file",
        description:
          `Replace an existing Drive file with the bytes of a file inside ${uploadDir.callerDir}. ` +
          `Preserves its file ID, name and parent folders. Up to ${formatLimit(uploadDir.maxBytes)}.`,
        service: "drive",
        requiredAccess: "write",
        inputSchema: {
          type: "object",
          required: ["fileId", "path"],
          properties: {
            fileId: {
              type: "string",
              description: "ID of the existing Drive file to replace.",
            },
            path: {
              type: "string",
              description: `Full path of a file directly inside ${uploadDir.callerDir}.`,
            },
            mimeType: {
              type: "string",
              description: "MIME type (default: the existing Drive file's type).",
            },
          },
        },
        handler: async (args) => {
          const fileId = args.fileId;
          if (typeof fileId !== "string" || !DRIVE_FILE_ID.test(fileId)) {
            throw new Error("fileId must be a Drive file id");
          }
          const meta = await drive.files.get({
            fileId,
            fields: "id, name, mimeType, parents",
            supportsAllDrives: true,
          });
          if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
            throw new Error("Item is outside allowed folders");
          }

          const file = await openUpload(uploadDir, args.path);
          const mimeType = (typeof args.mimeType === "string" && args.mimeType.trim())
            ? args.mimeType.trim()
            : meta.data.mimeType || guessMimeType(file.name);
          const digest = createHash("md5");
          file.stream.on("data", (chunk: Buffer) => digest.update(chunk));
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
          try {
            const res = await drive.files.update(
              {
                fileId,
                media: { mimeType, body: file.stream },
                fields: "id, name, mimeType, parents, modifiedTime, size, md5Checksum",
                supportsAllDrives: true,
              },
              { signal: controller.signal, timeout: DOWNLOAD_TIMEOUT_MS },
            );
            const stored = Number(res.data.size);
            if (res.data.size == null || stored !== file.size) {
              throw new Error(
                `Drive reported ${res.data.size == null ? "no stored size" : `${stored} bytes`} for a ${file.size}-byte file, ` +
                  `so the update isn't verified (Drive file ${res.data.id}). Download it before sharing.`,
              );
            }
            const expectedMd5 = digest.digest("base64");
            if (typeof res.data.md5Checksum !== "string" || res.data.md5Checksum !== expectedMd5) {
              throw new Error(
                `Drive's MD5 checksum doesn't match the source, so the update isn't verified ` +
                  `(Drive file ${res.data.id}). Download it before sharing.`,
              );
            }
            return { ...res.data, size: stored };
          } catch (err) {
            if (controller.signal.aborted) throw new Error("The update took too long and was stopped.");
            throw err;
          } finally {
            clearTimeout(timer);
            file.close();
          }
        },
      });
    }

  }

  // ── Admin tools ──────────────────────────────────────────────────────────

  if (hasAccess(driveAccess, "admin")) {
    tools.push({
      name: "drive_delete",
      description: "Move a file to trash in Google Drive.",
      service: "drive",
      requiredAccess: "admin",
      inputSchema: {
        type: "object",
        required: ["fileId"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file to delete (move to trash).",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;

        // Check folder access first
        const meta = await drive.files.get({
          fileId,
          fields: "id, name, parents",
          supportsAllDrives: true,
        });

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        await drive.files.update({
          fileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });

        return { success: true, fileId };
      },
    });

    tools.push({
      name: "drive_share",
      description: "Share a file or folder by adding a permission.",
      service: "drive",
      requiredAccess: "admin",
      inputSchema: {
        type: "object",
        required: ["fileId", "email", "role"],
        properties: {
          fileId: {
            type: "string",
            description: "ID of the file or folder to share.",
          },
          email: {
            type: "string",
            description: "Email address of the person to share with.",
          },
          role: {
            type: "string",
            enum: ["reader", "commenter", "writer"],
            description: "Permission role to grant.",
          },
        },
      },
      handler: async (args) => {
        const fileId = args.fileId as string;
        const email = args.email as string;
        const role = args.role as string;

        // Check folder access first
        const meta = await drive.files.get({
          fileId,
          fields: "id, name, parents",
          supportsAllDrives: true,
        });

        if (!(await isWithinAllowedFolders(drive, fileId, allowedFolders))) {
          throw new Error("Item is outside allowed folders");
        }

        const res = await drive.permissions.create({
          fileId,
          requestBody: {
            type: "user",
            role,
            emailAddress: email,
          },
          fields: "id, role, emailAddress",
          supportsAllDrives: true,
        });

        return res.data;
      },
    });
  }

  return tools;
}
