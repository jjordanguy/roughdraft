# Roughdraft

Roughdraft is a way to open a local Markdown file with tools on top of it: tools to see the file, comment on it, edit it, and rewrite it in lockstep with the agent that is working on the same file.

This is Jordan's fork of [Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft), on the `jordan/main` branch. It keeps the `roughdraft` command, reads every document the upstream version wrote, and keeps the way comments are left. It runs on the machine where the file lives (a Mac, or a VPS reached over Tailscale) and never as a hosted service. There is no command named `rd`.

## Install

The fork is installed from a packed build, never from the npm registry. [docs/fork/install.md](docs/fork/install.md) has the steps, the check that runs the packed build before it replaces anything, and the rollback to 0.1.10.

## How a review works

1. An agent writes or edits a Markdown file and runs `roughdraft open "/abs/path.md"`. Roughdraft starts its background server if needed, prints the file's link and opens it.
2. You read the file, edit it, highlight text to comment on it, suggest changes, and use **Global comment** for a note about the whole document. Every change is saved to the file on disk; if the agent or another program changes the file while it is open, the tab picks the change up.
3. You click **Done Reviewing**. Roughdraft writes the Done to its session log and wakes the chat session that opened the file through that harness's wake route.
4. The agent answers in a round: `roughdraft round` gives it a clean copy of the document and one entry per thread, it edits the copy and writes plain-text replies, and `roughdraft apply` lands everything in one checked write. Your comments, highlights and suggestions stay where they were; the agent never types review markup.

A Roughdraft link is the address of the Roughdraft running where the file lives plus the file's path, for example `http://localhost:7373/?path=/Users/me/notes/plan.md`. Opening a link for a file that already has a window brings that window forward. On a VPS the link is its Tailscale address with the VPS path; see [Running Roughdraft on a VPS](#running-roughdraft-on-a-vps).

## Keeping your tab and the file in sync

Each window holds one WebSocket to the local server, so any number of windows works. The server's first message on every connect or reconnect is the current file version, with a heartbeat after that, and the tab re-checks the file when it becomes visible, regains focus or comes back online. Saves go one at a time, retry on failure, and are decided on the file's content, never on its timestamp. Every write goes to a temporary file first and is renamed into place, so a reader never sees a half-written file (`ROUGHDRAFT_WRITE_MODE=inplace` turns the rename off; `scripts/check-drive-rename.mjs` checks a cloud-synced folder first).

When the file changes on disk while you have unsaved text, the tab merges the two. Edits in different places both land, with a quiet "Updated from disk" notice. When you and the agent changed the same words, your version is kept as a suggested change against the agent's text, so nothing is lost and autosave keeps going; only an overlap inside a comment or a suggestion asks you to choose, for that one spot. What you type is kept in the browser's local storage until it reaches disk, and restored on the next load if a tab closed mid-edit. A louder notice appears when an outside write removed text you saved in the last few minutes, with one click to restore it.

While an agent has a round open on the document (from `roughdraft round` until `apply`, or for the second a quick command takes), the tab shows an **AI editing...** badge with the elapsed time; after 30 minutes without a write it reads **AI round stalled** and can be dismissed. The document stays editable throughout.

## For agents

[docs/fork/agent-procedure.md](docs/fork/agent-procedure.md) is the procedure an agent follows (the paragraph for `~/.claude/CLAUDE.md`, why each step is there, and the optional guard hook). The Claude Code skill in [packages/skill/SKILL.md](packages/skill/SKILL.md) carries the same procedure. In short:

```bash
roughdraft route test claude-code                      # once per session
roughdraft open "/abs/path.md" --no-watch --harness claude-code \
  --session-label "what this session is doing" --session-id <session id>
# ... Done wakes the session, or Jordan says "done" in chat ...
roughdraft round "/abs/path.md"                        # prints the round folder
# edit clean.md with the Edit tool, fill in response.json
roughdraft apply "<round folder>/response.json"
```

The session log (`review-log.json` in the state directory, `~/.roughdraft` by default) keeps every Done until an agent acknowledges it, so a Done nobody was waiting for is not lost: `roughdraft pending "/abs/path.md" --json --ack` returns it. Wake routes, one per harness, tell Roughdraft how to reach a chat session when you click Done; [docs/fork/routes.md](docs/fork/routes.md) covers the commands, the placeholders, the payload and the HTTP routes behind them.

