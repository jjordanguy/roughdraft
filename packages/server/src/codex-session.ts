/**
 * Delivering a message into a running Codex session.
 *
 * Codex (0.153.4 checked) gives the commands it runs `CODEX_THREAD_ID` and
 * `CODEX_SESSION_ID`, and `codex queue --thread <id> --message <text>` queues
 * a message for that session: an idle interactive session takes it as a new
 * turn, a busy one after its current turn. The session's title is the
 * `thread_name` of its entry in `<codex home>/session_index.jsonl` (the codex
 * home is CODEX_HOME, else ~/.codex), one JSON object per line.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_QUEUE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 500;

export interface CodexTitleOptions {
  /** Codex's home directory. Default: CODEX_HOME, else ~/.codex. */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexWakeOptions {
  /** The codex executable. Default: ROUGHDRAFT_CODEX_BIN, else `codex` on PATH. */
  codexBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** The Codex session a process runs under, from the environment Codex gives the commands it runs. */
export function currentCodexSessionId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const id = env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim();
  return id ? id : null;
}

function codexHome(options: CodexTitleOptions): string {
  if (options.codexHome) return options.codexHome;
  const fromEnv = (options.env ?? process.env).CODEX_HOME?.trim();
  return fromEnv ? fromEnv : path.join(os.homedir(), ".codex");
}

/**
 * The session's title from Codex's session index, or null when the index or
 * the entry is missing. A renamed session has several entries; the most
 * recently updated one wins.
 */
export function codexSessionTitle(
  sessionId: string,
  options: CodexTitleOptions = {},
): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  let text: string;
  try {
    text = fs.readFileSync(
      path.join(codexHome(options), "session_index.jsonl"),
      "utf8",
    );
  } catch {
    return null;
  }
  let best: { title: string; updatedAt: string } | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.id !== id) continue;
    const title =
      typeof entry.thread_name === "string" ? entry.thread_name.trim() : "";
    if (!title) continue;
    const updatedAt =
      typeof entry.updated_at === "string" ? entry.updated_at : "";
    if (!best || updatedAt >= best.updatedAt) best = { title, updatedAt };
  }
  return best?.title ?? null;
}

/**
 * Queue `text` for the Codex session `sessionId` with `codex queue`. Returns
 * null when codex accepted it, else a sentence saying why not.
 */
export function wakeCodexSession(
  sessionId: string | null,
  text: string,
  options: CodexWakeOptions = {},
): Promise<string | null> {
  const id = sessionId?.trim() ?? "";
  if (!id) {
    return Promise.resolve(
      "The file's session has no Codex session id. Open the file from inside Codex (the CLI records the session itself) or pass --session-id.",
    );
  }
  const env = options.env ?? process.env;
  const bin = options.codexBin ?? (env.ROUGHDRAFT_CODEX_BIN?.trim() || "codex");
  const timeoutMs = options.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS;
  const { ROUGHDRAFT_TOKEN: _token, ...childEnv } = env;
  return new Promise((resolve) => {
    const child = spawn(bin, ["queue", "--thread", id, "--message", text], {
      stdio: ["ignore", "ignore", "pipe"],
      env: childEnv,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(
        error.code === "ENOENT"
          ? `The codex command was not found (looked for ${bin}). Install Codex, or set ROUGHDRAFT_CODEX_BIN to its path.`
          : `Could not run ${bin}: ${error.message}`,
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(`codex queue timed out after ${timeoutMs} ms`);
      } else if (code === 0) {
        resolve(null);
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        resolve(`codex queue exited with ${code ?? signal}${detail}`);
      }
    });
  });
}
