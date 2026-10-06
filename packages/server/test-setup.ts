// Tests must never reach a real Claude Code session: the shell they run in
// (a Claude Code session's Bash tool) names one in its environment, and the
// claude-session wake route would deliver a test Done into it. Point the
// session lookup at an empty directory and drop the session variables.
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
