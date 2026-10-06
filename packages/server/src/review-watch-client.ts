/**
 * The agent side of the review handoff, shared by the CLI and the MCP server:
 * finding the running server without starting one, the token header, the
 * Done watcher (event stream first, bounded long polls as the fallback), and
 * the handoff, document and wake-route calls. It also reads the session log
 * straight from disk when the server is down.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";
import type {
  DocumentRecord,
  HandoffRecord,
  SessionRecord,
} from "./handoff-log.js";
import {
  ROUGHDRAFT_BIND_HOST,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
} from "./network.js";
import { type DocumentView, documentKey } from "./registry.js";
import type { ReviewCompletedEvent } from "./review-events.js";
import { withBuiltInRoutes } from "./wake-route-defaults.js";
import type { WakeRoute } from "./wake-routes.js";

export type {
  DocumentRecord,
  DocumentView,
  HandoffRecord,
  SessionRecord,
  WakeRoute,
};

const REVIEW_LOG_FILE = "review-log.json";
const WAKE_ROUTES_FILE = "wake-routes.json";
const STATUS_TIMEOUT_MS = 750;
const API_TIMEOUT_MS = 10_000;

// --- Discovery and auth -----------------------------------------------------

export function getServerStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const explicitDir = env.ROUGHDRAFT_STATE_DIR?.trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), "server.json");
  }

  return path.join(os.homedir(), ".roughdraft", "server.json");
}

/** The directory the server keeps review-log.json and wake-routes.json in. */
export function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.dirname(getServerStateFilePath(env));
}

/** `Authorization: Bearer` when `ROUGHDRAFT_TOKEN` is set, else nothing. */
export function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.ROUGHDRAFT_TOKEN?.trim() ?? "";
  return token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

export interface ServerStatus {
  /** Base URL used for API calls (the loopback host that answered). */
  url: string;
  /** The public link base, `http://localhost:<port>`. */
  publicUrl: string;
  port: number | null;
  pid: number | null;
  version: string | null;
  instanceId: string | null;
  serverRoot: string | null;
  stateDir: string | null;
  capabilities: Record<string, unknown>;
  warnings: string[];
}

export interface RecordedServerState {
  port: number;
  pid: number;
  url: string;
  startedAt: string;
}

/** Reads server.json without changing it. */
export function readServerStateFile(
  env: NodeJS.ProcessEnv,
): RecordedServerState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getServerStateFilePath(env), "utf8"),
    ) as Partial<RecordedServerState>;
    if (typeof parsed.port === "number" && Number.isFinite(parsed.port)) {
      return {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        url:
          typeof parsed.url === "string"
            ? parsed.url
            : `http://${ROUGHDRAFT_PUBLIC_HOST}:${parsed.port}`,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      };
    }
  } catch {}
  return null;
}

function hostUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(
    signals.filter((signal): signal is AbortSignal => signal !== undefined),
  );
}

