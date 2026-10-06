import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentClaudeSessionId,
  findClaudeSession,
  listClaudeSessions,
} from "./claude-session";

describe("Claude Code session records", () => {
  let configDir: string;
  let sessions: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-cc-records-"));
    sessions = path.join(configDir, "sessions");
    fs.mkdirSync(sessions);
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function record(pid: number, fields: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(sessions, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `s-${pid}`,
        messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
        ...fields,
      }),
    );
  }

  it("lists live sessions with their socket, token and title, skipping dead or broken records", () => {
    record(10, { name: "Plan", hostSessionId: "local_10", updatedAt: 7 });
    fs.writeFileSync(
      path.join(sessions, "10.abc.key"),
      JSON.stringify({ peerToken: "tok-10" }),
    );
    record(11, {}); // dead
    record(12, { messagingSocketPath: "" }); // no inbox
    fs.writeFileSync(path.join(sessions, "13.json"), "{ not json");
    fs.writeFileSync(path.join(sessions, "notes.txt"), "ignored");

    const alive = (pid: number) => pid !== 11;
    expect(listClaudeSessions({ configDir, isAlive: alive })).toEqual([
      {
        pid: 10,
        sessionId: "s-10",
        hostSessionId: "local_10",
        name: "Plan",
        socketPath: "/tmp/cc-socks/10.sock",
        token: "tok-10",
        updatedAt: 7,
      },
    ]);
  });

  it("finds a session by either id and prefers the most recent live record", () => {
    record(20, { sessionId: "same", updatedAt: 1 });
    record(21, { sessionId: "same", updatedAt: 9, hostSessionId: "local_21" });
    const options = { configDir, isAlive: () => true };
    expect(findClaudeSession("same", options)?.pid).toBe(21);
    expect(findClaudeSession("local_21", options)?.pid).toBe(21);
    expect(findClaudeSession("nope", options)).toBeNull();
    expect(findClaudeSession("  ", options)).toBeNull();
    expect(
      listClaudeSessions({ configDir: path.join(configDir, "missing") }),
    ).toEqual([]);
  });

  it("reads the current session from the environment Claude Code sets", () => {
    record(30, { sessionId: "from-record" });
    const options = { configDir, isAlive: () => true };
    expect(
      currentClaudeSessionId({ CLAUDE_CODE_SESSION_ID: " direct " }, options),
    ).toBe("direct");
    expect(
      currentClaudeSessionId(
        { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/30.sock" },
        options,
      ),
    ).toBe("from-record");
    expect(
      currentClaudeSessionId(
        { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/30-0a1b2c3d.sock" },
        options,
      ),
    ).toBe("from-record");
    expect(
      currentClaudeSessionId(
        { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/99.sock" },
        options,
      ),
    ).toBeNull();
    expect(currentClaudeSessionId({}, options)).toBeNull();
  });
});
