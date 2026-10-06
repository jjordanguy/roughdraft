import crypto from "node:crypto";
import fs from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRoughdraftDocumentComment,
  extractRoughdraftReviewIndex,
} from "@roughdraft/rfm";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  type DocumentChange,
  type DocumentRead,
  type DocumentState,
  DocumentWatcher,
  hashFromVersion,
} from "./document-watcher.js";
import {
  type DocumentIdentity,
  type DocumentRecord,
  eventForHandoff,
  type HandoffRecord,
  isUnacknowledged,
  ReviewLog,
  type SessionRecord,
} from "./handoff-log.js";
import {
  hasNonLoopbackHost,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_PUBLIC_HOST,
  resolveBindHosts,
} from "./network.js";
import {
  DocumentRegistry,
  documentKey,
  documentUrl,
  identityFor,
} from "./registry.js";
import {
  normalizeTimeoutMs,
  type ReviewCompletedEvent,
  ReviewEventQueue,
} from "./review-events.js";
import { TabChannel, type TargetResult } from "./tab-channel.js";
import { resolveUpdateStatus } from "./update-status.js";
import {
  doneMessage,
  type RunWakeOptions,
  runWakeRoute,
  WakeRouteStore,
  wakeRouteRouter,
} from "./wake-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../../app/dist");
const defaultServerRoot = path.resolve(__dirname, "../../..");

