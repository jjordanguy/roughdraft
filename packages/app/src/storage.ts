export interface Page {
  id: string;
  title: string;
  content: string;
  version?: string;
}

export interface MarkdownFileChangeEvent {
  path: string;
  exists: boolean;
  version: string | null;
}

export class MarkdownFileConflictError extends Error {
  current: Page;

  constructor(current: Page) {
    super("Markdown file changed on disk");
    this.name = "MarkdownFileConflictError";
    this.current = current;
  }
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
  state: "pending" | "delivered" | "acknowledged" | "superseded";
  deliveredTo: string[];
  ackedAt: string | null;
  ackedBy: string | null;
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
}

export interface ReviewWatchStatus {
  watching: boolean;
  watcherCount: number;
  tabs?: number;
  handoff?: HandoffRecord | null;
  session?: SessionRecord | null;
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
  ): Promise<Page | undefined>;
  watchMarkdownFile?(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void;
  completeReview?(
    relativePath: string,
    options?: CompleteReviewOptions,
  ): Promise<CompleteReviewResult>;
  getReviewWatchStatus?(relativePath: string): Promise<ReviewWatchStatus>;
  saveAsset(file: File): Promise<StoredAsset>;
  resolveFileUrl(path: string): string | null;
  openProject(path: string): Promise<void>;
}
