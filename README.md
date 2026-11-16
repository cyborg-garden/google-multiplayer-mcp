# google multiplayer mcp

OAuth-based Google Workspace MCP server for Hermes agents. Replaces `workspace-mcp` with per-agent permission enforcement.

## Setup

1. Create `~/.nimbleco-google/config.json`:

```json
{
  "clientId": "YOUR_GOOGLE_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET"
}
```

2. Authenticate each identity:

```bash
npx google-multiplayer-mcp auth personal
npx google-multiplayer-mcp auth frontdoor
```

3. Create a permission config for each agent (see `examples/`).

4. Update Hermes agent `config.yaml`:

```yaml
mcp_servers:
  google:
    command: npx
    args:
      - github:NimbleCoAI/google-multiplayer-mcp
      - --config
      - /opt/data/google-permissions.yaml
    env:
      GOOGLE_TOKEN_DIR: /opt/google/tokens
```

5. Mount tokens in `docker-compose.yml`:

```yaml
volumes:
  - ~/.nimbleco-google/tokens:/opt/google/tokens:ro
```

## Permission Levels

| Level | Operations |
|-------|-----------|
| `none` | Service disabled |
| `read` | list, get, search, download |
| `write` | read + create, update, upload |
| `admin` | write + delete, share, trash (must be explicit) |

## Auth Commands

```bash
google-multiplayer-mcp auth <identity>   # OAuth flow (opens browser)
google-multiplayer-mcp auth status        # Show all identities
```

## Re-auth from chat (paste-code, no browser callback)

When an agent runs on a remote/headless host, the user's phone can't reach the
local OAuth callback server — so the browser-callback flow can't complete. For
that case the MCP exposes two tools that drive a **paste-code** flow:

| Tool | Purpose |
|------|---------|
| `google_auth_url` | Returns the consent URL (no callback server started). |
| `google_auth_exchange` | Takes the pasted `code=…` value, exchanges it for tokens, saves them. |

Flow: the agent sends `google_auth_url`'s URL to the user → the user consents on
their phone and copies the `code=…` from the redirected URL (which may show an
error — only the code matters) → pastes it back → the agent calls
`google_auth_exchange` → the MCP is reloaded (HSM quick-restart) so the Google
tools pick up the new token.

The companion agent skill `skills/reauth-google/SKILL.md` packages this as a
"reauth google" procedure for Signal/DM, including proactive use on
`invalid_grant`. The MCP starts in **auth-tools-only** mode when tokens are
missing/invalid (it does not exit), so these auth tools are always reachable.

## Broker mode

Broker mode runs one HTTP service that holds the Google credentials for many agents. An agent holds only a secret that identifies it to the broker, so it has no Google credential to read.

```bash
google-multiplayer-mcp broker --config broker.yaml
```

```yaml
# broker.yaml. Relative paths are read from this file's directory.
host: 127.0.0.1
port: 8797
audit_log: audit.jsonl
agents:
  research:
    secret_sha256: <sha256 of the agent's secret, as hex>
    credential: {type: service_account, key_file: keys/research.json}
    # Optional: lets this agent save large Drive files to disk. See below.
    download_dir: {host: /srv/agents/research/downloads/drive, caller: /data/downloads/drive}
    permissions:
      drive: {access: write, folders: [<folder-id>]}
      docs: {access: write, folders: [<folder-id>]}
      sheets: {access: write, folders: [<folder-id>]}
      calendar: {access: write, folders: [<calendar-id>]}
  assistant:
    secret_sha256: <sha256 of the agent's secret, as hex>
    credential: {type: oauth, identity: assistant, expected_account: assistant@example.com}
    allow_whole_account: [gmail]
    permissions:
      gmail: {access: read}
```

Connect an agent over MCP's streamable HTTP transport, at `/mcp` with the header `Authorization: Bearer <secret>`.

**Service accounts** suit team folders. Share each folder or calendar with the service account, so Google itself refuses anything else. Sharing a Shared Drive folder as Content manager lets the agent move and delete files as well as edit them. They have no consent screen and no login to expire. They can't use Gmail, and they must list their folders.

