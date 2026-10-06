// The tab's sync controller for one open document (batch 2 contract, "App";
// batch 5 contract, "Controller").
//
// It owns the draft and the base the draft is built on, the save queue, the
// tab channel and every resync trigger. A newer disk version that arrives
// while the tab has unsaved edits is merged into the draft with rfm's
// `mergeReview` instead of blocking: edits in different places both land,
// overlapping prose becomes Jordan's suggestion against the disk text, and
// only an overlap no suggestion can hold waits for a choice, per hunk. The
// draft and its base are also kept in IndexedDB until they reach disk.
// It has no React in it so the rules can be tested with a fake backend and
// fake timers; App, DocumentWorkspace and PageCard only render what it says
// and forward edits to it.

import {
  type ConflictHunk,
  mergeReview,
  type RfmMergeChoice,
  type RfmMergeReviewResult,
} from "@roughdraft/rfm";
import { contentHashForPage, localContentHash } from "./content-hash";
import {
  describeDiskChange,
  findRemovedText,
  restoreRemovedText as insertRemovedText,
  type RemovedText,
  recordSavedText,
  type SavedRun,
} from "./disk-changes";
import type { DraftStore } from "./draft-store";
import {
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type HandoffRecord,
  MarkdownFileConflictError,
  MarkdownFileNotFoundError,
  type MarkdownFileState,
  type Page,
  type RoundFlag,
  ServerUnreachableError,
  type SessionRecord,
  type StorageBackend,
  type TabChannel,
  type TabServerMessage,
  UnsupportedRouteError,
} from "./storage";

export type { ConflictHunk } from "@roughdraft/rfm";

export interface Snapshot {
  content: string;
  version: string;
  contentHash: string;
  seq: number;
}

export type SyncState =
  | { kind: "synced" }
  | { kind: "pending" }
  | { kind: "saving"; again: boolean }
  | { kind: "offline"; retryAt: number }
  | { kind: "unavailable"; reason: string }
  // The draft overlaps a change on disk in a way no suggestion can hold.
  // The draft is kept and typing goes on; `theirs` is the disk version the
  // hunks were computed against. Autosave waits until every hunk is chosen.
  | { kind: "conflict"; hunks: ConflictHunk[]; theirs: Snapshot };

// The notices of D5, plus the restored-draft line.
export type SyncNotice =
  // Quiet: "Updated from disk: <summary>" with "show me".
  | {
      id: number;
      kind: "updated";
      summary: string;
      // The editor content the change arrived with, and the thread to
      // select, for "show me".
      epoch: number;
      commentId: string | null;
      suggestionsAdded: string[];
    }
  // Loud: "An outside write removed text you saved. Restore it?"
  | { id: number; kind: "removed"; removed: RemovedText[] }
  // "Restored unsaved edits from your last session"
  | { id: number; kind: "restored" };

export type ChannelConnection = "idle" | "connecting" | "open" | "closed";

export interface DocumentSyncView {
  state: SyncState;
  base: Snapshot;
  dirty: boolean;
  connection: ChannelConnection;
  // True once the server has sent a hello, so it speaks the tab channel.
  channelSupported: boolean;
  watchers: number;
  session: SessionRecord | null;
  handoff: HandoffRecord | null;
  // The agent's round on this document ("AI editing..." badge); null when
  // the server never reported one.
  round: RoundFlag | null;
  latestSequence: number | null;
  lastError: string | null;
  // At most one of each kind, newest last.
  notices: SyncNotice[];
}

export type FlushResult =
  | { status: "saved" }
  | { status: "blocked"; reason: "conflict" | "unavailable" }
  | { status: "conflict" }
  | { status: "error"; error: unknown };

export interface ContentUpdate {
  content: string;
  epoch: number;
  reason: "fast-forward" | "reload" | "rebase" | "restore";
}

// The editor applies the content in place when it can (PageCard).
export type ContentListener = (update: ContentUpdate) => void;

export type HandoffFailureKind = "file-changed" | "no-answer" | "failed";

export class HandoffError extends Error {
  kind: HandoffFailureKind;

  constructor(kind: HandoffFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = "HandoffError";
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface SyncEnvironmentHandlers {
  visibility: (visible: boolean) => void;
  focus: () => void;
  online: () => void;
  pageshow: () => void;
  // The page is going away: write a pending draft now.
  pagehide?: () => void;
}

export interface SyncEnvironment {
  isVisible: () => boolean;
  listen: (handlers: SyncEnvironmentHandlers) => () => void;
}

export function browserSyncEnvironment(): SyncEnvironment {
  return {
    isVisible: () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
    listen(handlers) {
      if (typeof window === "undefined") return () => {};
      const onVisibility = () =>
        handlers.visibility(document.visibilityState !== "hidden");
      const onFocus = () => handlers.focus();
      const onOnline = () => handlers.online();
      const onPageShow = () => handlers.pageshow();
      const onPageHide = () => handlers.pagehide?.();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("pagehide", onPageHide);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("pagehide", onPageHide);
      };
    },
  };
}

export type SyncBackend = Pick<
  StorageBackend,
  | "getMarkdownFile"
  | "saveMarkdownFile"
  | "getMarkdownFileState"
  | "openTabChannel"
  | "completeReview"
>;

export interface DocumentSyncOptions {
  backend: SyncBackend;
  path: string;
  tabId: string;
  initialPage: Page;
  environment?: SyncEnvironment;
  onOpenRequest?: (request: { requestId: string; url: string }) => void;
  // Where unsaved drafts are kept, and this document's key there (its
  // absolute path). Without both, drafts live only in memory.
  draftStore?: DraftStore | null;
  draftKey?: string | null;
  // The clock for suggestion timestamps and the saved-text window (tests).
  now?: () => number;
}

export const SAVE_DEBOUNCE_MS = 500;
export const DRAFT_DEBOUNCE_MS = 250;
// A conflict is merged again once typing pauses for this long: the edit may
// have settled the overlap.
export const REMERGE_DEBOUNCE_MS = 500;
export const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
export const SAVE_RETRY_STEADY_MS = 30_000;
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];
// Two missed 15 s pings plus slack.
export const PING_TIMEOUT_MS = 35_000;
export const HIDDEN_CLOSE_MS = 60_000;
export const PRESENCE_INTERVAL_MS = 5_000;
// A stored draft that IndexedDB does not return within this long is skipped.
export const DRAFT_RESTORE_TIMEOUT_MS = 1_500;
const OURS_LIMIT = 20;
const EPOCH_HISTORY = 8;

