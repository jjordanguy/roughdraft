// The tab's sync controller for one open document (batch 2 contract, "App").
//
// It owns the draft and the base the draft is built on, the save queue, the
// tab channel and every resync trigger. It has no React in it so the rules
// can be tested with a fake backend and fake timers; App, DocumentWorkspace
// and PageCard only render what it says and forward edits to it.

import { contentHashForPage, localContentHash } from "./content-hash";
import {
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type HandoffRecord,
  type RoundFlag,
  MarkdownFileConflictError,
  MarkdownFileNotFoundError,
  type MarkdownFileState,
  type Page,
  ServerUnreachableError,
  type SessionRecord,
  type StorageBackend,
  type TabChannel,
  type TabServerMessage,
  UnsupportedRouteError,
} from "./storage";

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
  // Dirty tab, newer disk. Batch 5 replaces this with rebasing.
  | { kind: "changed"; theirs: Snapshot }
  // 409 on save. Batch 5 replaces this with rebasing.
  | { kind: "conflict"; theirs: Snapshot };

export type ChannelConnection = "idle" | "connecting" | "open" | "closed";

export interface DocumentSyncView {
  state: SyncState;
  base: Snapshot;
  dirty: boolean;
  // "Keep editing with autosave paused" was chosen in changed or conflict.
  paused: boolean;
  // Disk changes that arrived after the banner first showed.
  theirsUpdates: number;
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
}

export type FlushResult =
  | { status: "saved" }
  | { status: "blocked"; reason: "changed" | "conflict" | "unavailable" }
  | { status: "conflict" }
  | { status: "error"; error: unknown };

export interface ContentUpdate {
  content: string;
  epoch: number;
  reason: "fast-forward" | "reload" | "rebase";
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
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);
      window.addEventListener("pageshow", onPageShow);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("pageshow", onPageShow);
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
}

export const SAVE_DEBOUNCE_MS = 500;
export const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
export const SAVE_RETRY_STEADY_MS = 30_000;
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];
// Two missed 15 s pings plus slack.
export const PING_TIMEOUT_MS = 35_000;
export const HIDDEN_CLOSE_MS = 60_000;
export const PRESENCE_INTERVAL_MS = 5_000;
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

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let index = 0;
  while (
    index < limit &&
    a.charCodeAt(a.length - 1 - index) === b.charCodeAt(b.length - 1 - index)
  ) {
    index += 1;
  }
  return index;
}

// Re-applies one contiguous local edit (old -> mine) on top of a newer text
// (old -> theirs) when the two edits do not touch. Returns null when they
// overlap, so the caller keeps the user's text and shows the disk change
// instead of guessing. Batch 5 replaces this with the full merge.
export function mergeSingleEdit(
  old: string,
  mine: string,
  theirs: string,
): string | null {
  if (mine === old) return theirs;
  if (theirs === old || theirs === mine) return mine;

  const myPrefix = commonPrefixLength(old, mine);
  const mySuffix = commonSuffixLength(old, mine, myPrefix);
  const myStart = myPrefix;
  const myEnd = old.length - mySuffix;
  const myText = mine.slice(myPrefix, mine.length - mySuffix);

  const theirPrefix = commonPrefixLength(old, theirs);
  const theirSuffix = commonSuffixLength(old, theirs, theirPrefix);
  const theirStart = theirPrefix;
  const theirEnd = old.length - theirSuffix;

  if (myEnd <= theirStart && myStart < theirStart) {
    return theirs.slice(0, myStart) + myText + theirs.slice(myEnd);
  }
  if (myStart >= theirEnd && myStart > theirStart) {
    const delta = theirs.length - old.length;
    return (
      theirs.slice(0, myStart + delta) + myText + theirs.slice(myEnd + delta)
    );
  }
  return null;
}

export class DocumentSync {
  readonly path: string;
  readonly tabId: string;
  readonly pageId: string;
  readonly title: string;