`roughdraft guard --claude-hook` is an optional Claude Code PreToolUse hook that keeps the Edit, MultiEdit and Write tools off review markup and off a file with an open round.

## MCP server

`roughdraft mcp` is a stdio MCP server, one process per agent session. It speaks newline-delimited JSON-RPC (what Claude Code sends) and still accepts Content-Length framing from older clients, answers `ping`, honors `notifications/cancelled`, sends the agent procedure as its `instructions`, and exits when stdin ends or its parent process goes away. It never starts a Roughdraft server: tools that need one report `SERVER_UNREACHABLE` with the hint `roughdraft start`. Every `documentPath` must be absolute. A failed call comes back as an `isError` result whose text is the CLI's JSON error envelope (below); an unknown tool is a JSON-RPC `-32602` error.

Claude Code entry in `~/.claude.json` (see [docs/fork/install.md](docs/fork/install.md#the-mcp-entry-in-claudejson) for the switch from the old bridge script):

```json
"roughdraft": { "type": "stdio", "command": "roughdraft", "args": ["mcp"], "env": {} }
```

| Tool | What it does | Read-only |
| --- | --- | --- |
| `roughdraft_get_open_documents` | Documents in the session log with their link, open tabs, listening agents, session and handoffs; from disk when the server is down | yes |
| `roughdraft_get_review_index` | Every comment, reply and suggestion in a file, with scope, anchors, `lines`, `quote`, `continues`, resolution and lost anchors | yes |
| `roughdraft_get_pending_feedback` | The round list (threads with context and `needsAnswer`), `counts` and `fileVersion`, plus the older per-item list | yes |
| `roughdraft_validate_document` | The `roughdraft doctor <file>` result; `strict` fails on warnings | yes |
| `roughdraft_get_handoffs` | Dones no agent has acknowledged, for one file or all; non-blocking | yes |
| `roughdraft_watch_review_events` | Waits for Done on one file (`timeoutSeconds`, `afterSequence`, `includePending`, `ack`); cancellable | no |
| `roughdraft_ack_handoff` | Acknowledges Dones by handoff id | no |
| `roughdraft_register_session` | Records the harness and chat session that opened a file | no |
| `roughdraft_wake_routes` | Lists, adds, removes or tests a harness's wake route | no |
| `roughdraft_start_round` | Starts a round: the round list, `cleanText`, the tab state; writes the round folder, never the document | no |
| `roughdraft_apply_round` | Applies a filled-in response with the edited `cleanText` in one checked write (`dryRun`, `skipFailed`, `waitSeconds`) | no |
| `roughdraft_reply_to_comment` | One reply (`aN` id) in one checked write; optional `expectedVersion` | no |
| `roughdraft_mark_resolved` | Resolves one thread with an optional summary; optional `expectedVersion` | no |
| `roughdraft_add_document_comment` | The agent's round note as a document-level entry; optional `expectedVersion` | no |

## CLI reference

```text
roughdraft [flags] <command> [args]
roughdraft <path>                      same as open <path> when the argument is clearly a path
```

| Command | What it does |
| --- | --- |
| `open <path>` | Open one Markdown file and wait for Done Reviewing (`--no-watch` to return at once) |
| `start` | Start or reuse the background server |
| `status` | Server status and one line per open document with its link |
| `stop` | Stop the managed background server (`--all` also stops a detected unmanaged one) |
| `restart` | Stop the managed server and start this installed version |
| `watch <path>` | Wait for Done on one file; a waiting Done comes back at once |
| `pending [path]` | Dones no agent has acknowledged (`--ack`, `--all`) |
| `ack <id>...` | Acknowledge Dones by handoff id |
| `log` | The session log: each document, its session, wake route and latest Done |
| `route list` / `add` / `remove` / `test` | Wake routes per harness ([docs/fork/routes.md](docs/fork/routes.md)) |
| `mcp` | The stdio MCP server |
| `doctor [path]` | Check the setup, or validate one file (`--strict` fails on warnings) |
| `doctor --fix <file>` | Convert an older review format, after `--dry-run` (a backup goes to `<stateDir>/backups/`) |
| `feedback <file>` | Every review thread with its context; writes nothing |
| `round <file>` | Start a round: `round.json`, `clean.md`, `response.json`, `base.md` |
| `apply <response.json \| ->` | Land a round in one checked write |
| `reply <file> <id> <text \| ->` | Answer one thread (`-` reads the text from stdin) |
| `resolve <file> <id>` | Resolve one thread (`--summary`) |
| `accept <file> <sN>` / `reject <file> <sN>` | Settle one suggestion (`--drop-replies`) |
| `note <file> <text \| ->` | Add the agent's round note |
| `guard --claude-hook` | The Claude Code PreToolUse hook |
| `help [command]`, `help agent`, `help criticmarkup` | Help, the agent text, the format reference |
| `agent-setup`, `criticmarkup` | Older names for `help agent` and `help criticmarkup` |

Global flags: `-h, --help`, `--version`, `--json` (one JSON object on stdout), `--no-color`. Commands that find the server also take `--port <port>`, `--state-file <path>` and `--state-dir <dir>`.

Command flags:

```text
roughdraft open <path> [--no-open] [--no-watch] [--print-url] [--json] [--timeout <seconds>]
                       [--harness <name>] [--session-label <text>] [--session-link <url>] [--session-id <id>]
roughdraft watch <path> [--json] [--timeout <seconds>] [--reconnect <seconds>]
                        [--pending | --no-pending] [--after <sequence>] [--no-ack] [--replay] [--batch-window <seconds>]
roughdraft pending [<path>] [--ack] [--all] [--json]
roughdraft ack <handoffId>... [--json]
roughdraft log [--json]
roughdraft route add <harness> --command "<text>" | --url <url> [--label <text>]
roughdraft route test <harness>
roughdraft route remove <harness>
roughdraft doctor [<file>] [--strict] [--json]
roughdraft doctor --fix <file> [--dry-run] [--json]
roughdraft doctor --fix --dry-run [--report <out.md>] <files...> [--json]
roughdraft feedback <file> [--agent-labels AI,Mike] [--json]
roughdraft round <file> [--dir <dir>] [--agent-labels AI,Mike] [--no-ack] [--json]
roughdraft apply <response.json | -> [--dry-run] [--skip-failed] [--wait <seconds>] [--json]
roughdraft reply <file> <id> "<text>" | - [--author <name>] [--json]
roughdraft resolve <file> <id> [--summary "<text>"] [--author <name>] [--json]
roughdraft accept <file> <sN> [--drop-replies] [--json]
roughdraft reject <file> <sN> [--drop-replies] [--json]
roughdraft note <file> "<text>" | - [--author <name>] [--json]
roughdraft guard --claude-hook
```

`open` and `watch` return a Done that is already waiting (`--no-pending` waits for the next one only) and acknowledge what they return after printing it (`--no-ack` leaves it pending). A watcher that loses the server reconnects for `--reconnect` seconds (default 120) before it gives up. `apply --wait` sets how long it waits for a tab with unsaved text (default 10 seconds). `round --dir` writes the agent's round files elsewhere; `apply` finds the round from the response's folder or by its `roundId`.

Exit codes:

```text
0        Done received (status "completed"), the command succeeded (status "ok"),
         or a round or write applied (status "applied" or "already-applied")
1        INTERNAL (a bug); `doctor <file>` failed (or warned, with --strict); a review write
         refused with nothing written: REVIEW_REFUSED, LEGACY_FORMAT, NORMALIZE_REFUSED,
         VERSION_CONFLICT
2        Bad command or path: USAGE, PATH_NOT_FOUND, NOT_MARKDOWN, PATH_UNREADABLE,
         HANDOFF_NOT_FOUND, WAKE_ROUTE_NOT_FOUND, ROUND_NOT_FOUND
3        Server: SERVER_START_FAILED, SERVER_UNREACHABLE, SERVER_LOST, SERVER_VERSION_MISMATCH,
         SERVER_NOT_MANAGED, SERVER_STOP_FAILED, HTTP_ERROR, WAKE_ROUTE_FAILED
4        WATCH_TIMEOUT (the --timeout elapsed); TAB_DIRTY (the tab still had unsaved text
         or a conflict after apply --wait)
130/143  INTERRUPTED by SIGINT or SIGTERM
```

With `--json` every command prints exactly one JSON object on stdout, whatever the outcome:

```json
{ "ok": false, "status": "error", "exitCode": 3,
  "error": { "code": "SERVER_UNREACHABLE", "message": "...", "retryable": true, "hint": "..." } }
```

Successful output has `ok`, `status` and `exitCode` plus the command's own keys. `open` and `watch` also write one progress line to stderr in JSON mode. In human mode a failure prints `roughdraft: <message>` and `hint: <hint>` on stderr; stack traces appear only with `ROUGHDRAFT_DEBUG=1`. `apply --json` prints the apply report (`status` `applied`, `already-applied` or `refused`, then `rebase`, `restored`, `replies`, `resolved`, `accepted`, `rejected`, `droppedReplies`, `skipped`, `edits`, `anchors`, `note`, `remaining`, `doctor`, `errors`) with `written`, `writtenVia`, `document`, `version`, `skippedUnits` and `roundFlag`. A refusal carries the same report with `written: false` and `errors`, each `{ code, thread, message, hint }`.

Environment variables:

```text
ROUGHDRAFT_PORT            Preferred server port (PORT is read when this is unset)
ROUGHDRAFT_NO_OPEN=1       Never open a browser window
ROUGHDRAFT_STATE_DIR       Directory for server.json, review-log.json, wake-routes.json, rounds/, backups/
ROUGHDRAFT_STATE_FILE      Exact path of server.json (its folder is then the state directory)
ROUGHDRAFT_TOKEN           Bearer token sent on every request; required when the server binds
                           a non-loopback host
ROUGHDRAFT_BIND_HOST       Comma-separated hosts the server binds (default loopback)
ROUGHDRAFT_HARNESS, ROUGHDRAFT_SESSION_LABEL, ROUGHDRAFT_SESSION_LINK, ROUGHDRAFT_SESSION_ID
                           Defaults for open's session flags; nothing is registered without a harness
ROUGHDRAFT_DEBUG=1         Print stack traces on failure
```

## Running Roughdraft on a VPS

Install the fork on the VPS the same way ([docs/fork/install.md](docs/fork/install.md#on-the-vps)) and open its link from your browser. To listen beyond loopback, set `ROUGHDRAFT_BIND_HOST` (for example to the Tailscale interface) and `ROUGHDRAFT_TOKEN` to a strong secret; the server then requires `Authorization: Bearer <token>` on every `/api` request, and the CLI and the MCP server send it whenever `ROUGHDRAFT_TOKEN` is set.

## The file format

Review data lives in the Markdown file itself. The prose keeps only anchors (a highlight with an id, or a suggestion marker); every comment's text, author, time, replies and status sit in one YAML review block at the end of the file:

```markdown
The creator confirms {==the caption and the link placement==}{#c1} with ops.

---
comments:
  c1:
    body: "Split these checks by owner."
    by: user
    at: "2026-10-04T09:00:00.000Z"
  a1:
    body: "Done: split into creator and ops checks."
    by: AI
    at: "2026-10-04T10:00:00.000Z"
    re: c1
```

The full format, including comments on code blocks, comments over several paragraphs, global comments, suggestions, ids, line breaks and the older forms Roughdraft still reads, is in [docs/spec/roughdraft-flavored-markdown.md](docs/spec/roughdraft-flavored-markdown.md). Nothing converts an older file on its own: `roughdraft doctor --fix` does it after a dry run.

## Local development

```bash
./scripts/setup.sh     # install and build (also: pnpm setup)
./scripts/run.sh       # serve the built app (also: pnpm start)
```

`pnpm setup` installs a per-worktree CLI wrapper, `roughdraft-dev-<worktree name>`, into `~/.local/bin`; it points at that checkout and keeps its own state under `~/.roughdraft/dev/<wrapper name>`, so it never reuses a server started from another checkout. `pnpm dev:install-cli --name <name>` refreshes it.

```bash
pnpm lint:fix          # format and lint
pnpm check             # lint, selector check, unit tests, build (what CI runs first)
pnpm test:smoke        # browser smoke tests (CI runs these too)
pnpm test:pack         # install the packed build in a scratch folder and run it
pnpm unused            # knip: unused files, dependencies and exports
```

Decisions that shape the code are in [docs/adr/](docs/adr/).

## License

MIT. Roughdraft was created by [Nathan Baschez](https://twitter.com/nbashaw) at Lex.
