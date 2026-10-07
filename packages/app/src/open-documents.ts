// The open documents list at `/`: what the server reports per document,
// grouped by the chat session that opened it, and the actions on a row. The
// CLI's `roughdraft documents` groups the same way (server open-documents.ts).

import type { RoundFlag, SessionRecord } from "./storage";

export type SessionState = "live" | "ended" | "unknown";

export interface LatestHandoff {
  handoffId: string;
  state: "pending" | "delivered" | "acknowledged" | "superseded" | "dropped";
  createdAt: string;
  ackedAt: string | null;
  droppedAt: string | null;
  comments: number;
}

export interface OpenDocument {
  key: string;
  documentPath: string;
  projectPath: string;
  relativePath: string;
  title: string | null;
  tabs: number;
  tabsDirty: number;
  session: SessionRecord | null;
  lastSession: SessionRecord | null;
  sessionState: SessionState;
  closedAt: string | null;
  sweptAt: string | null;
  firstSeenAt: string;
  lastActivityAt: string;
  lastOpenRequestAt: string | null;
  latestHandoff: LatestHandoff | null;
  round: RoundFlag | null;
}

export interface DocumentGroup {
  // Null for "No session".
  session: SessionRecord | null;
  documents: OpenDocument[];
}

export interface OpenDocumentsList {
  groups: DocumentGroup[];
  earlier: OpenDocument[];
  sessionCount: number;
  windowCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSession(value: unknown): SessionRecord | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  return {
    harness: stringOr(value.harness, ""),
    label: value.label,
    link: stringOr(value.link, null),
    sessionId: stringOr(value.sessionId, null),
    routeId: stringOr(value.routeId, null),
    registeredAt: stringOr(value.registeredAt, ""),
  };
}

const HANDOFF_STATES = new Set<LatestHandoff["state"]>([
  "pending",
  "delivered",
  "acknowledged",
  "superseded",
  "dropped",
]);

function parseLatestHandoff(value: unknown): LatestHandoff | null {
  if (!isRecord(value) || typeof value.handoffId !== "string") return null;
  const state = value.state as LatestHandoff["state"];
  if (!HANDOFF_STATES.has(state)) return null;
  return {
    handoffId: value.handoffId,
    state,
    createdAt: stringOr(value.createdAt, ""),
    ackedAt: stringOr(value.ackedAt, null),
    droppedAt: stringOr(value.droppedAt, null),
    comments: numberOr(value.comments, 0),
  };
}

function parseRound(value: unknown): RoundFlag | null {
  if (!isRecord(value) || typeof value.roundId !== "string") return null;
  if (
    value.state !== "open" &&
    value.state !== "stalled" &&
    value.state !== "closed"
  ) {
    return null;
  }
  return value as unknown as RoundFlag;
}

export function parseOpenDocument(value: unknown): OpenDocument | null {
  if (!isRecord(value) || typeof value.documentPath !== "string") return null;
  const sessionState = value.sessionState;
  return {
    key: stringOr(value.key, value.documentPath),
    documentPath: value.documentPath,
    projectPath: stringOr(value.projectPath, ""),
    relativePath: stringOr(value.relativePath, ""),
    title: stringOr(value.title, null),
    tabs: numberOr(value.tabs, 0),
    tabsDirty: numberOr(value.tabsDirty, 0),
    session: parseSession(value.session),
    lastSession: parseSession(value.lastSession),
    sessionState:
      sessionState === "live" || sessionState === "ended"
        ? sessionState
        : "unknown",
    closedAt: stringOr(value.closedAt, null),
    sweptAt: stringOr(value.sweptAt, null),
    firstSeenAt: stringOr(value.firstSeenAt, ""),
    lastActivityAt: stringOr(value.lastActivityAt, ""),
    lastOpenRequestAt: stringOr(value.lastOpenRequestAt, null),
    latestHandoff: parseLatestHandoff(value.latestHandoff),
    round: parseRound(value.round),
  };
}

export function parseOpenDocuments(payload: unknown): OpenDocument[] {
  if (!isRecord(payload) || !Array.isArray(payload.documents)) return [];
  return payload.documents
    .map(parseOpenDocument)
    .filter((document): document is OpenDocument => document !== null);
}

const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
};

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness.trim().toLowerCase()] ?? harness;
}

function sessionKey(session: SessionRecord): string {
  return `${session.harness}\u0000${session.sessionId ?? session.label}`;
}

function byActivity(a: OpenDocument, b: OpenDocument): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

