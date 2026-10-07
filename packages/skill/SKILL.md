---
name: roughdraft
description: Hand Jordan a Markdown file to review in Roughdraft and answer his comments when he clicks Done. Use when he says "rd", "Roughdraft", "open it for review", "I left comments" or "done reviewing", when a plan or draft is ready for him to read, or when a command or MCP tool reports a Roughdraft round, handoff or wake route.
---

# Roughdraft

Roughdraft opens a local Markdown file with tools on top of it, so Jordan can read it, edit it and comment on it while you work on the same file. The command is `roughdraft`. "rd" in his messages means Roughdraft; never create an alias, script, symlink or command named `rd`.

## Rules that do not change

- Never type review markup: no CriticMarkup (`{==`, `{>>`, `{++`, `{--`, `{~~`), no `{#id}` refs, no review YAML at the end of the file. The commands below write all of it and check it.
- Never rewrite a reviewed file with Write, and never edit one with the Edit tool during a round. Prose changes go into the round's `clean.md`.
- Use absolute paths for every file you pass.
- An older-format file: tell Jordan and offer `roughdraft doctor --fix "/abs/path.md"` after `--dry-run`. Do not convert it without his yes.

## Procedure

1. At the start of a session that will hand Jordan a file, run `roughdraft route test claude-code` once (`roughdraft route test codex` when you are Codex). Both routes are built in, nothing to add. The test arrives in this session as a message a moment later. If the command fails, say so: his Done will then reach you only through the session log, so he should tell you in chat when he is done.
2. Hand him the file:

   ```bash
   roughdraft open "/abs/path.md" --no-watch --session-label "<what this session is doing>"
   ```

   It prints the link, opens the window and records this session by itself. Do not hold a live wait.
3. When his Done arrives as a message in this session, or he says in chat that he is done, run `roughdraft round "/abs/path.md"`. It acknowledges the Done and prints the round folder with `round.json`, `clean.md` and `response.json`. If it reports `tabDirty` or `tabConflict`, ask him before going on.
4. Read `round.json` (one entry per thread, with the highlighted text, the section and the paragraphs around it) and `clean.md` (the document with no markup).
5. Make the prose changes he asked for in `clean.md` with the Edit tool.
6. Fill in `response.json`: a plain-text `reply` for every thread with `needsAnswer`, `resolve` where he signed off, `skip` with a reason for anything you leave, `decision` on a suggestion only when he asked for it, and `note` with a one-line summary of the round.
7. Run `roughdraft apply "<round folder>/response.json"`. Exit 1 means nothing was written: fix what it lists and run it again. If the report lists `newThreads` or `remaining`, run `roughdraft round` again.
8. Reopen the file with the open command from step 2.

For a single answer outside a round:

```bash
roughdraft reply "/abs/path.md" c1 - <<'EOF'
The text of the reply, with $dollars and `backticks` kept as typed.
EOF
roughdraft resolve "/abs/path.md" c2 --summary "Named the approver."
roughdraft accept "/abs/path.md" s1          # or reject; only when he asked
roughdraft note "/abs/path.md" "Round 2: merged the timeline paragraphs."
```

Each prints the new entry's id and the doctor breakdown.

## Commands

| Command | Use |
| --- | --- |
| `roughdraft open <file> --no-watch --session-label "..."` | Hand a file over and record this session |
| `roughdraft round <file>` | Start a round after Done |
| `roughdraft apply <response.json>` | Land the round in one checked write (`--dry-run` to check first) |
| `roughdraft reply`, `resolve`, `accept`, `reject`, `note` | One answer outside a round |
| `roughdraft feedback <file> --json` | Read every thread without starting a round |
| `roughdraft pending <file> --json --ack` | Dones waiting in the session log, acknowledged as listed |
| `roughdraft status`, `roughdraft log` | Open documents and their links; sessions, wake routes and latest Dones |
| `roughdraft route list`, `route add <harness> --command "..."`, `--url <url> [--header "Name: value"] [--body '<template>']`, `--claude-session` or `--codex-queue`, `route test <harness>` | Wake routes (claude-code and codex are built in) |
| `roughdraft doctor <file> --strict` | Validate a file before handing it back |
| `roughdraft doctor --fix <file> --dry-run`, then without `--dry-run` | Convert an older-format file, only with Jordan's yes |
| `roughdraft help`, `roughdraft help <command>` | Flags and exit codes |

With `--json` every command prints one JSON object. Exit codes: 0 done, 1 refused with nothing written (or a bug), 2 wrong command or path, 3 server problem (`roughdraft start` fixes a stopped server), 4 timeout or a tab that kept unsaved text, 130 or 143 stopped by a signal. On failure, read `error.code`, `error.message` and `error.hint`.

## MCP tools

When the `roughdraft` MCP server is connected, the same steps are tools: `roughdraft_wake_routes` (`action: "test"`), `roughdraft_register_session`, `roughdraft_get_handoffs` when he says he is done, `roughdraft_start_round` (returns `cleanText`), `roughdraft_apply_round` (the response plus your edited `cleanText`), `roughdraft_reply_to_comment`, `roughdraft_mark_resolved` and `roughdraft_add_document_comment` (with the `expectedVersion` you read), `roughdraft_get_pending_feedback`, `roughdraft_validate_document`. Paths are absolute. A failure is an `isError` result holding the same JSON envelope as the CLI. `roughdraft_watch_review_events` holds your turn until Done; prefer the wake route and `roughdraft_get_handoffs`.

## Guard hook

`roughdraft guard --claude-hook` is an optional PreToolUse hook. It denies Edit, MultiEdit and Write on a file with an open round (naming its `clean.md`), Write over a file with review data, and edits that touch review markup outside code. It prints nothing for everything else and fails open. The settings entry, merged into the `hooks` block of `~/.claude/settings.json` only when Jordan agrees:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [{ "type": "command", "command": "roughdraft guard --claude-hook" }]
      }
    ]
  }
}
```

If the guard denies an edit, do what its message says (usually: edit the round's `clean.md`, or use `roughdraft reply`); do not work around it with Bash.