export function snapshotFromPage(page: Page): Snapshot {
  return {
    content: page.content,
    version: page.version ?? "",
    contentHash: contentHashForPage(page),
    seq: page.seq ?? 0,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// A choice for a hunk is remembered by what the hunk is, not by its id: the
// ids are only stable for the same three inputs, and the draft keeps
// changing while the banner is up.
function hunkKey(hunk: ConflictHunk): string {
  const entry = hunk.entry
    ? `${hunk.entry.section}:${hunk.entry.id}:${hunk.entry.key ?? ""}`
    : "";
  return [
    hunk.kind,
    hunk.reason,
    hunk.base ?? "",
    hunk.theirs ?? "",
    entry,
  ].join("\u0000");
}

function documentConflict(ours: string, error: unknown): RfmMergeReviewResult {
  return {
    merged: ours,
    conflicts: [
      {
        id: "document",
        kind: "document",
        reason: "result-invalid",
        message: `The two versions could not be merged (${describeError(error)}); keep one of them.`,
        choices: ["ours", "theirs"],
        base: null,
        ours: null,
        theirs: null,
        lines: null,
        entry: null,
      },
    ],
    suggestionsAdded: [],
    rekeyed: {},
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class DocumentSync {
  readonly path: string;
  readonly tabId: string;
  readonly pageId: string;
  readonly title: string;

  private readonly backend: SyncBackend;
  private readonly environment: SyncEnvironment;
  private readonly onOpenRequest?: DocumentSyncOptions["onOpenRequest"];
  private readonly draftStore: DraftStore | null;
  private readonly draftKey: string | null;
  private readonly now: () => number;

  private base: Snapshot;
  private draftContent: string;
  private state: SyncState = { kind: "synced" };
  private lastError: string | null = null;
  private readonly ours: string[] = [];
  // Choices made in the conflict banner, by hunk content (see hunkKey).
  private readonly resolutions = new Map<string, RfmMergeChoice>();
  // Body lines this tab saved in the last five minutes (the loud notice).
  private savedRuns: SavedRun[] = [];
  private notices: SyncNotice[] = [];
  private noticeSeq = 0;

  // Every content the controller pushes into the editor gets a new epoch.
  // Edits carry the epoch of the content they were typed on, so an edit made
  // on content the editor had not replaced yet can be moved onto the new one.
  private contentEpoch = 0;
  private readonly epochs = new Map<
    number,
    { content: string; base: Snapshot }
  >();

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private remergeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private inFlight: Promise<void> | null = null;
  private deferred: { state?: MarkdownFileState; snapshot?: Snapshot } | null =
    null;

  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private draftWrites: Promise<void> = Promise.resolve();

  private resyncing: Promise<void> | null = null;
  private resyncAgain = false;
  private fetching: Promise<void> | null = null;
  private refetch = false;

  private channel: TabChannel | null = null;
  private channelGeneration = 0;
  private connection: ChannelConnection = "idle";
  private channelSupported = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenClosed = false;
  private visible = true;

  private watchers = 0;
  private session: SessionRecord | null = null;
  private handoff: HandoffRecord | null = null;
  private round: RoundFlag | null = null;
  private latestSequence: number | null = null;

  private presenceKey: string | null = null;
  private lastPresence: { visible: boolean; conflict: boolean } | null = null;
  private presenceSentAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  private started = false;
  private disposed = false;
  private stopListening: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly contentListeners = new Set<ContentListener>();
  private readonly helloListeners = new Set<() => void>();
  private view: DocumentSyncView;

  constructor(options: DocumentSyncOptions) {
    this.backend = options.backend;
    this.path = options.path;
    this.tabId = options.tabId;
    this.pageId = options.initialPage.id;
    this.title = options.initialPage.title;
    this.environment = options.environment ?? browserSyncEnvironment();
    this.onOpenRequest = options.onOpenRequest;
    this.draftStore = options.draftStore ?? null;
    this.draftKey = options.draftKey ?? null;
    this.now = options.now ?? Date.now;
    this.base = snapshotFromPage(options.initialPage);
    this.draftContent = this.base.content;
    this.epochs.set(0, { content: this.base.content, base: this.base });
    this.view = this.buildView();
  }

  // --- Reading -------------------------------------------------------------

  get draft(): string {
    return this.draftContent;
  }

  get epoch(): number {
    return this.contentEpoch;
  }

  getView = (): DocumentSyncView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onContentUpdate(listener: ContentListener): () => void {
    this.contentListeners.add(listener);
    return () => this.contentListeners.delete(listener);
  }

  // Fires on every hello. App uses it to drop the legacy open-requests
  // stream once the server proves it speaks the tab channel.
  onHello(listener: () => void): () => void {
    this.helloListeners.add(listener);
    return () => this.helloListeners.delete(listener);
  }

  // --- Lifecycle -----------------------------------------------------------

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.visible = this.environment.isVisible();
    this.stopListening = this.environment.listen({
      visibility: (visible) => this.handleVisibility(visible),
      focus: () => void this.resync(),
      online: () => this.handleOnline(),
      pageshow: () => this.handlePageShow(),
      pagehide: () => this.flushDraftWrite(),
    });
    if (this.visible) {
      this.connect();
    } else {
      this.hiddenClosed = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.flushDraftWrite();
    this.disposed = true;
    this.stopListening?.();
    this.stopListening = null;
    this.clearSaveTimer();
    this.clearRemergeTimer();
    this.clearRetryTimer();
    this.clearTimer("reconnectTimer");
    this.clearTimer("hiddenTimer");
    this.clearTimer("presenceTimer");
    this.closeChannel();
    this.listeners.clear();
    this.contentListeners.clear();
    this.helloListeners.clear();
  }

  // --- Local edits and saving ----------------------------------------------

  edit(markdown: string, epoch: number = this.contentEpoch): void {
    if (this.disposed) return;

    if (epoch < this.contentEpoch) {
      this.editOnStaleContent(markdown, epoch);
      return;
    }

    this.draftContent = markdown;
    this.afterDraftChange();
  }

  // Saves now. Resolves once the draft is on disk or the save cannot finish.
  async flush(): Promise<FlushResult> {
    this.clearSaveTimer();
    for (let pass = 0; pass < 5 && !this.disposed; pass += 1) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      const blocked = this.blockedReason();
      if (blocked) return { status: "blocked", reason: blocked };
      if (this.draftContent === this.base.content) {
        if (this.state.kind === "offline" || this.state.kind === "pending") {
          this.clearRetryTimer();
          this.setState({ kind: "synced" });
        }
        return { status: "saved" };
      }
      this.clearRetryTimer();
      await this.startSave(this.draftContent, this.base);
      if (this.state.kind === "conflict") return { status: "conflict" };
      if (this.state.kind === "offline") {
        return { status: "error", error: new Error(this.lastError ?? "") };
      }
    }
    if (this.draftContent === this.base.content) return { status: "saved" };
    const blocked = this.blockedReason();
    if (blocked) return { status: "blocked", reason: blocked };
    return {
      status: "error",
      error: new Error(this.lastError ?? "The save did not finish."),
    };
  }

  private blockedReason(): "conflict" | "unavailable" | null {
    const kind = this.state.kind;
    if (kind === "conflict" || kind === "unavailable") return kind;
    return null;
  }

  private afterDraftChange(): void {
    const dirty = this.draftContent !== this.base.content;
    const state = this.state;
    this.scheduleDraftWrite();

    if (state.kind === "conflict") {
      if (!dirty) {
        // The user undid their edits; nothing is left to protect.
        this.clearRemergeTimer();
        this.resolutions.clear();
        this.setState({ kind: "synced" });
        this.applySnapshot(state.theirs);
        return;
      }
      // Typing goes on beside the banner. Once it pauses, merge again: the
      // edit may have settled an overlap, or moved it.
      this.armRemergeTimer();
      this.notify();
      return;
    }

    if (state.kind === "unavailable") {
      // Held until the file is back.
      this.notify();
      return;
    }

    if (state.kind === "offline") {
      if (!dirty && !this.inFlight) {
        this.clearRetryTimer();
        this.setState({ kind: "synced" });
      } else {
        this.notify();
      }
      return;
    }

    if (this.inFlight) {
      // The next PUT goes out when this one settles, on its returned base.
      this.setState({ kind: "saving", again: true });
      if (dirty) this.armSaveTimer();
      return;
    }

    if (!dirty) {
      this.clearSaveTimer();
      this.setState({ kind: "synced" });
      return;
    }

    this.armSaveTimer();
    this.setState({ kind: "pending" });
  }

  private armSaveTimer(): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.runSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private armRemergeTimer(): void {
    this.clearRemergeTimer();
    this.remergeTimer = setTimeout(() => {
      this.remergeTimer = null;
      if (this.disposed || this.state.kind !== "conflict") return;
      if (this.inFlight) return;
      this.rebase(this.state.theirs);
    }, REMERGE_DEBOUNCE_MS);
  }

  private runSave(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) {
      if (this.state.kind === "saving" && !this.state.again) {
        this.setState({ kind: "saving", again: true });
      }
      return this.inFlight;
    }
    if (this.blockedReason()) return Promise.resolve();
    if (this.draftContent === this.base.content) {
      if (this.state.kind !== "synced") {
        this.clearRetryTimer();
        this.setState({ kind: "synced" });
      }
      return Promise.resolve();
    }
    return this.startSave(this.draftContent, this.base);
  }

  private startSave(content: string, expected: Snapshot): Promise<void> {
    this.setState({ kind: "saving", again: false });
    const promise = this.performSave(content, expected).finally(() => {
      this.inFlight = null;
      this.afterSave();
    });
    this.inFlight = promise;
    return promise;
  }

  private async performSave(content: string, expected: Snapshot) {
    const previousBase = this.base;
    try {
      const page = await this.backend.saveMarkdownFile(
        this.path,
        content,
        expected.version || undefined,
        { expectedContentHash: expected.contentHash, tabId: this.tabId },
      );
      if (this.disposed) return;
      const saved = page
        ? snapshotFromPage(page)
        : {
            content,
            version: "",
            contentHash: localContentHash(content),
            seq: expected.seq,
          };
      this.rememberOurs(saved.contentHash);
      this.savedRuns = recordSavedText(
        this.savedRuns,
        previousBase.content,
        content,
        this.now(),
      );
      // Keep the text we sent as the base content so the editor's draft
      // compares equal, and the server's hash so the next PUT matches disk.
      this.base = { ...saved, content };
      this.retryAttempt = 0;
      this.lastError = null;
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof MarkdownFileConflictError) {
        const theirs = snapshotFromPage(error.current);
        if (theirs.content === content) {
          // Our earlier write landed but its answer was lost, or someone
          // wrote the same text. Either way disk has the draft.
          this.rememberOurs(theirs.contentHash);
          this.base = theirs;
          this.lastError = null;
          return;
        }
        // Disk moved under the save: merge onto the version in the answer.
        this.clearSaveTimer();
        this.clearRetryTimer();
        this.rebase(theirs);
        return;
      }
      if (error instanceof MarkdownFileNotFoundError) {
        this.enterUnavailable("missing");
        void this.resync();
        return;
      }
      this.lastError = describeError(error);
      this.enterOffline();
      void this.resync();
    }
  }

  private afterSave(): void {
    if (this.disposed) return;
    const deferred = this.deferred;
    this.deferred = null;

    const state = this.state;
    if (
      state.kind === "conflict" ||
      state.kind === "unavailable" ||
      state.kind === "offline"
    ) {
      this.processDeferred(deferred);
      return;
    }

    // The save succeeded (or merged). Disk news that arrived meanwhile goes
    // first so the dirty check below sees the final base.
    this.processDeferred(deferred);
    if (this.blockedReason()) return;

    if (this.draftContent === this.base.content) {
      this.clearSaveTimer();
      this.setState({ kind: "synced" });
      // The draft reached disk: nothing to keep in the browser.
      this.flushDraftWrite();
      return;
    }
    if (this.saveTimer) {
      this.setState({ kind: "pending" });
      return;
    }
    void this.runSave();
  }

  private processDeferred(
    deferred: { state?: MarkdownFileState; snapshot?: Snapshot } | null,
  ): void {
    if (!deferred) return;
    if (deferred.snapshot) this.applySnapshot(deferred.snapshot);
    else if (deferred.state) void this.handleState(deferred.state);
  }

  private enterOffline(): void {
    this.clearSaveTimer();
    this.clearRetryTimer();
    const delay =
      SAVE_RETRY_DELAYS_MS[this.retryAttempt] ?? SAVE_RETRY_STEADY_MS;
    this.retryAttempt += 1;
    this.setState({ kind: "offline", retryAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retrySave();
    }, delay);
  }

  // Retries an offline save now (timer, reconnect, online, visible, button).
  retrySave(): void {
    if (this.disposed || this.state.kind !== "offline") return;
    this.clearRetryTimer();
    void this.runSave();
  }

  private enterUnavailable(reason: string): void {
    this.clearSaveTimer();
    this.clearRetryTimer();
    if (this.state.kind === "unavailable" && this.state.reason === reason) {
      return;
    }
    this.setState({ kind: "unavailable", reason });
  }

  private leaveUnavailable(): void {
    if (this.state.kind !== "unavailable") return;
    if (this.draftContent === this.base.content) {
      this.setState({ kind: "synced" });
    } else {
      this.armSaveTimer();
      this.setState({ kind: "pending" });
    }
  }

  // "Recreate from my draft": the file is gone; write the draft back to its
  // path. Needs a server that accepts `create` on PUT.
  async recreateFromDraft(): Promise<boolean> {
    if (this.disposed || this.state.kind !== "unavailable") return false;
    if (this.inFlight) await this.inFlight;
    const content = this.draftContent;
    try {
      const page = await this.backend.saveMarkdownFile(
        this.path,
        content,
        undefined,
        { tabId: this.tabId, create: true },
      );
      if (this.disposed) return false;
      const saved = page
        ? snapshotFromPage(page)
        : {
            content,
            version: "",
            contentHash: localContentHash(content),
            seq: this.base.seq,
          };
      this.rememberOurs(saved.contentHash);
      this.base = { ...saved, content };
      this.lastError = null;
      if (this.draftContent === this.base.content) {
        this.setState({ kind: "synced" });
        this.flushDraftWrite();
      } else {
        this.armSaveTimer();
        this.setState({ kind: "pending" });
      }
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.lastError =
        error instanceof MarkdownFileNotFoundError
          ? "This Roughdraft server cannot recreate a missing file. Update Roughdraft, or save the text elsewhere from the code view."
          : describeError(error);
      this.notify();
      return false;
    }
  }

  // --- Incoming disk state -------------------------------------------------

  private async handleState(state: MarkdownFileState): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      // Decide after the PUT answers: it may be the echo of our own write.
      this.deferred = { state };
      return;
    }
    if (!state.exists) {
      this.enterUnavailable("missing");
      return;
    }
    if (!state.available) {
      this.enterUnavailable(state.reason || "unreadable");
      return;
    }
    if (state.contentHash === this.base.contentHash) {
      this.leaveUnavailable();
      return;
    }
    if (state.contentHash && this.ours.includes(state.contentHash)) {
      this.leaveUnavailable();
      return;
    }
    if (
      this.state.kind === "conflict" &&
      state.contentHash === this.state.theirs.contentHash
    ) {
      return;
    }
    await this.fetchAndApply();
  }

  private fetchAndApply(): Promise<void> {
    if (this.fetching) {
      this.refetch = true;
      return this.fetching;
    }
    const run = async () => {
      do {
        this.refetch = false;
        let page: Page;
        try {
          page = await this.backend.getMarkdownFile(this.path);
        } catch (error) {
          if (this.disposed) return;
          if (error instanceof MarkdownFileNotFoundError) {
            this.enterUnavailable("missing");
          }
          return;
        }
        if (this.disposed) return;
        // The dirty check happens here, after the fetch (sync finding 1).
        this.applySnapshot(snapshotFromPage(page));
      } while (this.refetch && !this.disposed);
    };
    this.fetching = run().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private applySnapshot(snapshot: Snapshot): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.deferred = { snapshot };
      return;
    }
    if (snapshot.contentHash === this.base.contentHash) {
      this.leaveUnavailable();
      return;
    }
    if (this.ours.includes(snapshot.contentHash)) {
      this.leaveUnavailable();
      return;
    }
    if (
      this.state.kind === "conflict" &&
      snapshot.contentHash === this.state.theirs.contentHash
    ) {
      return;
    }
    if (snapshot.content === this.draftContent) {
      // Disk already holds the draft.
      this.base = snapshot;
      this.clearSaveTimer();
      this.clearRemergeTimer();
      this.clearRetryTimer();
      this.resolutions.clear();
      this.setState({ kind: "synced" });
      this.flushDraftWrite();
      return;
    }

    if (this.draftContent === this.base.content) {
      this.fastForward(snapshot);
      return;
    }

    // Dirty: merge the draft onto the new disk version.
    this.rebase(snapshot);
  }

  private fastForward(snapshot: Snapshot): void {
    const oldBase = this.base.content;
    const oldDraft = this.draftContent;
    this.clearSaveTimer();
    this.clearRetryTimer();
    this.base = snapshot;
    this.draftContent = snapshot.content;
    this.setState({ kind: "synced" });
    this.pushContent("fast-forward");
    this.noteIncoming(oldBase, oldDraft, snapshot, []);
  }

  // The batch 5 merge: the draft (built on `base`) onto a newer disk version.
  // Clean: the merge becomes the draft, the editor takes it in place and a
  // save follows. Otherwise the draft is kept and the hunks wait for a choice.
  private rebase(theirs: Snapshot, options: { quiet?: boolean } = {}): void {
    const result = this.runMerge(this.base.content, this.draftContent, theirs);
    if (result.conflicts.length === 0) {
      this.applyMerged(theirs, result, options);
      return;
    }
    this.clearSaveTimer();
    this.clearRemergeTimer();
    this.clearRetryTimer();
    this.setState({ kind: "conflict", hunks: result.conflicts, theirs });
    this.scheduleDraftWrite();
  }

  private runMerge(
    base: string,
    ours: string,
    theirs: Snapshot,
  ): RfmMergeReviewResult {
    const now = new Date(this.now()).toISOString();
    try {
      const first = mergeReview(base, ours, theirs.content, { now });
      if (first.conflicts.length === 0 || this.resolutions.size === 0) {
        return first;
      }
      const chosen: Record<string, RfmMergeChoice> = {};
      for (const hunk of first.conflicts) {
        const choice = this.resolutions.get(hunkKey(hunk));
        if (choice && hunk.choices.includes(choice)) chosen[hunk.id] = choice;
      }
      if (Object.keys(chosen).length === 0) return first;
      return mergeReview(base, ours, theirs.content, {
        now,
        resolutions: chosen,
      });
    } catch (error) {
      return documentConflict(ours, error);
    }
  }

  private applyMerged(
    theirs: Snapshot,
    result: RfmMergeReviewResult,
    options: { quiet?: boolean } = {},
  ): void {
    const oldBase = this.base.content;
    const oldDraft = this.draftContent;
    this.clearRemergeTimer();
    this.resolutions.clear();
    this.base = theirs;
    this.draftContent = result.merged;
    this.pushContent("rebase");
    if (!options.quiet) {
      this.noteIncoming(oldBase, oldDraft, theirs, result.suggestionsAdded);
    }
    if (this.inFlight) {
      // A 409 answer: the save that is ending arms the next one.
      this.armSaveTimer();
      this.scheduleDraftWrite();
      return;
    }
    if (this.draftContent === this.base.content) {
      this.clearSaveTimer();
      this.setState({ kind: "synced" });
      this.flushDraftWrite();
      return;
    }
    this.armSaveTimer();
    this.setState({ kind: "pending" });
    this.scheduleDraftWrite();
  }

  // The notices for a change that arrived from disk (D5).
  private noteIncoming(
    oldBase: string,
    oldDraft: string,
    theirs: Snapshot,
    suggestionsAdded: string[],
  ): void {
    const change = describeDiskChange(oldBase, theirs.content);
    const summary =
      suggestionsAdded.length > 0
        ? `${change.summary}; your overlapping edit is kept as a suggestion`
        : change.summary;
    this.pushNotice({
      id: 0,
      kind: "updated",
      summary,
      epoch: this.contentEpoch,
      commentId: change.commentId,
      suggestionsAdded,
    });
    const removed = findRemovedText(
      this.savedRuns,
      oldBase,
      oldDraft,
      this.draftContent,
      this.now(),
    );
    if (removed.length > 0) {
      this.pushNotice({ id: 0, kind: "removed", removed });
    }
  }

  private pushContent(reason: ContentUpdate["reason"]): void {
    this.contentEpoch += 1;
    this.epochs.set(this.contentEpoch, {
      content: this.draftContent,
      base: this.base,
    });
    for (const key of this.epochs.keys()) {
      if (key <= this.contentEpoch - EPOCH_HISTORY) this.epochs.delete(key);
    }
    const update: ContentUpdate = {
      content: this.draftContent,
      epoch: this.contentEpoch,
      reason,
    };
    for (const listener of [...this.contentListeners]) {
      listener(update);
    }
  }

  // An edit typed on content the editor had not replaced yet (the editor
  // was resetting when the new content arrived). The keystrokes are merged
  // onto the current draft; if they overlap what changed, they are kept on
  // the base they were typed on and merged onto disk like any draft.
  private editOnStaleContent(markdown: string, epoch: number): void {
    const typedOn = this.epochs.get(epoch);
    if (!typedOn) {
      this.draftContent = markdown;
      this.pushContent("rebase");
      this.afterDraftChange();
      return;
    }
    let merged: RfmMergeReviewResult | null = null;
    try {
      merged = mergeReview(typedOn.content, markdown, this.draftContent, {
        now: new Date(this.now()).toISOString(),
      });
    } catch {
      merged = null;
    }
    if (merged && merged.conflicts.length === 0) {
      this.draftContent = merged.merged;
      this.pushContent("rebase");
      this.afterDraftChange();
      return;
    }

    const current = this.base;
    this.base = typedOn.base;
    this.draftContent = markdown;
    if (typedOn.base.contentHash === current.contentHash) {
      this.pushContent("rebase");
      this.afterDraftChange();
      return;
    }
    this.rebase(current, { quiet: true });
    if (this.state.kind === "conflict") this.pushContent("rebase");
  }

  // --- The conflict banner -------------------------------------------------

  // A choice for one hunk of the banner. Settled hunks drop out; when none
  // is left the merge applies like a clean one.
  resolveHunk(hunkId: string, choice: RfmMergeChoice): void {
    if (this.disposed || this.state.kind !== "conflict") return;
    const hunk = this.state.hunks.find((candidate) => candidate.id === hunkId);
    if (!hunk?.choices.includes(choice)) return;
    if (this.inFlight) return;
    this.resolutions.set(hunkKey(hunk), choice);
    this.rebase(this.state.theirs, { quiet: true });
  }

  // The explicit overwrite, behind a confirmation that shows the diff: the
  // draft replaces exactly the version the dialog showed. If disk moved
  // again since, the server refuses and the draft merges onto the newer one.
  async overwrite(shown: Snapshot): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.disposed || this.state.kind !== "conflict") return;
    this.clearSaveTimer();
    this.clearRemergeTimer();
    this.resolutions.clear();
    await this.startSave(this.draftContent, shown);
  }

  // Reload from disk: drop the draft and take the current file (the review
  // block error's Reload).
  async reloadFromDisk(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    const page = await this.backend.getMarkdownFile(this.path);
    if (this.disposed) return;
    this.clearSaveTimer();
    this.clearRemergeTimer();
    this.clearRetryTimer();
    this.resolutions.clear();
    this.base = snapshotFromPage(page);
    this.draftContent = this.base.content;
    this.setState({ kind: "synced" });
    this.pushContent("reload");
    this.flushDraftWrite();
  }

  // --- Notices -------------------------------------------------------------

  private pushNotice(notice: SyncNotice): void {
    this.noticeSeq += 1;
    const next = { ...notice, id: this.noticeSeq } as SyncNotice;
    this.notices = [
      ...this.notices.filter((current) => current.kind !== notice.kind),
      next,
    ];
    this.notify();
  }

  dismissNotice(id: number): void {
    const next = this.notices.filter((notice) => notice.id !== id);
    if (next.length === this.notices.length) return;
    this.notices = next;
    this.notify();
  }

  // Restore from the loud notice: each removed piece goes back in as
  // Jordan's insertion suggestion, and the draft saves.
  restoreRemovedText(noticeId: number): void {
    const notice = this.notices.find((current) => current.id === noticeId);
    if (!notice || notice.kind !== "removed") return;
    let next = this.draftContent;
    const at = new Date(this.now()).toISOString();
    for (const removed of notice.removed) {
      next = insertRemovedText(next, removed, at);
    }
    this.dismissNotice(noticeId);
    if (next === this.draftContent) return;
    this.draftContent = next;
    this.pushContent("restore");
    this.afterDraftChange();
  }

  // --- Drafts kept in the browser ------------------------------------------

  // On load: a draft this browser kept for the document goes back into the
  // editor, merged onto the file as it is now. App calls it before the
  // editor mounts. True when a draft was restored.
  async restoreDraft(): Promise<boolean> {
    const store = this.draftStore;
    const key = this.draftKey;
    if (!store || !key || this.disposed) return false;
    let stored: Awaited<ReturnType<DraftStore["get"]>>;
    try {
      stored = await withTimeout(store.get(key), DRAFT_RESTORE_TIMEOUT_MS);
    } catch {
      return false;
    }
    if (!stored || this.disposed) return false;
    // Typed already, or the draft is what disk holds now.
    if (this.draftContent !== this.base.content) return false;
    if (stored.draft === this.base.content) {
      this.flushDraftWrite();
      return false;
    }

    const current = this.base;
    if (
      stored.base.contentHash === current.contentHash ||
      stored.base.content === current.content
    ) {
      this.draftContent = stored.draft;
      this.pushContent("restore");
      this.afterDraftChange();
    } else {
      this.base = stored.base;
      this.draftContent = stored.draft;
      this.rebase(current, { quiet: true });
      if (this.state.kind === "conflict") this.pushContent("restore");
    }
    this.pushNotice({ id: 0, kind: "restored" });
    return true;
  }

  private scheduleDraftWrite(): void {
    if (!this.draftStore || !this.draftKey || this.disposed) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.writeDraftNow();
    }, DRAFT_DEBOUNCE_MS);
  }

  // Writes the pending draft (or removes the record once the draft is on
  // disk) right away.
  private flushDraftWrite(): void {
    if (!this.draftStore || !this.draftKey || this.disposed) return;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.writeDraftNow();
  }

  private writeDraftNow(): void {
    const store = this.draftStore;
    const key = this.draftKey;
    if (!store || !key) return;
    const dirty = this.draftContent !== this.base.content;
    const base = this.base;
    const record = dirty
      ? {
          key,
          draft: this.draftContent,
          base,
          tabId: this.tabId,
          savedAt: this.now(),
        }
      : null;
    this.draftWrites = this.draftWrites
      .then(() =>
        record
          ? store.put(record)
          : store.delete(
              key,
              // Another tab's newer draft for the same file stays.
              (stored) =>
                stored.tabId === this.tabId || stored.draft === base.content,
            ),
      )
      .catch((error) => {
        console.warn("Could not keep the draft in this browser:", error);
      });
  }

  // Resolves once every draft write queued so far is done (tests).
  whenDraftsWritten(): Promise<void> {
    return this.draftWrites;
  }

  // --- Resync --------------------------------------------------------------

  resync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.resyncing) {
      this.resyncAgain = true;
      return this.resyncing;
    }
    const run = async () => {
      do {
        this.resyncAgain = false;
        await this.resyncOnce();
      } while (this.resyncAgain && !this.disposed);
    };
    this.resyncing = run().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  private async resyncOnce(): Promise<void> {
    let state: MarkdownFileState;
    try {
      state = await this.backend.getMarkdownFileState(this.path);
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof UnsupportedRouteError) {
        // A batch 1 server: compare by fetching the page.
        await this.fetchAndApply();
        return;
      }
      if (error instanceof MarkdownFileNotFoundError) {
        this.enterUnavailable("missing");
      }
      // Otherwise the server is not answering; the save retry covers it.
      return;
    }
    if (this.disposed) return;
    await this.handleState(state);
  }

  // --- Handoff -------------------------------------------------------------

  async completeReview(
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    if (!this.backend.completeReview) return { delivered: false };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const flushed = await this.flush();
      if (flushed.status === "blocked" || flushed.status === "conflict") {
        const unavailable =
          flushed.status === "blocked" && flushed.reason === "unavailable";
        throw new HandoffError(
          unavailable ? "failed" : "file-changed",
          unavailable
            ? "The file is not available on disk."
            : "Your edit overlaps a change on disk.",
        );
      }
      if (flushed.status === "error") {
        throw new HandoffError(
          "no-answer",
          this.lastError ?? "The Roughdraft server did not answer.",
          flushed.error,
        );
      }

      const expected = this.base;
      try {
        return await this.backend.completeReview(this.path, {
          ...options,
          ...(expected.version ? { expectedVersion: expected.version } : {}),
          expectedContentHash: expected.contentHash,
        });
      } catch (error) {
        if (error instanceof MarkdownFileConflictError) {
          const theirs = snapshotFromPage(error.current);
          if (theirs.content === this.draftContent) {
            // Same text under a new hash: adopt it and try again.
            this.base = theirs;
            this.notify();
            continue;
          }
          // Disk moved after the flush: take the change (merging any
          // draft), save, and send Done again.
          this.applySnapshot(theirs);
          if (this.state.kind === "conflict") {
            throw new HandoffError(
              "file-changed",
              "Your edit overlaps a change on disk.",
              error,
            );
          }
          continue;
        }
        if (error instanceof ServerUnreachableError) {
          throw new HandoffError("no-answer", error.message, error);
        }
        throw new HandoffError("failed", describeError(error), error);
      }
    }
    throw new HandoffError("file-changed", "The file changed on disk.");
  }

  // --- Tab channel ---------------------------------------------------------

  private connect(): void {
    if (this.disposed || this.channel) return;
    this.clearTimer("reconnectTimer");
    const generation = ++this.channelGeneration;
    this.connection = "connecting";
    this.notify();
    this.channel = this.backend.openTabChannel(this.path, this.tabId, {
      onOpen: () => {
        if (generation !== this.channelGeneration) return;
        this.connection = "open";
        this.reconnectAttempt = 0;
        this.armPingTimer();
        this.sendPresence(true);
        this.notify();
      },
      onMessage: (message) => {
        if (generation !== this.channelGeneration) return;
        this.armPingTimer();
        this.handleMessage(message);
      },
      onClose: () => {
        if (generation !== this.channelGeneration) return;
        this.channel = null;
        this.connection = "closed";
        this.clearTimer("pingTimer");
        this.notify();
        this.scheduleReconnect();
      },
    });
  }

  private closeChannel(): void {
    this.channelGeneration += 1;
    const channel = this.channel;
    this.channel = null;
    this.clearTimer("pingTimer");
    channel?.close();
    if (this.connection !== "idle") this.connection = "closed";
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.hiddenClosed || this.reconnectTimer) return;
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ] ?? 5_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armPingTimer(): void {
    this.clearTimer("pingTimer");
    if (this.connection !== "open") return;
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      // Two pings missed: the socket is probably dead without a close.
      this.closeChannel();
      this.notify();
      void this.resync();
      this.connect();
    }, PING_TIMEOUT_MS);
  }

  private handleMessage(message: TabServerMessage): void {
    switch (message.type) {
      case "hello": {
        this.channelSupported = true;
        this.watchers = message.watchers;
        this.session = message.session;
        this.handoff = message.handoff;
        this.round = message.round;
        this.latestSequence = message.latestSequence;
        this.notify();
        for (const listener of [...this.helloListeners]) listener();
        // A hello after any gap is a resync. It carries the state already.
        this.retrySave();
        void this.handleState(message.document);
        return;
      }
      case "change": {
        if (
          message.origin === "tab" &&
          message.tabId === this.tabId &&
          message.contentHash
        ) {
          this.rememberOurs(message.contentHash);
        }
        void this.handleState(message);
        return;
      }
      case "watchers":
        this.watchers = message.count;
        this.notify();
        return;
      case "handoff":
        this.handoff = message.handoff;
        this.notify();
        return;
      case "round":
        this.round = message.round;
        this.notify();
        return;
      case "open-request":
        this.onOpenRequest?.({
          requestId: message.requestId,
          url: message.url,
        });
        return;
      case "ping":
        this.channel?.send({ type: "pong", seq: message.seq });
        return;
    }
  }

  // The server only needs the ack; App owns focus and navigation.
  acknowledgeOpenRequest(requestId: string): boolean {
    if (!this.channel || this.connection !== "open") return false;
    this.channel.send({ type: "open-request-ack", requestId });
    return true;
  }

  private sendPresence(force = false): void {
    if (!this.channel || this.connection !== "open") return;
    const dirty = this.draftContent !== this.base.content;
    const presence = {
      visible: this.visible,
      dirty,
      conflict: this.state.kind === "conflict",
      baseHash: this.base.contentHash || null,
    };
    const key = JSON.stringify(presence);
    if (!force && key === this.presenceKey) return;

    const last = this.lastPresence;
    const urgent =
      !last ||
      last.visible !== presence.visible ||
      last.conflict !== presence.conflict;
    const now = Date.now();
    const wait = this.presenceSentAt + PRESENCE_INTERVAL_MS - now;
    if (!force && !urgent && wait > 0) {
      // While typing, dirty and baseHash flip on every save; send at most
      // one presence every 5 s and let the trailing send carry the latest.
      if (!this.presenceTimer) {
        this.presenceTimer = setTimeout(() => {
          this.presenceTimer = null;
          this.sendPresence();
        }, wait);
      }
      return;
    }
    this.clearTimer("presenceTimer");
    this.presenceKey = key;
    this.lastPresence = presence;
    this.presenceSentAt = now;
    this.channel.send({ type: "presence", ...presence });
  }

  // --- Environment ---------------------------------------------------------

  private handleVisibility(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    if (!visible) {
      this.flushDraftWrite();
      this.clearTimer("hiddenTimer");
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        this.hiddenClosed = true;
        this.clearTimer("reconnectTimer");
        this.closeChannel();
        this.notify();
      }, HIDDEN_CLOSE_MS);
      this.sendPresence();
      return;
    }
    this.clearTimer("hiddenTimer");
    if (this.hiddenClosed || !this.channel) {
      this.hiddenClosed = false;
      this.reconnectAttempt = 0;
      this.connect();
    } else {
      this.sendPresence();
    }
    this.retrySave();
    void this.resync();
  }

  private handleOnline(): void {
    if (this.disposed) return;
    if (!this.channel && !this.hiddenClosed) {
      this.reconnectAttempt = 0;
      this.connect();
    }
    this.retrySave();
    void this.resync();
  }

  private handlePageShow(): void {
    if (this.disposed) return;
    if (!this.channel && !this.hiddenClosed) this.connect();
    void this.resync();
  }

  // --- Plumbing ------------------------------------------------------------

  private rememberOurs(hash: string): void {
    if (!hash || this.ours.includes(hash)) return;
    this.ours.push(hash);
    if (this.ours.length > OURS_LIMIT) this.ours.shift();
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private clearRemergeTimer(): void {
    if (this.remergeTimer) {
      clearTimeout(this.remergeTimer);
      this.remergeTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimer(
    name: "reconnectTimer" | "pingTimer" | "hiddenTimer" | "presenceTimer",
  ): void {
    const timer = this[name];
    if (timer) {
      clearTimeout(timer);
      this[name] = null;
    }
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.notify();
  }

  private buildView(): DocumentSyncView {
    return {
      state: this.state,
      base: this.base,
      dirty: this.draftContent !== this.base.content,
      connection: this.connection,
      channelSupported: this.channelSupported,
      watchers: this.watchers,
      session: this.session,
      handoff: this.handoff,
      round: this.round,
      latestSequence: this.latestSequence,
      lastError: this.lastError,
      notices: this.notices,
    };
  }

  private notify(): void {
    if (this.disposed) return;
    const next = this.buildView();
    const previous = this.view;
    const changed = (Object.keys(next) as (keyof DocumentSyncView)[]).some(
      (key) => next[key] !== previous[key],
    );
    this.sendPresence();
    if (!changed) return;
    this.view = next;
    for (const listener of [...this.listeners]) listener();
  }
}
