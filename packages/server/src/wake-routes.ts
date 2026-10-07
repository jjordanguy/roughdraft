import { spawn } from "node:child_process";
import path from "node:path";
import express, { type Request, type Response, type Router } from "express";
import { wakeClaudeSession } from "./claude-session.js";
import { wakeCodexSession } from "./codex-session.js";
import {
  errorMessage,
  type HandoffSummary,
  readJsonState,
  writeJsonAtomic,
} from "./handoff-log.js";
import { killProcessGroup } from "./process-group.js";
import {
  builtInRoute,
  redactRoute,
  withBuiltInRoutes,
} from "./wake-route-defaults.js";

export interface WakeRoute {
  harness: string;
  /**
   * command: a shell command; url: a JSON POST; claude-session: a user turn
   * in the Claude Code session that opened the file; codex-queue: a message
   * queued for the Codex session that opened the file.
   */
  kind: "command" | "url" | "claude-session" | "codex-queue";
  command?: string;
  url?: string;
  /** For kind url: extra request headers. They can hold a token, so lists show only their names. */
  headers?: Record<string, string>;
  /** For kind url: a JSON body template (see `fillBodyTemplate`). Null or absent sends the fixed body. */
  body?: string | null;
  label: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  lastError: string | null;
}

export interface WakePayload {
  event: "done" | "test";
  message: string;
  documentPath: string | null;
  link: string | null;
  counts: { comments: number; suggestions: number; unresolved: number };
  handoffId: string | null;
  session: { harness: string; label: string | null; sessionId: string | null };
}

export interface WakeOutcome {
  sent: boolean;
  error: string | null;
  durationMs: number;
}

export interface RunWakeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Where Claude Code keeps its session records (default: CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeConfigDir?: string;
  /** The codex executable for codex-queue routes (default: ROUGHDRAFT_CODEX_BIN, else codex on PATH). */
  codexBin?: string;
}

interface RoutesFile {
  schemaVersion: 1;
  routes: Record<string, WakeRoute>;
}

export const WAKE_ROUTES_FILE = "wake-routes.json";
export const WAKE_TIMEOUT_MS = 10_000;
const HARNESS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** An HTTP header name: an RFC 9110 token. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OUTPUT_TAIL_CHARS = 500;

export function isValidHarness(harness: string): boolean {
  return HARNESS_PATTERN.test(harness);
}

export class WakeRouteStore {
  readonly filePath: string | null;
  readonly warnings: string[] = [];
  private routes = new Map<string, WakeRoute>();

  constructor(options: { stateDir?: string; now?: () => Date } = {}) {
    this.filePath = options.stateDir
      ? path.join(options.stateDir, WAKE_ROUTES_FILE)
      : null;
    if (!this.filePath) return;
    const loaded = readJsonState(
      this.filePath,
      isRoutesFile,
      (options.now ?? (() => new Date()))(),
    );
    if (loaded.warning) this.warnings.push(loaded.warning);
    for (const route of Object.values(loaded.value?.routes ?? {})) {
      if (isValidHarness(route.harness)) this.routes.set(route.harness, route);
    }
  }

  /** Stored routes plus the built-in ones nothing replaced. */
  list(): WakeRoute[] {
    return withBuiltInRoutes([...this.routes.values()]);
  }

  get(harness: string): WakeRoute | null {
    return this.routes.get(harness) ?? builtInRoute(harness);
  }

  put(route: WakeRoute): WakeRoute {
    this.routes.set(route.harness, route);
    this.save();
    return route;
  }

  /** Drops a stored route. A built-in route cannot be removed; removing its replacement restores it. */
  remove(harness: string): boolean {
    const removed = this.routes.delete(harness);
    if (removed) this.save();
    return removed || builtInRoute(harness) !== null;
  }

  recordOutcome(
    harness: string,
    outcome: WakeOutcome,
    verification?: { at: string; by: string | null },
  ): void {
    let route = this.routes.get(harness);
    if (!route) {
      // A built-in route gets stored once it has an outcome to remember.
      const builtIn = builtInRoute(harness);
      if (!builtIn) return;
      route = builtIn;
      this.routes.set(harness, route);
    }
    route.lastError = outcome.error;
    if (outcome.sent && verification) {
      route.verifiedAt = verification.at;
      route.verifiedBy = verification.by;
    }
    this.save();
  }