  private readonly backend: SyncBackend;
  private readonly environment: SyncEnvironment;
  private readonly onOpenRequest?: DocumentSyncOptions["onOpenRequest"];

  private base: Snapshot;
  private draftContent: string;
  private state: SyncState = { kind: "synced" };
  private paused = false;
  private theirsUpdates = 0;
  private lastError: string | null = null;
  private readonly ours: string[] = [];

  // Every content the controller pushes into the editor gets a new epoch.
  // Edits carry the epoch of the content they were typed on, so an edit made
  // on content the editor had not replaced yet can be moved onto the new one.
  private contentEpoch = 0;
  private diskEpoch = 0;
  private readonly epochs = new Map<
    number,
    { content: string; base: Snapshot }
  >();

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private inFlight: Promise<void> | null = null;
  private deferred: { state?: MarkdownFileState; snapshot?: Snapshot } | null =
    null;

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
    });
    if (this.visible) {
      this.connect();
    } else {
      this.hiddenClosed = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListening?.();
    this.stopListening = null;
    this.clearSaveTimer();
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

  private blockedReason(): "changed" | "conflict" | "unavailable" | null {
    const kind = this.state.kind;
    if (kind === "changed" || kind === "conflict" || kind === "unavailable") {
      return kind;
    }
    return null;
  }

  private afterDraftChange(): void {
    const dirty = this.draftContent !== this.base.content;
    const state = this.state;

    if (state.kind === "changed" || state.kind === "conflict") {
      if (!dirty) {
        // The user undid their edits; nothing is left to protect.
        const theirs = state.theirs;
        this.paused = false;
        this.setState({ kind: "synced" });
        this.applySnapshot(theirs);
        return;
      }
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
        this.clearSaveTimer();
        this.clearRetryTimer();
        this.paused = false;
        this.theirsUpdates = 0;
        this.setState({ kind: "conflict", theirs });
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
    if (state.kind === "changed") {
      // A newer disk version arrived while the save was out.
      if (this.draftContent === this.base.content) {
        this.setState({ kind: "synced" });
        this.applySnapshot(state.theirs);
      } else {
        this.notify();
      }
      this.processDeferred(deferred);
      return;
    }
    if (
      state.kind === "conflict" ||
      state.kind === "unavailable" ||
      state.kind === "offline"
    ) {
      this.processDeferred(deferred);
      return;
    }

    // The save succeeded. Disk news that arrived meanwhile goes first so the
    // dirty check below sees the final base.
    this.processDeferred(deferred);
    if (this.blockedReason()) return;

    if (this.draftContent === this.base.content) {
      this.clearSaveTimer();
      this.setState({ kind: "synced" });
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
      (this.state.kind === "changed" || this.state.kind === "conflict") &&
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
    if (snapshot.content === this.draftContent) {
      // Disk already holds the draft.
      this.base = snapshot;
      this.clearSaveTimer();
      this.clearRetryTimer();
      this.setState({ kind: "synced" });
      return;
    }

    const state = this.state;
    if (state.kind === "changed" || state.kind === "conflict") {
      if (snapshot.contentHash !== state.theirs.contentHash) {
        this.theirsUpdates += 1;
        this.setState({ kind: state.kind, theirs: snapshot });
      }
      return;
    }

    if (this.draftContent === this.base.content) {
      this.fastForward(snapshot);
      return;
    }

    // Dirty: never move the base while the draft depends on it.
    this.clearSaveTimer();
    this.clearRetryTimer();
    this.paused = false;
    this.theirsUpdates = 0;
    this.setState({ kind: "changed", theirs: snapshot });
  }

  private fastForward(snapshot: Snapshot): void {
    this.clearSaveTimer();
    this.clearRetryTimer();
    this.base = snapshot;
    this.draftContent = snapshot.content;
    this.setState({ kind: "synced" });
    this.pushContent("fast-forward");
  }

  private pushContent(reason: ContentUpdate["reason"]): void {
    this.contentEpoch += 1;
    if (reason !== "rebase") this.diskEpoch = this.contentEpoch;
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
  // was resetting when the new content arrived).
  private editOnStaleContent(markdown: string, epoch: number): void {
    const typedOn = this.epochs.get(epoch);
    // The old editor reports everything typed since `epoch`, so the edit is
    // replayed on the newest disk content, not on an earlier replay.
    const target = this.epochs.get(this.diskEpoch);
    const merged =
      typedOn && target && this.diskEpoch > epoch
        ? mergeSingleEdit(typedOn.content, markdown, target.content)
        : null;

    if (merged !== null) {
      this.draftContent = merged;
      this.pushContent("rebase");
      this.afterDraftChange();
      return;
    }

    // Cannot place the keystrokes: keep them on the base they were typed on
    // and show the newer disk text as a change, so nothing is lost.
    const theirs = target?.base ?? this.base;
    this.base = typedOn?.base ?? this.base;
    this.draftContent = markdown;
    this.pushContent("rebase");
    if (
      this.draftContent === this.base.content ||
      theirs.contentHash === this.base.contentHash
    ) {
      this.afterDraftChange();
      return;
    }
    this.clearSaveTimer();
    this.paused = false;
    this.theirsUpdates = 0;
    this.setState({ kind: "changed", theirs });
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

  // --- Banner actions ------------------------------------------------------

  // Reload from disk: drop the draft and take the current file.
  async reloadFromDisk(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    const page = await this.backend.getMarkdownFile(this.path);
    if (this.disposed) return;
    this.clearSaveTimer();
    this.clearRetryTimer();
    this.base = snapshotFromPage(page);
    this.draftContent = this.base.content;
    this.paused = false;
    this.theirsUpdates = 0;
    this.setState({ kind: "synced" });
    this.pushContent("reload");
  }

  keepEditing(): void {
    if (this.state.kind !== "changed" && this.state.kind !== "conflict") {
      return;
    }
    this.paused = true;
    this.notify();
  }

  // Overwrite the version the banner shows. If disk moved again since, the
  // server answers 409 and the banner shows the newer version instead.
  async overwrite(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    const state = this.state;
    if (state.kind !== "changed" && state.kind !== "conflict") return;
    this.clearSaveTimer();
    this.paused = false;
    this.theirsUpdates = 0;
    await this.startSave(this.draftContent, state.theirs);
  }

  // --- Handoff -------------------------------------------------------------

  async completeReview(
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    if (!this.backend.completeReview) return { delivered: false };

    const flushed = await this.flush();
    if (flushed.status === "blocked") {
      throw new HandoffError(
        flushed.reason === "unavailable" ? "failed" : "file-changed",
        flushed.reason === "unavailable"
          ? "The file is not available on disk."
          : "The file changed on disk.",
      );
    }
    if (flushed.status === "conflict") {
      throw new HandoffError("file-changed", "The file changed on disk.");
    }
    if (flushed.status === "error") {
      throw new HandoffError(
        "no-answer",
        this.lastError ?? "The Roughdraft server did not answer.",
        flushed.error,
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
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
          if (theirs.content === this.draftContent && attempt === 0) {
            // Same text under a new hash: adopt it and try once more.
            this.base = theirs;
            this.notify();
            continue;
          }
          this.clearSaveTimer();
          this.paused = false;
          this.theirsUpdates = 0;
          this.setState({ kind: "conflict", theirs });
          throw new HandoffError(
            "file-changed",
            "The file changed on disk.",
            error,
          );
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
      conflict: this.state.kind === "changed" || this.state.kind === "conflict",
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
      paused: this.paused,
      theirsUpdates: this.theirsUpdates,
      connection: this.connection,
      channelSupported: this.channelSupported,
      watchers: this.watchers,
      session: this.session,
      handoff: this.handoff,
      round: this.round,
      latestSequence: this.latestSequence,
      lastError: this.lastError,
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
