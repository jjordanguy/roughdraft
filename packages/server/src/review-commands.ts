/**
 * The agent's review writes, shared by the CLI and the MCP server:
 *
 * - one-thread transactions (`reply`, `resolve`, `accept`, `reject`, `note`)
 *   on rfm's `applyReviewResponse` with a partial response;
 * - `feedback` (the round list without a round);
 * - `round` (clean copy, round list, response template, base, the open-round
 *   index the guard reads, the server's round flag) and `apply`;
 * - `doctor --fix` (normalization with a backup) and its dry-run report.
 *
 * Every write goes through `PUT /api/markdown-file` with
 * `expectedContentHash` when a fork server is running, rerun up to three
 * times on 409; with no server it writes a temp file in the same folder,
 * re-checks the target's hash and renames. Nothing here ever writes a file
 * the engine refused.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyReviewResponse,
  buildReviewRound,
  DEFAULT_AGENT_LABELS,
  normalizeRoughdraftMetadata,
  type RfmApplyError,
  type RfmApplyReport,
  type RfmApplyResult,
  type RfmNormalizationChange,
  type RfmNormalizationRefusal,
  type RfmRound,
  type RfmRoundThread,
  RoughdraftFormatError,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import { CliError, usageError } from "./errors.js";
import { clearOpenRound, recordOpenRound, roundsDir } from "./guard.js";
import {
  type ApiContext,
  ackHandoffs,
  apiRequest,
  authHeaders,
  collectHandoffs,
  createServerResolver,
  documentKey,
  getStateDir,
  httpError,
  listDocuments,
  type ServerStatus,
} from "./review-watch-client.js";

// ------------------------------------------------------------ plumbing

export interface ReviewDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  now?: () => number;
  /** A server on the preferred port reporting another install root is ignored. */
  serverRoot?: string;
}

/** Reruns after a 409 (or a changed hash on disk) before giving up. */
export const WRITE_RERUNS = 3;
/** Default seconds `apply` waits for a dirty tab to save. */
export const DEFAULT_APPLY_WAIT_SECONDS = 10;
const TAB_POLL_MS = 250;

interface ServerLink {
  server: ServerStatus;
  api: ApiContext;
}

function nowIso(deps: ReviewDeps): string {
  return new Date(deps.now?.() ?? Date.now()).toISOString();
}

/** The running fork server (it has the document registry), never starting one. */
async function findServer(deps: ReviewDeps): Promise<ServerLink | null> {
  const server = await createServerResolver({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    serverRoot: deps.serverRoot,
  })();
  if (!server || server.capabilities.documentRegistry !== true) return null;
  return {
    server,
    api: {
      fetchImpl: deps.fetchImpl,
      baseUrl: server.url,
      headers: authHeaders(deps.env),
    },
  };
}

export interface DocTarget {
  /** Absolute path as given (resolved against the cwd). */
  path: string;
  projectPath: string;
  relativePath: string;
}