/** `GET /api/status` at one base URL; null when it does not answer as Roughdraft. */
export async function fetchServerStatus(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<ServerStatus | null> {
  try {
    const response = await fetchImpl(new URL("/api/status", baseUrl), {
      headers: options.headers ?? {},
      signal: anySignal([
        AbortSignal.timeout(STATUS_TIMEOUT_MS),
        options.signal,
      ]),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.backend !== "local-files") return null;
    const port =
      typeof payload.port === "number"
        ? payload.port
        : Number.parseInt(new URL(baseUrl).port || "0", 10) || null;
    return {
      url: new URL(baseUrl).origin,
      publicUrl:
        port !== null
          ? `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`
          : new URL(baseUrl).origin,
      port,
      pid: typeof payload.pid === "number" ? payload.pid : null,
      version: typeof payload.version === "string" ? payload.version : null,
      instanceId:
        typeof payload.instanceId === "string" ? payload.instanceId : null,
      serverRoot:
        typeof payload.serverRoot === "string" ? payload.serverRoot : null,
      stateDir: typeof payload.stateDir === "string" ? payload.stateDir : null,
      capabilities:
        payload.capabilities && typeof payload.capabilities === "object"
          ? (payload.capabilities as Record<string, unknown>)
          : {},
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [],
    };
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return null;
  }
}

export type ResolveServer = (
  signal?: AbortSignal,
) => Promise<ServerStatus | null>;

/**
 * Finds the running server from server.json (then the preferred port), never
 * starting one. With `fixedUrl` it only checks that address.
 */
export function createServerResolver(options: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  fixedUrl?: string;
  /** When set, a server reporting another install root is ignored. */
  serverRoot?: string;
}): ResolveServer {
  const headers = authHeaders(options.env);
  const matchesRoot = (status: ServerStatus) =>
    !options.serverRoot ||
    (status.serverRoot !== null &&
      path.resolve(status.serverRoot) === path.resolve(options.serverRoot));

  return async (signal) => {
    if (options.fixedUrl) {
      return fetchServerStatus(options.fetchImpl, options.fixedUrl, {
        headers,
        signal,
      });
    }

    const ports: number[] = [];
    const recorded = readServerStateFile(options.env);
    if (recorded) ports.push(recorded.port);
    const preferred = Number.parseInt(
      options.env.ROUGHDRAFT_PORT || options.env.PORT || "",
      10,
    );
    const preferredPort =
      Number.isFinite(preferred) && preferred > 0
        ? preferred
        : ROUGHDRAFT_DEFAULT_PORT;
    if (!ports.includes(preferredPort)) ports.push(preferredPort);

    for (const [index, port] of ports.entries()) {
      for (const host of new Set([
        ROUGHDRAFT_BIND_HOST,
        ...ROUGHDRAFT_LOOPBACK_HOSTS,
      ])) {
        const status = await fetchServerStatus(
          options.fetchImpl,
          hostUrl(host, port),
          { headers, signal },
        );
        if (!status) continue;
        // The recorded port belongs to this state dir; the preferred port
        // may be some other checkout's server.
        if (index === 0 && recorded) return status;
        if (matchesRoot(status)) return status;
      }
    }
    return null;
  };
}

// --- Plain API calls ----------------------------------------------------------

export interface ApiContext {
  fetchImpl: typeof fetch;
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: callers narrow the JSON they read
  body: any;
}

/**
 * One JSON request to the server. Network failures become
 * `SERVER_UNREACHABLE`; the caller decides what a non-2xx status means.
 */
export async function apiRequest(
  ctx: ApiContext,
  method: string,
  pathname: string,
  options: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<ApiResponse> {
  const url = new URL(pathname, ctx.baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await ctx.fetchImpl(url, {
      method,
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...ctx.headers,
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: anySignal([
        AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
        ctx.signal,
      ]),
    });
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    throw new CliError(
      "SERVER_UNREACHABLE",
      `Could not reach Roughdraft at ${ctx.baseUrl}.`,
      { cause: error, hint: "Run `roughdraft status` to check the server." },
    );
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  return { status: response.status, body };
}

export function httpError(
  context: string,
  response: ApiResponse,
  baseUrl?: string,
): CliError {
  const serverMessage =
    response.body && typeof response.body.error === "string"
      ? response.body.error
      : null;
  return new CliError(
    "HTTP_ERROR",
    `${context} failed with HTTP ${response.status}${serverMessage ? `: ${serverMessage}` : "."}`,
    {
      hint:
        response.status === 401
          ? "Set ROUGHDRAFT_TOKEN to the token the server was started with."
          : undefined,
      details: {
        httpStatus: response.status,
        body: response.body,
        ...(baseUrl ? { serverUrl: baseUrl } : {}),
      },
    },
  );
}

function expectOk(
  context: string,
  response: ApiResponse,
  baseUrl: string,
): ApiResponse {
  if (response.status >= 200 && response.status < 300) return response;
  throw httpError(context, response, baseUrl);
}

export async function listDocuments(ctx: ApiContext): Promise<{
  instanceId: string | null;
  logId: string | null;
  documents: DocumentView[];
}> {
  const response = expectOk(
    "Listing documents",
    await apiRequest(ctx, "GET", "/api/documents"),
    ctx.baseUrl,
  );
  return {
    instanceId:
      typeof response.body?.instanceId === "string"
        ? response.body.instanceId
        : null,
    logId:
      typeof response.body?.logId === "string" ? response.body.logId : null,
    documents: Array.isArray(response.body?.documents)
      ? (response.body.documents as DocumentView[])
      : [],
  };
}

export interface AckResult {
  acked: string[];
  unknown: string[];
  handoffs: HandoffRecord[];
}

export async function ackHandoffs(
  ctx: ApiContext,
  handoffIds: string[],
  by: string,
): Promise<AckResult> {
  const result: AckResult = { acked: [], unknown: [], handoffs: [] };
  for (const handoffId of handoffIds) {
    const response = await apiRequest(ctx, "POST", "/api/review-events/ack", {
      body: { handoffId, by },
    });
    if (response.status === 404) {
      result.unknown.push(handoffId);
      continue;
    }
    expectOk("Acknowledging a handoff", response, ctx.baseUrl);
    result.acked.push(handoffId);
    if (response.body?.handoff) result.handoffs.push(response.body.handoff);
  }
  return result;
}

export async function registerSession(
  ctx: ApiContext,
  input: {
    projectPath: string;
    path: string;
    harness: string;
    label: string;
    link?: string | null;
    sessionId?: string | null;
  },
): Promise<SessionRecord> {
  const response = expectOk(
    "Registering the session",
    await apiRequest(ctx, "POST", "/api/documents/session", {
      body: {
        projectPath: input.projectPath,
        path: input.path,
        harness: input.harness,
        label: input.label,
        ...(input.link ? { link: input.link } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    }),
    ctx.baseUrl,
  );
  return response.body.session as SessionRecord;
}

export async function listWakeRoutes(ctx: ApiContext): Promise<WakeRoute[]> {
  const response = expectOk(
    "Listing wake routes",
    await apiRequest(ctx, "GET", "/api/wake-routes"),
    ctx.baseUrl,
  );
  return Array.isArray(response.body?.routes) ? response.body.routes : [];
}

export async function putWakeRoute(
  ctx: ApiContext,
  harness: string,
  route: {
    kind: "command" | "url" | "claude-session";
    command?: string;
    url?: string;
    label?: string | null;
  },
): Promise<WakeRoute> {
  const response = await apiRequest(
    ctx,
    "PUT",
    `/api/wake-routes/${encodeURIComponent(harness)}`,
    { body: route },
  );
  if (response.status === 400) {
    throw new CliError(
      "USAGE",
      typeof response.body?.error === "string"
        ? response.body.error
        : "The server rejected the wake route.",
    );
  }
  return expectOk("Saving the wake route", response, ctx.baseUrl).body
    .route as WakeRoute;
}

export async function removeWakeRoute(
  ctx: ApiContext,
  harness: string,
): Promise<boolean> {
  const response = expectOk(
    "Removing the wake route",
    await apiRequest(
      ctx,
      "DELETE",
      `/api/wake-routes/${encodeURIComponent(harness)}`,
    ),
    ctx.baseUrl,
  );
  return response.body?.removed === true;
}

export interface WakeTestResult {
  harness: string;
  sent: boolean;
  error: string | null;
  durationMs: number | null;
}

export async function testWakeRoute(
  ctx: ApiContext,
  harness: string,
  by: string,
  /** For a claude-session route: the session the test is delivered into. */
  sessionId: string | null = null,
): Promise<WakeTestResult> {
  const response = await apiRequest(
    ctx,
    "POST",
    `/api/wake-routes/${encodeURIComponent(harness)}/test`,
    // The server runs the route with a 10 s limit before it answers.
    {
      body: { by, ...(sessionId ? { sessionId } : {}) },
      timeoutMs: 30_000,
    },
  );
  if (response.status === 404) {
    throw new CliError(
      "WAKE_ROUTE_NOT_FOUND",
      `No wake route for ${harness}.`,
      {
        hint: `Add one with \`roughdraft route add ${harness} --command "<text>"\`, \`--url <url>\` or \`--claude-session\`.`,
      },
    );
  }
  const body = expectOk("Testing the wake route", response, ctx.baseUrl).body;
  return {
    harness,
    sent: body?.sent === true || body?.ok === true,
    error: typeof body?.error === "string" ? body.error : null,
    durationMs: typeof body?.durationMs === "number" ? body.durationMs : null,
  };
}

// --- Reading the session log from disk ---------------------------------------

export interface DiskLog {
  logId: string | null;
  documents: DocumentRecord[];
  filePath: string;
}

/** Reads review-log.json as it is, without pruning or repairing it. */
export function readReviewLogFromDisk(stateDir: string): DiskLog {
  const filePath = path.join(stateDir, REVIEW_LOG_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      logId?: unknown;
      documents?: unknown;
    };
    const documents =
      parsed.documents && typeof parsed.documents === "object"
        ? Object.values(parsed.documents as Record<string, unknown>).filter(
            (value): value is DocumentRecord =>
              !!value &&
              typeof value === "object" &&
              typeof (value as DocumentRecord).documentPath === "string" &&
              Array.isArray((value as DocumentRecord).handoffs),
          )
        : [];
    return {
      logId: typeof parsed.logId === "string" ? parsed.logId : null,
      documents,
      filePath,
    };
  } catch {
    return { logId: null, documents: [], filePath };
  }
}

export function readWakeRoutesFromDisk(stateDir: string): WakeRoute[] {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(stateDir, WAKE_ROUTES_FILE), "utf8"),
    ) as { routes?: unknown };
    return withBuiltInRoutes(
      parsed.routes && typeof parsed.routes === "object"
        ? Object.values(parsed.routes as Record<string, WakeRoute>)
        : [],
    );
  } catch {
    return withBuiltInRoutes([]);
  }
}

export function isUnacknowledged(handoff: HandoffRecord): boolean {
  return handoff.state === "pending" || handoff.state === "delivered";
}

/** A disk record shaped like the server's `DocumentView`, without presence. */
export function documentViewFromRecord(
  record: DocumentRecord,
  publicBaseUrl: string | null,
): DocumentView {
  return {
    ...record,
    lastOpenRequestAt: record.lastOpenRequestAt ?? null,
    tabs: 0,
    watchers: 0,
    pendingHandoffs: record.handoffs.filter(isUnacknowledged).length,
    url: publicBaseUrl
      ? buildDocumentUrl(publicBaseUrl, record.documentPath)
      : "",
  };
}

export function buildDocumentUrl(
  baseUrl: string,
  documentPath: string,
): string {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("path", documentPath);
  return url.toString();
}

export interface ListedHandoff extends HandoffRecord {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  url: string | null;
  sessionLabel: string | null;
}

export const ACKED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Unacknowledged handoffs (oldest first), for one document key or all. With
 * `includeAcked`, settled ones from the last seven days are listed too.
 */
export function collectHandoffs(
  documents: Array<DocumentRecord | DocumentView>,
  options: { key?: string; includeAcked?: boolean; nowMs?: number } = {},
): ListedHandoff[] {
  const nowMs = options.nowMs ?? Date.now();
  const listed: ListedHandoff[] = [];
  for (const document of documents) {
    if (options.key && document.key !== options.key) continue;
    for (const handoff of document.handoffs) {
      const keep = isUnacknowledged(handoff)
        ? true
        : options.includeAcked === true &&
          nowMs - Date.parse(handoff.ackedAt ?? handoff.createdAt) <=
            ACKED_LOOKBACK_MS;
      if (!keep) continue;
      listed.push({
        ...handoff,
        documentPath: document.documentPath,
        projectPath: document.projectPath,
        relativePath: document.relativePath,
        url:
          "url" in document && typeof document.url === "string" && document.url
            ? document.url
            : null,
        sessionLabel: document.session?.label ?? null,
      });
    }
  }
  return listed.sort((a, b) => a.sequence - b.sequence);
}

export { documentKey };

// --- The Done watcher -----------------------------------------------------------

export interface WatchTuning {
  /** Longest single long poll, below undici's 300 s defaults. */
  pollSeconds: number;
  /** How long a lost server may stay away before `SERVER_LOST`. */
  reconnectMs: number;
  /** Delays between reconnect attempts; the last one repeats. */
  backoffMs: number[];
  /** Headers must arrive within this on the stream. */
  connectTimeoutMs: number;
  /** A stream with no bytes (keepalives included) for this long is dead. */
  idleTimeoutMs: number;
  /** After the deadline, how long a server-timed request may still answer. */
  deadlineGraceMs: number;
}

export const DEFAULT_WATCH_TUNING: WatchTuning = {
  pollSeconds: 240,
  reconnectMs: 120_000,
  backoffMs: [500, 1_000, 2_000, 5_000],
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  deadlineGraceMs: 2_000,
};

export type WatchTransport = "stream" | "long-poll";

export interface WatchedEvent extends ReviewCompletedEvent {
  handoff?: HandoffRecord;
}

export interface WatchServerInfo {
  url: string;
  version: string | null;
  instanceId: string | null;
}

export interface WatchResult {
  status: "completed" | "timeout";
  events: WatchedEvent[];
  timedOut: boolean;
  nextSequence: number;
  handoff: HandoffRecord | null;
  handoffs: HandoffRecord[];
  server: WatchServerInfo;
  transport: WatchTransport;
}

export interface WatchArmed {
  server: ServerStatus;
  transport: WatchTransport;
  afterSequence: number | null;
}

export type WatchNotice =
  | { type: "connection-lost"; error: unknown; serverUrl: string | null }
  | { type: "reconnected"; serverUrl: string; instanceChanged: boolean };

export interface WatchReviewEventsOptions {
  fetchImpl: typeof fetch;
  resolveServer: ResolveServer;
  projectPath: string;
  relativePath: string;
  /** Explicit cursor: only events with a higher sequence. */
  afterSequence?: number;
  /** Without a cursor: true means "events after now", false replays. */
  fromNow?: boolean;
  /** Return an unacknowledged Done for this file at once. */
  includePending?: boolean;
  /** The caller's overall limit; omitted means wait indefinitely. */
  timeoutMs?: number;
  batchWindowSeconds?: number;
  client?: string;
  headers?: Record<string, string>;
  /** SIGINT, SIGTERM, an MCP cancel. Aborting rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Skips the first status lookup when the caller already has it. */
  initialServer?: ServerStatus | null;
  tuning?: Partial<WatchTuning>;
  now?: () => number;
  /** Runs once, after the server has registered the watcher. */
  onArmed?: (armed: WatchArmed) => void | Promise<void>;
  onNotice?: (notice: WatchNotice) => void;
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

class DeadlineReached extends Error {}

type Attempt =
  | { kind: "events"; events: WatchedEvent[]; handoffs: HandoffRecord[] }
  | { kind: "timeout"; nextSequence: number | null }
  | { kind: "again" }
  | { kind: "ended" };

interface ParsedSse {
  event: string;
  data: string;
  id: string | null;
}

/** Splits complete SSE blocks out of `buffer`; comments count as activity only. */
export function parseSseBlocks(buffer: string): {
  events: ParsedSse[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: ParsedSse[] = [];
  let cursor = 0;
  while (true) {
    const blank = normalized.indexOf("\n\n", cursor);
    if (blank === -1) break;
    const block = normalized.slice(cursor, blank);
    cursor = blank + 2;
    let event = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || line.length === 0) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length > 0) events.push({ event, data: data.join("\n"), id });
  }
  return { events, remainder: normalized.slice(cursor) };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Waits for the next Done Reviewing for one file and survives everything short
 * of the caller's own limit: undici's five-minute timeouts (headers at once
 * plus keepalives on the stream, polls bounded at 240 s), server restarts
 * (reconnect with backoff, cursor reset on a new instance), and a server that
 * moved port (re-resolved from server.json each time). It never starts a
 * server. Rejects with `SERVER_LOST`, `HTTP_ERROR`, or the abort reason.
 */
export async function watchReviewEvents(
  options: WatchReviewEventsOptions,
): Promise<WatchResult> {
  const tuning = { ...DEFAULT_WATCH_TUNING, ...options.tuning };
  const now = options.now ?? Date.now;
  const includePending = options.includePending ?? true;
  const fromNow = options.fromNow ?? true;
  const headers = options.headers ?? {};
  const client = options.client ?? "roughdraft";
  const batchWindowSeconds = options.batchWindowSeconds ?? 0.25;
  const startedAt = now();
  const startedAtIso = new Date(startedAt).toISOString();
  const deadline =
    options.timeoutMs === undefined ? null : startedAt + options.timeoutMs;

  // One controller for SIGINT, SIGTERM and the deadline.
  const master = new AbortController();
  const onCallerAbort = () => master.abort(options.signal?.reason);
  if (options.signal?.aborted) throw options.signal.reason;
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let cursor: number | null = options.afterSequence ?? null;
  let lastInstanceId: string | null = null;
  let lastLogId: string | null = null;
  let resetHappened = false;
  let armed = false;
  let firstAttemptDone = false;
  let deadlineReached = false;
  let serverTimedRequest = false;
  let latestNextSequence = 1;
  let lostSince: number | null = null;
  let backoffIndex = 0;
  let lastServerUrl: string | null = null;
  let server: ServerStatus | null = options.initialServer ?? null;
  let transport: WatchTransport = "stream";
  let graceTimer: NodeJS.Timeout | null = null;

  const abortForDeadline = () => master.abort(new DeadlineReached("deadline"));
  const onDeadline = () => {
    deadlineReached = true;
    if (firstAttemptDone && !serverTimedRequest) {
      abortForDeadline();
      return;
    }
    // A request that carries the deadline to the server ends by itself; give
    // it a moment, and never cut the first attempt short (`--timeout 0`
    // still returns a waiting Done).
    graceTimer = setTimeout(abortForDeadline, tuning.deadlineGraceMs);
  };
  const deadlineTimer =
    deadline === null
      ? null
      : setTimeout(onDeadline, Math.max(0, deadline - startedAt));

  const remainingSeconds = (): number | undefined =>
    deadline === null ? undefined : Math.max(0, (deadline - now()) / 1000);

  const serverInfo = (): WatchServerInfo => ({
    url: server?.publicUrl ?? lastServerUrl ?? "",
    version: server?.version ?? null,
    instanceId: lastInstanceId ?? server?.instanceId ?? null,
  });

  const timeoutResult = (nextSequence: number | null): WatchResult => ({
    status: "timeout",
    events: [],
    timedOut: true,
    nextSequence: nextSequence ?? latestNextSequence,
    handoff: null,
    handoffs: [],
    server: serverInfo(),
    transport,
  });

  const noteInstance = (instanceId: string | null, logId: string | null) => {
    if (!instanceId) return false;
    const changed =
      lastInstanceId !== null &&
      instanceId !== lastInstanceId &&
      (logId === null || lastLogId === null || logId !== lastLogId);
    lastInstanceId = instanceId;
    if (logId) lastLogId = logId;
    if (changed) {
      // A new server instance with a different log: its sequences do not
      // continue ours. Start from zero and let `pending` cover the gap.
      cursor = 0;
      resetHappened = true;
    }
    return changed;
  };

  /** After a cursor reset, "next event only" must not replay older Dones. */
  const keepEvent = (event: WatchedEvent) =>
    !(resetHappened && !includePending && event.createdAt < startedAtIso);

  const markConnected = (url: string, instanceChanged: boolean) => {
    if (lostSince !== null) {
      options.onNotice?.({
        type: "reconnected",
        serverUrl: url,
        instanceChanged,
      });
    }
    lostSince = null;
    backoffIndex = 0;
  };

  const arm = async (current: ServerStatus) => {
    if (armed) return;
    armed = true;
    await options.onArmed?.({
      server: current,
      transport,
      afterSequence: cursor,
    });
  };

  async function streamAttempt(current: ServerStatus): Promise<Attempt> {
    const url = new URL("/api/review-events/stream", current.url);
    url.searchParams.set("projectPath", options.projectPath);
    url.searchParams.set("path", options.relativePath);
    url.searchParams.set("includePending", includePending ? "1" : "0");
    url.searchParams.set("client", client);
    if (cursor !== null) url.searchParams.set("afterSequence", String(cursor));
    else url.searchParams.set("fromNow", fromNow ? "true" : "false");
    const remaining = remainingSeconds();
    if (remaining !== undefined) {
      url.searchParams.set("timeoutSeconds", String(remaining));
    }

    const request = new AbortController();
    const linked = anySignal([master.signal, request.signal]);
    let connectTimer: NodeJS.Timeout | null = setTimeout(
      () => request.abort(new Error("connect timeout")),
      tuning.connectTimeoutMs,
    );
    let idleTimer: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => request.abort(new Error("stream idle")),
        tuning.idleTimeoutMs,
      );
    };
    serverTimedRequest = remaining !== undefined;
    try {
      const response = await options.fetchImpl(url, {
        headers: { Accept: "text/event-stream", ...headers },
        signal: linked,
      });
      clearTimeout(connectTimer);
      connectTimer = null;
      if (!response.ok || !response.body) {
        throw new HttpStatusError(
          response.status,
          await response.text().catch(() => ""),
        );
      }
      touch();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collected: WatchedEvent[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return { kind: "ended" };
          touch();
          buffer += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSseBlocks(buffer);
          buffer = parsed.remainder;
          for (const block of parsed.events) {
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(block.data) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (block.event === "hello") {
              const changed = noteInstance(
                typeof data.instanceId === "string" ? data.instanceId : null,
                typeof data.logId === "string" ? data.logId : null,
              );
              if (changed) return { kind: "again" };
              if (typeof data.afterSequence === "number") {
                cursor = data.afterSequence;
              }
              if (typeof data.latestSequence === "number") {
                latestNextSequence = Math.max(
                  latestNextSequence,
                  data.latestSequence + 1,
                );
              }
              markConnected(current.publicUrl, false);
              firstAttemptDone = true;
              await arm(current);
              continue;
            }
            if (block.event === "review.completed") {
              const event = data as unknown as WatchedEvent;
              if (typeof event.sequence === "number") {
                cursor = Math.max(cursor ?? 0, event.sequence);
                latestNextSequence = Math.max(
                  latestNextSequence,
                  event.sequence + 1,
                );
              }
              if (keepEvent(event)) collected.push(event);
              continue;
            }
            if (block.event === "timeout") {
              if (collected.length > 0) break;
              return {
                kind: "timeout",
                nextSequence:
                  typeof data.nextSequence === "number"
                    ? data.nextSequence
                    : null,
              };
            }
          }
          if (collected.length > 0) {
            return {
              kind: "events",
              events: collected,
              handoffs: collected
                .map((event) => event.handoff)
                .filter((handoff): handoff is HandoffRecord => !!handoff),
            };
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
      serverTimedRequest = false;
      request.abort();
    }
  }

  async function pollAttempt(current: ServerStatus): Promise<Attempt> {
    const remaining = remainingSeconds();
    const timeoutSeconds =
      remaining === undefined
        ? tuning.pollSeconds
        : Math.min(tuning.pollSeconds, remaining);
    const body: Record<string, unknown> = {
      projectPath: options.projectPath,
      path: options.relativePath,
      batchWindowSeconds,
      timeoutSeconds,
      // Sending the key marks this as a client that acknowledges by itself.
      includePending,
      client,
    };
    if (cursor !== null) {
      body.fromNow = false;
      body.afterSequence = cursor;
    } else {
      body.fromNow = fromNow;
    }

    const request = new AbortController();
    const requestTimer = setTimeout(
      () => request.abort(new Error("poll timeout")),
      timeoutSeconds * 1000 + 15_000,
    );
    serverTimedRequest = true;
    try {
      const response = await options.fetchImpl(
        new URL("/api/review-events/watch", current.url),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: anySignal([master.signal, request.signal]),
        },
      );
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          await response.text().catch(() => ""),
        );
      }
      // Headers arrive at once from this server, so the watcher is armed.
      markConnected(current.publicUrl, false);
      await arm(current);
      const payload = (await response.json()) as {
        events?: WatchedEvent[];
        timedOut?: boolean;
        nextSequence?: number;
        instanceId?: string;
        handoffs?: HandoffRecord[];
      };
      firstAttemptDone = true;
      const instanceChanged = noteInstance(payload.instanceId ?? null, null);
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (typeof payload.nextSequence === "number") {
        latestNextSequence = payload.nextSequence;
        // After a reset the cursor stays at zero for one more poll, so the
        // new instance's unacknowledged Dones come back.
        if (!instanceChanged) {
          cursor = Math.max(cursor ?? 0, payload.nextSequence - 1);
        }
      }
      const handoffs = Array.isArray(payload.handoffs) ? payload.handoffs : [];
      const kept = events
        .map((event) => ({
          ...event,
          handoff:
            event.handoff ??
            handoffs.find((handoff) => handoff.sequence === event.sequence),
        }))
        .filter(keepEvent);
      if (kept.length > 0) {
        return {
          kind: "events",
          events: kept,
          handoffs: kept
            .map((event) => event.handoff)
            .filter((handoff): handoff is HandoffRecord => !!handoff),
        };
      }
      if (deadline !== null && now() >= deadline) {
        return { kind: "timeout", nextSequence: latestNextSequence };
      }
      return { kind: "again" };
    } finally {
      clearTimeout(requestTimer);
      serverTimedRequest = false;
    }
  }

  const finishEvents = (attempt: Extract<Attempt, { kind: "events" }>) => {
    const last = attempt.events.at(-1);
    return {
      status: "completed" as const,
      events: attempt.events,
      timedOut: false,
      nextSequence:
        last && typeof last.sequence === "number"
          ? Math.max(latestNextSequence, last.sequence + 1)
          : latestNextSequence,
      handoff: attempt.handoffs.at(-1) ?? null,
      handoffs: attempt.handoffs,
      server: serverInfo(),
      transport,
    };
  };

  const waitBeforeRetry = async (error: unknown) => {
    if (lostSince === null) {
      lostSince = now();
      options.onNotice?.({
        type: "connection-lost",
        error,
        serverUrl: lastServerUrl,
      });
    }
    if (now() - lostSince >= tuning.reconnectMs) {
      throw new CliError(
        "SERVER_LOST",
        `Lost Roughdraft${lastServerUrl ? ` at ${lastServerUrl}` : ""} and it did not return within ${Math.round(tuning.reconnectMs / 1000)} s.`,
        { cause: error },
      );
    }
    const wait =
      tuning.backoffMs[Math.min(backoffIndex, tuning.backoffMs.length - 1)] ??
      1_000;
    backoffIndex += 1;
    await delay(wait, undefined, { signal: master.signal });
  };

  try {
    while (true) {
      try {
        if (deadlineReached && firstAttemptDone) {
          return timeoutResult(null);
        }
        if (!server) {
          server = await options.resolveServer(master.signal);
          if (!server) {
            firstAttemptDone = true;
            await waitBeforeRetry(new Error("Roughdraft is not running."));
            continue;
          }
        }
        lastServerUrl = server.publicUrl;
        transport =
          server.capabilities.reviewEventStream === true
            ? "stream"
            : "long-poll";
        if (transport === "long-poll") {
          // The status tells us the instance before the first poll.
          noteInstance(server.instanceId, null);
        }
        const attempt =
          transport === "stream"
            ? await streamAttempt(server)
            : await pollAttempt(server);
        if (attempt.kind === "events") return finishEvents(attempt);
        if (attempt.kind === "timeout") {
          return timeoutResult(attempt.nextSequence);
        }
        if (attempt.kind === "ended") {
          // The server closed the stream (a restart, usually). Find it again.
          firstAttemptDone = true;
          server = null;
          await waitBeforeRetry(new Error("The event stream ended."));
        }
      } catch (error) {
        if (master.signal.aborted) {
          const reason = master.signal.reason;
          if (reason instanceof DeadlineReached) {
            return timeoutResult(null);
          }
          throw reason ?? error;
        }
        if (error instanceof CliError) throw error;
        if (error instanceof HttpStatusError) {
          if (![502, 503, 504].includes(error.status)) {
            let body: unknown = error.body;
            try {
              body =
                typeof error.body === "string" && error.body
                  ? JSON.parse(error.body)
                  : error.body;
            } catch {}
            throw httpError(
              "Watching for Done Reviewing",
              { status: error.status, body },
              server?.publicUrl,
            );
          }
        } else if (!isAbortError(error) && !(error instanceof TypeError)) {
          // Body read failures ("terminated") and socket errors are retried;
          // anything else is a bug worth surfacing.
          const message = error instanceof Error ? error.message : "";
          if (!/terminated|socket|ECONN|EPIPE|closed/i.test(message)) {
            throw error;
          }
        }
        firstAttemptDone = true;
        server = null;
        await waitBeforeRetry(error);
      }
    }
  } catch (error) {
    if (master.signal.aborted) {
      const reason = master.signal.reason;
      if (reason instanceof DeadlineReached) return timeoutResult(null);
      throw reason ?? error;
    }
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (graceTimer) clearTimeout(graceTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
