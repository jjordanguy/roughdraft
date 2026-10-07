import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReviewCompletedEvent, SeededEvent } from "./review-events.js";

export interface SessionRecord {
  harness: string;
  label: string;
  link: string | null;
  sessionId: string | null;
  routeId: string | null;
  registeredAt: string;
}

export interface HandoffSummary {
  comments: number;
  replies: number;
  suggestions: number;
  unresolved: number;
}

export interface WakeResult {
  routeId: string | null;
  state: "none" | "sent" | "failed";
  at: string | null;
  error: string | null;
}

export type HandoffState =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "superseded";

export interface HandoffRecord {
  sequence: number;
  handoffId: string;
  createdAt: string;
  version: string;
  summary: HandoffSummary;
  overallComment: string | null;
  state: HandoffState;
  deliveredTo: string[];
  ackedAt: string | null;
  ackedBy: string | null;
  wake: WakeResult;
}

export interface DocumentIdentity {
  key: string;
  documentPath: string;
  projectPath: string;
  relativePath: string;
}

export interface DocumentRecord extends DocumentIdentity {
  firstSeenAt: string;
  lastActivityAt: string;
  lastOpenRequestAt: string | null;
  lastKnownVersion: string | null;
  session: SessionRecord | null;
  handoffs: HandoffRecord[];
}

export interface NewHandoff {
  handoffId: string;
  version: string;
  summary: HandoffSummary;
  overallComment: string | null;
  wakeRouteId: string | null;
}

interface LogFile {
  schemaVersion: 1;
  logId: string;
  nextSequence: number;
  documents: Record<string, DocumentRecord>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const HANDOFF_RETENTION = {
  unacknowledgedMs: 14 * DAY_MS,
  acknowledgedMs: 2 * DAY_MS,
  perDocument: 50,
  overall: 500,
};

export const REVIEW_LOG_FILE = "review-log.json";

export function isUnacknowledged(handoff: HandoffRecord): boolean {
  return handoff.state === "pending" || handoff.state === "delivered";
}

export class ReviewLog {
  readonly filePath: string | null;
  readonly warnings: string[] = [];
  logId: string = crypto.randomUUID();
  private nextSequence = 1;
  private documents = new Map<string, DocumentRecord>();
  private readonly now: () => Date;