  private save(): void {
    if (!this.filePath) return;
    const file: RoutesFile = {
      schemaVersion: 1,
      routes: Object.fromEntries(this.routes),
    };
    try {
      // A url route's headers can hold a token: only this user may read the file.
      writeJsonAtomic(this.filePath, file, { mode: 0o600 });
    } catch (error) {
      const message = `Could not write ${this.filePath}: ${errorMessage(error)}`;
      if (!this.warnings.includes(message)) this.warnings.push(message);
    }
  }
}

export function parseWakeRouteBody(
  harness: string,
  body: unknown,
): { route: WakeRoute } | { error: string } {
  if (!isValidHarness(harness)) {
    return {
      error:
        "harness must be 1 to 64 letters, digits, dots, dashes or underscores",
    };
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const label =
    typeof input.label === "string" && input.label.trim()
      ? input.label.trim()
      : null;
  const base = {
    harness,
    label,
    verifiedAt: null,
    verifiedBy: null,
    lastError: null,
  };

  const hasHeaders =
    input.headers !== undefined &&
    input.headers !== null &&
    !(Array.isArray(input.headers) && input.headers.length === 0);
  const hasBody = typeof input.body === "string" && input.body.trim() !== "";
  if (input.kind !== "url" && (hasHeaders || hasBody)) {
    return { error: "headers and body apply only to kind url" };
  }

  if (input.kind === "command") {
    const command =
      typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return { error: "command is required for kind command" };
    return { route: { ...base, kind: "command", command } };
  }
  if (input.kind === "url") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!isHttpUrl(url)) return { error: "url must be an http or https URL" };
    const parsedHeaders = hasHeaders
      ? parseHeaders(input.headers)
      : { headers: {} };
    if ("error" in parsedHeaders) return parsedHeaders;
    const { headers } = parsedHeaders;
    if (
      input.body !== undefined &&
      input.body !== null &&
      typeof input.body !== "string"
    ) {
      return { error: "body must be a string (a JSON template)" };
    }
    const body = hasBody ? (input.body as string).trim() : null;
    if (body !== null) {
      const problem = bodyTemplateProblem(body);
      if (problem) return { error: problem };
    }
    return {
      route: {
        ...base,
        kind: "url",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body !== null ? { body } : {}),
      },
    };
  }
  if (input.kind === "claude-session") {
    return { route: { ...base, kind: "claude-session" } };
  }
  if (input.kind === "codex-queue") {
    return { route: { ...base, kind: "codex-queue" } };
  }
  return {
    error: 'kind must be "command", "url", "claude-session" or "codex-queue"',
  };
}

/**
 * Headers for a url route, from `Name: value` lines (the CLI's --header) or
 * an object of names to values (the MCP tool). A name must be a token; a
 * value must be one line.
 */
function parseHeaders(
  input: unknown,
): { headers: Record<string, string> } | { error: string } {
  const pairs: [string, unknown][] = [];
  if (Array.isArray(input)) {
    for (const line of input) {
      if (typeof line !== "string") {
        return { error: 'each header must be a "Name: value" line' };
      }
      const colon = line.indexOf(":");
      if (colon === -1) {
        return {
          error: `header "${line.trim()}" must be written "Name: value"`,
        };
      }
      pairs.push([line.slice(0, colon), line.slice(colon + 1)]);
    }
  } else if (typeof input === "object" && input !== null) {
    pairs.push(...Object.entries(input));
  } else {
    return {
      error:
        'headers must be "Name: value" lines or an object of names to values',
    };
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      return {
        error: `header name "${name}" must be a token: letters, digits and !#$%&'*+.^_\`|~-, no spaces`,
      };
    }
    if (typeof rawValue !== "string") {
      return { error: `header ${name} must have a string value` };
    }
    const value = rawValue.trim();
    if (/[\r\n\0]/.test(value)) {
      return { error: `header ${name} must have a one-line value` };
    }
    if (!value) return { error: `header ${name} has no value` };
    headers[name] = value;
  }
  return { headers };
}

const TEMPLATE_PLACEHOLDER =
  /\{(message|file|link|sessionId|event|handoffId)\}/g;

/**
 * Fills a url route's body template: each of {message}, {file}, {link},
 * {sessionId}, {event} and {handoffId} becomes a JSON string literal, quotes
 * included, and a missing value becomes "". Nothing else is replaced.
 */
export function fillBodyTemplate(
  template: string,
  payload: WakePayload,
): string {
  const values: Record<string, string> = {
    message: payload.message,
    file: payload.documentPath ?? "",
    link: payload.link ?? "",
    sessionId: payload.session.sessionId ?? "",
    event: payload.event,
    handoffId: payload.handoffId ?? "",
  };
  return template.replace(TEMPLATE_PLACEHOLDER, (_match, name: string) =>
    JSON.stringify(values[name] ?? ""),
  );
}

