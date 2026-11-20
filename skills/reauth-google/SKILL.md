---
name: reauth-google
description: "Re-authenticate Google over chat (Signal/DM) when a Google tool fails with invalid_grant or the user asks to 'reauth google' / 'reconnect google' / 'my google auth expired'. Drives the paste-code flow: send the consent URL, take the pasted code back, exchange it, reload."
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [auth, google, signal, reauth, oauth]
    related_skills: []
---

# Re-authenticate Google over chat (paste-code)

## When to use

Use this skill when either of these happens:

- A Google tool call (calendar, gmail, drive, docs, sheets) fails with an auth error: `invalid_grant`, `No tokens for identity`, "auth needed", or the google MCP says it started with **auth tools only**.
- The user asks to "reauth google", "reconnect google" or "log back into google", or says their Google access expired.

This is the remote path.
The user is on their phone over Signal or DM, and their phone can't reach a login callback on this host.
Do **not** use `google_auth_start` here. It waits on a local callback server the phone can't reach.
Use the paste-code tools below.

## Prerequisites

- The `google` MCP server is configured for this agent and offers `google_auth_url` and `google_auth_exchange`.
- The agent logs in with **its own** Google client. The MCP already reads the agent's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Never use the host's client.

## Procedure

### 1. Get the consent URL

Call **`google_auth_url`**. It returns `{ url, ... }`.
Do not start a callback flow.

### 2. Send it to the user with paste instructions

Send the user one clear message. For example:

> Google access expired. Open this link on your phone, pick the right Google
> account, and approve:
>
> `<url>`
>
> The page it lands on will probably show an error or "can't reach this site".
> That is expected. Copy the long value after `code=` in the address bar, up to
> the next `&`, and paste it back here.

### 3. Exchange the pasted code

When the user pastes the code, call **`google_auth_exchange`** with `{ code: "<pasted value>" }`.

- If the user pasted the whole URL, pass only the value between `code=` and the next `&`.
- On success the tool returns `{ status: "authenticated", email }`.
- On `{ status: "error" }`, the code was probably already used or cut short. Each code works once. Ask the user to open the link from step 1 again and paste a fresh code.

### 4. Restart so the Google tools come back

A stdio MCP server keeps the old credentials in memory until it restarts.
After a successful exchange, restart the agent or its MCP server with the restart tool your harness provides.
If you can't restart yourself, tell the user that the login is saved and the Google tools will work after the next restart.
A broker-mode agent needs no restart.

### 5. Confirm

Tell the user: "Google reconnected as `<email>`."
Then retry the Google action they originally asked for.

## Notes

- **One message each way.** Send one instruction in step 2 and one confirmation in step 5. Never repeat reconnect notices.
- **Codes work once and expire quickly.** If the exchange fails, start again from a fresh `google_auth_url`.
- **Use the right account.** The consent URL is for this agent's identity. The user must approve with that identity's Google account.