export function resolveDocument(cwd: string, raw: string): DocTarget {
  if (!raw || raw.trim() === "")
    throw usageError("A Markdown file is required.");
  const absolute = path.resolve(cwd, raw);
  if (!absolute.toLowerCase().endsWith(".md")) {
    throw new CliError(
      "NOT_MARKDOWN",
      `Roughdraft only reviews .md files: ${absolute}`,
      { details: { path: absolute } },
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new CliError("PATH_NOT_FOUND", `Path not found: ${absolute}`, {
      details: { path: absolute },
    });
  }
  if (!stat.isFile()) {
    throw new CliError("NOT_MARKDOWN", `Path is not a file: ${absolute}`, {
      details: { path: absolute },
    });
  }
  return {
    path: absolute,
    projectPath: path.dirname(absolute),
    relativePath: path.basename(absolute),
  };
}

interface Snapshot {
  content: string;
  hash: string;
  version: string;
}

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** The hash segment of a `mtimeMs:size:sha256` version (or the value itself). */
export function hashOfVersion(version: string | null | undefined): string {
  if (!version) return "";
  const parts = version.split(":");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function readSnapshot(filePath: string): Snapshot {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  const hash = sha256(bytes);
  return {
    content: bytes.toString("utf8"),
    hash,
    version: `${stat.mtimeMs}:${stat.size}:${hash}`,
  };
}

type WriteOutcome =
  | { status: "written"; via: "server" | "disk"; version: string; hash: string }
  | { status: "conflict" };

async function writeDocument(
  link: ServerLink | null,
  target: DocTarget,
  content: string,
  expectedHash: string,
): Promise<WriteOutcome> {
  if (link) {
    const response = await apiRequest(link.api, "PUT", "/api/markdown-file", {
      body: {
        projectPath: target.projectPath,
        path: target.relativePath,
        content,
        expectedContentHash: expectedHash,
      },
    });
    if (response.status === 409) return { status: "conflict" };
    if (response.status < 200 || response.status >= 300) {
      throw httpError("Writing the document", response, link.api.baseUrl);
    }
    return {
      status: "written",
      via: "server",
      version: String(response.body?.version ?? ""),
      hash: String(response.body?.contentHash ?? sha256(content)),
    };
  }

  // No server: temp file beside the target, hash re-check, rename.
  const dir = path.dirname(target.path);
  const temp = path.join(
    dir,
    `.${path.basename(target.path)}.roughdraft-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const mode = fs.statSync(target.path).mode & 0o777;
  const fd = fs.openSync(temp, "w", mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (sha256(fs.readFileSync(target.path)) !== expectedHash) {
      fs.rmSync(temp, { force: true });
      return { status: "conflict" };
    }
    fs.renameSync(temp, target.path);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  const written = readSnapshot(target.path);
  return {
    status: "written",
    via: "disk",
    version: written.version,
    hash: written.hash,
  };
}

/** A refused engine run as a CLI error (exit 1, nothing written). */
function refusalError(
  report: RfmApplyReport,
  errors: RfmApplyError[],
  extra: Record<string, unknown> = {},
): CliError {
  const legacy = errors.find((error) => error.code === "legacy-format");
  const details = {
    ...report,
    ok: false,
    status: "refused",
    written: false,
    errors,
    ...extra,
  };
  if (legacy) {
    return new CliError(
      "LEGACY_FORMAT",
      "This file uses an older review format; run roughdraft doctor --fix first. Nothing was written.",
      {
        hint: "Run `roughdraft doctor --fix --dry-run <file>` to see what changes, then `roughdraft doctor --fix <file>`.",
        details,
      },
    );
  }
  const lines = errors.map((error) => {
    // The engine's messages often start with the unit already ("c2: ...").
    const message =
      error.thread && error.message.startsWith(`${error.thread}: `)
        ? error.message.slice(error.thread.length + 2)
        : error.message;
    return `  ${error.thread ? `${error.thread} ` : ""}${error.code}: ${message}${error.hint ? ` (${error.hint})` : ""}`;
  });
  return new CliError(
    "REVIEW_REFUSED",
    `Refused, nothing written (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    {
      hint:
        errors.find((error) => error.hint)?.hint ??
        "Fix what is listed and run the command again.",
      details,
    },
  );
}

/** A file the engine will not touch (old shape, needs a person, unreadable block). */
function formatError(error: RoughdraftFormatError): CliError {
  if (error.code === "legacy-format") {
    return new CliError(
      "LEGACY_FORMAT",
      "This file uses an older review format; run roughdraft doctor --fix first.",
      {
        hint: "Run `roughdraft doctor --fix --dry-run <file>` to see what changes, then `roughdraft doctor --fix <file>`.",
        details: {
          reason: error.code,
          line: error.line,
          changes: error.changes,
        },
      },
    );
  }
  return new CliError("REVIEW_REFUSED", error.message, {
    hint: "Run `roughdraft doctor <file>` to list every problem.",
    details: {
      reason: error.code,
      line: error.line,
      refused: error.refused,
      written: false,
    },
  });
}

interface TransactionOutcome {
  result: RfmApplyResult;
  written: boolean;
  via: "server" | "disk" | null;
  attempts: number;
  previousVersion: string;
  version: string;
  contentHash: string;
  /** Extra data the compute step chose to keep (the reduced response). */
  carry?: unknown;
}

type Compute = (
  current: Snapshot,
) => Promise<{ result: RfmApplyResult; carry?: unknown }>;

/**
 * Read, compute, write; on a conflict (409, or a changed hash on disk) read
 * again and rerun the same computation, up to `WRITE_RERUNS` times. With
 * `expectedHash` the caller pinned a version: a mismatch is a conflict at
 * once, never a rerun.
 */
async function transact(
  link: ServerLink | null,
  target: DocTarget,
  compute: Compute,
  options: { expectedHash?: string | null; dryRun?: boolean } = {},
): Promise<TransactionOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const current = readSnapshot(target.path);
    if (options.expectedHash && current.hash !== options.expectedHash) {
      throw new CliError(
        "VERSION_CONFLICT",
        "The document changed since the version you read; nothing was written.",
        {
          hint: "Read the document again and retry with its current version.",
          details: {
            written: false,
            expectedContentHash: options.expectedHash,
            currentVersion: current.version,
          },
        },
      );
    }
    const { result, carry } = await compute(current);
    if (result.errors.length > 0 || result.markdown === null) {
      throw refusalError(result.report, result.errors, {
        ...(carry && typeof carry === "object"
          ? (carry as Record<string, unknown>)
          : {}),
      });
    }
    const unchanged =
      result.report.status === "already-applied" ||
      result.markdown === current.content;
    if (unchanged || options.dryRun) {
      return {
        result,
        written: false,
        via: null,
        attempts: attempt,
        previousVersion: current.version,
        version: current.version,
        contentHash: current.hash,
        carry,
      };
    }
    const outcome = await writeDocument(
      link,
      target,
      result.markdown,
      current.hash,
    );
    if (outcome.status === "written") {
      return {
        result,
        written: true,
        via: outcome.via,
        attempts: attempt,
        previousVersion: current.version,
        version: outcome.version,
        contentHash: outcome.hash,
        carry,
      };
    }
    if (options.expectedHash || attempt > WRITE_RERUNS) {
      throw new CliError(
        "VERSION_CONFLICT",
        options.expectedHash
          ? "The document changed while writing; nothing was written."
          : `The document kept changing while writing (${attempt} attempts); nothing was written.`,
        {
          hint: "Wait for the tab to save, then run the command again.",
          details: { written: false, attempts: attempt },
        },
      );
    }
  }
}

function doctorSummary(markdown: string) {
  const validation = validateRoughdraftMarkdown(markdown);
  return {
    ok: validation.ok,
    comments: validation.summary.comments,
    roots: validation.summary.roots,
    documentComments: validation.summary.documentComments,
    replies: validation.summary.replies,
    suggestions: validation.summary.suggestions,
    endmatter: validation.summary.endmatter,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
  };
}

export function breakdownLine(doctor: {
  roots: number;
  documentComments: number;
  replies: number;
  suggestions: number;
}): string {
  return `Breakdown: roots ${doctor.roots}, documentComments ${doctor.documentComments}, replies ${doctor.replies}, suggestions ${doctor.suggestions}`;
}

function agentLabelsFor(author: string | undefined): string[] {
  const labels = [...DEFAULT_AGENT_LABELS];
  if (author && !labels.includes(author)) labels.push(author);
  return labels;
}

// ------------------------------------------------------------ one-thread commands

export type ThreadCommand = "reply" | "resolve" | "accept" | "reject" | "note";

export interface ThreadCommandInput {
  documentPath: string;
  command: ThreadCommand;
  thread?: string;
  text?: string;
  summary?: string;
  dropReplies?: boolean;
  author?: string;
  /** A version (or content hash) the caller read; a mismatch refuses. */
  expectedVersion?: string;
}

export interface ThreadCommandResult {
  command: ThreadCommand;
  path: string;
  thread: string | null;
  /** The entry this command created (`aN`), when it created one. */
  id: string | null;
  applyStatus: "applied" | "already-applied";
  written: boolean;
  writtenVia: "server" | "disk" | null;
  attempts: number;
  previousVersion: string;
  version: string;
  contentHash: string;
  doctor: ReturnType<typeof doctorSummary>;
  report: RfmApplyReport;
}

export async function runThreadCommand(
  deps: ReviewDeps,
  input: ThreadCommandInput,
): Promise<ThreadCommandResult> {
  const target = resolveDocument(deps.cwd, input.documentPath);
  const { command } = input;
  const thread = input.thread?.trim() || null;
  if (command !== "note" && !thread) {
    throw usageError(`roughdraft ${command} needs a thread id.`);
  }
  if ((command === "reply" || command === "note") && input.text === undefined) {
    throw usageError(
      `roughdraft ${command} needs the text (or - to read it from stdin).`,
    );
  }
  const action: Record<string, unknown> = {};
  if (command === "reply") action.reply = input.text;
  if (command === "resolve") action.resolve = input.summary?.trim() || true;
  if (command === "accept" || command === "reject") {
    action.decision = command;
    if (input.dropReplies) action.dropReplies = true;
  }
  const response = {
    roughdraftResponse: 1,
    roundId: `one-${command}`,
    partial: true,
    ...(command === "note"
      ? { note: input.text }
      : { threads: { [thread as string]: action } }),
  };
  const author = input.author?.trim() || undefined;
  const link = await findServer(deps);
  const expectedHash = input.expectedVersion
    ? hashOfVersion(input.expectedVersion)
    : null;
  // The tab shows "AI editing..." for the second or two the write takes.
  const quickRoundId = await openQuickRound(link, target, command);
  let outcome: TransactionOutcome;
  try {
    outcome = await transact(
      link,
      target,
      async (current) => ({
        result: applyReviewResponse({
          base: current.content,
          current: current.content,
          response,
          author,
          agentLabels: agentLabelsFor(author),
          now: nowIso(deps),
        }),
      }),
      { expectedHash },
    );
  } finally {
    if (quickRoundId) {
      await setRoundFlag(link, target, quickRoundId, "closed");
    }
  }
  const { report } = outcome.result;
  const id =
    command === "reply"
      ? (report.replies.find((reply) => reply.thread === thread)?.id ?? null)
      : (report.note ?? null);
  return {
    command,
    path: target.path,
    thread,
    id,
    applyStatus:
      report.status === "already-applied" ? "already-applied" : "applied",
    written: outcome.written,
    writtenVia: outcome.via,
    attempts: outcome.attempts,
    previousVersion: outcome.previousVersion,
    version: outcome.version,
    contentHash: outcome.contentHash,
    doctor: doctorSummary(
      outcome.result.markdown ?? fs.readFileSync(target.path, "utf8"),
    ),
    report,
  };
}

// ------------------------------------------------------------ feedback

export interface FeedbackResult {
  path: string;
  version: string;
  sha256: string;
  endmatter: string;
  /** The file is in an older format (listing works; writes need doctor --fix). */
  legacyFormat: boolean;
  normalized: RfmNormalizationChange[];
  counts: RfmRound["counts"];
  threads: RfmRoundThread[];
}

export function readFeedback(
  deps: Pick<ReviewDeps, "cwd">,
  documentPath: string,
  options: { agentLabels?: string[] } = {},
): FeedbackResult {
  const target = resolveDocument(deps.cwd, documentPath);
  const snapshot = readSnapshot(target.path);
  let round: RfmRound;
  try {
    round = buildReviewRound(snapshot.content, {
      path: target.path,
      version: snapshot.version,
      agentLabels: options.agentLabels,
      allowLegacy: true,
    });
  } catch (error) {
    if (error instanceof RoughdraftFormatError) throw formatError(error);
    throw error;
  }
  return {
    path: target.path,
    version: snapshot.version,
    sha256: snapshot.hash,
    endmatter: round.endmatter,
    legacyFormat: round.normalized.some(
      (change) =>
        ![
          "yaml-rewritten",
          "document-scope",
          "blank-line-before-block",
        ].includes(change.code),
    ),
    normalized: round.normalized,
    counts: round.counts,
    threads: round.threads,
  };
}

// ------------------------------------------------------------ round

export interface RoundFiles {
  round: string;
  clean: string;
  response: string;
  base: string;
}

export interface RoundState {
  roundId: string;
  documentPath: string;
  dir: string;
  openedAt: string;
  version: string;
  sha256: string;
  agentLabels: string[];
  status: "open" | "applied";
  applied: {
    key: string;
    at: string;
    version: string;
    contentHash: string;
    report: RfmApplyReport;
  } | null;
}

export interface TabState {
  tabs: number;
  tabDirty: boolean;
  tabConflict: boolean;
  tabsDirty: number;
  tabsConflict: number;
}

export interface StartRoundInput {
  documentPath: string;
  dir?: string;
  agentLabels?: string[];
  ack?: boolean;
  /** Who acknowledges the handoff (`roughdraft-cli round`, `roughdraft-mcp`). */
  client?: string;
}

export interface StartRoundResult {
  roundId: string;
  path: string;
  dir: string;
  files: RoundFiles;
  version: string;
  sha256: string;
  counts: RfmRound["counts"];
  threads: RfmRoundThread[];
  tab: TabState | null;
  acked: string[];
  ackError: string | null;
  roundFlag: string;
  server: { running: boolean; url: string | null };
  round: RfmRound;
}

function roundStateDir(stateDir: string, roundId: string): string {
  return path.join(roundsDir(stateDir), roundId);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The response.json the agent fills in: one empty reply per waiting thread, and the round note. */
export function responseTemplate(round: RfmRound): Record<string, unknown> {
  const threads: Record<string, { reply: string }> = {};
  for (const thread of round.threads) {
    if (thread.needsAnswer) threads[thread.id] = { reply: "" };
  }
  return {
    roughdraftResponse: 1,
    roundId: round.roundId,
    partial: false,
    threads,
    note: "",
  };
}

async function readTabState(
  link: ServerLink,
  target: DocTarget,
): Promise<{ tab: TabState; lastKnownVersion: string | null }> {
  const response = await apiRequest(link.api, "GET", "/api/documents/one", {
    query: { projectPath: target.projectPath, path: target.relativePath },
  });
  if (response.status === 404) {
    return {
      tab: {
        tabs: 0,
        tabDirty: false,
        tabConflict: false,
        tabsDirty: 0,
        tabsConflict: 0,
      },
      lastKnownVersion: null,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    throw httpError("Reading the tab state", response, link.api.baseUrl);
  }
  const body = response.body ?? {};
  const tabsDirty = Number(body.tabsDirty ?? 0) || 0;
  const tabsConflict = Number(body.tabsConflict ?? 0) || 0;
  return {
    tab: {
      tabs: Number(body.tabs ?? 0) || 0,
      tabDirty: tabsDirty > 0,
      tabConflict: tabsConflict > 0,
      tabsDirty,
      tabsConflict,
    },
    lastKnownVersion:
      typeof body.lastKnownVersion === "string" ? body.lastKnownVersion : null,
  };
}

async function setRoundFlag(
  link: ServerLink | null,
  target: DocTarget,
  roundId: string,
  state: "open" | "closed",
): Promise<string> {
  if (!link) return "skipped";
  try {
    const response = await apiRequest(
      link.api,
      "POST",
      "/api/documents/round",
      {
        body: {
          projectPath: target.projectPath,
          path: target.relativePath,
          roundId,
          state,
        },
      },
    );
    if (response.status >= 200 && response.status < 300) {
      return String(response.body?.round?.state ?? state);
    }
    return response.status === 404 ? "unsupported" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Opens the round flag for one quick command (reply, resolve, accept,
 * reject, note) and returns its round id, or null when there is no server or
 * a real round already holds the flag: a quick command never replaces the
 * flag of a `roughdraft round` that is open or stalled on the document.
 */
async function openQuickRound(
  link: ServerLink | null,
  target: DocTarget,
  command: string,
): Promise<string | null> {
  if (!link) return null;
  try {
    const view = await apiRequest(link.api, "GET", "/api/documents/one", {
      query: { projectPath: target.projectPath, path: target.relativePath },
    });
    const state = view.body?.round?.state;
    if (view.status === 200 && (state === "open" || state === "stalled")) {
      return null;
    }
  } catch {
    return null;
  }
  const roundId = `quick-${command}-${crypto.randomBytes(4).toString("hex")}`;
  const flag = await setRoundFlag(link, target, roundId, "open");
  return flag === "open" ? roundId : null;
}

export async function startRound(
  deps: ReviewDeps,
  input: StartRoundInput,
): Promise<StartRoundResult> {
  const target = resolveDocument(deps.cwd, input.documentPath);
  const link = await findServer(deps);

  // Read through the server when it runs, so its registry records the
  // round's version (apply compares the browser's later saves with it).
  let snapshot: Snapshot;
  if (link) {
    const response = await apiRequest(link.api, "GET", "/api/markdown-file", {
      query: { projectPath: target.projectPath, path: target.relativePath },
    });
    if (response.status < 200 || response.status >= 300) {
      throw httpError("Reading the document", response, link.api.baseUrl);
    }
    const content = String(response.body?.content ?? "");
    snapshot = {
      content,
      hash: String(response.body?.contentHash ?? sha256(content)),
      version: String(response.body?.version ?? ""),
    };
  } else {
    snapshot = readSnapshot(target.path);
  }

  let round: RfmRound;
  try {
    round = buildReviewRound(snapshot.content, {
      path: target.path,
      version: snapshot.version,
      agentLabels: input.agentLabels,
      createdAt: nowIso(deps),
    });
  } catch (error) {
    if (error instanceof RoughdraftFormatError) throw formatError(error);
    throw error;
  }

  const stateDir = getStateDir(deps.env);
  const stateRoundDir = roundStateDir(stateDir, round.roundId);
  const dir = input.dir ? path.resolve(deps.cwd, input.dir) : stateRoundDir;
  const files: RoundFiles = {
    round: path.join(dir, "round.json"),
    clean: path.join(dir, "clean.md"),
    response: path.join(dir, "response.json"),
    base: path.join(dir, "base.md"),
  };
  fs.mkdirSync(dir, { recursive: true });
  writeJson(files.round, round);
  fs.writeFileSync(files.clean, round.clean);
  writeJson(files.response, responseTemplate(round));
  fs.writeFileSync(files.base, snapshot.content);
  if (dir !== stateRoundDir) {
    fs.mkdirSync(stateRoundDir, { recursive: true });
    writeJson(path.join(stateRoundDir, "round.json"), round);
    fs.writeFileSync(path.join(stateRoundDir, "base.md"), snapshot.content);
  }
  const state: RoundState = {
    roundId: round.roundId,
    documentPath: target.path,
    dir,
    openedAt: round.createdAt,
    version: snapshot.version,
    sha256: snapshot.hash,
    agentLabels: round.agentLabels,
    status: "open",
    applied: null,
  };
  writeJson(path.join(stateRoundDir, "state.json"), state);
  recordOpenRound(stateDir, {
    documentPath: target.path,
    roundId: round.roundId,
    dir,
    cleanPath: files.clean,
    responsePath: files.response,
    openedAt: round.createdAt,
  });

  let acked: string[] = [];
  let ackError: string | null = null;
  let tab: TabState | null = null;
  let roundFlag = "skipped";
  if (input.ack !== false) {
    if (link) {
      const listed = await listDocuments(link.api);
      const ids = collectHandoffs(listed.documents, {
        key: documentKey(target.path),
      })
        .filter(
          (handoff) =>
            handoff.state === "pending" || handoff.state === "delivered",
        )
        .map((handoff) => handoff.handoffId);
      if (ids.length > 0) {
        acked = (
          await ackHandoffs(
            link.api,
            ids,
            input.client ?? "roughdraft-cli round",
          )
        ).acked;
      }
    } else {
      ackError =
        "Roughdraft is not running, so no Done was acknowledged. Run `roughdraft pending <file> --ack` once it runs.";
    }
  }
  if (link) {
    tab = (await readTabState(link, target)).tab;
    roundFlag = await setRoundFlag(link, target, round.roundId, "open");
  }

  return {
    roundId: round.roundId,
    path: target.path,
    dir,
    files,
    version: snapshot.version,
    sha256: snapshot.hash,
    counts: round.counts,
    threads: round.threads,
    tab,
    acked,
    ackError,
    roundFlag,
    server: { running: link !== null, url: link?.server.publicUrl ?? null },
    round,
  };
}

// ------------------------------------------------------------ apply

export interface ApplyRoundInput {
  /** Path of response.json, or null when the response comes as text or a value. */
  responsePath?: string | null;
  responseText?: string;
  response?: unknown;
  /** The edited clean text (MCP); else clean.md from the round folder. */
  cleanText?: string | null;
  dryRun?: boolean;
  skipFailed?: boolean;
  waitSeconds?: number;
}

export interface SkippedUnit {
  unit: string;
  errors: RfmApplyError[];
}

export interface ApplyRoundResult {
  status: "applied" | "already-applied";
  path: string;
  roundId: string;
  dryRun: boolean;
  written: boolean;
  writtenVia: "server" | "disk" | null;
  attempts: number;
  previousVersion: string;
  version: string;
  contentHash: string;
  replay: boolean;
  baseline: "used" | "not-used";
  skippedUnits: SkippedUnit[];
  roundFlag: string;
  tab: TabState | null;
  report: RfmApplyReport;
}

interface LoadedRound {
  round: RfmRound;
  base: string;
  state: RoundState | null;
  stateRoundDir: string;
  cleanPath: string;
  documentPath: string;
}

function loadRound(
  deps: ReviewDeps,
  roundId: string,
  responsePath: string | null,
): LoadedRound {
  const stateDir = getStateDir(deps.env);
  const stateRoundDir = roundStateDir(stateDir, roundId);
  const state = readJsonFile<RoundState>(
    path.join(stateRoundDir, "state.json"),
  );
  const dirs = [
    ...(responsePath ? [path.dirname(responsePath)] : []),
    ...(state?.dir ? [state.dir] : []),
    stateRoundDir,
  ];
  for (const dir of dirs) {
    const round = readJsonFile<RfmRound>(path.join(dir, "round.json"));
    if (!round || round.roundId !== roundId) continue;
    let base: string;
    try {
      base = fs.readFileSync(path.join(dir, "base.md"), "utf8");
    } catch {
      continue;
    }
    const cleanDir = [dir, state?.dir, stateRoundDir].find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        fs.existsSync(path.join(candidate, "clean.md")),
    );
    const documentPath = state?.documentPath ?? round.document.path;
    if (!documentPath) break;
    return {
      round,
      base,
      state,
      stateRoundDir,
      cleanPath: path.join(cleanDir ?? dir, "clean.md"),
      documentPath,
    };
  }
  throw new CliError(
    "ROUND_NOT_FOUND",
    `No round ${roundId} was found (looked in ${dirs.join(", ")}).`,
    { hint: "Run `roughdraft round <file>` to start a round." },
  );
}

function unitLinks(response: Record<string, unknown>): Map<string, string[]> {
  // edits[n] is tied to the thread it names (anchor or near), both ways.
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  const edits = Array.isArray(response.edits) ? response.edits : [];
  edits.forEach((edit, index) => {
    if (!edit || typeof edit !== "object") return;
    const record = edit as Record<string, unknown>;
    for (const key of ["anchor", "near"]) {
      if (typeof record[key] === "string") link(`edits[${index}]`, record[key]);
    }
  });
  return links;
}

/**
 * Drops the failing units from a response (threads, `edits[n]`, the note)
 * with everything tied to them. Returns null when an error is on a unit that
 * cannot be dropped alone (a clean.md hunk, the response as a whole, a gate).
 */
function dropFailedUnits(
  response: Record<string, unknown>,
  errors: RfmApplyError[],
): { response: Record<string, unknown>; dropped: SkippedUnit[] } | null {
  const threads = {
    ...((response.threads as Record<string, unknown> | undefined) ?? {}),
  };
  const edits = Array.isArray(response.edits) ? [...response.edits] : [];
  const failing = new Map<string, RfmApplyError[]>();
  for (const error of errors) {
    const unit = error.thread ?? "";
    const droppable =
      unit in threads ||
      unit === "note" ||
      /^edits\[\d+\]$/.test(unit) ||
      // An answer may name a thread the round does not have.
      ((error.code === "unknown-thread" ||
        error.code === "thread-not-in-round") &&
        unit !== "");
    if (!droppable || error.code.startsWith("gate-")) return null;
    failing.set(unit, [...(failing.get(unit) ?? []), error]);
  }
  const links = unitLinks(response);
  const queue = [...failing.keys()];
  const units = new Set<string>();
  while (queue.length > 0) {
    const unit = queue.shift() as string;
    if (units.has(unit)) continue;
    units.add(unit);
    for (const linked of links.get(unit) ?? []) queue.push(linked);
  }
  const next: Record<string, unknown> = { ...response, partial: true };
  for (const unit of units) delete threads[unit];
  next.threads = threads;
  const keptEdits = edits.filter((_, index) => !units.has(`edits[${index}]`));
  if (Array.isArray(response.edits)) next.edits = keptEdits;
  if (units.has("note")) delete next.note;
  return {
    response: next,
    dropped: [...units].map((unit) => ({
      unit,
      errors: failing.get(unit) ?? [],
    })),
  };
}

function hasWork(
  response: Record<string, unknown>,
  cleanEdited: string | null,
) {
  const threads =
    (response.threads as Record<string, unknown> | undefined) ?? {};
  const edits = Array.isArray(response.edits) ? response.edits : [];
  return (
    Object.keys(threads).length > 0 ||
    edits.length > 0 ||
    typeof response.note === "string" ||
    cleanEdited !== null
  );
}

function parseResponse(input: ApplyRoundInput): Record<string, unknown> {
  let value: unknown = input.response;
  if (value === undefined) {
    const text =
      input.responseText ??
      (input.responsePath ? fs.readFileSync(input.responsePath, "utf8") : "");
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw usageError(
        `The response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "Check response.json; it must be one JSON object with roughdraftResponse and roundId.",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("The response must be a JSON object.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.roundId !== "string" || response.roundId.trim() === "") {
    throw usageError(
      "The response has no roundId.",
      "Fill in the response.json that `roughdraft round` wrote; it carries the roundId.",
    );
  }
  return response;
}

function replayKey(
  roundId: string,
  response: Record<string, unknown>,
  cleanEdited: string | null,
): string {
  return sha256(JSON.stringify({ roundId, response, cleanEdited }));
}

export async function applyRound(
  deps: ReviewDeps,
  input: ApplyRoundInput,
): Promise<ApplyRoundResult> {
  const responsePath =
    input.responsePath && input.responsePath !== "-"
      ? path.resolve(deps.cwd, input.responsePath)
      : null;
  if (responsePath && !fs.existsSync(responsePath)) {
    throw new CliError("PATH_NOT_FOUND", `Path not found: ${responsePath}`, {
      details: { path: responsePath },
    });
  }
  const original = parseResponse({ ...input, responsePath });
  const roundId = original.roundId as string;
  const loaded = loadRound(deps, roundId, responsePath);
  const target = resolveDocument(deps.cwd, loaded.documentPath);
  const clean =
    typeof input.cleanText === "string"
      ? input.cleanText
      : fs.existsSync(loaded.cleanPath)
        ? fs.readFileSync(loaded.cleanPath, "utf8")
        : loaded.round.clean;
  const cleanEdited = clean !== loaded.round.clean ? clean : null;
  const key = replayKey(roundId, original, cleanEdited);
  const stateDir = getStateDir(deps.env);
  const statePath = path.join(loaded.stateRoundDir, "state.json");

  // A retry of the response that already landed: answer from the record.
  const applied = loaded.state?.applied;
  if (applied && applied.key === key) {
    const current = readSnapshot(target.path);
    if (current.hash === applied.contentHash) {
      return {
        status: "already-applied",
        path: target.path,
        roundId,
        dryRun: Boolean(input.dryRun),
        written: false,
        writtenVia: null,
        attempts: 0,
        previousVersion: current.version,
        version: current.version,
        contentHash: current.hash,
        replay: true,
        baseline: "not-used",
        skippedUnits: [],
        roundFlag: "unchanged",
        tab: null,
        report: { ...applied.report, status: "already-applied" },
      };
    }
  }

  const link = await findServer(deps);
  let tab: TabState | null = null;
  if (link) {
    const waitMs = Math.max(
      0,
      (input.waitSeconds ?? DEFAULT_APPLY_WAIT_SECONDS) * 1000,
    );
    const started = deps.now?.() ?? Date.now();
    for (;;) {
      tab = (await readTabState(link, target)).tab;
      if (input.dryRun || (!tab.tabDirty && !tab.tabConflict)) break;
      const waited = (deps.now?.() ?? Date.now()) - started;
      if (waited >= waitMs) {
        throw new CliError(
          "TAB_DIRTY",
          tab.tabConflict
            ? "Jordan's tab has a conflict it has not settled; nothing was written."
            : `Jordan's tab still has unsaved text after ${Math.round(waitMs / 1000)} s; nothing was written.`,
          {
            hint: "Ask Jordan to let the tab save (or settle the conflict), then run apply again; add --wait <seconds> to wait longer.",
            details: { written: false, status: "refused", ...tab },
          },
        );
      }
      await deps.sleepImpl(TAB_POLL_MS);
    }
  }

  let skippedUnits: SkippedUnit[] = [];
  let baselineUsed = false;
  const compute: Compute = async (current) => {
    // The browser saved after the round started when the server last saw a
    // version other than the round's; that save is the baseline only when it
    // is what is on disk now (otherwise an outside write came after it).
    let baseline: string | null = null;
    if (link) {
      const { lastKnownVersion } = await readTabState(link, target);
      const lastHash = hashOfVersion(lastKnownVersion);
      if (
        lastHash !== "" &&
        lastHash !== loaded.round.document.sha256 &&
        lastHash === current.hash
      ) {
        baseline = current.content;
      }
    }
    baselineUsed = baseline !== null;
    let response = original;
    skippedUnits = [];
    for (;;) {
      const result = applyReviewResponse({
        base: loaded.base,
        current: current.content,
        cleanEdited,
        response,
        baseline,
        round: loaded.round,
        agentLabels: loaded.round.agentLabels,
        now: nowIso(deps),
      });
      if (result.errors.length === 0 || !input.skipFailed) {
        return { result, carry: { skippedUnits } };
      }
      const reduced = dropFailedUnits(response, result.errors);
      if (!reduced || !hasWork(reduced.response, cleanEdited)) {
        return { result, carry: { skippedUnits } };
      }
      skippedUnits = [...skippedUnits, ...reduced.dropped];
      response = reduced.response;
    }
  };

  const outcome = await transact(link, target, compute, {
    dryRun: input.dryRun,
  });
  const report = outcome.result.report;
  let roundFlag = "unchanged";
  if (!input.dryRun) {
    const state: RoundState = loaded.state ?? {
      roundId,
      documentPath: target.path,
      dir: path.dirname(loaded.cleanPath),
      openedAt: loaded.round.createdAt,
      version: loaded.round.document.version ?? "",
      sha256: loaded.round.document.sha256,
      agentLabels: loaded.round.agentLabels,
      status: "open",
      applied: null,
    };
    state.status = "applied";
    state.applied = {
      key,
      at: nowIso(deps),
      version: outcome.version,
      contentHash: outcome.contentHash,
      report,
    };
    writeJson(statePath, state);
    try {
      writeJson(path.join(path.dirname(loaded.cleanPath), "report.json"), {
        ...report,
        written: outcome.written,
        skippedUnits,
      });
    } catch {}
    clearOpenRound(stateDir, target.path, roundId);
    roundFlag = await setRoundFlag(link, target, roundId, "closed");
  }

  return {
    status: report.status === "already-applied" ? "already-applied" : "applied",
    path: target.path,
    roundId,
    dryRun: Boolean(input.dryRun),
    written: outcome.written,
    writtenVia: outcome.via,
    attempts: outcome.attempts,
    previousVersion: outcome.previousVersion,
    version: outcome.version,
    contentHash: outcome.contentHash,
    replay: false,
    baseline: baselineUsed ? "used" : "not-used",
    skippedUnits,
    roundFlag,
    tab,
    report,
  };
}

// ------------------------------------------------------------ doctor --fix

export interface FixFileResult {
  path: string;
  result: "converts" | "converted" | "unchanged" | "refused" | "error";
  changes: RfmNormalizationChange[];
  refused: RfmNormalizationRefusal[];
  error?: string;
  backup: string | null;
  written: boolean;
  writtenVia: "server" | "disk" | null;
  before: ReturnType<typeof doctorSummary> | null;
  after: ReturnType<typeof doctorSummary> | null;
  /** Threads a round would list on the converted file. */
  threads: number | null;
  needsAnswer: number | null;
}

function backupStamp(deps: ReviewDeps): string {
  return nowIso(deps)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function analyzeFix(filePath: string): {
  snapshot: Snapshot;
  result: FixFileResult;
  markdown: string;
} {
  const snapshot = readSnapshot(filePath);
  const normalized = normalizeRoughdraftMetadata(snapshot.content);
  const changed =
    normalized.refused.length === 0 && normalized.markdown !== snapshot.content;
  let threads: number | null = null;
  let needsAnswer: number | null = null;
  if (normalized.refused.length === 0) {
    try {
      const round = buildReviewRound(normalized.markdown, {
        allowLegacy: true,
      });
      threads = round.counts.threads;
      needsAnswer = round.counts.needsAnswer;
    } catch {}
  }
  return {
    snapshot,
    markdown: normalized.markdown,
    result: {
      path: filePath,
      result:
        normalized.refused.length > 0
          ? "refused"
          : changed
            ? "converts"
            : "unchanged",
      changes: normalized.changes,
      refused: normalized.refused,
      backup: null,
      written: false,
      writtenVia: null,
      before: doctorSummary(snapshot.content),
      after:
        normalized.refused.length > 0
          ? null
          : doctorSummary(normalized.markdown),
      threads,
      needsAnswer,
    },
  };
}

export async function fixDocument(
  deps: ReviewDeps,
  documentPath: string,
  options: { dryRun?: boolean } = {},
): Promise<FixFileResult> {
  const target = resolveDocument(deps.cwd, documentPath);
  const { snapshot, result, markdown } = analyzeFix(target.path);
  if (result.result === "refused") {
    const lines = result.refused.map(
      (refusal) => `  line ${refusal.line} ${refusal.code}: ${refusal.message}`,
    );
    throw new CliError(
      "NORMALIZE_REFUSED",
      `doctor --fix cannot convert this file without a person; nothing was written:\n${lines.join("\n")}`,
      {
        hint: "Fix the listed lines by hand, then run doctor --fix again.",
        details: { ...result, written: false },
      },
    );
  }
  if (options.dryRun || result.result === "unchanged") return result;

  const stateDir = getStateDir(deps.env);
  const backup = path.join(
    stateDir,
    "backups",
    `${path.basename(target.path, ".md")}.${backupStamp(deps)}.md`,
  );
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, snapshot.content);
  const link = await findServer(deps);
  const outcome = await writeDocument(link, target, markdown, snapshot.hash);
  if (outcome.status === "conflict") {
    throw new CliError(
      "VERSION_CONFLICT",
      "The file changed while converting it; nothing was written.",
      {
        hint: "Run doctor --fix again.",
        details: { ...result, backup, written: false },
      },
    );
  }
  return {
    ...result,
    result: "converted",
    backup,
    written: true,
    writtenVia: outcome.via,
  };
}

// ------------------------------------------------------------ dry-run report

/** Inline code that is safe to open in Roughdraft (markup in code is literal). */
function codeSpan(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ");
  const longest = Math.max(
    0,
    ...(flat.match(/`+/g) ?? []).map((m) => m.length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function plainOrCode(text: string): string {
  return /[{}`<>|*_[\]]/.test(text) ? codeSpan(text) : text;
}

function countByCode(items: Array<{ code: string }>): string {
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...counts]
    .map(([code, count]) => (count > 1 ? `${code} x${count}` : code))
    .join(", ");
}

export function renderFixReport(
  results: FixFileResult[],
  options: { generatedAt: string; cwd: string },
): string {
  const display = (filePath: string) => {
    const relative = path.relative(options.cwd, filePath);
    return relative && !relative.startsWith("..") ? relative : filePath;
  };
  const tally = (result: FixFileResult["result"]) =>
    results.filter((entry) => entry.result === result).length;
  const lines: string[] = [
    "# Roughdraft doctor --fix: dry run",
    "",
    `Generated ${options.generatedAt} over ${results.length} file${results.length === 1 ? "" : "s"}. Nothing was changed. ${tally("converts")} would convert, ${tally("unchanged")} already in the current format, ${tally("refused")} refused until a person fixes them${tally("error") > 0 ? `, ${tally("error")} could not be read` : ""}.`,
    "",
    "| File | Result | Changes | Threads after |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of results) {
    const summary =
      entry.result === "refused"
        ? `refused: ${countByCode(entry.refused)}`
        : entry.result === "error"
          ? "could not be read"
          : entry.changes.length > 0
            ? countByCode(entry.changes)
            : "none";
    lines.push(
      `| ${codeSpan(path.basename(entry.path))} | ${entry.result === "converts" ? "converts" : entry.result} | ${summary} | ${entry.threads === null ? "-" : `${entry.threads} (${entry.needsAnswer} waiting)`} |`,
    );
  }
  for (const entry of results) {
    lines.push("", `## ${path.basename(entry.path)}`, "");
    lines.push(`Path: ${codeSpan(display(entry.path))}`, "");
    if (entry.result === "error") {
      lines.push(
        `Could not be read: ${plainOrCode(entry.error ?? "unknown error")}`,
      );
      continue;
    }
    const before = entry.before;
    const after = entry.after;
    if (before) {
      lines.push(
        `Now: ${before.comments} comment(s) (roots ${before.roots}, documentComments ${before.documentComments}, replies ${before.replies}), ${before.suggestions} suggestion(s), review block ${before.endmatter}, doctor ${before.ok ? "passes" : "fails"}${before.warnings > 0 ? ` with ${before.warnings} warning(s)` : ""}.`,
      );
    }
    if (entry.result === "refused") {
      lines.push(
        "",
        "Refused (nothing would be written until these are fixed by hand):",
        "",
      );
      for (const refusal of entry.refused) {
        lines.push(
          `- line ${refusal.line}, ${codeSpan(refusal.code)}: ${plainOrCode(refusal.message)}`,
        );
      }
    } else if (entry.result === "unchanged") {
      lines.push("", "Already in the current format; nothing to change.");
    } else if (after) {
      lines.push(
        `After: ${after.comments} comment(s) (roots ${after.roots}, documentComments ${after.documentComments}, replies ${after.replies}), ${after.suggestions} suggestion(s), review block ${after.endmatter}, doctor ${after.ok ? "passes" : "fails"}${after.warnings > 0 ? ` with ${after.warnings} warning(s)` : ""}.`,
      );
    }
    if (entry.result !== "unchanged" && entry.changes.length > 0) {
      lines.push("", "Changes:", "");
      for (const change of entry.changes) {
        const where = [
          change.id ? codeSpan(change.id) : null,
          change.line ? `line ${change.line}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `- ${codeSpan(change.code)}${where ? ` (${where})` : ""}${change.message ? `: ${plainOrCode(change.message)}` : ""}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function dryRunFiles(
  deps: Pick<ReviewDeps, "cwd">,
  files: string[],
): FixFileResult[] {
  return files.map((file) => {
    try {
      const target = resolveDocument(deps.cwd, file);
      return analyzeFix(target.path).result;
    } catch (error) {
      return {
        path: path.resolve(deps.cwd, file),
        result: "error" as const,
        changes: [],
        refused: [],
        error: error instanceof Error ? error.message : String(error),
        backup: null,
        written: false,
        writtenVia: null,
        before: null,
        after: null,
        threads: null,
        needsAnswer: null,
      };
    }
  });
}

// ------------------------------------------------------------ CLI front ends

export interface ReviewCliDeps extends ReviewDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  readStdin: () => Promise<string>;
}

export interface ReviewCliOptions {
  positionals: string[];
  author?: string;
  summary?: string;
  dropReplies: boolean;
  dir?: string;
  agentLabels?: string;
  noAck: boolean;
  dryRun: boolean;
  skipFailed: boolean;
  waitSeconds?: number;
  report?: string;
}

/** Lets a failure envelope echo the document path. */
export interface ReviewCliContext {
  path?: string;
}

function emit(deps: ReviewCliDeps, value: unknown): void {
  deps.log(JSON.stringify(value, null, 2));
}

function envelope(
  payload: Record<string, unknown>,
  status = "ok",
): Record<string, unknown> {
  return { ...payload, ok: true, status, exitCode: 0 };
}

/** `-` reads stdin; one trailing newline (from a heredoc) is dropped. */
async function textArgument(
  deps: ReviewCliDeps,
  value: string | undefined,
): Promise<string | undefined> {
  if (value !== "-") return value;
  const text = await deps.readStdin();
  return text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
}

function describeThreadResult(result: ThreadCommandResult): string {
  const file = path.basename(result.path);
  const via = result.writtenVia
    ? ` (written ${result.writtenVia === "server" ? "through the server" : "on disk"})`
    : "";
  if (!result.written) {
    return `Nothing to write: ${result.command} on ${result.thread ?? file} is already in ${file}.`;
  }
  const moved = result.id ? `; the note is ${result.id}` : "";
  switch (result.command) {
    case "reply":
      return `Replied to ${result.thread} as ${result.id} in ${file}${via}.`;
    case "note":
      return `Added round note ${result.id} to ${file}${via}.`;
    case "resolve":
      return `Resolved ${result.thread} in ${file}${via}.`;
    case "accept":
      return `Accepted ${result.thread} in ${file}${moved}${via}.`;
    case "reject":
      return `Rejected ${result.thread} in ${file}${moved}${via}.`;
  }
}

function printDoctor(
  deps: ReviewCliDeps,
  doctor: { ok: boolean } & Parameters<typeof breakdownLine>[0],
): void {
  deps.log(`Doctor: ${doctor.ok ? "passed" : "failed"}`);
  deps.log(breakdownLine(doctor));
}

const THREAD_USAGE: Record<ThreadCommand, string> = {
  reply:
    'Usage: roughdraft reply <file> <id> "<text>" | - [--author <name>] [--json]',
  resolve:
    'Usage: roughdraft resolve <file> <id> [--summary "<text>"] [--json]',
  accept: "Usage: roughdraft accept <file> <sN> [--drop-replies] [--json]",
  reject: "Usage: roughdraft reject <file> <sN> [--drop-replies] [--json]",
  note: 'Usage: roughdraft note <file> "<text>" | - [--author <name>] [--json]',
};

export async function runThreadCli(
  deps: ReviewCliDeps,
  command: ThreadCommand,
  options: ReviewCliOptions,
  json: boolean,
  ctx: ReviewCliContext,
): Promise<number> {
  const expected = command === "reply" ? 3 : 2;
  if (options.positionals.length !== expected) {
    throw usageError(THREAD_USAGE[command]);
  }
  const [file = "", second = "", third] = options.positionals;
  ctx.path = path.resolve(deps.cwd, file);
  const text =
    command === "reply"
      ? await textArgument(deps, third)
      : command === "note"
        ? await textArgument(deps, second)
        : undefined;
  const result = await runThreadCommand(deps, {
    documentPath: file,
    command,
    thread: command === "note" ? undefined : second,
    text,
    summary: options.summary,
    dropReplies: options.dropReplies,
    author: options.author,
  });
  if (json) {
    emit(deps, envelope({ ...result }, result.applyStatus));
    return 0;
  }
  deps.log(describeThreadResult(result));
  printDoctor(deps, result.doctor);
  return 0;
}

function parseLabels(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const labels = value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length > 0 ? labels : undefined;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function printThreads(deps: ReviewCliDeps, threads: RfmRoundThread[]): void {
  for (const thread of threads) {
    const first = thread.anchor?.segments[0];
    const where = first
      ? `line ${first.line}`
      : thread.kind === "document"
        ? "whole document"
        : "no anchor";
    const flags = [
      thread.needsAnswer ? "needs an answer" : null,
      thread.status === "resolved" ? "resolved" : null,
      thread.replies.length > 0
        ? `${thread.replies.length} repl${thread.replies.length === 1 ? "y" : "ies"}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    const { suggestion } = thread;
    const body = suggestion
      ? `${suggestion.type}: ${oneLine(suggestion.original, 30)} -> ${oneLine(suggestion.proposed, 30)}`
      : oneLine(thread.body);
    deps.log(
      `  ${thread.id} ${thread.kind} by ${thread.author ?? "unknown"}, ${where}${flags ? `, ${flags}` : ""}: ${body}`,
    );
  }
}

export async function runFeedbackCli(
  deps: ReviewCliDeps,
  options: ReviewCliOptions,
  json: boolean,
  ctx: ReviewCliContext,
): Promise<number> {
  if (options.positionals.length !== 1) {
    throw usageError("Usage: roughdraft feedback <file> [--json]");
  }
  const file = options.positionals[0] ?? "";
  ctx.path = path.resolve(deps.cwd, file);
  const feedback = readFeedback(deps, file, {
    agentLabels: parseLabels(options.agentLabels),
  });
  if (json) {
    emit(deps, envelope({ ...feedback }));
    return 0;
  }
  deps.log(
    `${feedback.path}: ${feedback.counts.threads} thread(s), ${feedback.counts.needsAnswer} waiting for an answer, ${feedback.counts.resolved} resolved.`,
  );
  if (feedback.legacyFormat) {
    deps.log(
      "This file uses an older review format: run `roughdraft doctor --fix` before any write.",
    );
  }
  printThreads(deps, feedback.threads);
  return 0;
}

export async function runRoundCli(
  deps: ReviewCliDeps,
  options: ReviewCliOptions,
  json: boolean,
  ctx: ReviewCliContext,
): Promise<number> {
  if (options.positionals.length !== 1) {
    throw usageError(
      "Usage: roughdraft round <file> [--dir <dir>] [--agent-labels AI,Mike] [--no-ack] [--json]",
    );
  }
  const file = options.positionals[0] ?? "";
  ctx.path = path.resolve(deps.cwd, file);
  const result = await startRound(deps, {
    documentPath: file,
    dir: options.dir,
    agentLabels: parseLabels(options.agentLabels),
    ack: !options.noAck,
  });
  if (json) {
    const { round: _round, ...rest } = result;
    emit(
      deps,
      envelope({
        ...rest,
        tabDirty: result.tab?.tabDirty ?? false,
        tabConflict: result.tab?.tabConflict ?? false,
      }),
    );
    return 0;
  }
  deps.log(`Round ${result.roundId} for ${result.path}`);
  deps.log(
    `  clean.md:      ${result.files.clean} (edit this copy, never the file)`,
  );
  deps.log(`  response.json: ${result.files.response} (fill this in)`);
  deps.log(`  round.json:    ${result.files.round}`);
  deps.log(`  base.md:       ${result.files.base}`);
  if (!result.server.running) {
    deps.log("Tab: Roughdraft is not running, so no tab is open.");
  } else if (result.tab?.tabConflict) {
    deps.log(
      "Tab: tabConflict. Jordan's tab has an unsettled conflict; ask him before applying.",
    );
  } else if (result.tab?.tabDirty) {
    deps.log(
      "Tab: tabDirty. Jordan's tab has unsaved text; ask him before applying.",
    );
  } else {
    deps.log(`Tab: ${result.tab?.tabs ?? 0} open, nothing unsaved.`);
  }
  if (result.acked.length > 0) {
    deps.log(
      `Acknowledged ${result.acked.length} Done${result.acked.length === 1 ? "" : "s"}.`,
    );
  }
  if (result.ackError) deps.error(`roughdraft: ${result.ackError}`);
  deps.log(
    `Threads: ${result.counts.threads}, ${result.counts.needsAnswer} need an answer, ${result.counts.resolved} resolved.`,
  );
  printThreads(deps, result.threads);
  deps.log(
    `Then run: roughdraft apply ${JSON.stringify(result.files.response)}`,
  );
  return 0;
}

export async function runApplyCli(
  deps: ReviewCliDeps,
  options: ReviewCliOptions,
  json: boolean,
  ctx: ReviewCliContext,
): Promise<number> {
  if (options.positionals.length !== 1) {
    throw usageError(
      "Usage: roughdraft apply <response.json | -> [--dry-run] [--skip-failed] [--wait <seconds>] [--json]",
    );
  }
  const source = options.positionals[0] ?? "";
  const responseText = source === "-" ? await deps.readStdin() : undefined;
  const result = await applyRound(deps, {
    responsePath: source === "-" ? null : source,
    responseText,
    dryRun: options.dryRun,
    skipFailed: options.skipFailed,
    waitSeconds: options.waitSeconds,
  });
  ctx.path = result.path;
  if (json) {
    const { report, ...rest } = result;
    emit(deps, {
      ...report,
      ...rest,
      ok: true,
      status: result.status,
      exitCode: 0,
      document: result.path,
    });
    return 0;
  }
  const { report } = result;
  const file = path.basename(result.path);
  if (result.status === "already-applied") {
    deps.log(
      `Round ${result.roundId} is already applied to ${file}; nothing written.`,
    );
  } else {
    const parts = [
      `${report.replies.length} repl${report.replies.length === 1 ? "y" : "ies"}`,
      report.resolved.length > 0 ? `${report.resolved.length} resolved` : null,
      report.accepted.length > 0 ? `${report.accepted.length} accepted` : null,
      report.rejected.length > 0 ? `${report.rejected.length} rejected` : null,
      `${report.edits.length} edit${report.edits.length === 1 ? "" : "s"}`,
      report.note ? `note ${report.note}` : null,
    ].filter(Boolean);
    deps.log(
      `${result.dryRun ? "Dry run, nothing written. Would apply" : "Applied"} round ${result.roundId} to ${file}: ${parts.join(", ")}.`,
    );
  }
  for (const anchor of report.anchors) {
    deps.log(`  ${anchor.id}: highlight ${anchor.result}`);
  }
  for (const item of report.restored) {
    deps.log(
      `  restored ${item.id} (${item.what}${item.keys ? `: ${item.keys.join(", ")}` : ""})`,
    );
  }
  for (const unit of result.skippedUnits) {
    deps.log(
      `  skipped ${unit.unit}: ${unit.errors.map((error) => error.code).join(", ")}`,
    );
  }
  for (const dropped of report.droppedReplies) {
    deps.log(`  dropped reply ${dropped.id} on ${dropped.thread}`);
  }
  if (report.rebase.newThreads.length > 0) {
    deps.log(
      `New threads since the round: ${report.rebase.newThreads.join(", ")}. Run roughdraft round again.`,
    );
  }
  if (report.remaining.length > 0) {
    deps.log(`Still waiting for an answer: ${report.remaining.join(", ")}.`);
  }
  if (report.doctor) printDoctor(deps, report.doctor);
  return 0;
}

function printFix(deps: ReviewCliDeps, entry: FixFileResult): void {
  const verdict: Record<FixFileResult["result"], string> = {
    converts: "would convert (dry run, nothing written)",
    converted: "converted",
    unchanged: "already in the current format, nothing to change",
    refused: "refused, needs a person first",
    error: `could not be read: ${entry.error ?? ""}`,
  };
  deps.log(`${entry.path}: ${verdict[entry.result]}`);
  if (entry.result === "unchanged" || entry.result === "error") return;
  for (const change of entry.changes) {
    deps.log(
      `  ${change.code}${change.id ? ` ${change.id}` : ""}${change.line ? ` line ${change.line}` : ""}${change.message ? `: ${change.message}` : ""}`,
    );
  }
  for (const refusal of entry.refused) {
    deps.log(
      `  refused line ${refusal.line} ${refusal.code}: ${refusal.message}`,
    );
  }
}

export async function runDoctorFixCli(
  deps: ReviewCliDeps,
  options: ReviewCliOptions,
  json: boolean,
  ctx: ReviewCliContext,
): Promise<number> {
  const files = options.positionals;
  if (files.length === 0) {
    throw usageError(
      "Usage: roughdraft doctor --fix <file> [--dry-run] | roughdraft doctor --fix --dry-run --report <out.md> <files...>",
    );
  }
  if (options.report && !options.dryRun) {
    throw usageError(
      "--report needs --dry-run: the report is what you read before converting.",
    );
  }
  if (files.length > 1 && !options.dryRun) {
    throw usageError(
      "doctor --fix converts one file at a time; only --dry-run takes several.",
    );
  }

  if (options.report || files.length > 1) {
    const results = dryRunFiles(deps, files);
    let reportPath: string | null = null;
    if (options.report) {
      reportPath = path.resolve(deps.cwd, options.report);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        renderFixReport(results, { generatedAt: nowIso(deps), cwd: deps.cwd }),
      );
    }
    const tally = (kind: FixFileResult["result"]) =>
      results.filter((entry) => entry.result === kind).length;
    if (json) {
      emit(
        deps,
        envelope({
          dryRun: true,
          report: reportPath,
          counts: {
            files: results.length,
            converts: tally("converts"),
            unchanged: tally("unchanged"),
            refused: tally("refused"),
            error: tally("error"),
          },
          files: results,
        }),
      );
      return 0;
    }
    for (const entry of results) printFix(deps, entry);
    deps.log(
      `${results.length} file(s): ${tally("converts")} would convert, ${tally("unchanged")} unchanged, ${tally("refused")} refused${tally("error") > 0 ? `, ${tally("error")} unreadable` : ""}. Nothing was written.`,
    );
    if (reportPath) deps.log(`Report: ${reportPath}`);
    return 0;
  }

  const file = files[0] ?? "";
  ctx.path = path.resolve(deps.cwd, file);
  const result = await fixDocument(deps, file, { dryRun: options.dryRun });
  if (json) {
    emit(deps, envelope({ ...result, dryRun: options.dryRun }));
    return 0;
  }
  printFix(deps, result);
  if (result.backup) deps.log(`Backup: ${result.backup}`);
  if (result.after && result.result !== "unchanged") {
    printDoctor(deps, result.after);
  }
  return 0;
}
