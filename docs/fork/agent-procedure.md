# Agent procedure for Roughdraft reviews

This is the proposed replacement for the Roughdraft paragraph in Jordan's `~/.claude/CLAUDE.md`, plus the optional guard hook for `~/.claude/settings.json`. Per D12 nothing here is applied to his files until he has read it. Markup examples sit in inline code and the file has no horizontal rule, so it is safe to open in Roughdraft.

The same paragraph reaches agents two other ways: `roughdraft mcp` sends it word for word as its MCP `instructions` (a test fails if the two drift apart), and the Claude Code skill in `packages/skill/SKILL.md` carries it with the command reference. Change it here first.

## What changes for the agent

Today the paragraph describes CriticMarkup and asks the agent to type replies into the file and check the count with `roughdraft doctor`. With batch 3b the agent never types review markup. It reads a round, edits a clean copy of the document with its normal Edit tool, writes plain-text replies into a small JSON file, and lands everything with one command that writes the whole round or nothing. Done reaches the agent through the session log and the harness wake route (D14), so the agent does not hold a live `roughdraft open` wait.

## Replacement paragraph

Paste this in place of the current "Roughdraft (markdown review app, all projects)" section:

> **Roughdraft (markdown review app, all projects).** "rd" means Roughdraft, Jordan's local Markdown review app, run as `roughdraft` (never create an alias or command named rd). At the start of a session that will hand Jordan a file, run `roughdraft route test claude-code` once; the test arrives in this session as a message a moment later, and if the command fails, say so. Hand him a file with `roughdraft open "/abs/path.md" --no-watch --session-label "<what this session is doing>"` (it records this session by itself). When his Done arrives as a message in this session, or when he says in chat that he is done, run `roughdraft round "/abs/path.md"`. If it reports `tabDirty` or `tabConflict`, ask him before going on. Read the round.json and clean.md it names. Make the prose changes he asked for in clean.md with the Edit tool, never in the reviewed file. Fill in response.json: a plain-text `reply` for every thread with `needsAnswer`, `resolve` where he signed off, `skip` with a reason for anything you leave, `decision` on a suggestion only when he asked for it, and `note` with a one-line summary of the round. Then run `roughdraft apply "<response.json>"`. Exit 1 means nothing was written: fix what it lists and run it again. If the report lists `newThreads` or `remaining`, run `roughdraft round` again. For a single answer outside a round use `roughdraft reply "/abs/path.md" <id> - <<'EOF'` (text on the next lines, then `EOF`), or `resolve`, `accept`, `reject` or `note`. Never type CriticMarkup, `{#id}` refs or review YAML, and never rewrite a reviewed file with Write. If a command says the file uses an older review format, tell Jordan and offer `roughdraft doctor --fix "/abs/path.md"` (after `--dry-run`); do not convert it without his yes. Reopen the file with the open command when the round is applied.

## Why each step is there

- `route test` at session start: the wake route is owned and tested by the agent (D14). Claude Code's route is built in: it posts the Done into the session that opened the file, over the socket every Claude Code session listens on for messages from other sessions, so the test message shows up in the session a moment after the command. A failing command means Done will land only in the session log, so Jordan should know to tell the agent in chat. `docs/fork/routes.md` has the details and the other route kinds.
- `open --no-watch`: the CLI reads the session id from the environment Claude Code gives its shell and registers the session (harness, id, and the session's title as the label unless `--session-label` is given), and Done fires that session's wake route. No live wait means no five-minute or seven-hour blocking call (assumption 1).
- `round` after Done or a chat "done": it acknowledges the waiting Done in the log, writes `round.json`, `clean.md`, `response.json` and `base.md` to `~/.roughdraft/rounds/<roundId>/`, reports the tab state and one line per thread, and shows "AI editing" in Jordan's tab until `apply` lands (stalled after 30 minutes).
- `clean.md` instead of the file: the clean copy has no markup, so the Edit tool cannot break a highlight. `apply` moves each highlight with the edit and reports what happened to it.
- `response.json`: replies are tied to a thread id, so a reply cannot land on the wrong thread or be duplicated across a two-paragraph comment. `note` is the round's global comment (D9). `decision` only on request (assumption 9).
- `apply`: all or nothing. It waits up to 10 seconds for an open tab to save (exit 4 if it never does), refuses with every problem listed (exit 1), and a retry of the same response answers `already-applied` (exit 0).
- One-thread commands: for a quick answer between rounds or from the other harness. Each prints the new `aN` id and the doctor breakdown.
- Older files: nothing converts a file on its own (D11).

## Optional guard hook

`roughdraft guard --claude-hook` is a Claude Code PreToolUse hook. For Edit, MultiEdit and Write on a `.md` file it denies:

- any of the three on a file with an open round, and names the round's `clean.md` and `response.json`;
- Write over a file that holds review data;
- an edit whose old or new text holds review markup outside code (fenced or inline), whose matched text overlaps a highlight, ref or suggestion marker, or that reaches into the review block at the end.

Everything else is allowed. An allow prints nothing, so Claude Code's own permission prompts still apply. Any error inside the guard (bad input, an unreadable index, a crash) also allows: it fails open (assumption 11). An open round stops counting for the guard after two hours, or when `apply` lands, or when a newer `round` replaces it. Bash writes (sed, scripts) are not covered; `apply` puts back anything of Jordan's they damage.

Settings entry for `~/.claude/settings.json` (merge into an existing `hooks` block if there is one):

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

## The other harness and the MCP tools

OpenClaw and scripts use the same commands. The MCP server (`roughdraft mcp`) offers the same steps as tools, for a session that has the tools but no shell:

- `roughdraft_wake_routes` with `action: "test"` at the start of the session; `roughdraft_register_session` after opening a file.
- `roughdraft_get_handoffs` when Jordan says in chat that he is done (it does not wait), then `roughdraft_ack_handoff` once the Done is handled. `roughdraft_start_round` acknowledges the Done itself.
- `roughdraft_start_round` returns the round and `cleanText`; `roughdraft_apply_round` takes the filled-in response object and the edited `cleanText`.
- `roughdraft_reply_to_comment`, `roughdraft_mark_resolved` and `roughdraft_add_document_comment` take an optional `expectedVersion` (the `fileVersion` the agent read).
- `roughdraft_watch_review_events` holds the turn until Done or its `timeoutSeconds`; a cancelled call stops the wait on the server too. Prefer the wake route and `roughdraft_get_handoffs`.

Every `documentPath` is absolute; a relative one is refused, because the MCP process does not share the session's working directory. Any failure, a refusal included, is an `isError` result whose text is the CLI's JSON envelope (`error.code`, `error.message`, `error.hint`, and for a refusal the same error list as the CLI). The tools never start a Roughdraft server; without one they answer `SERVER_UNREACHABLE` with the hint `roughdraft start`.
