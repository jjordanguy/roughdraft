# Wake routes

A wake route tells Roughdraft how to reach one harness (Claude Code, Codex, OpenClaw, a script) when Jordan clicks Done Reviewing. There is one route per harness. The agent owns its route: at the start of a session it tests the route for its harness, and if there is none, adding and testing one is its first job (decision D14). Claude Code and Codex need no setup: their routes are built in and deliver the Done straight into the session that opened the file. This file has no horizontal rule and keeps markup examples in code, so it is safe to open in Roughdraft.

## How Done uses a route

1. An agent opens a file and registers its session: `roughdraft open "/abs/path.md" --no-watch --session-label "..."` (or the `roughdraft_register_session` MCP tool). Inside Claude Code the CLI fills in the harness (`claude-code`), the session id and, when no label is given, the session's title, from the environment Claude Code gives its shell. Inside Codex it does the same with harness `codex`, the id from `CODEX_THREAD_ID` (or `CODEX_SESSION_ID`) and the thread name. When a shell has both, Claude Code wins. Other harnesses pass `--harness <name>` and `--session-id <id>`. The session log records the harness, label, link and session id against that file.
2. Jordan clicks Done. Roughdraft writes the Done to the session log first, then delivers it to any agent waiting with `watch`, then, when the file's session names a harness that has a route, runs that route with the file path, the link, the comment counts and the global comment.
3. The result goes into the log: `wake.state` is `sent` or `failed` (with the error), or `none` when the file has no session or its harness has no route. `roughdraft log` shows it per document. A Done whose wake failed is still in the log until an agent acknowledges it (`roughdraft pending`).

A watching agent that also has a route gets the Done twice, once from each. Acknowledging it once (the watch does this by default) is enough.

## Commands

```bash
roughdraft route list [--json]
roughdraft route add <harness> --command "<shell command>" [--label "<text>"]
roughdraft route add <harness> --url <http or https URL> [--header "Name: value"]... [--body '<JSON template>'] [--label "<text>"]
roughdraft route add <harness> --claude-session [--label "<text>"]
roughdraft route add <harness> --codex-queue [--label "<text>"]
roughdraft route test <harness> [--session-id <id>] [--json]
roughdraft route remove <harness> [--json]
```

- `<harness>` is 1 to 64 letters, digits, dots, dashes or underscores, for example `claude-code` or `openclaw`. Adding a route for a harness that has one replaces it.
- `route add`, `route test` and `route remove` start the server if it is not running; `route list` reads `wake-routes.json` from disk when the server is down.
- `route list` and `roughdraft log` show a url route's address, the names of its headers and "body template" when it has one. Header values are never printed; `--json` output and the MCP tool show each value as `"<set>"`.
- `route test` sends a test wake (`event` is `test`) and records when the route was last verified and by whom. It exits 0 when the wake was sent, 3 (`WAKE_ROUTE_FAILED`, with the error) when it was not, and 2 (`WAKE_ROUTE_NOT_FOUND`) when the harness has no route.
- The MCP tool `roughdraft_wake_routes` does the same with `action` set to `list`, `add`, `remove` or `test`.

Routes live in `wake-routes.json` in the state directory (`~/.roughdraft` by default). A url route's headers can hold a token, so the file is written with mode 0600 (readable by this user only), and a file left from an older build becomes 0600 the next time a route is saved. The `claude-code` route (kind `claude-session`) and the `codex` route (kind `codex-queue`) are built in and are not in the file until they have a result to remember; `route add claude-code ...` replaces one and `route remove claude-code` brings the built-in one back, and the same for `codex`.

## Claude session routes

A `claude-session` route delivers the Done into the Claude Code session that opened the file, as a user turn: the session starts a turn on it when it is idle and reads it at its next tool round when it is busy. The message is the wake message (below), then a blank line, `File: <path>`, `Link: <the file's link>` and `Next: roughdraft round '<path>'`.

