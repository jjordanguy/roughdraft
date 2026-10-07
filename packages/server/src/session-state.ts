/**
 * Whether the chat session that opened a document is still running, for the
 * open documents list ("session ended"). Only harnesses whose live sessions
 * can be seen on this machine get an answer: Claude Code keeps a record per
 * running process (see claude-session.ts). Everything else is "unknown", and
 * so is a Claude Code session on a machine with no session records at all.
 */
import fs from "node:fs";
import {
  type ClaudeSessionOptions,
  claudeSessionsDir,
  listClaudeSessions,
} from "./claude-session.js";
import type { SessionRecord } from "./handoff-log.js";

export type SessionState = "live" | "ended" | "unknown";

export type SessionStateOf = (session: SessionRecord | null) => SessionState;

/**
 * Returns a factory: each call reads the live sessions once and answers for
 * any number of documents, so one list costs one directory read.
 */
export function sessionStateResolver(
  options: ClaudeSessionOptions = {},
): () => SessionStateOf {
  return () => {
    let live: Set<string> | null = null;
    return (session) => {
      const id = session?.sessionId?.trim();
      if (!session || !id || session.harness !== "claude-code") {
        return "unknown";
      }
      if (live === null) {
        if (!fs.existsSync(claudeSessionsDir(options))) return "unknown";
        live = new Set(
          listClaudeSessions(options).flatMap((target) =>
            target.hostSessionId
              ? [target.sessionId, target.hostSessionId]
              : [target.sessionId],
          ),
        );
      }
      return live.has(id) ? "live" : "ended";
    };
  };
}
