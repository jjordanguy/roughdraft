# Roughdraft
A local-first markdown editor and viewer for working with AI.

{==Open one markdown file on your machine. Review it, comment on it, and suggest edits.==}{>>What does this mean?<<}{id="c3" by="user" at="2026-04-30T20:18:51.163Z"}{>>It means Roughdraft works with a normal local Markdown file: you open one .md file from your computer, read it in the app, leave inline comments, and propose edits that are saved back into the Markdown using CriticMarkup.<<}{id="c4" by="AI" at="2026-04-30T20:19:39.000Z" re="c3"}{>>cjool<<}{id="c5" by="user" at="2026-05-07T20:38:25.621Z" re="c4"}

Paste this into your coding agent:

```text
Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Or install and open a file yourself:

```bash
npm i -g roughdraft
roughdraft open /absolute/path/to/file.md
```
## What is this?
Roughdraft is a local-first markdown editor and viewer that runs on your computer.

Its job is to make markdown files easy to open, read, edit, review, and discuss with your AI agent without moving them into a proprietary format or a hosted app.

Roughdraft opens a single markdown file directly for CriticMarkup comments and suggested changes.
## How it works
- **Local-first markdown editor** — Open normal `.md` files from your machine and edit them directly
  
- **Works with your AI agent** — Tell your local agent to open a file in Roughdraft on your computer, then keep collaborating from there
  
- **Comments & suggested changes** — Use CriticMarkup for inline feedback, revisions, and review conversations
  
- **Markdown files on disk** — Everything stays as regular markdown files you can also edit in VS Code, Vim, Cursor, or anywhere else
  
- **No cloud, no account, no telemetry** — Runs entirely on your machine
  
## Quick start
Install Roughdraft and start the local server:

```bash
npm i -g roughdraft
roughdraft start
```

`roughdraft start` runs Roughdraft in the background, reuses or chooses a free localhost port, writes server state to `~/.roughdraft/server.json`, prints the active URL, and exits while the server keeps running.

Open a specific markdown file:

```bash
roughdraft open ./path/to/my-essay/draft.md
```

For scripts and agents that need a URL without launching a browser:

```bash
roughdraft open ./path/to/my-essay/draft.md --print-url
roughdraft status --json
```

Check or stop the background server:

```bash
roughdraft status
roughdraft stop
```

`roughdraft open` will reuse the running server and auto-start it if needed. You can also use `roughdraft ./path/to/file.md` as a shortcut when the input clearly looks like a path.

Roughdraft does not edit `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files. The setup prompt asks your agent to update its own guidance.

If the local server is already running, you can also open a file directly by URL:

```text
http://localhost:7373/?path=/absolute/path/to/my-essay/draft.md
```

That makes an agent-friendly workflow possible:

1. Your AI writes or updates markdown files on disk.
  
2. You tell it to open a markdown file in Roughdraft.
  
3. Roughdraft opens locally on your machine.
  
4. You read, edit, leave comments, and suggest changes.
  
5. You click **Done Reviewing** in Roughdraft, and the AI can respond to your comments or revise the document.
  

Agents can watch that handoff directly:

```bash
roughdraft open ./path/to/my-essay/draft.md --json
```

`roughdraft open` starts or reuses the local server, arms a watcher, opens the document, blocks until you click **Done Reviewing**, then prints one JSON object with the document path, file version, feedback counts, the handoff record, and any optional `overallComment` you submit at handoff. There is no watch timeout unless you pass `--timeout <seconds>`; the watcher keeps its connection alive past HTTP client limits and reconnects on its own when the server restarts. Use `--no-watch` when you only want to open the document and return immediately.

Every Done is written to the session log (`review-log.json` next to `server.json`) before anything else happens, so a Done that no agent was waiting for is kept. `roughdraft watch <file>` returns it at once, `roughdraft pending <file> --json --ack` lists and acknowledges it without waiting, and `roughdraft log` shows each document with the session that opened it, its wake route, and its latest Done. Overall comments are written to Markdown as document-level YAML endmatter comments before the handoff is recorded, so Markdown remains the durable source of truth.

An agent can register the chat session that opened a file (`roughdraft open <file> --harness claude-code --session-label "..." --session-id <id>`) and a wake route for its harness (`roughdraft route add <harness> --command "<text>"` or `--url <url>`, then `roughdraft route test <harness>`). Done then also fires that route with the file path, the link, and your comment counts.

Experimental MCP clients can start the stdio server with:

```bash
roughdraft mcp
```

The MCP server exposes tools to read the review index, list pending feedback, watch review events, list open documents and handoffs, acknowledge handoffs, register a session, manage wake routes, append replies, and mark items resolved. CriticMarkup in the Markdown file remains the durable source of truth.

### Running Roughdraft on another machine

