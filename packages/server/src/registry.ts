import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { documentTitleFromMarkdown } from "@roughdraft/rfm";
import {
  type DocumentIdentity,
  type DocumentRecord,
  HANDOFF_RETENTION,
  type HandoffRecord,
  isUnacknowledged,
  type ReviewLog,
  type SessionRecord,
} from "./handoff-log.js";
import type { SessionState, SessionStateOf } from "./session-state.js";

export interface TabPresence {
  tabId: string;
  connectedAt: string;
  lastSeenAt: string;
  visible: boolean;
  /** The tab holds text that has not reached disk. */
  dirty: boolean;
  conflict: boolean;
  /** Content hash the tab's draft is based on. */
  baseHash: string | null;
}

export type TabPresenceUpdate = Partial<
  Pick<TabPresence, "visible" | "dirty" | "conflict" | "baseHash">
>;

export type RegistryChange = "tabs" | "watchers" | "round" | "session";

/**
 * The "AI editing" flag of a document: `roughdraft round` opens it, `apply`
 * closes it, and an open round turns `stalled` after `roundStallMs` (30
 * minutes) so the tab can tell Jordan he is free. Kept in memory only.
 */
export interface RoundFlag {
  roundId: string;
  state: "open" | "closed" | "stalled";
  openedAt: string;
  updatedAt: string;
  stalledAt: string | null;
  closedAt: string | null;
}

export type RoundFlagResult =
  | { ok: true; round: RoundFlag }
  | { ok: false; round: RoundFlag };
export type RegistryListener = (key: string, change: RegistryChange) => void;

export interface WatcherPresence {
  watcherId: string;
  kind: "stream" | "long-poll";
  client: string | null;
  connectedAt: string;
  afterSequence: number;
}

/** The latest Done of a document, as the open documents list shows it. */
export interface LatestHandoffSummary {
  handoffId: string;
  sequence: number;
  state: HandoffRecord["state"];
  createdAt: string;
  comments: number;
  wakeState: HandoffRecord["wake"]["state"];
  ackedAt: string | null;
  droppedAt: string | null;
}

export function summarizeHandoff(
  handoff: HandoffRecord | undefined,
): LatestHandoffSummary | null {
  if (!handoff) return null;
  return {
    handoffId: handoff.handoffId,
    sequence: handoff.sequence,
    state: handoff.state,
    createdAt: handoff.createdAt,
    comments: handoff.summary.comments,
    wakeState: handoff.wake.state,
    ackedAt: handoff.ackedAt,
    droppedAt: handoff.droppedAt ?? null,
  };
}

export interface DocumentView extends DocumentRecord {
  /** The file's first heading; null when it has none or cannot be read. */
  title?: string | null;
  /** Whether the session that opened it still runs (claude-code only). */
  sessionState?: SessionState;
  latestHandoff?: LatestHandoffSummary | null;
  tabs: number;
  /**
   * Tabs that reported unsaved text. Always set by the registry; optional so
   * views rebuilt from the log file on disk (no presence) still type-check.
   */
  tabsDirty?: number;
  /** Tabs that reported a conflict they have not settled. */
  tabsConflict?: number;
  /** The document's round flag; null when no round was seen. */
  round?: RoundFlag | null;
  watchers: number;
  pendingHandoffs: number;
  url: string;
}

interface TabEntry extends TabPresence {
  connections: number;
  disconnectedAt: number | null;
  dropTimer: NodeJS.Timeout | null;
}

interface Presence {
  tabs: Map<string, TabEntry>;
  watchers: Map<string, WatcherPresence>;
}

export interface RegistryOptions {
  log: ReviewLog;
  publicBaseUrl: string;
  now?: () => number;
  tabGraceMs?: number;
  documentIdleMs?: number;
  roundStallMs?: number;
  /** Session liveness for views; every session is "unknown" without it. */
  sessionStates?: () => SessionStateOf;
}

const TITLE_READ_BYTES = 256 * 1024;

/** Today's local midnight, as epoch milliseconds. */
export function localMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export const ROUND_STALL_MS = 30 * 60 * 1000;
export const TAB_GRACE_MS = 30_000;
export const DOCUMENT_IDLE_MS = 60 * 60 * 1000;

/**
 * The key every lookup uses, so `/tmp/x.md` and `/private/tmp/x.md` meet.
 * A missing file keys on its real parent directory, so the key does not
 * change when the file disappears and comes back.
 */
export function documentKey(absolutePath: string): string {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    const resolved = path.resolve(absolutePath);
    try {
      return path.join(
        fs.realpathSync.native(path.dirname(resolved)),
        path.basename(resolved),
      );
    } catch {
      return resolved;
    }
  }
}