function mergeBySequence(
  ...lists: ReviewCompletedEvent[][]
): ReviewCompletedEvent[] {
  const bySequence = new Map<number, ReviewCompletedEvent>();
  for (const event of lists.flat()) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

function readServerVersion(packageJsonPath?: string): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        packageJsonPath ?? path.join(defaultServerRoot, "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {}
  return "0.0.0";
}

interface AssetPayload {
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

interface FileSystemEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface FileSystemListing {
  path: string;
  displayPath: string;
  parentPath: string | null;
  directories: FileSystemEntry[];
  files: FileSystemEntry[];
}

interface ProjectTreeListing {
  paths: string[];
}

interface CreateAppOptions {
  port?: number;
  projectDir?: string;
  serverRoot?: string;
  homeDir?: string;
  staticDirPath?: string;
  packageJsonPath?: string;
  fetchImpl?: typeof fetch;
  packageName?: string;
  version?: string;
  /** Directory for review-log.json and wake-routes.json. Memory only when omitted. */
  stateDir?: string;
  /** When set, every /api/* route requires `Authorization: Bearer <token>`. */
  apiToken?: string;
  keepaliveMs?: number;
  sweepIntervalMs?: number;
  openRequestAckMs?: number;
  deliveryWaitMs?: number;
  wakeTimeoutMs?: number;
  /** Document watcher stat poll (default 1 s). */
  watchPollMs?: number;
  /** Document watcher rehash while subscribed (default 10 s). */
  watchRehashMs?: number;
  /** How long a document watch outlives its last subscriber (default 30 s). */
  watchReleaseMs?: number;
  /** Tab channel `ping` interval (default 15 s). */
  tabPingMs?: number;
}

interface CreateAppResult {
  app: Express;
  port: number;
  /** Serves the `/api/tab` WebSocket on an http server running `app`. */
  attachTabChannel: (server: Server) => void;
}

interface OpenRequestClient {
  id: number;
  key: string | null;
  tabId: string;
  response: Response;
}

interface OpenRequestPayload {
  path?: string;
  url?: string;
}

const MAX_OVERALL_COMMENT_LENGTH = 4_000;
const MAX_HANDOFF_ID_LENGTH = 200;
const KEEPALIVE_MS = 15_000;
const SWEEP_INTERVAL_MS = 60_000;
const OPEN_REQUEST_ACK_MS = 1_000;
const DELIVERY_WAIT_MS = 2_000;

let nextOpenRequestClientId = 1;

function writeSseEvent(
  response: Response,
  event: string,
  data: unknown,
  id?: number,
): void {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  response.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startEventStream(res: Response, retryMs: number): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`retry: ${retryMs}\n\n`);
}

function isOpen(res: Response): boolean {
  return !res.destroyed && !res.writableEnded;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  if (header.startsWith("Bearer "))
    return header.slice("Bearer ".length).trim();
  return req.method === "GET" && typeof req.query.token === "string"
    ? req.query.token
    : "";
}

function listMdFiles(projectDir: string): string[] {
  try {
    return fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function titleFromContent(content: string, fallback: string): string {
  const firstLine = content.split("\n")[0] || "";
  return firstLine.replace(/^#*\s*/, "").trim() || fallback;
}

function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${contentHash}`;
}

/** The markdown-file page for a watcher read of a readable file. */
function pageFromRead(
  relativePath: string,
  read: DocumentRead,
  instanceId: string,
) {
  const content = read.content ?? "";
  return {
    id: pageIdFromRelativePath(relativePath),
    title: titleFromContent(content, path.basename(relativePath, ".md")),
    content,
    version: read.state.version ?? "",
    contentHash: read.state.contentHash ?? "",
    seq: read.state.seq,
    instanceId,
  };
}

/** The fields of a change, shared by the tab channel and the legacy stream. */
function changeFromState(
  state: DocumentState,
  origin: DocumentChange["origin"],
): DocumentChange {
  return {
    seq: state.seq,
    exists: state.exists,
    available: state.available,
    reason: state.reason,
    version: state.version,
    contentHash: state.contentHash,
    origin,
  };
}

/**
 * The content hash a write is based on: `expectedContentHash`, else the hash
 * segment of `expectedVersion`, else null (no check).
 */
function expectedHashFromBody(body: unknown): string | null {
  const fields = (body ?? {}) as Record<string, unknown>;
  const explicit = optionalString(fields.expectedContentHash);
  if (explicit) return explicit.toLowerCase();
  const version = optionalString(fields.expectedVersion);
  if (!version) return null;
  // A version without a hash segment can never match: keep the old 409.
  return hashFromVersion(version) ?? version;
}

function normalizeOverallComment(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function markdownPageFromFile(
  relativePath: string,
  absolutePath: string,
): {
  id: string;
  title: string;
  content: string;
  version: string;
} {
  const content = fs.readFileSync(absolutePath, "utf-8");
  const stats = fs.statSync(absolutePath);
  const fallbackTitle = path.basename(relativePath, ".md");

  return {
    id: pageIdFromRelativePath(relativePath),
    title: titleFromContent(content, fallbackTitle),
    content,
    version: fileVersionFromContent(stats, content),
  };
}

function pageIdFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "").split(path.sep).join("/");
}

function nextUntitledId(projectDir: string): string {
  const existing = listMdFiles(projectDir);
  let i = 1;
  while (existing.includes(`untitled-${i}`)) i++;
  return `untitled-${i}`;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureProjectPath(
  projectDir: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replace(/^\.?\//, "");
  const absolute = path.resolve(projectDir, normalized);
  const relative = path.relative(projectDir, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolute;
}

function pageFilePathFromId(projectDir: string, id: string): string | null {
  return ensureProjectPath(projectDir, `${id}.md`);
}

function nextAssetPath(projectDir: string, filename: string): string {
  const assetsDir = path.join(projectDir, ".roughdraft-assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const safeName = sanitizeFilename(filename);
  const extensionIndex = safeName.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";

  let counter = 0;
  while (true) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const relativePath = `.roughdraft-assets/${basename}${suffix}${extension}`;
    const absolutePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return relativePath;
    }
    counter += 1;
  }
}

function ensureDirectoryExists(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(dir: string): DirectoryListing {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parentPath = path.dirname(dir);

  return {
    path: dir,
    parentPath: parentPath === dir ? null : parentPath,
    directories: entries,
  };
}

function formatDisplayPath(targetPath: string, homeDir: string): string {
  const normalizedHome = path.resolve(homeDir);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget === normalizedHome) {
    return "~";
  }

  const relativeToHome = path.relative(normalizedHome, normalizedTarget);
  if (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `~/${relativeToHome.split(path.sep).join("/")}`;
  }

  return normalizedTarget;
}

function listFileSystem(dir: string, homeDir: string): FileSystemListing {
  const normalizedDir = path.resolve(dir);
  const normalizedHome = path.resolve(homeDir);

  let rawEntries: fs.Dirent[];
  try {
    rawEntries = fs.readdirSync(normalizedDir, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "EACCES" || errorCode === "EPERM") {
      throw new Error("Directory is not readable.");
    }
    throw error;
  }

  const directories = rawEntries
    .filter((entry) => entry.isDirectory())
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "directory",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const files = rawEntries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"),
    )
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    path: normalizedDir,
    displayPath: formatDisplayPath(normalizedDir, normalizedHome),
    parentPath:
      normalizedDir === normalizedHome ? null : path.dirname(normalizedDir),
    directories,
    files,
  };
}

function toCanonicalRelativePath(
  projectDir: string,
  absolutePath: string,
  isDirectory: boolean,
): string {
  const relativePath = path.relative(projectDir, absolutePath);
  const canonicalPath = relativePath.split(path.sep).join("/");
  return isDirectory ? `${canonicalPath}/` : canonicalPath;
}

function listProjectTree(projectDir: string): ProjectTreeListing {
  const paths: string[] = [];

  const visitDirectory = (dir: string) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .slice()
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
        });
      });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, true));
        visitDirectory(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, false));
      }
    }
  };

  visitDirectory(projectDir);

  return { paths };
}

export function createApp(options: CreateAppOptions = {}): CreateAppResult {
  const port = options.port ?? ROUGHDRAFT_DEFAULT_PORT;
  const homeDir = options.homeDir ?? os.homedir();
  const serverRoot = path.resolve(options.serverRoot ?? defaultServerRoot);
  const staticDirPath = options.staticDirPath ?? staticDir;
  const fetchImpl = options.fetchImpl ?? fetch;
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : null;
  const apiToken = optionalString(options.apiToken);
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const app = express();
  const serverVersion =
    options.version ?? readServerVersion(options.packageJsonPath);
  const instanceId = `srv_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
  const publicBaseUrl = `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
  const openRequestClients = new Set<OpenRequestClient>();
  const openRequestAcks = new Map<string, () => void>();
  const log = new ReviewLog({ stateDir: stateDir ?? undefined });
  const registry = new DocumentRegistry({ log, publicBaseUrl });
  const reviewEvents = new ReviewEventQueue({
    nextSequence: log.peekNextSequence(),
    seed: log.unacknowledgedEvents(),
  });
  const wakeRoutes = new WakeRouteStore({ stateDir: stateDir ?? undefined });
  const documents = new DocumentWatcher({
    pollMs: options.watchPollMs,
    rehashMs: options.watchRehashMs,
    releaseMs: options.watchReleaseMs,
  });
  const tabChannel = new TabChannel({
    watcher: documents,
    registry,
    log,
    instanceId,
    latestSequence: () => reviewEvents.latestSequence(),
    resolveTarget: (url) =>
      resolveMarkdownTarget(
        url.searchParams.get("projectPath") ?? "",
        url.searchParams.get("path") ?? "",
        { allowMissing: true },
      ),
    authorize: (req: IncomingMessage, url: URL) => {
      if (!apiToken) return true;
      const header = req.headers.authorization ?? "";
      const supplied = header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : (url.searchParams.get("token") ?? "");
      return tokenMatches(supplied, apiToken);
    },
    acknowledgeOpenRequest: (requestId) => openRequestAcks.get(requestId)?.(),
    pingMs: options.tabPingMs ?? keepaliveMs,
  });

  /** Tells the tabs on a document that one of its handoffs changed. */
  function announceHandoff(handoff: HandoffRecord | null | undefined): void {
    if (!handoff) return;
    const found = log.findHandoff({ handoffId: handoff.handoffId });
    if (found) tabChannel.broadcastHandoff(found.document.key, found.handoff);
  }

  const wakeRunOptions = (): RunWakeOptions => ({
    timeoutMs: options.wakeTimeoutMs,
    fetchImpl,
  });

  const sweeper = setInterval(
    () => registry.sweep(),
    options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
  );
  sweeper.unref?.();

  if (apiToken) {
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      if (tokenMatches(requestToken(req), apiToken)) {
        next();
        return;
      }
      res.status(401).json({
        error:
          "This Roughdraft server requires a token. Send Authorization: Bearer <ROUGHDRAFT_TOKEN>; event streams may pass ?token=... instead.",
        code: "UNAUTHORIZED",
      });
    });
  }

  app.use(express.json({ limit: "50mb" }));

  function requestedProjectPath(req: Request): string | null {
    const queryPath =
      typeof req.query.projectPath === "string"
        ? req.query.projectPath.trim()
        : "";
    const bodyPath =
      typeof req.body?.projectPath === "string"
        ? req.body.projectPath.trim()
        : "";
    const nextPath = queryPath || bodyPath;
    return nextPath.length > 0 ? nextPath : null;
  }

  function projectDirFromRequest(
    req: Request,
    res: Response,
    options?: { mustExist?: boolean },
  ): string | null {
    const nextProjectPath = requestedProjectPath(req);
    if (!nextProjectPath) {
      res.status(400).json({ error: "projectPath is required" });
      return null;
    }

    const resolvedProjectDir = path.resolve(nextProjectPath);
    const mustExist = options?.mustExist ?? true;

    if (mustExist && !isExistingDirectory(resolvedProjectDir)) {
      res.status(404).json({ error: "Project directory not found" });
      return null;
    }

    return resolvedProjectDir;
  }

  interface MarkdownLocation {
    relativePath: string;
    absolutePath: string;
    projectDir: string;
  }

  type Located =
    | { ok: true; location: MarkdownLocation }
    | { ok: false; status: number; error: string };

  /** A `.md` path inside an existing project; the file may be missing when allowed. */
  function locateMarkdown(
    projectPath: string,
    relativePath: string,
    options: { allowMissing?: boolean } = {},
  ): Located {
    if (projectPath.trim().length === 0) {
      return { ok: false, status: 400, error: "projectPath is required" };
    }
    const projectDir = path.resolve(projectPath.trim());
    if (!isExistingDirectory(projectDir)) {
      return { ok: false, status: 404, error: "Project directory not found" };
    }
    const absolutePath = ensureProjectPath(projectDir, relativePath);
    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      return { ok: false, status: 404, error: "Markdown file not found" };
    }
    if (!options.allowMissing && !fs.existsSync(absolutePath)) {
      return { ok: false, status: 404, error: "Markdown file not found" };
    }
    return { ok: true, location: { relativePath, absolutePath, projectDir } };
  }

  function resolveMarkdownTarget(
    projectPath: string,
    relativePath: string,
    options: { allowMissing?: boolean } = {},
  ): TargetResult {
    const located = locateMarkdown(projectPath, relativePath, options);
    if (!located.ok) return located;
    const { absolutePath, projectDir } = located.location;
    return {
      ok: true,
      target: {
        absolutePath,
        identity: identityFor(absolutePath, projectDir, relativePath),
      },
    };
  }

  function markdownTargetFromRequest(
    req: Request,
    res: Response,
    options: { allowMissing?: boolean } = {},
  ): MarkdownLocation | null {
    const relativePath =
      typeof req.query.path === "string"
        ? req.query.path
        : typeof req.body?.path === "string"
          ? req.body.path
          : "";
    const located = locateMarkdown(
      requestedProjectPath(req) ?? "",
      relativePath,
      options,
    );
    if (!located.ok) {
      res.status(located.status).json({ error: located.error });
      return null;
    }
    return located.location;
  }

  function markdownPathFromRequest(
    req: Request,
    res: Response,
  ): MarkdownLocation | null {
    return markdownTargetFromRequest(req, res);
  }

  function unavailableBody(state: DocumentState) {
    return {
      error: "Markdown file could not be read",
      exists: state.exists,
      available: false,
      reason: state.reason,
      instanceId,
    };
  }

  type MarkdownTarget = NonNullable<ReturnType<typeof markdownPathFromRequest>>;

  function targetIdentity(target: MarkdownTarget): DocumentIdentity {
    return identityFor(
      target.absolutePath,
      target.projectDir,
      target.relativePath,
    );
  }

  function resolveUserPath(rawPath: string): string {
    if (rawPath === "~") return homeDir;
    if (rawPath.startsWith("~/")) return path.join(homeDir, rawPath.slice(2));
    return path.resolve(rawPath);
  }

  function handoffsFor(events: ReviewCompletedEvent[]): HandoffRecord[] {
    return events
      .map((event) => log.findHandoff({ sequence: event.sequence })?.handoff)
      .filter((handoff): handoff is HandoffRecord => handoff !== undefined);
  }

  function recordDelivery(
    events: ReviewCompletedEvent[],
    watcherId: string,
    ackedBy: string | null,
  ): void {
    for (const event of events) {
      const handoff = log.markDelivered(event.sequence, watcherId);
      if (handoff && ackedBy) log.acknowledge(handoff, ackedBy);
      announceHandoff(handoff);
    }
  }

  /**
   * Starting point for a watcher: an explicit cursor wins, otherwise `fromNow`
   * (the default) means "only events after this moment".
   */
  function resolveAfterSequence(
    explicit: number | undefined,
    fromNow: unknown,
  ): number {
    if (explicit !== undefined) return Math.max(0, explicit);
    return fromNow === false || fromNow === "false" || fromNow === "0"
      ? 0
      : reviewEvents.latestSequence();
  }

  function pendingEvents(document: DocumentRecord | undefined) {
    if (!document) return [];
    return document.handoffs
      .filter(isUnacknowledged)
      .map((handoff) => eventForHandoff(document, handoff));
  }

  function longPollBody(events: ReviewCompletedEvent[], timedOut: boolean) {
    return {
      events,
      timedOut,
      nextSequence: reviewEvents.peekNextSequence(),
      instanceId,
      handoffs: handoffsFor(events),
    };
  }

  /**
   * Ends a long poll and resolves true once the body has been flushed. Legacy
   * clients never acknowledge, so for them a finished response is the ack.
   */
  function finishLongPoll(
    res: Response,
    events: ReviewCompletedEvent[],
    timedOut: boolean,
    delivery: { watcherId: string; legacyAck: boolean },
  ): Promise<boolean> {
    if (!isOpen(res)) return Promise.resolve(false);
    return new Promise((resolve) => {
      res.once("finish", () => {
        recordDelivery(
          events,
          delivery.watcherId,
          delivery.legacyAck ? "long-poll" : null,
        );
        resolve(true);
      });
      res.once("close", () => {
        if (!res.writableFinished) resolve(false);
      });
      if (!res.headersSent) {
        res.status(200);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      res.end(JSON.stringify(longPollBody(events, timedOut)));
    });
  }

  function wakeRouteIdFor(session: SessionRecord | null | undefined) {
    return session && wakeRoutes.get(session.harness) ? session.harness : null;
  }

  async function fireWake(key: string, sequence: number): Promise<void> {
    const document = log.get(key);
    const handoff = log.findHandoff({ sequence })?.handoff;
    const session = document?.session;
    if (!document || !handoff || !session) return;
    const route = wakeRoutes.get(session.harness);
    const at = () => new Date().toISOString();
    if (!route) {
      log.setWake(sequence, {
        routeId: null,
        state: "failed",
        at: at(),
        error: `No wake route for ${session.harness}`,
      });
      announceHandoff(handoff);
      return;
    }
    const outcome = await runWakeRoute(
      route,
      {
        event: "done",
        message: doneMessage(
          document.documentPath,
          handoff.summary,
          handoff.overallComment,
        ),
        documentPath: document.documentPath,
        link: documentUrl(publicBaseUrl, document.documentPath),
        counts: {
          comments: handoff.summary.comments,
          suggestions: handoff.summary.suggestions,
          unresolved: handoff.summary.unresolved,
        },
        handoffId: handoff.handoffId,
        session: {
          harness: session.harness,
          label: session.label,
          sessionId: session.sessionId,
        },
      },
      wakeRunOptions(),
    );
    log.setWake(sequence, {
      routeId: route.harness,
      state: outcome.sent ? "sent" : "failed",
      at: at(),
      error: outcome.error,
    });
    announceHandoff(handoff);
    wakeRoutes.recordOutcome(route.harness, outcome);
  }

  function doneResponse(
    document: DocumentIdentity,
    handoff: HandoffRecord,
    delivered: boolean,
    event: ReviewCompletedEvent = eventForHandoff(document, handoff),
  ) {
    return {
      delivered,
      pending: handoff.state === "pending",
      event,
      handoff,
      wake: handoff.wake,
      instanceId,
    };
  }

  // --- API routes ---

  app.get("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const ids = listMdFiles(projectDir);
    const pages = ids.map((id) => {
      const content = fs.readFileSync(
        path.join(projectDir, `${id}.md`),
        "utf-8",
      );
      return { id, title: titleFromContent(content, id), content };
    });
    res.json(pages);
  });

  app.get("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.get("/api/markdown-file", async (req, res) => {
    const target = markdownTargetFromRequest(req, res);
    if (!target) return;

    const read = await documents.read(target.absolutePath);
    if (!read.state.exists) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }
    if (!read.state.available) {
      res.status(503).json(unavailableBody(read.state));
      return;
    }
    registry.recordVersion(targetIdentity(target), read.state.version);
    res.json(pageFromRead(target.relativePath, read, instanceId));
  });

  app.get("/api/markdown-file/state", async (req, res) => {
    const target = markdownTargetFromRequest(req, res, { allowMissing: true });
    if (!target) return;

    const state = await documents.refresh(target.absolutePath);
    const key = targetIdentity(target).key;
    res.json({
      exists: state.exists,
      available: state.available,
      reason: state.reason,
      version: state.version,
      contentHash: state.contentHash,
      seq: state.seq,
      instanceId,
      tabs: registry.tabCount(key),
      tabsDirty: registry.tabsDirty(key),
    });
  });

  // Legacy stream, kept for one release. The fork's app uses /api/tab.
  app.get("/api/markdown-file/events", async (req, res) => {
    const target = markdownTargetFromRequest(req, res, { allowMissing: true });
    if (!target) return;

    startEventStream(res, 1000);
    const identity = targetIdentity(target);
    const send = (change: DocumentChange) => {
      if (change.available && change.exists) {
        registry.recordVersion(identity, change.version);
      }
      if (!isOpen(res)) return;
      writeSseEvent(
        res,
        "change",
        { path: target.relativePath, ...change, instanceId },
        change.seq,
      );
    };

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const ping = setInterval(() => {
      if (!isOpen(res)) return;
      writeSseEvent(res, "ping", {
        seq: documents.current(target.absolutePath)?.seq ?? 0,
      });
    }, keepaliveMs);
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      unsubscribe?.();
    });

    const opened = await documents.open(target.absolutePath, send);
    unsubscribe = opened.unsubscribe;
    if (closed) {
      unsubscribe();
      return;
    }
    send(changeFromState(opened.state, "unknown"));
    opened.start();
  });

  app.get("/api/review-index", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const read = await documents.read(target.absolutePath);
    if (!read.state.exists) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }
    if (!read.state.available) {
      res.status(503).json(unavailableBody(read.state));
      return;
    }
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      fileVersion: read.state.version,
      ...extractRoughdraftReviewIndex(read.content ?? ""),
    });
  });

  app.post("/api/review-events", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const overallComment = normalizeOverallComment(req.body?.overallComment);
    if (
      overallComment !== undefined &&
      overallComment.length > MAX_OVERALL_COMMENT_LENGTH
    ) {
      res.status(400).json({
        error: `overallComment must be ${MAX_OVERALL_COMMENT_LENGTH} characters or fewer`,
      });
      return;
    }

    const suppliedHandoffId = optionalString(req.body?.handoffId);
    if (suppliedHandoffId && suppliedHandoffId.length > MAX_HANDOFF_ID_LENGTH) {
      res.status(400).json({
        error: `handoffId must be ${MAX_HANDOFF_ID_LENGTH} characters or fewer`,
      });
      return;
    }
    const replay = suppliedHandoffId
      ? log.findHandoff({ handoffId: suppliedHandoffId })
      : null;
    if (replay) {
      res
        .status(200)
        .json(
          doneResponse(
            replay.document,
            replay.handoff,
            replay.handoff.deliveredTo.length > 0,
          ),
        );
      return;
    }

    // Optional: a tab that sends its base turns a Done on a file that moved
    // under it into a 409 instead of handing off text it has not seen.
    const expectedHash = expectedHashFromBody(req.body);
    const written = overallComment
      ? await documents.mutate(
          target.absolutePath,
          (markdown) =>
            appendRoughdraftDocumentComment(markdown, {
              message: overallComment,
              author: "user",
            }),
          { expectedHash, tabId: optionalString(req.body?.tabId) },
        )
      : null;
    const read = written?.read ?? (await documents.read(target.absolutePath));
    if (!read.state.exists) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }
    if (!read.state.available) {
      res.status(503).json(unavailableBody(read.state));
      return;
    }
    if (
      written?.status === "conflict" ||
      (!written &&
        expectedHash !== null &&
        expectedHash !== read.state.contentHash)
    ) {
      res.status(409).json({
        error: "Markdown file changed on disk",
        current: pageFromRead(target.relativePath, read, instanceId),
      });
      return;
    }
    const persistedMarkdown = read.content ?? "";

    const identity = targetIdentity(target);
    const index = extractRoughdraftReviewIndex(persistedMarkdown);
    const version = read.state.version ?? "";
    const superseded = log.unacknowledged(identity.key);
    const handoff = log.recordHandoff(identity, {
      handoffId: suppliedHandoffId ?? crypto.randomUUID(),
      version,
      summary: index.summary,
      overallComment: overallComment ?? null,
      wakeRouteId: wakeRouteIdFor(log.get(identity.key)?.session),
    });
    for (const older of superseded) announceHandoff(older);
    announceHandoff(handoff);
    const result = reviewEvents.emit(
      {
        documentPath: target.absolutePath,
        projectPath: target.projectDir,
        relativePath: target.relativePath,
        version,
        summary: index.summary,
        overallComment,
      },
      {
        documentKey: identity.key,
        sequence: handoff.sequence,
        createdAt: handoff.createdAt,
      },
    );
    const delivered = await withTimeout(
      result.delivery,
      options.deliveryWaitMs ?? DELIVERY_WAIT_MS,
      false,
    );

    res
      .status(201)
      .json(doneResponse(identity, handoff, delivered, result.event));
    if (handoff.wake.routeId) {
      setImmediate(() => {
        void fireWake(identity.key, handoff.sequence);
      });
    }
  });

  app.post("/api/review-events/watch", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const identity = targetIdentity(target);
    const legacyAck = !("includePending" in body);
    const afterSequence = resolveAfterSequence(
      optionalNumber(body.afterSequence),
      body.fromNow,
    );
    const timeoutSeconds = optionalNumber(body.timeoutSeconds);
    const batchWindowSeconds = optionalNumber(body.batchWindowSeconds) ?? 0.25;

    const pending =
      body.includePending === true
        ? pendingEvents(log.get(identity.key)).slice(-1)
        : [];
    const ready =
      pending.length > 0
        ? pending
        : reviewEvents.eventsAfter({
            documentKey: identity.key,
            afterSequence,
          });
    if (ready.length > 0) {
      void finishLongPoll(res, ready, false, {
        watcherId: `w_${crypto.randomUUID().slice(0, 12)}`,
        legacyAck,
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders();

    const watcher = registry.addWatcher(identity, {
      kind: "long-poll",
      client: optionalString(body.client),
      afterSequence,
    });
    const controller = new AbortController();
    const keepalive = setInterval(() => res.write("\n"), keepaliveMs);
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
      watcher.remove();
    };
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
      cleanup();
    });

    const delivery = { watcherId: watcher.watcherId, legacyAck };
    const subscription = reviewEvents.subscribe({
      documentKey: identity.key,
      afterSequence,
      batchWindowMs: batchWindowSeconds * 1000,
      once: true,
      signal: controller.signal,
      onMatch: () => {
        if (timer) clearTimeout(timer);
      },
      deliver: (events) => {
        cleanup();
        return finishLongPoll(res, events, false, delivery);
      },
    });
    if (timeoutSeconds !== undefined) {
      timer = setTimeout(
        () => {
          subscription?.close();
          cleanup();
          void finishLongPoll(res, [], true, delivery);
        },
        normalizeTimeoutMs(timeoutSeconds * 1000),
      );
    }
  });

  app.get("/api/review-events/stream", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const identity = targetIdentity(target);
    const afterSequence = resolveAfterSequence(
      optionalNumber(req.get("last-event-id")) ??
        optionalNumber(req.query.afterSequence),
      req.query.fromNow,
    );
    const timeoutSeconds = optionalNumber(req.query.timeoutSeconds);

    startEventStream(res, 2000);
    const watcher = registry.addWatcher(identity, {
      kind: "stream",
      client: optionalString(req.query.client),
      afterSequence,
    });
    writeSseEvent(res, "hello", {
      instanceId,
      logId: log.logId,
      latestSequence: reviewEvents.latestSequence(),
      afterSequence,
      pending: log.unacknowledged(identity.key),
    });

    const sendEvents = (events: ReviewCompletedEvent[]): boolean => {
      if (!isOpen(res)) return false;
      for (const event of events) {
        const handoff = log.markDelivered(event.sequence, watcher.watcherId);
        writeSseEvent(
          res,
          "review.completed",
          { ...event, handoff },
          event.sequence,
        );
        announceHandoff(handoff);
      }
      return true;
    };

    const initial = mergeBySequence(
      reviewEvents.eventsAfter({ documentKey: identity.key, afterSequence }),
      isTruthyFlag(req.query.includePending)
        ? pendingEvents(log.get(identity.key))
        : [],
    );
    if (initial.length > 0) sendEvents(initial);

    const controller = new AbortController();
    reviewEvents.subscribe({
      documentKey: identity.key,
      afterSequence: Math.max(afterSequence, initial.at(-1)?.sequence ?? 0),
      batchWindowMs: 0,
      signal: controller.signal,
      deliver: sendEvents,
    });
    const keepalive = setInterval(
      () => res.write(": keepalive\n\n"),
      keepaliveMs,
    );
    const timer =
      timeoutSeconds !== undefined
        ? setTimeout(
            () => {
              writeSseEvent(res, "timeout", {
                nextSequence: reviewEvents.peekNextSequence(),
              });
              res.end();
            },
            normalizeTimeoutMs(timeoutSeconds * 1000),
          )
        : null;

    res.on("close", () => {
      controller.abort();
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
      watcher.remove();
    });
  });

  app.post("/api/review-events/ack", (req, res) => {
    const handoffId = optionalString(req.body?.handoffId);
    const sequence = optionalNumber(req.body?.sequence);
    if (!handoffId && sequence === undefined) {
      res
        .status(400)
        .json({ error: "handoffId or sequence is required", code: "USAGE" });
      return;
    }
    const found = log.findHandoff(handoffId ? { handoffId } : { sequence });
    if (!found) {
      res
        .status(404)
        .json({ error: "Handoff not found", code: "HANDOFF_NOT_FOUND" });
      return;
    }
    registry.touch(found.document, { keepExistingIdentity: true });
    const handoff = log.acknowledge(
      found.handoff,
      optionalString(req.body?.by),
    );
    announceHandoff(handoff);
    res.json({ ok: true, handoff });
  });

  app.get("/api/review-events/status", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const key = targetIdentity(target).key;
    const watcherCount = registry.watcherCount(key);
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      watching: watcherCount > 0,
      watcherCount,
      tabs: registry.tabCount(key),
      tabsDirty: registry.tabsDirty(key),
      handoff: log.latestHandoff(key),
      session: log.get(key)?.session ?? null,
      latestSequence: reviewEvents.latestSequence(),
      instanceId,
    });
  });

  app.get("/api/documents", (_req, res) => {
    res.json({ instanceId, logId: log.logId, documents: registry.list() });
  });

  app.get("/api/documents/one", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const view = registry.view(targetIdentity(target).key);
    if (!view) {
      res
        .status(404)
        .json({ error: "Document not tracked", code: "DOCUMENT_NOT_FOUND" });
      return;
    }
    res.json(view);
  });

  app.post("/api/documents/session", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const harness = optionalString(req.body?.harness);
    const label = optionalString(req.body?.label);
    if (!harness || !label) {
      res
        .status(400)
        .json({ error: "harness and label are required", code: "USAGE" });
      return;
    }
    const session = log.setSession(targetIdentity(target), {
      harness,
      label,
      link: optionalString(req.body?.link),
      sessionId: optionalString(req.body?.sessionId),
      routeId: wakeRoutes.get(harness) ? harness : null,
    });
    res.json({ ok: true, session });
  });

  app.use(
    "/api/wake-routes",
    wakeRouteRouter({
      store: wakeRoutes,
      tokenRequired: apiToken !== null,
      runOptions: wakeRunOptions,
    }),
  );

  app.put("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { content } = req.body as { content: string };
    fs.writeFileSync(filePath, content);
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.put("/api/markdown-file", async (req, res) => {
    const target = markdownTargetFromRequest(req, res);
    if (!target) return;

    const content = (req.body as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }

    // Equality is decided on the content hash, never on file metadata.
    const result = await documents.write(target.absolutePath, content, {
      expectedHash: expectedHashFromBody(req.body),
      tabId: optionalString(req.body?.tabId),
    });
    const { read } = result;
    if (result.status === "missing") {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }
    if (result.status === "unavailable") {
      res.status(503).json(unavailableBody(read.state));
      return;
    }
    const page = pageFromRead(target.relativePath, read, instanceId);
    if (result.status === "conflict") {
      res
        .status(409)
        .json({ error: "Markdown file changed on disk", current: page });
      return;
    }
    registry.recordVersion(targetIdentity(target), read.state.version);
    res.json(page);
  });

  app.post("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const { title, content: bodyContent } = req.body as {
      title?: string;
      content?: string;
    };
    const id = nextUntitledId(projectDir);
    const content = bodyContent || `# ${title || "Untitled"}\n`;
    const filePath = path.join(projectDir, `${id}.md`);
    fs.writeFileSync(filePath, content);

    res.status(201).json(markdownPageFromFile(`${id}.md`, filePath));
  });

  app.delete("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    fs.unlinkSync(filePath);

    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      backend: "local-files",
      pid: process.pid,
      port,
      projectDir: options.projectDir
        ? path.resolve(options.projectDir)
        : undefined,
      serverRoot,
      version: serverVersion,
      instanceId,
      stateless: true,
      stateDir,
      capabilities: {
        projectPathRequired: true,
        fileSystemBrowsing: true,
        reviewEventStream: true,
        documentRegistry: true,
        handoffLog: true,
        wakeRoutes: true,
        tokenRequired: apiToken !== null,
      },
      warnings: [...log.warnings, ...wakeRoutes.warnings],
    });
  });

  app.get("/api/open-requests", (req, res) => {
    const requestedPath = optionalString(req.query.path);
    const tabId =
      optionalString(req.query.tabId) ?? `tab_${nextOpenRequestClientId}`;
    const resolvedPath = requestedPath ? resolveUserPath(requestedPath) : null;
    const client: OpenRequestClient = {
      id: nextOpenRequestClientId,
      key: resolvedPath ? documentKey(resolvedPath) : null,
      tabId,
      response: res,
    };
    nextOpenRequestClientId += 1;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    writeSseEvent(res, "connected", { id: client.id, tabId });

    openRequestClients.add(client);
    const disconnectTab = resolvedPath
      ? registry.connectTab(identityFor(resolvedPath), {
          tabId,
          visible: req.query.visible !== "false",
        })
      : () => {};
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, keepaliveMs);

    res.on("close", () => {
      clearInterval(keepAlive);
      openRequestClients.delete(client);
      disconnectTab();
    });
  });

  function waitForOpenRequestAck(requestId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        openRequestAcks.delete(requestId);
        resolve(false);
      }, options.openRequestAckMs ?? OPEN_REQUEST_ACK_MS);
      openRequestAcks.set(requestId, () => {
        clearTimeout(timer);
        openRequestAcks.delete(requestId);
        resolve(true);
      });
    });
  }

  app.post("/api/open-request", async (req, res) => {
    const payload = req.body as OpenRequestPayload;
    const targetPath = optionalString(payload.path);
    const targetUrl = optionalString(payload.url);

    if (!targetPath || !targetUrl) {
      res.status(400).json({ error: "path and url are required" });
      return;
    }

    const resolvedPath = resolveUserPath(targetPath);
    const key = documentKey(resolvedPath);
    registry.recordOpenRequest(identityFor(resolvedPath));
    const clients = [...openRequestClients].filter(
      (client) => client.key === key && isOpen(client.response),
    );
    const tabs = new Set([
      ...tabChannel.tabIds(key),
      ...clients.map((client) => client.tabId),
    ]).size;

    // A tab on the WebSocket channel first, then a legacy SSE client.
    const requestId = crypto.randomUUID();
    const acknowledged = waitForOpenRequestAck(requestId);
    const request = { path: targetPath, url: targetUrl, requestId };
    let delivered = tabChannel.sendOpenRequest(key, request);
    const matchingClient = clients.at(-1);
    if (!delivered && matchingClient) {
      writeSseEvent(matchingClient.response, "open-request", request);
      delivered = true;
    }
    if (!delivered) {
      openRequestAcks.get(requestId)?.();
      await acknowledged;
      res.json({ delivered: false, acknowledged: false, tabs });
      return;
    }
    res.json({ delivered: true, acknowledged: await acknowledged, tabs });
  });

  app.post("/api/open-request/ack", (req, res) => {
    const requestId = optionalString(req.body?.requestId);
    const resolveAck = requestId ? openRequestAcks.get(requestId) : undefined;
    resolveAck?.();
    res.json({ ok: resolveAck !== undefined });
  });

  app.get("/api/update-status", async (_req, res) => {
    const updateStatus = await resolveUpdateStatus({
      fetchImpl,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
    });
    res.json(updateStatus);
  });

  app.get("/api/directories", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!isExistingDirectory(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json(listDirectories(requestedPath));
  });

  app.get("/api/fs/list", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!fs.existsSync(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    if (!isExistingDirectory(requestedPath)) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    try {
      res.json(listFileSystem(requestedPath, homeDir));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to read directory listing";
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/file-tree", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    res.json(listProjectTree(projectDir));
  });

  app.post("/api/project/open", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    if (!isExistingDirectory(absolutePath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.post("/api/project/create", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    ensureDirectoryExists(absolutePath);

    res.status(201).json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.get("/api/files", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    res.sendFile(absolutePath);
  });

  app.post("/api/assets", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const payload = req.body as AssetPayload;
    if (!payload.filename || !payload.dataBase64) {
      res.status(400).json({ error: "filename and dataBase64 are required" });
      return;
    }

    const relativePath = nextAssetPath(projectDir, payload.filename);
    const absolutePath = ensureProjectPath(projectDir, relativePath);
    if (!absolutePath) {
      res.status(400).json({ error: "Invalid asset path" });
      return;
    }

    const buffer = Buffer.from(payload.dataBase64, "base64");
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    res.status(201).json({
      markdownPath: `./${relativePath}`,
      previewUrl: `/api/files?projectPath=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(relativePath)}`,
      mimeType: payload.mimeType || "application/octet-stream",
    });
  });

  // --- Static files & SPA fallback ---

  app.use(express.static(staticDirPath));

  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticDirPath, "index.html"));
  });

  return {
    app,
    port,
    attachTabChannel: (server: Server) => tabChannel.attach(server),
  };
}