A Roughdraft link is the address of the Roughdraft running where the file lives, plus the file's path. To review files on a VPS, install and run Roughdraft on the VPS and open its link (for example its Tailscale address) in your browser. To listen beyond loopback, set `ROUGHDRAFT_BIND_HOST` (for example to the Tailscale interface) and `ROUGHDRAFT_TOKEN` to a strong secret; the server then requires `Authorization: Bearer <token>` on every `/api` request, and the CLI and MCP send it whenever `ROUGHDRAFT_TOKEN` is set. The old remote mode (`ROUGHDRAFT_HOST`, which copied a file up to another server) is gone.
## Local development
```bash
./scripts/setup.sh
./scripts/run.sh
```

`./scripts/setup.sh` installs workspace dependencies and builds the app and server. `./scripts/run.sh` serves the built app at `http://localhost:7373`.

The two scripts coordinate through a lock file, so it's safe to start `./scripts/run.sh` while `./scripts/setup.sh` is still in progress. `run` will wait for setup to finish, or trigger setup itself if nothing has been built yet.

If you prefer package scripts, the same commands are available as `pnpm setup` and `pnpm start`.

Running `pnpm setup` also installs a per-worktree dev CLI wrapper into `~/.local/bin` by default, using the current worktree directory name. For example, this checkout might install `roughdraft-dev-lyon-v2`, which points at this worktree's local code while leaving the published global `roughdraft` command untouched.

Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening a file from one worktree will not accidentally reuse a backend started from another worktree. `roughdraft-dev-<worktree> open ...` can start its own background server as needed; you do not need to run `pnpm dev` first just to open files in Roughdraft.

You can refresh that wrapper manually with:

```bash
pnpm dev:install-cli
pnpm dev:install-cli --name api-redesign
```

Quality checks:

```bash
pnpm lint
pnpm test
pnpm check
```

`pnpm check` is the same command the pull request workflow runs before merge.
## Publishing
Roughdraft publishes from `main` when the root `package.json` version is newer than the current npm `latest` version.

Release flow:

1. Bump the root `package.json` version in a pull request.
  
2. Merge the pull request to `main`.
  
3. The `Publish to npm` GitHub Actions workflow runs `pnpm check`, publishes the package if that exact version is not already on npm and is newer than `latest`, then creates a `v<version>` git tag.
  

The workflow uses npm trusted publishing, so npm must be configured with this trusted publisher:

```text
Owner: Lex-Inc
Repository: roughdraft
Workflow filename: publish.yml
```

No `NPM_TOKEN` secret is required.
## Files on disk
```
my-essay/
  draft-1.md            # A normal markdown file on disk
  draft-2.md            # Another file you can open separately
```

Roughdraft reads and writes the markdown file directly.
## Agent setup
If you want your local agent to remember the Roughdraft workflow, ask it to read the live setup prompt:

```text
Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Use `roughdraft help`, `roughdraft help agent`, or `roughdraft help criticmarkup` if you need a local refresher.
## CLI reference
```text
roughdraft [flags] <command> [args]
roughdraft <path>
```

Commands:

```text
open <path>        Open one Markdown file and wait for Done Reviewing
start              Start or reuse the background server
status             Show server status and one line per open document
stop               Stop the managed background server
restart            Stop the managed server and start this version
watch <path>       Wait for a Done Reviewing event
pending [path]     List Dones no agent has acknowledged yet
ack <id>...        Acknowledge Dones by handoff id
log                Show the session log
route <action>     list | add <harness> | remove <harness> | test <harness>
mcp                Start the experimental stdio MCP server
doctor [path]      Diagnose setup or validate Markdown
help agent         Print the agent setup prompt
help criticmarkup  Show CriticMarkup examples
agent-setup        Print the agent setup prompt
criticmarkup       Show CriticMarkup examples
```

Global flags:

```text
-h, --help         Show help
--version          Print version
--json             Print JSON for supported commands
--no-color         Disable color
```

Useful command flags:

```text
roughdraft open <path> --no-open
roughdraft open <path> --print-url
roughdraft open <path> --json
roughdraft open <path> --no-watch
roughdraft open <path> --harness <name> --session-label <text> --session-link <url> --session-id <id>
roughdraft start --port <port>
roughdraft status --json
roughdraft stop --all
roughdraft watch ./draft.md --json
roughdraft watch ./draft.md --timeout <seconds> --reconnect <seconds>
roughdraft watch ./draft.md --no-pending | --after <sequence> | --no-ack
roughdraft pending [./draft.md] [--ack] [--all] --json
roughdraft ack <handoffId>... --json
roughdraft log --json
roughdraft route add <harness> --command "<text>" | --url <url> [--label <text>]
roughdraft route test <harness>
roughdraft doctor --json
roughdraft doctor ./draft.md
roughdraft doctor ./draft.md --json
```

`open` and `watch` return a Done that is already waiting (`--no-pending` waits for the next one only), and acknowledge what they return after printing it (`--no-ack` leaves it pending). `--after <sequence>` sets the cursor. A watcher that loses the server reconnects for `--reconnect` seconds (default 120) before it gives up.

Exit codes:

```text
0        Done received (status "completed"), or the command succeeded (status "ok")
1        Unexpected error (code INTERNAL); also `doctor <file>` when the file fails validation
2        Bad command or path: USAGE, PATH_NOT_FOUND, NOT_MARKDOWN, PATH_UNREADABLE,
         HANDOFF_NOT_FOUND, WAKE_ROUTE_NOT_FOUND