/** Why a body template would not produce JSON, or null when it does. */
function bodyTemplateProblem(template: string): string | null {
  const sample: WakePayload = {
    event: "done",
    message: "I'm done reviewing plan.md.",
    documentPath: "/notes/plan.md",
    link: "http://localhost:7373/?path=%2Fnotes%2Fplan.md",
    counts: { comments: 1, suggestions: 0, unresolved: 1 },
    handoffId: "h-1",
    session: { harness: "sample", label: null, sessionId: "s-1" },
  };
  try {
    JSON.parse(fillBodyTemplate(template, sample));
    return null;
  } catch (error) {
    return `body is not JSON once its placeholders are filled in (${errorMessage(error)}). Placeholders become quoted JSON strings, so write them bare: {"text": {message}}`;
  }
}

export function doneMessage(
  documentPath: string,
  summary: HandoffSummary,
  overallComment: string | null,
): string {
  const line = `I'm done reviewing ${path.basename(documentPath)}. Please check my comments. (${summary.comments} comments, ${summary.suggestions} suggestions)`;
  return overallComment ? `${line}\n${overallComment}` : line;
}

export function testPayload(
  harness: string,
  sessionId: string | null = null,
): WakePayload {
  return {
    event: "test",
    message: `Roughdraft wake route test for ${harness}.`,
    documentPath: null,
    link: null,
    counts: { comments: 0, suggestions: 0, unresolved: 0 },
    handoffId: null,
    session: { harness, label: null, sessionId },
  };
}

/**
 * What a claude-session route posts into the session: the Done message, then
 * the file and the command that picks the round up. A test says it is one.
 */
export function sessionMessage(payload: WakePayload): string {
  if (payload.event === "test") {
    return `${payload.message} It reached this session, so a Done will too. Nothing to do.`;
  }
  const lines = [payload.message];
  if (payload.documentPath) {
    lines.push(
      "",
      `File: ${payload.documentPath}`,
      ...(payload.link ? [`Link: ${payload.link}`] : []),
      `Next: roughdraft round ${shellQuote(payload.documentPath)}`,
    );
  }
  return lines.join("\n");
}

export async function runWakeRoute(
  route: WakeRoute,
  payload: WakePayload,
  options: RunWakeOptions = {},
): Promise<WakeOutcome> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? WAKE_TIMEOUT_MS;
  try {
    const error =
      route.kind === "command"
        ? await runCommand(route.command ?? "", payload, timeoutMs, options.env)
        : route.kind === "url"
          ? await postUrl(route, payload, timeoutMs, options.fetchImpl)
          : route.kind === "codex-queue"
            ? await wakeCodexSession(
                payload.session.sessionId,
                sessionMessage(payload),
                {
                  timeoutMs,
                  ...(options.codexBin ? { codexBin: options.codexBin } : {}),
                  ...(options.env ? { env: options.env } : {}),
                },
              )
            : await wakeClaudeSession(
                payload.session.sessionId,
                sessionMessage(payload),
                {
                  timeoutMs,
                  ...(options.claudeConfigDir
                    ? { configDir: options.claudeConfigDir }
                    : {}),
                  ...(options.env ? { env: options.env } : {}),
                },
              );
    return { sent: error === null, error, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      sent: false,
      error: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

export function wakeEnv(payload: WakePayload): Record<string, string> {
  return {
    ROUGHDRAFT_EVENT: payload.event,
    ROUGHDRAFT_MESSAGE: payload.message,
    ROUGHDRAFT_FILE: payload.documentPath ?? "",
    ROUGHDRAFT_LINK: payload.link ?? "",
    ROUGHDRAFT_COMMENTS: String(payload.counts.comments),
    ROUGHDRAFT_SUGGESTIONS: String(payload.counts.suggestions),
    ROUGHDRAFT_UNRESOLVED: String(payload.counts.unresolved),
    ROUGHDRAFT_HANDOFF_ID: payload.handoffId ?? "",
    ROUGHDRAFT_SESSION_LABEL: payload.session.label ?? "",
    ROUGHDRAFT_SESSION_ID: payload.session.sessionId ?? "",
  };
}

export function expandPlaceholders(
  command: string,
  payload: WakePayload,
): string {
  const values: Record<string, string> = {
    message: payload.message,
    file: payload.documentPath ?? "",
    link: payload.link ?? "",
    sessionId: payload.session.sessionId ?? "",
  };
  return command.replace(
    /\{(message|file|link|sessionId)\}/g,
    (_match, name: string) => shellQuote(values[name] ?? ""),
  );
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runCommand(
  command: string,
  payload: WakePayload,
  timeoutMs: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const { ROUGHDRAFT_TOKEN: _token, ...inherited } = baseEnv;
  return new Promise((resolve) => {
    // Its own process group, so a timeout can kill the shell and whatever
    // the shell started. Killing the shell alone leaves a child holding the
    // stderr pipe open on Linux, and "close" waits for it.
    const child = spawn(expandPlaceholders(command, payload), {
      shell: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...inherited, ...wakeEnv(payload) },
      detached: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-OUTPUT_TAIL_CHARS);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve(`Command timed out after ${timeoutMs} ms`);
      else if (code === 0) resolve(null);
      else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        resolve(`Command exited with ${code ?? signal}${detail}`);
      }
    });
  });
}