How it finds the session: every Claude Code process keeps a record under `~/.claude/sessions/` (or `$CLAUDE_CONFIG_DIR/sessions/`) with the path of the socket it listens on for messages from other sessions, and a key file next to it with the token a sender presents. Roughdraft matches the session id the file was registered with (the conversation id, or the desktop app's `local_...` id) against the live records, reads the token, and writes two lines of JSON to the socket. Nothing is stored in Roughdraft but the id. The delivery fails, with the reason in the log, when the file's session has no id, when no running session has that id (the session was closed or the machine restarted), or when the socket does not answer.

`route test claude-code` needs a session to deliver the test into. Run it from inside a Claude Code session (its shell carries the session id) or pass `--session-id <id>` for a session that is running; the test message says it is a test and asks for nothing.

## Codex queue routes

A `codex-queue` route queues the Done for the Codex session that opened the file, with the same message a `claude-session` route sends. It runs `codex queue --thread <session id> --message <message>` directly (no shell) with a 10 second limit. An idle interactive Codex session takes the queued message as a new turn; a busy one takes it when its current turn ends. Codex 0.153.4 was checked.

How it finds the session: Codex gives the commands it runs `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, so `roughdraft open` run by Codex records that id. The title comes from `thread_name` in `session_index.jsonl` in Codex's home (`CODEX_HOME`, else `~/.codex`). Roughdraft stores only the id.

The executable is `codex` on the server's PATH; `ROUGHDRAFT_CODEX_BIN` in the server's environment names another one. The delivery fails, with the reason in the log, when the file's session has no id, when `codex` is not found, when `codex queue` exits non-zero (the end of its stderr is kept), or when it runs past the limit. `route test codex` uses the Codex session the command runs in, or `--session-id <id>`.

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

The URL receives a JSON POST (`Content-Type: application/json`) with a 10 second limit; any 2xx answer counts as sent. Each `--header "Name: value"` adds a request header (a header named `Content-Type` replaces the default). A name must be an HTTP token (letters, digits and a few symbols such as `-` and `_`, no spaces) and a value one line; anything else is refused when the route is added.

`--body` replaces the fixed body below with a template. In it, `{message}`, `{file}`, `{link}`, `{sessionId}`, `{event}` (`done` or `test`) and `{handoffId}` become JSON string literals, quotes included, so write them bare: `{"text": {message}, "mode": "now"}`, not `"{message}"`. A value that is missing (a test has no file, link or handoff) becomes `""`. Nothing else in the template changes. `route add` fills the template with sample values and refuses it (exit 2, `USAGE`) when the result is not JSON. A `route test` goes through the same template with the test values.

Without `--body` the route sends this fixed body:

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

## The three harnesses today

- **Claude Code (Mac and VPS)**: the built-in `claude-session` route. Nothing to add; `roughdraft route test claude-code` from inside a session confirms it.
- **Codex (Mac)**: the built-in `codex-queue` route. Nothing to add; `roughdraft route test codex` from inside a Codex session confirms it.
- **OpenClaw (Mike, on the VPS)**: a URL route to the gateway's wake hook with the hooks token and a body template (recipe below).

The session log still covers the cases a route cannot: a session that was closed before Done, or a Done nobody was registered for. Then Jordan says "done" in chat and the agent runs `roughdraft round`, which picks up the waiting Done.

## Recipes, one per tool

Each recipe is the command to run, the test, what a pass looks like and what to do when it fails. Run them on the machine where the harness runs, since the route runs there.

### Claude Code

Built in, nothing to add.

```bash
roughdraft route test claude-code
```

Pass: `Sent a test wake through the claude-code route in <n> ms.`, and a moment later the session gets a message that starts `Roughdraft wake route test for claude-code.`

When it fails: `No running Claude Code session has the id ...` or `has no Claude Code session id` means the command did not run inside a Claude Code session; run it from the session's own shell (the Bash tool) or pass `--session-id <id>`. `Could not reach Claude Code session ...` means the session's socket did not answer; restart the session and test again. If a replacement route was added by mistake, `roughdraft route remove claude-code` restores the built-in one.

### Codex

Built in, nothing to add.

```bash
roughdraft route test codex
```

Pass: `Sent a test wake through the codex route in <n> ms.`, and the Codex session takes a message that starts `Roughdraft wake route test for codex.` (at once when it is idle, after its turn when it is busy).

When it fails: `has no Codex session id` means the command did not run inside Codex; run it from a command Codex runs, or pass `--session-id <thread id>` (the id is in `~/.codex/session_index.jsonl`). `The codex command was not found` means the Roughdraft server cannot see `codex` on its PATH; restart the server from a shell that has it (`roughdraft restart`) or set `ROUGHDRAFT_CODEX_BIN` to its path before starting it. `codex queue exited with ...` carries Codex's own error; check that the id names a session in `~/.codex/session_index.jsonl`. `roughdraft route remove codex` restores the built-in route.

### OpenClaw on the VPS

The gateway's `/hooks/wake` takes `{"text": "...", "mode": "now", "agentId": "main"}` with `Authorization: Bearer <hooks token>` and queues the text for Mike's main session. The token is `hooks.token` in `/root/.openclaw/openclaw.json`. On the VPS:

```bash
roughdraft route add openclaw --url http://127.0.0.1:18789/hooks/wake --header 'Authorization: Bearer <hooks token>' --body '{"text": {message}, "mode": "now", "agentId": "main"}' --label "Mike"
roughdraft route test openclaw
```

Replace `<hooks token>` with the token itself. Pass: `Sent a test wake through the openclaw route in <n> ms.`, and Mike's main session receives `Roughdraft wake route test for openclaw.` `roughdraft route list` shows `openclaw (url http://127.0.0.1:18789/hooks/wake, headers Authorization, body template), verified ...` and never the token.

When it fails: `URL answered HTTP 401` (or 403) means the token is wrong; copy it again from `openclaw.json` and run the `route add` line again. `HTTP 503` means the gateway's queue is full; wait and test again. `fetch failed` with `ECONNREFUSED` means the gateway is not listening on 18789; check that OpenClaw is running. A Done carries the wake message only; the agent picks the file up from the session log with `roughdraft round`.

### Any other tool: a command route

When a tool has a command that delivers a message to a session, a command route is the template. For example, a tool `mytool` with `mytool send --session <id> <text>`:

```bash
roughdraft route add mytool --command 'mytool send --session {sessionId} {message}' --label "mytool"
roughdraft route test mytool --session-id <a running session's id>
```

Pass: `Sent a test wake through the mytool route in <n> ms.` and the session shows `Roughdraft wake route test for mytool.` The agent registers its session when it opens a file: `roughdraft open "/abs/path.md" --no-watch --harness mytool --session-id <id> --session-label "..."`.

When it fails: the error is the command's exit code and the end of its stderr. Run the same command by hand with the values filled in to see the problem, fix it, and run the `route add` line again (it replaces the route). The `scratch` example under Command routes shows what a route receives.

## HTTP routes behind the commands

The CLI and the MCP server call these on the running server (with `Authorization: Bearer <ROUGHDRAFT_TOKEN>` when the token is set). Changes to wake routes are refused (403) unless the request comes from this machine or carries the token, because a route runs commands.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/wake-routes` | | `{ routes: [{ harness, kind, command?, url?, headers?, body?, label, verifiedAt, verifiedBy, lastError }] }`, header values as `"<set>"` |
| `PUT /api/wake-routes/<harness>` | `{ kind: "command" \| "url" \| "claude-session" \| "codex-queue", command?, url?, headers?, body?, label? }`; `headers` is a list of `Name: value` lines or an object of names to values | `{ ok, route }` with header values as `"<set>"`; 400 `USAGE` on a bad body |
| `DELETE /api/wake-routes/<harness>` | | `{ ok, removed }` |
| `POST /api/wake-routes/<harness>/test` | `{ by? }` | `{ ok, sent, error, durationMs }`; 404 `WAKE_ROUTE_NOT_FOUND` |
| `POST /api/documents/session` | `{ projectPath, path, harness, label, link?, sessionId? }` | `{ ok, session }` with `routeId` when the harness has a route |
| `POST /api/review-events` | `{ projectPath, path, overallComment? }` (the Done) | `{ delivered, pending, event, handoff, wake, instanceId }` |
| `POST /api/review-events/ack` | `{ handoffId, by? }` | `{ ok, handoff }`; 404 `HANDOFF_NOT_FOUND` |
| `GET /api/documents` | | the session log and registry: every document with its tabs, watchers, session and handoffs |
