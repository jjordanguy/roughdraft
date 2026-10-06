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
}

export interface WatcherPresence {
  watcherId: string;
  kind: "stream" | "long-poll";
  client: string | null;
  connectedAt: string;
  afterSequence: number;
}

export interface DocumentView extends DocumentRecord {
  tabs: number;
  watchers: number;
  pendingHandoffs: number;
  url: string;
}

interface TabEntry extends TabPresence {
  connections: number;
  disconnectedAt: number | null;
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
 */
export function documentKey(absolutePath: string): string {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return path.resolve(absolutePath);
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
      connections: 0,
      disconnectedAt: null,
    };
    entry.connections += 1;
    entry.disconnectedAt = null;
    entry.lastSeenAt = at;
    entry.visible = tab.visible;
    tabs.set(tab.tabId, entry);

    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      entry.connections -= 1;
      entry.lastSeenAt = new Date(this.now()).toISOString();
      if (entry.connections <= 0) entry.disconnectedAt = this.now();
      this.touch(identity, { keepExistingIdentity: true });
    };
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
    return {
      watcherId,
      remove: () => {
        if (watchers.delete(watcherId)) {
          this.touch(identity, { keepExistingIdentity: true });
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
          presence.tabs.delete(tabId);
        }
      }
    }
    for (const document of this.log.all()) {
      if (this.isIdle(document, now)) {
        this.presence.delete(document.key);
        this.log.remove(document.key);
      }
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
