import { spawn } from "node:child_process";
import path from "node:path";
import express, { type Request, type Response, type Router } from "express";
import {
  errorMessage,
  type HandoffSummary,
  readJsonState,
  writeJsonAtomic,
} from "./handoff-log.js";

export interface WakeRoute {
  harness: string;
  kind: "command" | "url";
  command?: string;
  url?: string;
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
}

interface RoutesFile {
  schemaVersion: 1;
  routes: Record<string, WakeRoute>;
}

export const WAKE_ROUTES_FILE = "wake-routes.json";
export const WAKE_TIMEOUT_MS = 10_000;
const HARNESS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
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

  list(): WakeRoute[] {
    return [...this.routes.values()].sort((a, b) =>
      a.harness.localeCompare(b.harness),
    );
  }

  get(harness: string): WakeRoute | null {
    return this.routes.get(harness) ?? null;
  }

  put(route: WakeRoute): WakeRoute {
    this.routes.set(route.harness, route);
    this.save();
    return route;
  }

  remove(harness: string): boolean {
    const removed = this.routes.delete(harness);
    if (removed) this.save();
    return removed;
  }

  recordOutcome(
    harness: string,
    outcome: WakeOutcome,
    verification?: { at: string; by: string | null },
  ): void {
    const route = this.routes.get(harness);
    if (!route) return;
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
      writeJsonAtomic(this.filePath, file);
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

  if (input.kind === "command") {
    const command =
      typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return { error: "command is required for kind command" };
    return { route: { ...base, kind: "command", command } };
  }
  if (input.kind === "url") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!isHttpUrl(url)) return { error: "url must be an http or https URL" };
    return { route: { ...base, kind: "url", url } };
  }
  return { error: 'kind must be "command" or "url"' };
}

export function doneMessage(
  documentPath: string,
  summary: HandoffSummary,
  overallComment: string | null,
): string {
  const line = `I'm done reviewing ${path.basename(documentPath)}. Please check my comments. (${summary.comments} comments, ${summary.suggestions} suggestions)`;
  return overallComment ? `${line}\n${overallComment}` : line;
}

export function testPayload(harness: string): WakePayload {
  return {
    event: "test",
    message: `Roughdraft wake route test for ${harness}.`,
    documentPath: null,
    link: null,
    counts: { comments: 0, suggestions: 0, unresolved: 0 },
    handoffId: null,
    session: { harness, label: null, sessionId: null },
  };
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
        : await postUrl(route.url ?? "", payload, timeoutMs, options.fetchImpl);
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
    const child = spawn(expandPlaceholders(command, payload), {
      shell: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...inherited, ...wakeEnv(payload) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-OUTPUT_TAIL_CHARS);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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
  url: string,
  payload: WakePayload,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(urlBody(payload)),
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
    res.json({ routes: store.list() });
  });

  router.put("/:harness", (req, res) => {
    if (!guard(req, res)) return;
    const parsed = parseWakeRouteBody(req.params.harness, req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, code: "USAGE" });
      return;
    }
    res.json({ ok: true, route: store.put(parsed.route) });
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
    const outcome = await runWakeRoute(
      route,
      testPayload(route.harness),
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