**OAuth** suits a real person's account. Tokens and the client come from the same `GOOGLE_TOKEN_DIR` and `GOOGLE_CLIENT_ID` settings as stdio mode. An agent can re-authenticate with `google_auth_url` and `google_auth_exchange`, and needs no reload afterwards. A new login is saved only if it's for `expected_account`, and a saved login is checked against it before use, so an agent can't swap in another account.

**Rules the broker applies at startup:**

- A key file must not be readable by group or others.
- Each agent needs its own secret and its own credential.
- `access` must be `none`, `read`, `write` or `admin`. Leaving it out means no access.
- `folders` must be a list of IDs.
- An OAuth agent must name each service with no folder limit in `allow_whole_account`. Gmail always needs this, because folders can't limit Gmail.
- Listening beyond loopback needs `allow_non_loopback: true`.
- A `download_dir` host folder must exist, be given as its real path (no links), and belong to one agent only.
- The audit log must be writable.

**Limits:** 8 requests at once per agent and 32 in total, counted until the work ends even if the client disconnects, up to the four-minute limit per tool call. Also 50 requests a second per agent, one JSON-RPC message per request, a 32 MB request body by default, a 32 MB Drive download (2 GB by default with `drive_download_to_file`), 2,048 connections, and a two-minute timeout per Google request with no retries. An agent should retry a call that Google refuses for being busy.

**Audit log:** one JSON line when a call starts, and one when it ends, with the agent, tool, result, time taken and IDs such as `fileId`. Recipients are recorded as email addresses only. It never records content, names or secrets. At 64 MB it moves to `audit.jsonl.1`, replacing any older one. If the log can't be written, the call isn't run. Refused requests are logged as `denied` or `refused`.

**Keep it safe:**

- Keep the broker's files out of reach of agents.
- Bind it to loopback unless something else protects the port.
- Secrets travel unencrypted, so agents sharing a network must not hold `NET_RAW`. With it, one agent could read another's secret.

Calls are stateless, so restarting the broker doesn't disturb connected agents.

### Large Drive files: `drive_download_to_file`

`drive_download` returns the file as base64 in the tool result, so it stops at 32 MB. `drive_download_to_file` streams the file to disk instead and returns only:

```json
{"path": "/data/downloads/drive/<file-id>-clip.mp4", "name": "clip.mp4", "mimeType": "video/mp4", "size": 734003200}
```

It takes one argument, `fileId`. The folder comes only from the agent's `download_dir`; an agent without one isn't offered the tool.

```yaml
    download_dir:
      host: /srv/agents/research/downloads/drive   # the folder as the broker sees it
      caller: /data/downloads/drive                # the same folder as the agent sees it
      max_bytes: 2147483648                        # optional; 2 GB by default
```

For an agent in a container, point `host` at a folder inside a directory the container already mounts, and `caller` at the same folder's path inside the container. No new mount is needed.

- Same folder allowlist as `drive_download`.
- The file is named `<file-id>-<name>`, with path separators and control characters replaced, leading dots removed, and the name capped at 150 bytes. Downloading the same file again replaces the earlier copy.
- It is written to a temporary file and renamed when complete. A failed, oversized or timed-out download leaves nothing behind, and an earlier copy stays.
- The size is checked against `max_bytes` before downloading and counted while streaming, since Drive's stated size can be missing.
- Google Docs, Sheets and Slides have no file to download, so they are refused with a pointer to `drive_get`, `docs_get` and `sheets_get`.
- The agent can often write into its own folder, so the broker refuses to write if the folder has been removed or replaced by a link, and never writes through a link.
- A download must finish within about 3.5 minutes, under the broker's four-minute limit per call. At 2 GB that needs roughly 80 Mbit/s.
- Free disk space isn't checked; a full disk fails the call and removes the partial file.
- Downloads are never deleted by the broker; clear the folder yourself when needed.