3        Server problem: SERVER_START_FAILED, SERVER_UNREACHABLE, SERVER_LOST,
         SERVER_VERSION_MISMATCH, SERVER_NOT_MANAGED, SERVER_STOP_FAILED, HTTP_ERROR,
         WAKE_ROUTE_FAILED
4        WATCH_TIMEOUT: the --timeout elapsed
130/143  INTERRUPTED by SIGINT or SIGTERM
```

With `--json`, every command prints exactly one JSON object on stdout, whatever the outcome: `{ "ok", "status", "exitCode", "path"?, ...command keys, "error"?: { "code", "message", "retryable", "hint"?, "cause"? } }`. `open` and `watch` also write one progress line to stderr in JSON mode. In human mode failures print `roughdraft: <message>` and `hint: <hint>` on stderr; stack traces appear only with `ROUGHDRAFT_DEBUG=1`. `roughdraft status --json` returns exit code `0` even when the JSON says `"running": false` (it then reads `pendingHandoffs` from the log on disk); human `roughdraft status` exits `1` when the server is not running.

Supported environment variables:

```text
ROUGHDRAFT_PORT
  Preferred server port.

PORT
  Legacy preferred server port. Used only when ROUGHDRAFT_PORT is unset.

ROUGHDRAFT_NO_OPEN=1
  Disable browser/app opening.

ROUGHDRAFT_STATE_FILE
  Exact path to the server state JSON file.

ROUGHDRAFT_STATE_DIR
  Directory containing server.json, review-log.json and wake-routes.json.

ROUGHDRAFT_TOKEN
  Bearer token sent on every request. Required when the server binds a
  non-loopback host.

ROUGHDRAFT_BIND_HOST
  Comma-separated hosts the server binds (default: loopback). Needs
  ROUGHDRAFT_TOKEN for anything else.

ROUGHDRAFT_HARNESS, ROUGHDRAFT_SESSION_LABEL, ROUGHDRAFT_SESSION_LINK, ROUGHDRAFT_SESSION_ID
  Defaults for open's --harness, --session-label, --session-link and
  --session-id. No session is registered without a harness.

ROUGHDRAFT_DEBUG=1
  Print stack traces on failure.
```

Development-only environment variables:

```text
ROUGHDRAFT_DEV_FRONTEND_STATE_FILE
ROUGHDRAFT_DEV_BIN_DIR
ROUGHDRAFT_DEV_STATE_BASE_DIR
ROUGHDRAFT_DEV_WRAPPER_NAME
ROUGHDRAFT_DEV_WRAPPER_PATH
ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT
```
## Roughdraft-flavored CriticMarkup
Roughdraft uses [CriticMarkup](https://criticmarkup.com) as the readable review layer inside normal Markdown files. It supports the standard markers for comments, highlights, insertions, deletions, and substitutions:

The canonical Roughdraft Flavored Markdown spec is published at [roughdraft.md/spec/roughdraft-flavored-markdown.md](https://roughdraft.md/spec/roughdraft-flavored-markdown.md). The review-index JSON Schema is published at [roughdraft.md/spec/roughdraft-flavored-markdown.schema.json](https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json).

```markdown
This is {--deleted--} text.
This is {++inserted++} text.
This is {~~old~>new~~} substituted text.
This is {>>a comment<<} in the margin.
This is {==highlighted==} text.
```

Roughdraft extends those markers with compact id references so review state can round-trip through the file. Root comments and suggestions keep an inline anchor such as `{#c1}` or `{#s1}`, while metadata lives in final YAML endmatter:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z"
```

Supported attributes:

- `id` is the compact inline reference after the comment or suggested change.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
- `re` links a reply to another comment or suggestion id.
  

Replies are stored in endmatter with a `body` and `re` pointer:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z" c2: body: I can add one from the intro. by: AI at: "2026-04-28T12:05:00.000Z" re: c1
```

Suggested changes can also carry ids and discussion:

```markdown
Add {++one concrete example++}{#s1}.
Remove {--vague phrasing--}{#s2}.
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
  s2:
    by: user
    at: "2026-04-28T12:13:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:14:00.000Z"
```

Older inline metadata such as `{id="c1" by="user" at="..."}` and legacy `{@id:c1; by:user; at:...@}` blocks are still accepted for compatibility.

CriticMarkup inside inline code and fenced code blocks is treated as literal example text, not live review feedback:

````markdown
Inline code stays literal: `{==not a comment==}`.

```text
{++not a suggestion++}
```
````

This matters because the main workflow is often:

- The AI writes a doc
  
- The user opens it in Roughdraft
  
- The user leaves comments and suggested changes
  
- The AI reads those comments and responds in the same markdown file
  
## Try the demo
Don't want to install anything? Try the [live demo](https://roughdraft.md) — it runs entirely in your browser using local storage.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
