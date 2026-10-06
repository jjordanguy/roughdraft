# 0004: CLI Server State Model

## Context

The CLI starts or reuses a local server so `roughdraft open <file.md>` works without manual process management.

## Decision

The server state file records the managed background process, port, URL, and start time. The CLI should reuse healthy managed servers, recover from stale state, and avoid claiming ownership of unrelated processes unless explicitly requested.

## Consequences

State handling must remain deterministic and testable. Stale-write protection and local-file boundary checks belong in the core server path.

## What This Explicitly Does Not Mean

The state file is not a project database, collaboration backend, sync system, or persistent document model.

## Clarification (2026-04-30): Remote Document Sessions

Remote document mode (see `docs/plans/2026-04-30-001-feat-remote-document-mode-plan.md`) introduces in-memory session state on the server: a map of registered remote-document sessions, each holding a CLI-supplied markdown file's bytes for the lifetime of the SSE connection.

This state is **deliberately not persisted in the state file**. Sessions live only in the running server process and are evicted on disconnect or server restart. The state file's role — managed background process, port, URL, start time — is unchanged. Treating remote-document sessions as transient in-memory state preserves the boundary above: the state file does not become a document model just because the server now hosts other machines' edits.

### Trust model and `ROUGHDRAFT_TOKEN`

The hosted Roughdraft is a write-capable peer for every connected CLI: a PUT to a session causes the CLI on the source machine to atomically rewrite the registered file on disk. Loopback-only deployments can rely on the OS for trust, but the moment the server binds to a non-loopback host (e.g. `ROUGHDRAFT_BIND_HOST=0.0.0.0` for Tailscale access), anyone reachable on that interface can register, read, or PUT.

The mitigation is a shared bearer token, `ROUGHDRAFT_TOKEN`:

- The server reads `ROUGHDRAFT_TOKEN` at startup. When set, all `/api/remote-document/*` endpoints require it (Authorization: Bearer header, or `?token=` query for the SSE endpoint specifically since `EventSource` can't set headers).
- `createServer()` refuses to bind to any non-loopback host without a token, returning a clear actionable error before listening.
- The CLI sends the same token via `Authorization: Bearer` on its register POST and SSE GET, and surfaces a 401 explicitly (suggesting the user set `ROUGHDRAFT_TOKEN`).
- The viewerUrl printed by the CLI includes `?token=...` so the browser tab can authenticate. The frontend forwards the token as a header on fetches and as `?token=` on the EventSource.

Loopback-only deployments stay back-compatible: no token required, no behavior change. The token is the contract that lets non-loopback deployments be safe; the secure-by-default startup guard is the contract that lets us ship the feature without expecting users to read documentation before exposing the endpoints.

## Superseded (2026-10-06): Remote Document Sessions Removed

Jordan's fork removed remote document mode (fork plan, ruling R1), so the in-memory remote-document sessions and their `/api/remote-document/*` endpoints are gone. `ROUGHDRAFT_TOKEN` stays, with a wider job: when set, the server requires `Authorization: Bearer <token>` on every `/api` request, and the server refuses to bind a non-loopback host (`ROUGHDRAFT_BIND_HOST`) without it. A GET request (an event stream) may pass it as `?token=` instead. The CLI and the MCP server send the header whenever the token is set.

## Clarification (2026-10-06): The State Directory Holds Delivery State

The state directory (`~/.roughdraft` by default, `ROUGHDRAFT_STATE_DIR` or the folder of `ROUGHDRAFT_STATE_FILE` otherwise) now holds more than `server.json`:

- `review-log.json`, the session log: per document, the chat session that opened it (harness, label, link, session id) and its Done handoffs with their delivery state (pending, delivered, acknowledged, superseded) and the result of the wake. Unacknowledged Dones are kept 14 days, acknowledged ones 2 days, at most 50 per document and 500 overall.
- `wake-routes.json`: one wake route per harness (a shell command or a URL), with when it was last verified and its last error.
- `rounds/<roundId>/`: an agent's review round (the round list, the clean copy, the response template, the file as it was) until `apply` lands it, and `rounds/index.json`, the open rounds the guard hook reads.
- `backups/`: the copies `roughdraft doctor --fix` makes before it converts a file.

All of this is delivery and agent-handoff state. None of it is a document model: no file's content is stored as the source of truth (a round folder holds working copies the agent edits, and `apply` writes the result back to the Markdown file; a backup is a copy). The Markdown file on disk stays the only record of the document and its review data, and deleting the state directory loses waiting Dones, wake routes and unfinished rounds, never a document or a comment.

The CLI and the MCP server find the running server the same way (`findReusableServer`: the tracked pid plus a status check, then the preferred port when it serves the same install) and never trust `server.json` alone. The MCP server never starts a server; it reports `SERVER_UNREACHABLE` instead.
