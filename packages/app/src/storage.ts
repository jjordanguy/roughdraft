export interface Page {
  id: string;
  title: string;
  content: string;
  version?: string;
  // Batch 2 server fields. Older servers and the in-browser backends leave
  // them out; the sync controller derives a content hash when they do.
  contentHash?: string;
  seq?: number;
  instanceId?: string;
}

export class MarkdownFileConflictError extends Error {
  current: Page;

  constructor(current: Page) {
    super("Markdown file changed on disk");
    this.name = "MarkdownFileConflictError";
    this.current = current;
  }
}

// The file does not exist (GET or PUT answered 404 for a valid path).
export class MarkdownFileNotFoundError extends Error {
  path: string;

  constructor(path: string, message = `File not found: ${path}`) {
    super(message);
    this.name = "MarkdownFileNotFoundError";
    this.path = path;
  }
}

// The request never got an answer (connection refused, reset, DNS, abort).
export class ServerUnreachableError extends Error {
  constructor(route: string, cause?: unknown) {
    super(
      `The Roughdraft server did not answer (${route})${
        cause instanceof Error && cause.message ? `: ${cause.message}` : ""
      }`,
    );
    this.name = "ServerUnreachableError";
  }
}

// The server answered with a status the app does not expect.
export class ServerResponseError extends Error {
  status: number;
  route: string;

  constructor(route: string, status: number, detail?: string) {
    super(
      `The Roughdraft server answered ${status} (${route})${
        detail ? `: ${detail}` : ""
      }`,
    );
    this.name = "ServerResponseError";
    this.status = status;
    this.route = route;
  }
}

// The server predates a route (a batch 1 server has no state route and no
// tab channel). Callers fall back to the older route.
export class UnsupportedRouteError extends Error {
  constructor(route: string) {
    super(`The Roughdraft server does not support ${route}`);
    this.name = "UnsupportedRouteError";
  }
}

// `GET /api/markdown-file/state` and the `document` field of `hello`.
export interface MarkdownFileState {
  exists: boolean;
  available: boolean;
  reason?: string | null;
  version: string | null;
  contentHash: string | null;
  seq: number;
  instanceId?: string;
  tabs?: number;
}

export interface SaveMarkdownFileOptions {
  expectedContentHash?: string;
  tabId?: string;
  // "Recreate from my draft": write the file even though it is missing.
  // Needs a server that accepts `create` on PUT; an older one answers 404.
  create?: boolean;
}

// The "AI editing" flag of a document (batch 3b round route): `roughdraft
// round` and every quick command open it, `apply` closes it, and an open
// round turns `stalled` after 30 minutes without `apply`.
export interface RoundFlag {
  roundId: string;
  state: "open" | "stalled" | "closed";
  openedAt: string;
  updatedAt: string | null;
  stalledAt: string | null;
  closedAt: string | null;
}

// Tab channel wire types (batch 2 contract, "Tab channel").
export type TabServerMessage =
  | {
      type: "hello";
      instanceId: string;
      document: MarkdownFileState;
      tabs: number;
      watchers: number;
      session: SessionRecord | null;
      handoff: HandoffRecord | null;
      latestSequence: number | null;
      // Null when no round was seen (or the server predates rounds).
      round: RoundFlag | null;
    }
  | {
      type: "change";
      seq: number;
      exists: boolean;
      available: boolean;
      reason?: string | null;
      version: string | null;
      contentHash: string | null;
      origin: "tab" | "outside" | "unknown";
      tabId?: string;
    }
  | { type: "watchers"; count: number }
  | { type: "handoff"; handoff: HandoffRecord }
  | { type: "round"; round: RoundFlag }
  | { type: "open-request"; requestId: string; url: string }
  | { type: "ping"; seq: number }
  // The session that opened the document changed (registered, or ended).
  | { type: "session"; session: SessionRecord | null }
  // Closed from the open documents list.
  | { type: "close" };

export type TabClientMessage =
  | {
      type: "presence";
      visible: boolean;
      dirty: boolean;
      conflict: boolean;
      baseHash: string | null;
    }
  | { type: "open-request-ack"; requestId: string }
  | { type: "pong"; seq: number };

export interface TabChannelHandlers {
  onOpen: () => void;
  onMessage: (message: TabServerMessage) => void;
  onClose: () => void;
}

// One socket. The sync controller opens a new channel to reconnect.
export interface TabChannel {
  send: (message: TabClientMessage) => void;
  close: () => void;
}

export interface StoredAsset {
  markdownPath: string;
  previewUrl: string;
  mimeType: string;
}

// Wire types from the batch 1 server contract. The server owns the canonical
// definitions; these mirror them by name because the wire is JSON.
export interface HandoffWake {
  routeId: string | null;
  state: "none" | "sent" | "failed";
  at: string | null;
  error: string | null;
}

export interface HandoffRecord {
  sequence: number;
  handoffId: string;
  createdAt: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment: string | null;
  // "dropped": dropped from the open documents list; nothing waits on it.
  state: "pending" | "delivered" | "acknowledged" | "superseded" | "dropped";
  deliveredTo: string[];
  ackedAt: string | null;
  ackedBy: string | null;
  droppedAt?: string | null;
  wake: HandoffWake;
}

export interface SessionRecord {
  harness: string;
  label: string;
  link: string | null;
  sessionId: string | null;
  routeId: string | null;
  registeredAt: string;
}

export interface CompleteReviewResult {
  delivered: boolean;
  // Optional so backends without a handoff log (preview, browser storage)
  // can keep answering `{ delivered: false }`.
  pending?: boolean;
  handoff?: HandoffRecord | null;
  wake?: HandoffWake | null;
}

export interface CompleteReviewOptions {
  overallComment?: string;
  // Client-generated id, reused until a 2xx arrives so a retry is idempotent.
  handoffId?: string;
  // The version the tab's draft is based on. The server answers 409 with the
  // current page when the file moved on.
  expectedVersion?: string;
  expectedContentHash?: string;
}

export interface BackendInfo {
  kind: "local-files" | "local-storage";
  label: string;
  detail: string;
  projectPath?: string;
}

export interface StorageBackend {
  info: BackendInfo;
  canManageProjects: boolean;
  getMarkdownFile(relativePath: string): Promise<Page>;
  saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
    options?: SaveMarkdownFileOptions,
  ): Promise<Page | undefined>;
  getMarkdownFileState(relativePath: string): Promise<MarkdownFileState>;
  openTabChannel(
    relativePath: string,
    tabId: string,
    handlers: TabChannelHandlers,
  ): TabChannel;
  completeReview?(
    relativePath: string,
    options?: CompleteReviewOptions,
  ): Promise<CompleteReviewResult>;
  saveAsset(file: File): Promise<StoredAsset>;
  resolveFileUrl(path: string): string | null;
  openProject(path: string): Promise<void>;
}