async function postUrl(
  route: WakeRoute,
  payload: WakePayload,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The route's own headers win over the default Content-Type.
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(route.headers ?? {})) {
    headers.set(name, value);
  }
  try {
    const response = await fetchImpl(route.url ?? "", {
      method: "POST",
      headers,
      body: route.body
        ? fillBodyTemplate(route.body, payload)
        : JSON.stringify(urlBody(payload)),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return response.ok ? null : `URL answered HTTP ${response.status}`;
  } catch (error) {
    if (controller.signal.aborted) return `URL timed out after ${timeoutMs} ms`;
    const cause = (error as { cause?: unknown }).cause;
    return cause
      ? `${errorMessage(error)}: ${errorMessage(cause)}`
      : errorMessage(error);
  } finally {
    clearTimeout(timer);
  }
}

function urlBody(payload: WakePayload) {
  return {
    type: payload.event === "done" ? "roughdraft.done" : "roughdraft.test",
    message: payload.message,
    documentPath: payload.documentPath,
    link: payload.link,
    counts: payload.counts,
    handoffId: payload.handoffId,
    session: payload.session,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRoutesFile(value: unknown): value is RoutesFile {
  const candidate = value as Partial<RoutesFile> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.schemaVersion === 1 &&
    typeof candidate.routes === "object" &&
    candidate.routes !== null
  );
}

/**
 * Wake routes run commands, so mutations refuse requests that look like they
 * came from a web page on another origin or through a rebound DNS name.
 */
function isLocalControlRequest(req: Request, tokenRequired: boolean): boolean {
  const origin = req.get("origin");
  const host = req.get("host") ?? "";
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  if (tokenRequired) return true;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

export function wakeRouteRouter(deps: {
  store: WakeRouteStore;
  tokenRequired: boolean;
  runOptions: () => RunWakeOptions;
}): Router {
  const router = express.Router();
  const { store } = deps;

  const guard = (req: Request, res: Response): boolean => {
    if (isLocalControlRequest(req, deps.tokenRequired)) return true;
    res.status(403).json({
      error: "Wake routes can only be changed from this machine.",
      code: "FORBIDDEN",
    });
    return false;
  };

  router.get("/", (_req, res) => {
    res.json({ routes: store.list().map(redactRoute) });
  });

  router.put("/:harness", (req, res) => {
    if (!guard(req, res)) return;
    const parsed = parseWakeRouteBody(req.params.harness, req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, code: "USAGE" });
      return;
    }
    res.json({ ok: true, route: redactRoute(store.put(parsed.route)) });
  });

  router.delete("/:harness", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ ok: true, removed: store.remove(req.params.harness) });
  });

  router.post("/:harness/test", async (req, res) => {
    if (!guard(req, res)) return;
    const route = store.get(req.params.harness);
    if (!route) {
      res.status(404).json({
        error: `No wake route for ${req.params.harness}`,
        code: "WAKE_ROUTE_NOT_FOUND",
      });
      return;
    }
    const sessionId =
      typeof req.body?.sessionId === "string" && req.body.sessionId.trim()
        ? req.body.sessionId.trim()
        : null;
    const outcome = await runWakeRoute(
      route,
      testPayload(route.harness, sessionId),
      deps.runOptions(),
    );
    const by = typeof req.body?.by === "string" ? req.body.by : null;
    store.recordOutcome(route.harness, outcome, {
      at: new Date().toISOString(),
      by,
    });
    res.json({ ok: outcome.sent, ...outcome });
  });

  return router;
}
