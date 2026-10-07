// Tests must never reach a real Claude Code or Codex session: the shell they
// run in (a Claude Code session's Bash tool, or a Codex session's command)
// names one in its environment, and the claude-session and codex-queue wake
// routes would deliver a test Done into it. Point the Claude Code session
// lookup and the Codex home at empty directories, drop the session
// variables, and point the codex executable at a path that does not exist,
// so a test that forgets its stub fails instead of queueing for real.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const emptyConfigDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "roughdraft-test-claude-"),
);
process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;

process.env.CODEX_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "roughdraft-test-codex-"),
);
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_SESSION_ID;
process.env.ROUGHDRAFT_CODEX_BIN = path.join(
  process.env.CODEX_HOME,
  "no-codex-in-tests",
);

// The open documents page links the other Roughdraft when this is set.
delete process.env.ROUGHDRAFT_PEER_URL;
