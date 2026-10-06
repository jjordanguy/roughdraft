# Wake routes

A wake route tells Roughdraft how to reach one harness (Claude Code, OpenClaw, a script) when Jordan clicks Done Reviewing. There is one route per harness. The agent owns its route: at the start of a session it tests the route for its harness, and if there is none, adding and testing one is its first job (decision D14). Claude Code needs no setup: its route is built in and posts the Done straight into the session that opened the file. This file has no horizontal rule and keeps markup examples in code, so it is safe to open in Roughdraft.

## How Done uses a route

1. An agent opens a file and registers its session: `roughdraft open "/abs/path.md" --no-watch --session-label "..."` (or the `roughdraft_register_session` MCP tool). Inside Claude Code the CLI fills in the harness (`claude-code`), the session id and, when no label is given, the session's title, from the environment Claude Code gives its shell. Other harnesses pass `--harness <name>` and `--session-id <id>`. The session log records the harness, label, link and session id against that file.
2. Jordan clicks Done. Roughdraft writes the Done to the session log first, then delivers it to any agent waiting with `watch`, then, when the file's session names a harness that has a route, runs that route with the file path, the link, the comment counts and the global comment.
3. The result goes into the log: `wake.state` is `sent` or `failed` (with the error), or `none` when the file has no session or its harness has no route. `roughdraft log` shows it per document. A Done whose wake failed is still in the log until an agent acknowledges it (`roughdraft pending`).

A watching agent that also has a route gets the Done twice, once from each. Acknowledging it once (the watch does this by default) is enough.

## Commands

```bash
roughdraft route list [--json]
roughdraft route add <harness> --command "<shell command>" [--label "<text>"]
roughdraft route add <harness> --url <http or https URL> [--label "<text>"]
roughdraft route add <harness> --claude-session [--label "<text>"]
roughdraft route test <harness> [--session-id <id>] [--json]
roughdraft route remove <harness> [--json]
```

- `<harness>` is 1 to 64 letters, digits, dots, dashes or underscores, for example `claude-code` or `openclaw`. Adding a route for a harness that has one replaces it.
- `route add`, `route test` and `route remove` start the server if it is not running; `route list` reads `wake-routes.json` from disk when the server is down.
- `route test` sends a test wake (`event` is `test`) and records when the route was last verified and by whom. It exits 0 when the wake was sent, 3 (`WAKE_ROUTE_FAILED`, with the error) when it was not, and 2 (`WAKE_ROUTE_NOT_FOUND`) when the harness has no route.
- The MCP tool `roughdraft_wake_routes` does the same with `action` set to `list`, `add`, `remove` or `test`.

Routes live in `wake-routes.json` in the state directory (`~/.roughdraft` by default). The `claude-code` route is built in (kind `claude-session`, below) and is not in the file until it has a result to remember; `route add claude-code ...` replaces it and `route remove claude-code` brings the built-in one back.

## Claude session routes

A `claude-session` route delivers the Done into the Claude Code session that opened the file, as a user turn: the session starts a turn on it when it is idle and reads it at its next tool round when it is busy. The message is the wake message (below), then a blank line, `File: <path>`, `Link: <the file's link>` and `Next: roughdraft round '<path>'`.

