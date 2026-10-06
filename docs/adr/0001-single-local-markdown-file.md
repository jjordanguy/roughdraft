# 0001: Single Local Markdown File

## Context

Roughdraft's core workflow is opening one ordinary Markdown file from the local filesystem so a human and coding agents can review it together.

## Decision

Roughdraft treats a Markdown file path as the primary unit of work. The server resolves that file within local-file boundaries and the app edits the file directly.

## Consequences

The CLI and app should optimize for quick open, review, edit, save, and close flows. Features that require a project database, global index, or vault model need a separate decision.

## What This Explicitly Does Not Mean

This does not make Roughdraft a vault manager, note database, git client, desktop shell, or multi-document workspace.

## Clarification (2026-04-30): Remote Document Mode

The "single markdown file" unit of work is preserved when the file lives on a different machine than the Roughdraft server. Remote document mode (see `docs/plans/2026-04-30-001-feat-remote-document-mode-plan.md`) lets a CLI on a remote host register one markdown file with a hosted Roughdraft over HTTP/SSE; the server holds the bytes in memory for the duration of the session and never browses or indexes a remote filesystem. The user-facing invariant is the same: open one file, edit it, save it, close it.

The "local-file boundary" wording above should be read as the **resolved file boundary** — Roughdraft still resolves and operates on a single markdown file. Whether the bytes originate from local disk or from a CLI-owned session does not change the unit of work.

This clarification does not extend Roughdraft into a vault manager, note database, or multi-document workspace.

## Superseded (2026-10-06): Remote Document Mode Removed

Jordan's fork removed remote document mode (fork plan, ruling R1). A Roughdraft link is the address of the Roughdraft running on the machine where the file lives plus the file's path, and that is the only way to open a document. To review a file on a VPS, Roughdraft runs on the VPS and the browser opens its link. The 2026-04-30 clarification above is kept as history; nothing in the code registers a file from another machine any more.

## Clarification (2026-10-06): The Document Registry and the Session Log

The server keeps a registry of the single files that are open or were opened recently: per file, its open tabs (and whether a tab holds unsaved text or an unsettled conflict), the agents waiting for Done, the last version the server read or wrote, and the "AI editing" flag of a running round. The session log (`review-log.json`) adds, per file, the chat session that opened it and its Done handoffs. `roughdraft status`, `roughdraft log` and the `roughdraft_get_open_documents` MCP tool list these files.

This is lifecycle bookkeeping for the single-file unit of work, not a workspace. Each record is keyed by one file's real path and describes that file's review, never a group of files: there is no project, no folder browsing, no index of document contents, and no cross-file operation. A record that goes idle is dropped from the registry, and the log keeps only what delivery needs (sessions and handoffs, with fixed retention). Opening a second file is still a second, independent unit of work with its own link and window.