export function identityFor(
  absolutePath: string,
  projectPath = path.dirname(absolutePath),
  relativePath = path.basename(absolutePath),
): DocumentIdentity {
  return {
    key: documentKey(absolutePath),
    documentPath: path.resolve(absolutePath),
    projectPath,
    relativePath,
  };
}

export function documentUrl(
  publicBaseUrl: string,
  documentPath: string,
): string {
  const url = new URL(publicBaseUrl);
  url.pathname = "/";
  url.searchParams.set("path", documentPath);
  return url.toString();
}

export class DocumentRegistry {
  readonly log: ReviewLog;
  private readonly presence = new Map<string, Presence>();
  private readonly publicBaseUrl: string;
  private readonly now: () => number;
  private readonly tabGraceMs: number;
  private readonly documentIdleMs: number;
  private readonly listeners = new Set<RegistryListener>();
  private readonly roundStallMs: number;
  private readonly rounds = new Map<
    string,
    { flag: RoundFlag; timer: NodeJS.Timeout | null }
  >();
  private readonly sessionStates: () => SessionStateOf;
  private readonly titles = new Map<
    string,
    { stamp: string; title: string | null }
  >();
  /** Every tab id seen per document while this server runs. */
  private readonly knownTabs = new Map<string, Set<string>>();
  /** The tabs a document had when it was closed from the list. */
  private readonly closedTabs = new Map<string, Set<string>>();

  constructor(options: RegistryOptions) {
    this.log = options.log;
    this.publicBaseUrl = options.publicBaseUrl;
    this.now = options.now ?? Date.now;
    this.tabGraceMs = options.tabGraceMs ?? TAB_GRACE_MS;
    this.documentIdleMs = options.documentIdleMs ?? DOCUMENT_IDLE_MS;
    this.roundStallMs = options.roundStallMs ?? ROUND_STALL_MS;
    this.sessionStates = options.sessionStates ?? (() => () => "unknown");
  }

  setSession(
    identity: DocumentIdentity,
    session: Omit<SessionRecord, "registeredAt">,
  ): SessionRecord {
    const record = this.log.setSession(identity, session);
    this.closedTabs.delete(identity.key);
    this.emit(identity.key, "session");
    return record;
  }

  /**
   * Closed from the open documents list. The tabs it has now are remembered,
   * so one that reconnects later (a hidden tab wakes up) is told to close
   * instead of opening the document again.
   */
  close(key: string): DocumentRecord | null {
    const document = this.log.close(key);
    if (!document) return null;
    this.closedTabs.set(key, new Set(this.knownTabs.get(key) ?? []));
    this.emit(key, "session");
    return document;
  }

  /** True when `tabId` was open on the document when it was closed. */
  isClosedTab(key: string, tabId: string): boolean {
    return (
      (this.log.get(key)?.closedAt ?? null) !== null &&
      (this.closedTabs.get(key)?.has(tabId) ?? false)
    );
  }

  private reopen(key: string): void {
    if (!this.log.reopen(key)) return;
    this.closedTabs.delete(key);
    this.emit(key, "session");
  }

  /** Marks documents closed before today's local midnight with no Done waiting. */
  sweepClosed(): void {
    this.log.sweepClosed(localMidnight(this.now()));
  }

