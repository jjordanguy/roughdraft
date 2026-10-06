/**
 * Delivering a message into a running Claude Code session.
 *
 * Every Claude Code process keeps a record under `<config dir>/sessions/`
 * (`<pid>.json`, the config dir is CLAUDE_CONFIG_DIR or ~/.claude) with the
 * path of the Unix socket it listens on for messages from other sessions, and
 * a `<pid>.<hash>.key` file with the token a sender has to present. The wire
 * format is newline-delimited JSON: an auth line, then a user message. Claude
 * Code prints that recipe itself when it starts the inbox. A message sent this
 * way lands in the session as a user turn: it starts a turn when the session
 * is idle and is read at the next tool round when it is busy.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface ClaudeSessionTarget {
  pid: number;
  /** The conversation id (`CLAUDE_CODE_SESSION_ID`). */
  sessionId: string;
  /** The desktop app's id for the session (`local_...`), when it has one. */
  hostSessionId: string | null;
  /** The session's title. */
  name: string | null;
  socketPath: string;
  token: string | null;
  updatedAt: number;
}

export interface ClaudeSessionOptions {
  /** Claude Code's config directory. Default: CLAUDE_CONFIG_DIR, else ~/.claude. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Replaced in tests. */
  isAlive?: (pid: number) => boolean;
}

export interface SendOptions {
  timeoutMs?: number;
}

export const SEND_TIMEOUT_MS = 5_000;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? fromEnv : path.join(os.homedir(), ".claude");
}

export function claudeSessionsDir(options: ClaudeSessionOptions = {}): string {
  return path.join(
    options.configDir ?? claudeConfigDir(options.env ?? process.env),
    "sessions",
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live Claude Code sessions on this machine, from their own records. */
export function listClaudeSessions(
  options: ClaudeSessionOptions = {},
): ClaudeSessionTarget[] {
  const dir = claudeSessionsDir(options);
  const alive = options.isAlive ?? processAlive;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: ClaudeSessionTarget[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const socketPath =
      typeof record.messagingSocketPath === "string"
        ? record.messagingSocketPath
        : "";
    const sessionId =
      typeof record.sessionId === "string" ? record.sessionId : "";
    if (!socketPath || !sessionId || !alive(pid)) continue;
    const keyFile = names.find(
      (file) => file.startsWith(`${pid}.`) && file.endsWith(".key"),
    );
    let token: string | null = null;
    if (keyFile) {
      try {
        const key = JSON.parse(
          fs.readFileSync(path.join(dir, keyFile), "utf8"),
        ) as { peerToken?: unknown };
        if (typeof key.peerToken === "string" && key.peerToken) {
          token = key.peerToken;
        }
      } catch {
        // A key file that cannot be read: send without auth and let the
        // session say no.
      }
    }
    sessions.push({
      pid,
      sessionId,
      hostSessionId:
        typeof record.hostSessionId === "string" ? record.hostSessionId : null,
      name: typeof record.name === "string" ? record.name : null,
      socketPath,
      token,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    });
  }
  return sessions;
}

/**
 * The live session with this id (the conversation id or the desktop app's
 * `local_...` id). A resumed conversation can have an old record next to the
 * live one; the most recently updated live process wins.
 */
export function findClaudeSession(
  sessionId: string,
  options: ClaudeSessionOptions = {},
): ClaudeSessionTarget | null {
  const id = sessionId.trim();
  if (!id) return null;
  return (
    listClaudeSessions(options)
      .filter(
        (session) => session.sessionId === id || session.hostSessionId === id,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  );
}

/**
 * The id of the Claude Code session a process runs under, from the environment
 * Claude Code gives its shell and MCP children: CLAUDE_CODE_SESSION_ID, else
 * the pid in CLAUDE_CODE_MESSAGING_SOCKET looked up in the session records.
 */
export function currentClaudeSessionId(
  env: NodeJS.ProcessEnv = process.env,
  options: ClaudeSessionOptions = {},
): string | null {
  const direct = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (direct) return direct;
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (!socket) return null;
  const pid = Number(
    /^(\d+)(?:-[0-9a-f]{8})?\.sock$/.exec(path.basename(socket))?.[1] ?? "",
  );
  if (!pid) return null;
  return (
    listClaudeSessions({ ...options, env }).find(
      (session) => session.pid === pid,
    )?.sessionId ?? null
  );
}

/** Posts `text` as a user turn into the session. Resolves once the session has closed the connection. */
export function sendToClaudeSession(
  target: Pick<ClaudeSessionTarget, "socketPath" | "token">,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: target.socketPath });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out after ${timeoutMs} ms sending to ${target.socketPath}`,
          ),
        ),
      timeoutMs,
    );
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => {
      const lines: string[] = [];
      if (target.token) {
        lines.push(JSON.stringify({ type: "auth", token: target.token }));
      }
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
        }),
      );
      socket.write(`${lines.join("\n")}\n`, () => {
        // Let the session read before the half-close, as Claude Code's own
        // sender does on macOS.
        setTimeout(() => socket.end(), 250);
      });
    });
    socket.on("close", () => finish());
  });
}

/**
 * Deliver `text` into the Claude Code session `sessionId`. Returns null when
 * it was delivered, else a sentence saying why not.
 */
export async function wakeClaudeSession(
  sessionId: string | null,
  text: string,
  options: ClaudeSessionOptions & SendOptions = {},
): Promise<string | null> {
  const id = sessionId?.trim() ?? "";
  if (!id) {
    return "The file's session has no Claude Code session id. Open the file from inside Claude Code (the CLI records the session itself) or pass --session-id.";
  }
  const target = findClaudeSession(id, options);
  if (!target) {
    return `No running Claude Code session has the id ${id} (looked in ${claudeSessionsDir(options)}).`;
  }
  try {
    await sendToClaudeSession(target, text, options);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not reach Claude Code session ${target.pid} (${target.name ?? id}) at ${target.socketPath}: ${message}`;
  }
}
