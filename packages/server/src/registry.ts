import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type DocumentIdentity,
  type DocumentRecord,
  isUnacknowledged,
  type ReviewLog,
} from "./handoff-log.js";

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

export type RegistryChange = "tabs" | "watchers";
export type RegistryListener = (key: string, change: RegistryChange) => void;

export interface WatcherPresence {
  watcherId: string;
  kind: "stream" | "long-poll";
  client: string | null;
  connectedAt: string;
  afterSequence: number;
}

export interface DocumentView extends DocumentRecord {
  tabs: number;
  /**
   * Tabs that reported unsaved text. Always set by the registry; optional so
   * views rebuilt from the log file on disk (no presence) still type-check.
   */
  tabsDirty?: number;
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
}

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

  constructor(options: RegistryOptions) {
    this.log = options.log;
    this.publicBaseUrl = options.publicBaseUrl;
    this.now = options.now ?? Date.now;
    this.tabGraceMs = options.tabGraceMs ?? TAB_GRACE_MS;
    this.documentIdleMs = options.documentIdleMs ?? DOCUMENT_IDLE_MS;
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
  }

  connectTab(
    identity: DocumentIdentity,
    tab: { tabId: string; visible: boolean },
  ): () => void {
    this.touch(identity, { keepExistingIdentity: true });
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

  view(key: string): DocumentView | null {
    const document = this.log.get(key);
    if (!document) return null;
    return {
      ...structuredClone(document),
      tabs: this.tabCount(key),
      tabsDirty: this.tabsDirty(key),
      watchers: this.watcherCount(key),
      pendingHandoffs: document.handoffs.filter(isUnacknowledged).length,
      url: documentUrl(this.publicBaseUrl, document.documentPath),
    };
  }

  list(): DocumentView[] {
    return this.log
      .all()
      .map((document) => this.view(document.key))
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
    for (const document of this.log.all()) {
      if (!this.isIdle(document, now)) continue;
      this.presence.delete(document.key);
      if (document.session === null && document.handoffs.length === 0) {
        this.log.remove(document.key);
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