  private titleFor(document: DocumentRecord): string | null {
    const cached = this.titles.get(document.key);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(document.documentPath);
    } catch {
      return cached?.title ?? null;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (cached?.stamp === stamp) return cached.title;
    let title: string | null = null;
    try {
      const handle = fs.openSync(document.documentPath, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, TITLE_READ_BYTES));
        const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
        title = documentTitleFromMarkdown(
          buffer.subarray(0, read).toString("utf8"),
        );
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return cached?.title ?? null;
    }
    this.titles.set(document.key, { stamp, title });
    return title;
  }

  /**
   * Opens or closes the round flag. A new open replaces any earlier round; a
   * close must name the round that is open (or stalled), else it is refused.
   */
  setRound(
    identity: DocumentIdentity,
    input: { roundId: string; state: "open" | "closed" },
  ): RoundFlagResult {
    this.touch(identity, { keepExistingIdentity: true });
    const key = identity.key;
    const existing = this.rounds.get(key);
    const at = new Date(this.now()).toISOString();
    if (input.state === "closed") {
      if (
        existing &&
        existing.flag.state !== "closed" &&
        existing.flag.roundId !== input.roundId
      ) {
        return { ok: false, round: { ...existing.flag } };
      }
      if (existing?.timer) clearTimeout(existing.timer);
      const flag: RoundFlag = {
        roundId: input.roundId,
        state: "closed",
        openedAt: existing?.flag.openedAt ?? at,
        updatedAt: at,
        stalledAt: existing?.flag.stalledAt ?? null,
        closedAt: at,
      };
      this.rounds.set(key, { flag, timer: null });
      this.emit(key, "round");
      return { ok: true, round: { ...flag } };
    }
    if (existing?.timer) clearTimeout(existing.timer);
    const flag: RoundFlag = {
      roundId: input.roundId,
      state: "open",
      openedAt: at,
      updatedAt: at,
      stalledAt: null,
      closedAt: null,
    };
    const entry: { flag: RoundFlag; timer: NodeJS.Timeout | null } = {
      flag,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.rounds.get(key) !== entry || flag.state !== "open") return;
      const stalledAt = new Date(this.now()).toISOString();
      flag.state = "stalled";
      flag.stalledAt = stalledAt;
      flag.updatedAt = stalledAt;
      this.emit(key, "round");
    }, this.roundStallMs);
    entry.timer.unref?.();
    this.rounds.set(key, entry);
    this.emit(key, "round");
    return { ok: true, round: { ...flag } };
  }

  round(key: string): RoundFlag | null {
    const entry = this.rounds.get(key);
    return entry ? { ...entry.flag } : null;
  }

  touch(
    identity: DocumentIdentity,
    options: { keepExistingIdentity?: boolean } = {},
  ): DocumentRecord {
    return this.log.upsert(identity, options);
  }

  recordVersion(identity: DocumentIdentity, version: string | null): void {
    const document = this.touch(identity, { keepExistingIdentity: true });
    document.lastKnownVersion = version;
  }

  recordOpenRequest(identity: DocumentIdentity): void {
    const document = this.touch(identity, { keepExistingIdentity: true });
    document.lastOpenRequestAt = new Date(this.now()).toISOString();
    this.reopen(identity.key);
  }

  connectTab(
    identity: DocumentIdentity,
    tab: { tabId: string; visible: boolean },
  ): () => void {
    this.touch(identity, { keepExistingIdentity: true });
    let known = this.knownTabs.get(identity.key);
    if (!known) {
      known = new Set();
      this.knownTabs.set(identity.key, known);
    }
    known.add(tab.tabId);
    // A window the document did not have when it was closed (a Reopen link,
    // a reload) opens it again.
    if (!this.closedTabs.get(identity.key)?.has(tab.tabId)) {
      this.reopen(identity.key);
    }
    const tabs = this.presenceFor(identity.key).tabs;
    const at = new Date(this.now()).toISOString();
    const existing = tabs.get(tab.tabId);
    const entry: TabEntry = existing ?? {
      tabId: tab.tabId,
      connectedAt: at,
      lastSeenAt: at,
      visible: tab.visible,
      dirty: false,
      conflict: false,
      baseHash: null,
      connections: 0,
      disconnectedAt: null,
      dropTimer: null,
    };
    entry.connections += 1;
    entry.disconnectedAt = null;
    if (entry.dropTimer) clearTimeout(entry.dropTimer);
    entry.dropTimer = null;
    entry.lastSeenAt = at;
    entry.visible = tab.visible;
    tabs.set(tab.tabId, entry);
    this.emit(identity.key, "tabs");

    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      entry.connections -= 1;
      entry.lastSeenAt = new Date(this.now()).toISOString();
      if (entry.connections <= 0) {
        entry.disconnectedAt = this.now();
        // Dropped after the grace period unless the tab reconnects first.
        if (entry.dropTimer) clearTimeout(entry.dropTimer);
        entry.dropTimer = setTimeout(() => {
          entry.dropTimer = null;
          if (entry.connections > 0 || tabs.get(entry.tabId) !== entry) return;
          tabs.delete(entry.tabId);
          this.emit(identity.key, "tabs");
        }, this.tabGraceMs);
        entry.dropTimer.unref?.();
      }
      this.touch(identity, { keepExistingIdentity: true });
    };
  }

  /** Presence reported by a tab over its channel. Unknown tabs are ignored. */
  updateTab(key: string, tabId: string, update: TabPresenceUpdate): boolean {
    const entry = this.presence.get(key)?.tabs.get(tabId);
    if (!entry) return false;
    if (update.visible !== undefined) entry.visible = update.visible;
    if (update.dirty !== undefined) entry.dirty = update.dirty;
    if (update.conflict !== undefined) entry.conflict = update.conflict;
    if (update.baseHash !== undefined) entry.baseHash = update.baseHash;
    entry.lastSeenAt = new Date(this.now()).toISOString();
    this.emit(key, "tabs");
    return true;
  }

  tabs(key: string): TabPresence[] {
    return [...(this.presence.get(key)?.tabs.values() ?? [])].map((tab) => ({
      tabId: tab.tabId,
      connectedAt: tab.connectedAt,
      lastSeenAt: tab.lastSeenAt,
      visible: tab.visible,
      dirty: tab.dirty,
      conflict: tab.conflict,
      baseHash: tab.baseHash,
    }));
  }

  tabsDirty(key: string): number {
    return this.tabs(key).filter((tab) => tab.dirty).length;
  }

  tabsConflict(key: string): number {
    return this.tabs(key).filter((tab) => tab.conflict).length;
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addWatcher(
    identity: DocumentIdentity,
    watcher: Omit<WatcherPresence, "watcherId" | "connectedAt">,
  ): { watcherId: string; remove: () => void } {
    this.touch(identity, { keepExistingIdentity: true });
    const watcherId = `w_${crypto.randomUUID().slice(0, 12)}`;
    const watchers = this.presenceFor(identity.key).watchers;
    watchers.set(watcherId, {
      ...watcher,
      watcherId,
      connectedAt: new Date(this.now()).toISOString(),
    });
    this.emit(identity.key, "watchers");
    return {
      watcherId,
      remove: () => {
        if (watchers.delete(watcherId)) {
          this.touch(identity, { keepExistingIdentity: true });
          this.emit(identity.key, "watchers");
        }
      },
    };
  }

  tabCount(key: string): number {
    return this.presence.get(key)?.tabs.size ?? 0;
  }

  watcherCount(key: string): number {
    return this.presence.get(key)?.watchers.size ?? 0;
  }

  view(
    key: string,
    sessionStateOf: SessionStateOf = this.sessionStates(),
  ): DocumentView | null {
    const document = this.log.get(key);
    if (!document) return null;
    return {
      ...structuredClone(document),
      title: this.titleFor(document),
      sessionState: sessionStateOf(document.session),
      latestHandoff: summarizeHandoff(document.handoffs.at(-1)),
      tabs: this.tabCount(key),
      tabsDirty: this.tabsDirty(key),
      tabsConflict: this.tabsConflict(key),
      round: this.round(key),
      watchers: this.watcherCount(key),
      pendingHandoffs: document.handoffs.filter(isUnacknowledged).length,
      url: documentUrl(this.publicBaseUrl, document.documentPath),
    };
  }

  list(): DocumentView[] {
    this.sweepClosed();
    const sessionStateOf = this.sessionStates();
    return this.log
      .all()
      .map((document) => this.view(document.key, sessionStateOf))
      .filter((view): view is DocumentView => view !== null)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  sweep(): void {
    const now = this.now();
    for (const presence of this.presence.values()) {
      for (const [tabId, tab] of presence.tabs) {
        if (
          tab.disconnectedAt !== null &&
          now - tab.disconnectedAt >= this.tabGraceMs
        ) {
          if (tab.dropTimer) clearTimeout(tab.dropTimer);
          presence.tabs.delete(tabId);
        }
      }
    }
    this.sweepClosed();
    for (const document of this.log.all()) {
      if (!this.isIdle(document, now)) continue;
      this.presence.delete(document.key);
      if (
        document.session === null &&
        document.handoffs.length === 0 &&
        this.historyExpired(document, now)
      ) {
        this.log.remove(document.key);
        this.titles.delete(document.key);
        this.knownTabs.delete(document.key);
        this.closedTabs.delete(document.key);
      }
    }
  }

  private emit(key: string, change: RegistryChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(key, change);
      } catch {}
    }
  }

  /**
   * A closed document stays for the Earlier list until the midnight sweep,
   * then as history for as long as an acknowledged Done would.
   */
  private historyExpired(document: DocumentRecord, now: number): boolean {
    if (document.closedAt === null) return true;
    return (
      document.sweptAt !== null &&
      now - Date.parse(document.closedAt) >= HANDOFF_RETENTION.acknowledgedMs
    );
  }

  private isIdle(document: DocumentRecord, now: number): boolean {
    return (
      this.tabCount(document.key) === 0 &&
      this.watcherCount(document.key) === 0 &&
      !document.handoffs.some(isUnacknowledged) &&
      now - Date.parse(document.lastActivityAt) >= this.documentIdleMs
    );
  }

  private presenceFor(key: string): Presence {
    let presence = this.presence.get(key);
    if (!presence) {
      presence = { tabs: new Map(), watchers: new Map() };
      this.presence.set(key, presence);
    }
    return presence;
  }
}
