/**
 * The open documents list in text form (`roughdraft documents`) and the
 * `close` command. The page at `/` groups the same way: one group per chat
 * session, ordered by latest activity, documents with no session last under
 * "No session", closed documents under "Earlier today" until the midnight
 * sweep takes them off.
 */
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import type { SessionRecord } from "./handoff-log.js";
import type { DocumentView } from "./registry.js";
import { type ApiContext, apiRequest } from "./review-watch-client.js";

const HARNESS_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
};

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness.trim().toLowerCase()] ?? harness;
}

export interface OpenDocumentGroup {
  /** Null for the "No session" group. */
  session: SessionRecord | null;
  documents: DocumentView[];
}

export interface OpenDocumentsList {
  groups: OpenDocumentGroup[];
  earlier: DocumentView[];
  sessionCount: number;
  windowCount: number;
}

function sessionKey(session: SessionRecord): string {
  return `${session.harness}\u0000${session.sessionId ?? session.label}`;
}

function byActivity(a: DocumentView, b: DocumentView): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

export function groupOpenDocuments(views: DocumentView[]): OpenDocumentsList {
  const listed = views.filter((view) => !view.sweptAt);
  const open = listed.filter((view) => !view.closedAt).sort(byActivity);
  const earlier = listed
    .filter((view) => view.closedAt)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  const groups: OpenDocumentGroup[] = [];
  const bySession = new Map<string, OpenDocumentGroup>();
  const noSession: OpenDocumentGroup = { session: null, documents: [] };
  for (const view of open) {
    if (!view.session) {
      noSession.documents.push(view);
      continue;
    }
    const key = sessionKey(view.session);
    let group = bySession.get(key);
    if (!group) {
      group = { session: view.session, documents: [] };
      bySession.set(key, group);
      groups.push(group);
    }
    group.documents.push(view);
  }
  if (noSession.documents.length > 0) groups.push(noSession);

  return {
    groups,
    earlier,
    sessionCount: bySession.size,
    windowCount: open.reduce((total, view) => total + view.tabs, 0),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `plan.md, ~/dev/project/docs` */
export function documentPlace(
  documentPath: string,
  homeDir: string = os.homedir(),
): string {
  const folder = path.dirname(documentPath);
  const shortFolder =
    folder === homeDir
      ? "~"
      : folder.startsWith(`${homeDir}${path.sep}`)
        ? `~${folder.slice(homeDir.length)}`
        : folder;
  return `${path.basename(documentPath)}, ${shortFolder}`;
}

export function documentStateParts(view: DocumentView): string[] {
  const parts: string[] = [];
  if ((view.tabsDirty ?? 0) > 0) parts.push("unsaved text in a window");
  const latest = view.handoffs.at(-1);
  if (latest?.state === "pending" || latest?.state === "delivered") {
    parts.push(`Done waiting since ${formatClock(latest.createdAt)}`);
  } else if (latest?.state === "acknowledged") {
    parts.push(`Done picked up at ${formatClock(latest.ackedAt)}`);
  } else if (latest?.state === "dropped") {
    parts.push("Done dropped");
  } else if (!latest) {
    parts.push("no Done yet");
  }
  if (view.round?.state === "open") parts.push("AI editing");
  if (!view.closedAt) parts.push(plural(view.tabs, "window"));
  if (view.sessionState === "ended") parts.push("session ended");
  return parts;
}

function sessionHeading(session: SessionRecord | null): string {
  if (!session) return "No session";
  return `${harnessName(session.harness)} · ${session.label}${session.link ? ` (${session.link})` : ""}`;
}

export function formatOpenDocuments(views: DocumentView[]): string[] {
  const list = groupOpenDocuments(views);
  const lines: string[] = [
    `Open documents: ${plural(list.sessionCount, "session")}, ${plural(list.windowCount, "window")}`,
  ];
  if (list.groups.length === 0) lines.push("", "No open documents.");
  for (const group of list.groups) {
    lines.push("", sessionHeading(group.session));
    for (const view of group.documents) {
      lines.push(
        `  ${view.title ?? path.basename(view.documentPath)} (${documentPlace(view.documentPath)})`,
        `    ${documentStateParts(view).join(", ")}`,
      );
    }
  }
  if (list.earlier.length > 0) {
    lines.push("", "Earlier today");
    for (const view of list.earlier) {
      const session = view.lastSession;
      lines.push(
        `  ${view.title ?? path.basename(view.documentPath)} (${documentPlace(view.documentPath)})`,
        `    closed at ${formatClock(view.closedAt)}${session ? `, ${harnessName(session.harness)} · ${session.label}` : ""}, ${documentStateParts(view).join(", ")}`,
      );
    }
  }
  return lines;
}

export interface CloseResult {
  closedTabs: number;
  document: DocumentView | null;
}

/** POST /api/documents/close for one file; refusals become CliErrors. */
export async function closeDocumentOnServer(
  ctx: ApiContext,
  documentPath: string,
): Promise<CloseResult> {
  const response = await apiRequest(ctx, "POST", "/api/documents/close", {
    body: {
      projectPath: path.dirname(documentPath),
      path: path.basename(documentPath),
    },
  });
  if (response.status === 409 && response.body?.code === "TAB_DIRTY") {
    throw new CliError(
      "TAB_DIRTY",
      `A window on ${documentPath} has unsaved text, so it was not closed.`,
      { hint: "Let the window save (or close it there), then try again." },
    );
  }
  if (response.status === 404) {
    throw new CliError(
      "DOCUMENT_NOT_FOUND",
      `Roughdraft has no open document at ${documentPath}.`,
      { hint: "Run `roughdraft documents` to list what is open." },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CliError(
      "HTTP_ERROR",
      `Closing ${documentPath} failed with HTTP ${response.status}${response.body?.error ? `: ${response.body.error}` : ""}.`,
    );
  }
  return {
    closedTabs:
      typeof response.body?.closedTabs === "number"
        ? response.body.closedTabs
        : 0,
    document: (response.body?.document as DocumentView | undefined) ?? null,
  };
}
