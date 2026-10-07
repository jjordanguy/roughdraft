# Installing the fork

This fork is installed from a packed build, never from the npm registry. The command name stays `roughdraft`. These steps work the same on a Mac and on a Linux VPS. Nothing here creates a command named `rd`.

## Before the first install: keep the current version

```bash
mkdir -p ~/.roughdraft/releases
cp -a "$(npm root -g)/roughdraft" ~/.roughdraft/releases/roughdraft-0.1.10-installed
```

A fresh install of upstream 0.1.10 from the registry does not start under current npm (a package it needs is not installed with it), so this copy is the rollback.

## Build, prove, install

From the fork checkout:

```bash
pnpm install --frozen-lockfile && pnpm check
pnpm test:pack
npm pack --pack-destination ~/.roughdraft/releases
```

`pnpm test:pack` installs the tarball into a temporary folder and runs the installed command before anything touches the real install. Then:

```bash
roughdraft stop
npm i -g ~/.roughdraft/releases/roughdraft-<version>.tgz
roughdraft --version
roughdraft restart
```

`roughdraft stop` uses the old command to stop the old server. `roughdraft restart` after the install starts the new version; if a server of another version is still running, every command refuses to reuse it and says to run `roughdraft restart`.

Close Roughdraft windows that were open on the old server and open the documents again with their links; the links do not change.

## On the VPS

Copy the tarball to the VPS (for example with `scp`), then run the same stop, install, restart sequence there. The Tailscale link keeps its address; only the server behind it changes.

## Roll back

```bash
roughdraft stop
npm rm -g roughdraft
cp -a ~/.roughdraft/releases/roughdraft-0.1.10-installed "$(npm root -g)/roughdraft"
ln -sf ../lib/node_modules/roughdraft/packages/server/bin/roughdraft.mjs "$(npm bin -g 2>/dev/null || dirname "$(which roughdraft)")/roughdraft"
roughdraft --version
roughdraft start
```

Without the saved copy: `npm i -g roughdraft@0.1.10 yaml@2` (the extra package is what the registry build is missing).

If `~/.claude.json` already points at `roughdraft mcp` directly (see below), put the bridge entry back before rolling back: 0.1.10 only understands Content-Length framing, which Claude Code does not send.

## Checking what is running

```bash
roughdraft status --json
```

`serverVersion`, `cliVersion` and `versionMatches` say whether the server and the command agree.

## The guard hook (optional, after batch 3b)

Once the batch 3b build is installed and Jordan has read `docs/fork/agent-procedure.md`, the Claude Code guard can be added to `~/.claude/settings.json` (merge into an existing `hooks` block):

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

It denies Edit, MultiEdit and Write on a file with an open review round (naming the round's `clean.md`), Write over a file with review data, and edits that touch review markup outside code. It prints nothing and exits 0 for everything else and on any error of its own, so it never blocks unrelated work. To check it after installing:

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"/abs/path/reviewed.md","content":"x"}}' | roughdraft guard --claude-hook
```

A reviewed file prints a `permissionDecision` of `deny`; any other file prints nothing. Removing the entry from `settings.json` turns it off. Remove it before rolling back: 0.1.10 has no guard command, and Claude Code treats a hook that exits 2 as a block.

## The MCP entry in `~/.claude.json`

Claude Code reaches the Roughdraft tools through `~/.claude/roughdraft-mcp-bridge.mjs`, a small script that translated Claude Code's newline-delimited messages into the Content-Length framing 0.1.10 needed. From batch 6 on, `roughdraft mcp` speaks Claude Code's framing itself (and still accepts Content-Length, so the bridge keeps working), answers `ping`, survives a bad message, stops a cancelled wait, and exits with its session. The bridge can retire.

The change is one entry in `~/.claude.json`, made only when Jordan says so, after the batch 6 build is installed. Before:

```json
"roughdraft": { "type": "stdio", "command": "node", "args": ["/Users/jordanlam/.claude/roughdraft-mcp-bridge.mjs"], "env": {} }
```

After:

```json
"roughdraft": { "type": "stdio", "command": "roughdraft", "args": ["mcp"], "env": {} }
```

Keep `roughdraft-mcp-bridge.mjs` where it is: putting the old entry back is the rollback. If a session reports that the command was not found, use the absolute path from `which roughdraft` as `command`.

Running sessions keep the process they started with; the new entry applies to sessions started afterwards. To check it, start a new Claude Code session, run `/mcp` and confirm `roughdraft` is connected with 14 tools, then ask the agent to call `roughdraft_get_open_documents`. A second check that nothing doubled: `ps -o pid,ppid,command -ax | grep "roughdraft mcp"` shows one `roughdraft mcp` per session and no `roughdraft-mcp-bridge.mjs` for new sessions.
