# google multiplayer mcp

An MCP server that gives AI agents access to Google Drive, Docs, Sheets, Calendar and Gmail.
Each agent gets its own permission file, so one agent can read a single folder while another manages a whole account.

It is built for people who run several agents, such as [Hermes](https://github.com/NousResearch/hermes-agent) agents, against shared Google accounts.
It covers the same ground as `workspace-mcp`, with per-agent permissions added.

It runs in two ways:

- **Stdio mode.** One server process per agent, holding that agent's Google login.
- **Broker mode.** One HTTP service holds the Google credentials for many agents. An agent holds only a secret for the broker.

## Quick start (stdio mode)

The package is not published to npm. Build it from source:

```bash
git clone https://github.com/cyborg-garden/google-multiplayer-mcp.git
cd google-multiplayer-mcp
npm install
npm run build
```

1. Give it your Google OAuth client. Either set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or create `~/.nimbleco-google/config.json`:

   ```json
   {
     "clientId": "YOUR_GOOGLE_CLIENT_ID",
     "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET"
   }
   ```

2. Log in once per identity. An identity is a name for one Google account.

   ```bash
   node dist/index.js auth personal
   node dist/index.js auth research
   ```

3. Write a permission file for each agent. See `examples/` and [Permissions](#permissions).

4. Point the agent at the server. For a Hermes agent, in `config.yaml`:

   ```yaml
   mcp_servers:
     google:
       command: node
       args:
         - /path/to/google-multiplayer-mcp/dist/index.js
         - --config
         - /opt/data/google-permissions.yaml
       env:
         GOOGLE_TOKEN_DIR: /opt/google/tokens
   ```

5. If the agent runs in a container, mount the tokens read-only in `docker-compose.yml`:

   ```yaml
   volumes:
     - ~/.nimbleco-google/tokens:/opt/google/tokens:ro
   ```

## Commands

```bash
node dist/index.js auth <identity>            # log in; opens a browser
node dist/index.js auth-headless <identity>   # log in; prints the URL instead of opening a browser
node dist/index.js auth status                # show every identity and whether it is logged in
node dist/index.js --config <path>            # start the MCP server over stdio
node dist/index.js broker --config <path>     # start the broker
```

## Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | read from `~/.nimbleco-google/config.json` | Your Google OAuth client. |
| `GOOGLE_TOKEN_DIR` | `~/.nimbleco-google/tokens` | Where login tokens are stored, one `<identity>.json` per identity. |
| `GOOGLE_AUTH_PORT` | `8095` | Port for the login callback. |
| `GOOGLE_AUTH_HOST` | `localhost` | Host in the login callback URL. Set it when the browser is on another machine. |

## Permissions

A permission file names one identity and sets a level per service:

```yaml
google:
  identity: research
  permissions:
    drive:
      access: read
      folders: ["<folder-id>"]
    docs:
      access: read
      folders: ["<folder-id>"]
    gmail:
      access: none
```

| Level | Tools it adds |
|-------|---------------|
| `none` | The service is off. |
| `read` | list, get, search, download |
| `write` | create, update, upload, rename, move, copy, send and draft email |
| `admin` | delete and share. Must be set explicitly. |

Each level includes the ones above it.
In stdio mode, a service you list without `access` gets `read`. A service you leave out gets `none`.
`folders` limits Drive, Docs and Sheets to those folders and what is inside them. For Calendar it lists the allowed calendar IDs.
Agents only see the tools their level allows.

### Tools

| Service | Tools |
|---------|-------|
| Drive | `drive_list`, `drive_get`, `drive_search`, `drive_download`, `drive_download_to_file`, `drive_upload`, `drive_upload_from_file`, `drive_create_folder`, `drive_rename`, `drive_move`, `drive_copy`, `drive_update`, `drive_delete` (moves to trash), `drive_share` |
| Docs | `docs_get`, `docs_create`, `docs_update`, `docs_batch_update`, `docs_delete` |
| Sheets | `sheets_get`, `sheets_create`, `sheets_update`, `sheets_batch_update`, `sheets_delete` |
| Calendar | `calendar_list_events`, `calendar_get_event`, `calendar_list_calendars`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event` |
| Gmail | `gmail_list`, `gmail_get`, `gmail_search`, `gmail_send`, `gmail_draft`, `gmail_delete` (permanent) |
| Login | `google_auth_url`, `google_auth_exchange`, `google_auth_start` (stdio only), `google_auth_status` |

`drive_download_to_file` and `drive_upload_from_file` are broker-only. See [Broker mode](#broker-mode).

## Logging in again from chat

When a login expires, the agent can fix it over chat without anyone touching the host.
This matters when the agent runs on a remote machine, because the user's phone can't reach the login callback there.

Two tools handle it:

| Tool | What it does |
|------|--------------|
| `google_auth_url` | Returns the Google consent URL. Starts no callback server. |
| `google_auth_exchange` | Takes the pasted `code=…` value, swaps it for tokens and saves them. |

1. The agent sends the user the URL from `google_auth_url`.
2. The user approves on their phone. The page they land on may show an error. They copy the `code=…` value from the address bar and paste it back.
3. The agent calls `google_auth_exchange` with that code.
4. In stdio mode, restart the MCP server so the Google tools load the new token. Broker mode needs no restart.

If tokens are missing or invalid at startup, the server still starts, with only the login tools. So these tools are always available.

`skills/reauth-google/SKILL.md` is an agent skill that walks through these steps.

`google_auth_start` and `google_auth_status` are the browser-callback version. Use them only when the user's browser can reach the host.

## Broker mode

Broker mode runs one HTTP service that holds the Google credentials for many agents.
An agent holds only a secret that identifies it to the broker, so it has no Google credential to read.

```bash
node dist/index.js broker --config broker.yaml
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
    download_dir: {host: /srv/broker-downloads/research, caller: /data/downloads/drive}
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

Agents connect over MCP's streamable HTTP transport, at `/mcp`, with the header `Authorization: Bearer <secret>`.

**Service accounts** suit team folders.
Share each folder or calendar with the service account, and Google itself refuses everything else.
Sharing a Shared Drive folder as Content manager lets the agent move and delete files as well as edit them.
Service accounts have no consent screen and no login to expire.
They can't use Gmail, and they must list their folders.

**OAuth** suits a real person's account.
Tokens and the client come from the same `GOOGLE_TOKEN_DIR` and `GOOGLE_CLIENT_ID` settings as stdio mode.
An agent can log in again with `google_auth_url` and `google_auth_exchange`, and needs no restart afterwards.
A new login is saved only if it is for `expected_account`, and a saved login is checked against it before use. An agent can't swap in another account.

**Rules the broker checks at startup:**

- A key file must not be readable by group or others.
- Each agent needs its own secret and its own credential.
- `access` must be `none`, `read`, `write` or `admin`. Unlike stdio mode, leaving it out means no access.
- `folders` must be a list of IDs.
- An OAuth agent must name each service with no folder limit in `allow_whole_account`. Gmail always needs this, because folders can't limit Gmail.
- Listening beyond loopback needs `allow_non_loopback: true`.
- A `download_dir` host folder must exist, be given as its real path (no links), and belong to one agent only. No two agents' folders may be the same or one inside the other.
- An `upload_dir` follows the same rules as `download_dir` and may not overlap one.
- The audit log must be writable.

**Limits:**

- 8 requests at once per agent and 32 in total. A request counts until its work ends, even if the client disconnects, up to the four-minute limit per tool call.
- 50 requests a second per agent, and one JSON-RPC message per request.
- A 32 MB request body by default.
- A 32 MB Drive download, or 2 GB by default with `drive_download_to_file`.
- 2,048 connections.
- A two-minute timeout per Google request, with no retries. An agent should retry a call that Google refuses for being busy.

**Audit log.**
One JSON line when a call starts and one when it ends, with the agent, tool, result, time taken, and IDs such as `fileId`.
Recipients are recorded as email addresses only. It never records content, names or secrets.
At 64 MB it moves to `audit.jsonl.1`, replacing any older one.
If the log can't be written, the call isn't run.
Refused requests are logged as `denied` or `refused`.

**Running it safely:**

- Keep the broker's files out of reach of agents.
- Bind it to loopback unless something else protects the port.
- Secrets travel unencrypted, so agents sharing a network must not hold `NET_RAW`. With it, one agent could read another's secret.

Calls are stateless, so restarting the broker doesn't disturb connected agents.

### Large Drive files: `drive_download_to_file`

`drive_download` returns the file as base64 in the tool result, so it stops at 32 MB.
`drive_download_to_file` streams the file to disk instead and returns only:

```json
{"path": "/data/downloads/drive/<file-id>-<hash>-clip.mp4", "name": "clip.mp4", "mimeType": "video/mp4", "size": 734003200}
```

It takes one argument, `fileId`.
The folder comes only from the agent's `download_dir`. An agent without one isn't offered the tool.

```yaml
    download_dir:
      host: /srv/broker-downloads/research    # the folder as the broker sees it
      caller: /data/downloads/drive           # the same folder as the agent sees it
      max_bytes: 2147483648                   # optional: largest file; 2 GB by default
      max_total_bytes: 10737418240            # optional: most the folder may hold; 10 GB by default
      max_concurrent: 2                       # optional: downloads at once; 2 by default
      min_free_bytes: 5368709120              # optional: free space to leave on the disk; 5 GB by default
```

**Recommended setup for an agent in a container.**
Give each agent a host folder outside its own data folder, owned by the broker's user.
Bind-mount it read-only into the container at the `caller` path:

```yaml
# the agent's compose service
volumes:
  - /srv/broker-downloads/research:/data/downloads/drive:ro
```

Read-only, the agent can read its downloads but can't rename the folder, plant links in it, or fill it.
Pointing `host` inside a folder the agent can write to also works. The agent can then try to swap the folder for a link. The checks below refuse that, but treat this setup as a fallback.

- Same folder allowlist as `drive_download`.
- The file is named `<file-id>-<hash>-<name>`. The hash is of the exact id, so ids that differ only by case don't collide on a case-insensitive disk. Path separators and control characters are replaced, leading dots removed, and the name capped at 150 bytes.
- Downloading the same file again replaces the earlier copy.
- The temporary file is created before anything is requested from Drive, with `O_CREAT | O_EXCL | O_NOFOLLOW`. The open file is matched by device and inode against the entry in the configured folder, and the folder against the one checked at the start. This happens before the download, before the rename and after it. If anything has moved, the call fails.
- A failed, oversized, over-quota or timed-out download leaves nothing behind, and an earlier copy stays.
- Sizes are checked before downloading and counted while streaming. A download may write exactly Drive's stated size, and is stopped if more arrives. With no stated size, it reserves the whole remaining per-file allowance.
- The quota and the free-space floor count files already in the folder plus what running downloads have reserved.
- Partial files over an hour old, left by a broker crash, are removed at broker start and before each quota check.
- A download is refused if it would leave less than `min_free_bytes` free on the disk.
- Google Docs, Sheets and Slides have no file to download. They are refused with a pointer to `drive_get`, `docs_get` and `sheets_get`.
- Errors never show host paths. File-system errors are reported by code only.
- A download must finish within about 3.5 minutes, under the four-minute limit per call. At 2 GB that needs roughly 80 Mbit/s.
- The broker never deletes downloads. Clear the folder when the quota fills.

### Videos, PDFs and other binary files: `drive_upload_from_file`

`drive_upload` takes its content as a string in the tool call.
That suits text and small files. Pass binary as base64 with `encoding: base64`.
An agent can't type a video into a tool call, so `drive_upload_from_file` sends a file from disk instead, byte for byte:

```json
{"path": "/data/uploads/drive/cut.mp4", "folderId": "<drive-folder-id>"}
```

`name` and `mimeType` are optional. The type is chosen from the file name.
The result carries the new file's `id`, `size` and `webViewLink`.
If Drive stores a different number of bytes than the file holds, the call fails and says so.

The agent copies the file into its upload folder first.
That folder comes only from the agent's `upload_dir`. An agent without one, or without Drive `write` access, isn't offered the tool.

```yaml
    upload_dir:
      host: /srv/broker-uploads/research   # the folder as the broker sees it
      caller: /data/uploads/drive          # the same folder as the agent sees it
      max_bytes: 2147483648                # optional: largest file; 2 GB by default
```

**Setup for an agent in a container.**
Give each agent a host folder outside its own data folder, with parents only the operator can change.
Bind-mount it read-write into the container at the `caller` path:

```yaml
# the agent's compose service
volumes:
  - /srv/broker-uploads/research:/data/uploads/drive
```

The agent can then fill the folder but can't rename it, delete it, or replace it or any folder above it.
Don't point `host` at a folder inside the agent's own data folder. The broker reads the folder's path once at startup to learn which directory it is. An agent that swaps that path at that moment could get another folder recorded in its place.

- The agent must be able to write to this folder, so it is a different folder from `download_dir`, which is best mounted read-only.
- The host folder must exist, be given as its real path (no links), and belong to one agent only. It may not be the same as, inside, or around any `download_dir`, another agent's `upload_dir`, or the broker's own folder (where its keys are kept).
- Only regular files directly in the folder are sent. Links, pipes, subfolders, hidden files and paths elsewhere are refused.
- The broker reads every upload from the directory it recorded at startup, opening the file by name from inside it. An agent that swaps its folder for a link to someone else's gets a refusal, however it times the swap. If you delete and recreate the folder, restart the broker.
- If the file is cut short or changes size while it is read, the upload fails. Nothing shorter than the file is left in Drive looking whole.
- Two uploads at a time per agent.
- Keep credentials out of this folder. Anything in it can be sent to Drive on the agent's word. The broker refuses its own config folder, but can't know where else you keep keys.
- Same folder allowlist as `drive_upload`.

## Development

```bash
npm install
npm test        # vitest
npm run dev     # run from source with tsx
```