How it finds the session: every Claude Code process keeps a record under `~/.claude/sessions/` (or `$CLAUDE_CONFIG_DIR/sessions/`) with the path of the socket it listens on for messages from other sessions, and a key file next to it with the token a sender presents. Roughdraft matches the session id the file was registered with (the conversation id, or the desktop app's `local_...` id) against the live records, reads the token, and writes two lines of JSON to the socket. Nothing is stored in Roughdraft but the id. The delivery fails, with the reason in the log, when the file's session has no id, when no running session has that id (the session was closed or the machine restarted), or when the socket does not answer.

`route test claude-code` needs a session to deliver the test into. Run it from inside a Claude Code session (its shell carries the session id) or pass `--session-id <id>` for a session that is running; the test message says it is a test and asks for nothing.

## Command routes

The command runs through the shell (`sh -c`) with a 10 second limit. Before it runs, `{message}`, `{file}`, `{link}` and `{sessionId}` are replaced with shell-quoted values, so write them bare: `notify {message}`, not `notify "{message}"`. The command also gets these environment variables:

| Variable | Value |
| --- | --- |
| `ROUGHDRAFT_EVENT` | `done` or `test` |
| `ROUGHDRAFT_MESSAGE` | The wake message (below) |
| `ROUGHDRAFT_FILE` | Absolute path of the reviewed file (empty for a test) |
| `ROUGHDRAFT_LINK` | The file's Roughdraft link (empty for a test) |
| `ROUGHDRAFT_COMMENTS`, `ROUGHDRAFT_SUGGESTIONS`, `ROUGHDRAFT_UNRESOLVED` | Counts from the file at Done |
| `ROUGHDRAFT_HANDOFF_ID` | The Done's handoff id, for `roughdraft ack` |
| `ROUGHDRAFT_SESSION_LABEL`, `ROUGHDRAFT_SESSION_ID` | From the registered session |

`ROUGHDRAFT_TOKEN` is removed from the command's environment. Exit 0 counts as sent; any other exit, a crash or the time limit counts as failed, and the last 500 characters of stderr go into the error. Stdout is ignored.

The wake message is `I'm done reviewing <file name>. Please check my comments. (<n> comments, <n> suggestions)`, followed on a new line by Jordan's global comment when Done carried one.

Example, a route that appends every wake to a file (useful to see what a harness would receive):

```bash
roughdraft route add scratch --command 'printf "%s\n" {message} >> /tmp/roughdraft-wakes.log' --label "test sink"
roughdraft route test scratch
```

## URL routes

The URL receives a JSON POST (`Content-Type: application/json`) with a 10 second limit; any 2xx answer counts as sent.

```json
{
  "type": "roughdraft.done",
  "message": "I'm done reviewing plan.md. Please check my comments. (3 comments, 1 suggestions)",
  "documentPath": "/Users/me/notes/plan.md",
  "link": "http://localhost:7373/?path=%2FUsers%2Fme%2Fnotes%2Fplan.md",
  "counts": { "comments": 3, "suggestions": 1, "unresolved": 4 },
  "handoffId": "6f1c...",
  "session": { "harness": "openclaw", "label": "planning chat", "sessionId": "abc" }
}
```

A test sends `type: "roughdraft.test"` with `documentPath`, `link` and `handoffId` set to null and zero counts.

## The two harnesses today

- **OpenClaw (Mike)**: a URL route to its existing webhook, `roughdraft route add openclaw --url <webhook URL> --label "Mike's webhook"`.
- **Claude Code (Mac and VPS)**: the built-in `claude-session` route. Nothing to add; `roughdraft route test claude-code` from inside a session confirms it. The session log still covers the cases the route cannot: a session that was closed before Done, or a Done nobody was registered for. Then Jordan says "done" in chat and the agent runs `roughdraft round`, which picks up the waiting Done.

## HTTP routes behind the commands

The CLI and the MCP server call these on the running server (with `Authorization: Bearer <ROUGHDRAFT_TOKEN>` when the token is set). Changes to wake routes are refused (403) unless the request comes from this machine or carries the token, because a route runs commands.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/wake-routes` | | `{ routes: [{ harness, kind, command?, url?, label, verifiedAt, verifiedBy, lastError }] }` |
| `PUT /api/wake-routes/<harness>` | `{ kind: "command" \| "url", command?, url?, label? }` | `{ ok, route }`; 400 `USAGE` on a bad body |
| `DELETE /api/wake-routes/<harness>` | | `{ ok, removed }` |
| `POST /api/wake-routes/<harness>/test` | `{ by? }` | `{ ok, sent, error, durationMs }`; 404 `WAKE_ROUTE_NOT_FOUND` |
| `POST /api/documents/session` | `{ projectPath, path, harness, label, link?, sessionId? }` | `{ ok, session }` with `routeId` when the harness has a route |
| `POST /api/review-events` | `{ projectPath, path, overallComment? }` (the Done) | `{ delivered, pending, event, handoff, wake, instanceId }` |
| `POST /api/review-events/ack` | `{ handoffId, by? }` | `{ ok, handoff }`; 404 `HANDOFF_NOT_FOUND` |
| `GET /api/documents` | | the session log and registry: every document with its tabs, watchers, session and handoffs |