export const ROUGHDRAFT_TOKEN_ENV = "ROUGHDRAFT_TOKEN";

export const ROUGHDRAFT_STATE_DIR_ENV = "ROUGHDRAFT_STATE_DIR";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicitDir = env[ROUGHDRAFT_STATE_DIR_ENV]?.trim();
  if (explicitDir) return path.resolve(explicitDir);
  const explicitFile = env.ROUGHDRAFT_STATE_FILE?.trim();
  if (explicitFile) return path.dirname(path.resolve(explicitFile));
  return path.join(os.homedir(), ".roughdraft");
}

export async function createServer(
  port = ROUGHDRAFT_DEFAULT_PORT,
  projectDir?: string,
  stateDir = resolveStateDir(),
): Promise<void> {
  const bindHosts = resolveBindHosts();
  const token = process.env[ROUGHDRAFT_TOKEN_ENV]?.trim() ?? "";
  const exposed = hasNonLoopbackHost(bindHosts);

  if (exposed && token.length === 0) {
    throw new Error(
      [
        `Roughdraft refuses to bind ${bindHosts.join(", ")} without a token.`,
        "Non-loopback bindings expose every /api route, which can read and",
        "rewrite Markdown files and run wake routes on this machine. Set",
        "ROUGHDRAFT_TOKEN to a strong secret and pass the same value to your",
        "CLI before retrying, or remove ROUGHDRAFT_BIND_HOST to keep",
        "loopback-only.",
      ].join(" "),
    );
  }

  const { app, attachTabChannel } = createApp({
    port,
    projectDir,
    stateDir,
    apiToken: exposed ? token : undefined,
  });
  const listeningHosts: string[] = [];

  await Promise.all(
    bindHosts.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = createHttpServer(app);
          attachTabChannel(server);

          server.once("error", (error: NodeJS.ErrnoException) => {
            if (
              error.code === "EAFNOSUPPORT" ||
              error.code === "EADDRNOTAVAIL"
            ) {
              resolve();
              return;
            }

            reject(error);
          });

          server.listen(port, host, () => {
            listeningHosts.push(host);
            resolve();
          });
        }),
    ),
  );

  if (listeningHosts.length === 0) {
    throw new Error(
      `Roughdraft could not bind to any host (tried: ${bindHosts.join(", ")}).`,
    );
  }

  console.log(
    `\n  Roughdraft running at http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`,
  );
  console.log("  No active project is stored on the server.\n");
}
