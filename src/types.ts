/** Shared types for google-multiplayer-mcp server. */

export type ServiceName = "drive" | "calendar" | "gmail" | "docs" | "sheets";

export type AccessLevel = "none" | "read" | "write" | "admin";

/** Numeric access levels for comparison. */
const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/** Returns true if granted level meets or exceeds required level. */
export function hasAccess(granted: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[granted] >= ACCESS_RANK[required];
}

export interface ServicePermission {
  access: AccessLevel;
  /** Allowed folder IDs (Drive/Docs/Sheets) or calendar IDs (Calendar). Empty = all. */
  folders?: string[];
}

/**
 * Where drive_download_to_file writes, set only by the operator. The same
 * folder is seen at `hostDir` by this process and at `callerDir` by the agent,
 * for example through a container mount.
 */
export interface DownloadDir {
  /** Absolute path with no links in it, as this process sees it. */
  hostDir: string;
  /** Absolute path the caller sees; returned in tool results. */
  callerDir: string;
  /** Largest file the tool will write. */
  maxBytes: number;
}

export interface PermissionConfig {
  identity: string;
  permissions: Partial<Record<ServiceName, ServicePermission>>;
  /** Unset means drive_download_to_file isn't offered. */
  downloadDir?: DownloadDir;
}

/** Root shape of the YAML config file. */
export interface ConfigFile {
  google: PermissionConfig;
}

/** Shape of ~/.nimbleco-google/config.json */
export interface GlobalConfig {
  clientId: string;
  clientSecret: string;
}

/** Shape of a token file (googleapis OAuth2 tokens). */
export interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/** MCP tool definition with required access level. */
export interface ToolDef {
  name: string;
  description: string;
  service: ServiceName;
  requiredAccess: AccessLevel;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