// Groups and rows by latest activity, "No session" last, closed documents in
// Earlier today (newest close first) until the midnight sweep takes them off.
export function groupOpenDocuments(
  documents: OpenDocument[],
): OpenDocumentsList {
  const listed = documents.filter((document) => !document.sweptAt);
  const open = listed.filter((document) => !document.closedAt).sort(byActivity);
  const earlier = listed
    .filter((document) => document.closedAt)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  const groups: DocumentGroup[] = [];
  const bySession = new Map<string, DocumentGroup>();
  const noSession: DocumentGroup = { session: null, documents: [] };
  for (const document of open) {
    if (!document.session) {
      noSession.documents.push(document);
      continue;
    }
    const key = sessionKey(document.session);
    let group = bySession.get(key);
    if (!group) {
      group = { session: document.session, documents: [] };
      bySession.set(key, group);
      groups.push(group);
    }
    group.documents.push(document);
  }
  if (noSession.documents.length > 0) groups.push(noSession);

  return {
    groups,
    earlier,
    sessionCount: bySession.size,
    windowCount: open.reduce((total, document) => total + document.tabs, 0),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// "3 sessions, 4 windows"
export function describeCounts(list: OpenDocumentsList): string {
  return `${plural(list.sessionCount, "session")}, ${plural(list.windowCount, "window")}`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function leaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

// "plan.md · ~/dev/roughdraft/.context"
export function documentPlace(documentPath: string): string {
  const separator = Math.max(
    documentPath.lastIndexOf("/"),
    documentPath.lastIndexOf("\\"),
  );
  const folder = separator > 0 ? documentPath.slice(0, separator) : "/";
  const shortFolder = folder
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/root(?=\/|$)/, "~");
  return `${leaf(documentPath)} · ${shortFolder}`;
}

export function documentTitle(document: OpenDocument): string {
  return document.title ?? leaf(document.documentPath);
}

export type StatusTone = "good" | "warn" | "muted";

export interface StatusPart {
  text: string;
  tone: StatusTone;
}

export function isDoneWaiting(document: OpenDocument): boolean {
  const state = document.latestHandoff?.state;
  return state === "pending" || state === "delivered";
}

// The row's one-line state: unsaved text, the latest Done, an AI round, how
// many windows, whether the session ended.
export function describeStatus(
  document: OpenDocument,
  formatTime: (iso: string | null) => string = formatClock,
): StatusPart[] {
  const parts: StatusPart[] = [];
  if (document.tabsDirty > 0) {
    parts.push({ text: "unsaved text in a window", tone: "warn" });
  }
  const latest = document.latestHandoff;
  if (latest && isDoneWaiting(document)) {
    parts.push({
      text: `Done waiting since ${formatTime(latest.createdAt)}`,
      tone: "warn",
    });
  } else if (latest?.state === "acknowledged") {
    parts.push({
      text: `Done picked up at ${formatTime(latest.ackedAt)}`,
      tone: "good",
    });
  } else if (latest?.state === "dropped") {
    parts.push({ text: "Done dropped", tone: "muted" });
  } else if (!latest) {
    parts.push({ text: "no Done yet", tone: "muted" });
  }
  if (document.round?.state === "open") {
    parts.push({ text: "AI editing", tone: "muted" });
  }
  if (!document.closedAt) {
    parts.push({ text: plural(document.tabs, "window"), tone: "muted" });
  }
  if (document.sessionState === "ended") {
    parts.push({ text: "session ended", tone: "muted" });
  }
  return parts;
}

// The link that opens the document, on the address this page was loaded from
// (the server's own link names localhost, which is wrong over Tailscale).
export function documentLink(documentPath: string, origin: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("path", documentPath);
  return url.toString();
}

export function peerLabel(peerUrl: string): string {
  try {
    return new URL(peerUrl).host;
  } catch {
    return peerUrl;
  }
}

// --- Server calls ----------------------------------------------------------

async function postJson(
  route: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: payload };
}

export async function fetchOpenDocuments(): Promise<OpenDocument[]> {
  const response = await fetch("/api/documents");
  if (!response.ok) {
    throw new Error(`The server answered ${response.status}`);
  }
  return parseOpenDocuments(await response.json());
}

export async function fetchPeerUrl(): Promise<string | null> {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) return null;
    const payload = (await response.json()) as { peerUrl?: unknown };
    return typeof payload.peerUrl === "string" ? payload.peerUrl : null;
  } catch {
    return null;
  }
}

export type CloseOutcome = "closed" | "dirty" | "failed";

export async function closeDocument(
  document: OpenDocument,
): Promise<CloseOutcome> {
  const result = await postJson("/api/documents/close", {
    projectPath: document.projectPath,
    path: document.relativePath,
  });
  if (result.status === 409) return "dirty";
  return result.status >= 200 && result.status < 300 ? "closed" : "failed";
}

export async function closeFinishedDocuments(): Promise<{
  closed: number;
  skipped: number;
}> {
  const result = await postJson("/api/documents/close-finished", {});
  const body = isRecord(result.body) ? result.body : {};
  return {
    closed: Array.isArray(body.closed) ? body.closed.length : 0,
    skipped: Array.isArray(body.skipped) ? body.skipped.length : 0,
  };
}

export async function dropHandoff(handoffId: string): Promise<boolean> {
  const result = await postJson("/api/review-events/drop", { handoffId });
  return result.status >= 200 && result.status < 300;
}

// Brings the document's window forward through the same open request
// `roughdraft open` uses; a new window when no tab answers.
export async function openDocumentWindow(
  document: OpenDocument,
  origin: string,
  openWindow: (url: string) => void,
): Promise<void> {
  const url = documentLink(document.documentPath, origin);
  try {
    const result = await postJson("/api/open-request", {
      path: document.documentPath,
      url,
    });
    const body = isRecord(result.body) ? result.body : {};
    if (body.delivered === true && body.acknowledged === true) return;
  } catch {
    // No answer: open the link.
  }
  openWindow(url);
}

// A document window's title: "<document title> · <session title>", or the
// document title alone when no session is registered.
export function documentWindowTitle(
  title: string,
  sessionLabel: string | null,
): string {
  const label = sessionLabel?.trim();
  return label ? `${title} · ${label}` : title;
}