  constructor(options: { stateDir?: string; now?: () => Date } = {}) {
    this.filePath = options.stateDir
      ? path.join(options.stateDir, REVIEW_LOG_FILE)
      : null;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  peekNextSequence(): number {
    return this.nextSequence;
  }

  get(key: string): DocumentRecord | undefined {
    return this.documents.get(key);
  }

  all(): DocumentRecord[] {
    return [...this.documents.values()];
  }

  upsert(
    identity: DocumentIdentity,
    options: { keepExistingIdentity?: boolean } = {},
  ): DocumentRecord {
    const at = this.timestamp();
    const existing = this.documents.get(identity.key);
    if (!existing) {
      const created: DocumentRecord = {
        ...identity,
        firstSeenAt: at,
        lastActivityAt: at,
        lastOpenRequestAt: null,
        lastKnownVersion: null,
        session: null,
        handoffs: [],
      };
      this.documents.set(identity.key, created);
      return created;
    }
    if (!options.keepExistingIdentity) {
      existing.documentPath = identity.documentPath;
      existing.projectPath = identity.projectPath;
      existing.relativePath = identity.relativePath;
    }
    existing.lastActivityAt = at;
    return existing;
  }

  remove(key: string): void {
    const removed = this.documents.get(key);
    if (!removed) return;
    this.documents.delete(key);
    if (isPersisted(removed)) this.save();
  }

  setSession(
    identity: DocumentIdentity,
    session: Omit<SessionRecord, "registeredAt">,
  ): SessionRecord {
    const document = this.upsert(identity);
    const at = this.timestamp();
    document.session = { ...session, registeredAt: at };
    document.lastOpenRequestAt = at;
    this.save();
    return document.session;
  }

  findHandoff(query: {
    handoffId?: string;
    sequence?: number;
  }): { document: DocumentRecord; handoff: HandoffRecord } | null {
    for (const document of this.documents.values()) {
      const handoff = document.handoffs.find((candidate) =>
        query.handoffId !== undefined
          ? candidate.handoffId === query.handoffId
          : candidate.sequence === query.sequence,
      );
      if (handoff) return { document, handoff };
    }
    return null;
  }

  recordHandoff(identity: DocumentIdentity, input: NewHandoff): HandoffRecord {
    const document = this.upsert(identity);
    for (const older of document.handoffs) {
      if (isUnacknowledged(older)) older.state = "superseded";
    }
    const handoff: HandoffRecord = {
      sequence: this.nextSequence,
      handoffId: input.handoffId,
      createdAt: this.timestamp(),
      version: input.version,
      summary: { ...input.summary },
      overallComment: input.overallComment,
      state: "pending",
      deliveredTo: [],
      ackedAt: null,
      ackedBy: null,
      wake: {
        routeId: input.wakeRouteId,
        state: "none",
        at: null,
        error: null,
      },
    };
    this.nextSequence += 1;
    document.handoffs.push(handoff);
    document.lastKnownVersion = input.version;
    this.save();
    return handoff;
  }

  markDelivered(sequence: number, watcherId: string): HandoffRecord | null {
    const found = this.findHandoff({ sequence });
    if (!found) return null;
    const { handoff } = found;
    if (!handoff.deliveredTo.includes(watcherId)) {
      handoff.deliveredTo.push(watcherId);
    }
    if (handoff.state === "pending") handoff.state = "delivered";
    this.save();
    return handoff;
  }

  acknowledge(handoff: HandoffRecord, by: string | null): HandoffRecord {
    if (isUnacknowledged(handoff)) {
      handoff.state = "acknowledged";
      handoff.ackedAt = this.timestamp();
      handoff.ackedBy = by;
      this.save();
    }
    return handoff;
  }

  setWake(sequence: number, wake: WakeResult): void {
    const found = this.findHandoff({ sequence });
    if (!found) return;
    found.handoff.wake = wake;
    this.save();
  }

  unacknowledged(key: string): HandoffRecord[] {
    return (this.documents.get(key)?.handoffs ?? []).filter(isUnacknowledged);
  }

  latestHandoff(key: string): HandoffRecord | null {
    return this.documents.get(key)?.handoffs.at(-1) ?? null;
  }

  unacknowledgedEvents(): SeededEvent[] {
    return this.all().flatMap((document) =>
      document.handoffs.filter(isUnacknowledged).map((handoff) => ({
        documentKey: document.key,
        event: eventForHandoff(document, handoff),
      })),
    );
  }

  save(): void {
    if (!this.filePath) return;
    pruneHandoffs(this.all(), this.now().getTime());
    const file: LogFile = {
      schemaVersion: 1,
      logId: this.logId,
      nextSequence: this.nextSequence,
      documents: Object.fromEntries(
        this.all()
          .filter(isPersisted)
          .map((document) => [document.key, document]),
      ),
    };
    try {
      writeJsonAtomic(this.filePath, file);
    } catch (error) {
      this.warn(`Could not write ${this.filePath}: ${errorMessage(error)}`);
    }
  }

  private load(): void {
    if (!this.filePath) return;
    const loaded = readJsonState(this.filePath, isLogFile, this.now());
    if (loaded.warning) this.warn(loaded.warning);
    if (!loaded.value) return;

    this.logId = loaded.value.logId;
    for (const document of Object.values(loaded.value.documents)) {
      if (isDocumentRecord(document)) {
        this.documents.set(document.key, {
          ...document,
          lastOpenRequestAt: document.lastOpenRequestAt ?? null,
        });
      }
    }
    const highest = Math.max(
      0,
      ...this.all().flatMap((document) =>
        document.handoffs.map((handoff) => handoff.sequence),
      ),
    );
    this.nextSequence = Math.max(loaded.value.nextSequence, highest + 1, 1);
    pruneHandoffs(this.all(), this.now().getTime());
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function eventForHandoff(
  document: DocumentIdentity,
  handoff: HandoffRecord,
): ReviewCompletedEvent {
  return {
    type: "review.completed",
    documentPath: document.documentPath,
    projectPath: document.projectPath,
    relativePath: document.relativePath,
    version: handoff.version,
    summary: { ...handoff.summary },
    ...(handoff.overallComment !== null
      ? { overallComment: handoff.overallComment }
      : {}),
    sequence: handoff.sequence,
    createdAt: handoff.createdAt,
  };
}

export function pruneHandoffs(
  documents: DocumentRecord[],
  nowMs: number,
): void {
  for (const document of documents) {
    document.handoffs = document.handoffs
      .filter((handoff) => withinRetention(handoff, nowMs))
      .slice(-HANDOFF_RETENTION.perDocument);
  }
  const all = documents.flatMap((document) => document.handoffs);
  if (all.length <= HANDOFF_RETENTION.overall) return;
  const cutoff = all.map((handoff) => handoff.sequence).sort((a, b) => b - a)[
    HANDOFF_RETENTION.overall - 1
  ];
  for (const document of documents) {
    document.handoffs = document.handoffs.filter(
      (handoff) => handoff.sequence >= cutoff,
    );
  }
}

function withinRetention(handoff: HandoffRecord, nowMs: number): boolean {
  if (isUnacknowledged(handoff)) {
    return (
      nowMs - Date.parse(handoff.createdAt) <=
      HANDOFF_RETENTION.unacknowledgedMs
    );
  }
  const settledAt = Date.parse(handoff.ackedAt ?? handoff.createdAt);
  return nowMs - settledAt <= HANDOFF_RETENTION.acknowledgedMs;
}

function isPersisted(document: DocumentRecord): boolean {
  return document.session !== null || document.handoffs.length > 0;
}

function isLogFile(value: unknown): value is LogFile {
  const candidate = value as Partial<LogFile> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.schemaVersion === 1 &&
    typeof candidate.logId === "string" &&
    typeof candidate.nextSequence === "number" &&
    typeof candidate.documents === "object" &&
    candidate.documents !== null
  );
}

function isDocumentRecord(value: unknown): value is DocumentRecord {
  const candidate = value as Partial<DocumentRecord> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.key === "string" &&
    typeof candidate.documentPath === "string" &&
    Array.isArray(candidate.handoffs)
  );
}

export interface JsonStateResult<T> {
  value: T | null;
  warning: string | null;
}

/**
 * Reads a JSON state file. A file that does not parse or fails the shape check
 * is renamed aside with a `.corrupt-<timestamp>` suffix so a fresh one can start.
 */
export function readJsonState<T>(
  filePath: string,
  isValid: (value: unknown) => value is T,
  now: Date,
): JsonStateResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: null, warning: null };
    }
    return {
      value: null,
      warning: `Could not read ${filePath}: ${errorMessage(error)}. Starting with an empty one in memory.`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValid(parsed)) return { value: parsed, warning: null };
  } catch {}

  const asidePath = `${filePath}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(filePath, asidePath);
  } catch (error) {
    return {
      value: null,
      warning: `${filePath} was unreadable and could not be moved aside (${errorMessage(error)}). Started a fresh one.`,
    };
  }
  return {
    value: null,
    warning: `${filePath} was unreadable. Moved it to ${asidePath} and started a fresh one.`,
  };
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
