import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AtomicWriteOptions,
  type WriteMode,
  writeFileAtomic,
  writeModeFromEnv,
} from "./atomic-write.js";
import { documentKey } from "./registry.js";

/**
 * Change detection for open Markdown documents, and the one source of truth
 * for their state.
 *
 * Content decides: two snapshots are equal when their bytes hash the same.
 * File metadata only triggers a rescan. Every read (GET, the state route, a
 * hello, a poll or an `fs.watch` event) goes through `apply()`, which bumps
 * `seq` and notifies subscribers only when the content hash, existence or
 * availability changed.
 */

export interface DocumentStat {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DocumentState {
  /** +1 on every content, existence or availability change, per process. */
  seq: number;
  exists: boolean;
  /** False when the file exists but cannot be read. */
  available: boolean;
  reason: string | null;
  /** sha256 of the bytes on disk, null when missing or unreadable. */
  contentHash: string | null;
  /** Legacy `mtimeMs:size:sha256`, null when missing or unreadable. */
  version: string | null;
  stat: DocumentStat | null;
}

export type ChangeOrigin = "tab" | "outside" | "unknown";

export interface DocumentChange {
  seq: number;
  exists: boolean;
  available: boolean;
  reason: string | null;
  version: string | null;
  contentHash: string | null;
  origin: ChangeOrigin;
  tabId?: string;
}

export interface DocumentRead {
  state: DocumentState;
  /** Decoded content (invalid UTF-8 becomes U+FFFD), null when not readable. */
  content: string | null;
}

export type WriteStatus =
  | "written"
  | "unchanged"
  | "conflict"
  | "missing"
  | "unavailable";

export interface WriteResult {
  status: WriteStatus;
  read: DocumentRead;
}

export type ChangeListener = (change: DocumentChange) => void;

export interface DocumentWatcherOptions {
  /** Own stat poll interval. Default 1 s. */
  pollMs?: number;
  /** Rehash interval while subscribers exist. Default 10 s. */
  rehashMs?: number;
  /** How long an entry outlives its last subscriber. Default 30 s. */
  releaseMs?: number;
  /** Parent-directory `fs.watch`. Default true; tests turn it off to prove the poll. */
  fsWatch?: boolean;
  /** Temp file plus rename (default), or in place. Default: `ROUGHDRAFT_WRITE_MODE`. */
  writeMode?: WriteMode;
  /** Test seam: runs inside a write after the temp file is synced, before the last hash check. */
  beforeWriteCommit?: AtomicWriteOptions["beforeCommit"];
}

export const WATCH_POLL_MS = 1_000;
export const WATCH_REHASH_MS = 10_000;
export const WATCH_RELEASE_MS = 30_000;
const OWN_WRITES_KEPT = 20;
const STABLE_READ_ATTEMPTS = 3;

interface Snapshot {
  exists: boolean;
  available: boolean;
  reason: string | null;
  bytes: Buffer | null;
  contentHash: string | null;
  version: string | null;
  stat: DocumentStat | null;
}

interface PollStat {
  exists: boolean;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  error: string | null;
}

interface ActiveWatch {
  epoch: number;
  listeners: Set<ChangeListener>;
  dirWatcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout;
  rehashTimer: NodeJS.Timeout;
  releaseTimer: NodeJS.Timeout | null;
  lastPoll: PollStat | null;
  polling: boolean;
  scanning: Promise<void> | null;
  again: boolean;
}

interface Entry {
  key: string;
  filePath: string;
  state: DocumentState | null;
  /** Watch epoch the state was observed under; -1 when nothing was watching. */
  stateEpoch: number;
  ownWrites: Map<string, string | null>;
  lock: Mutex;
  watch: ActiveWatch | null;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The hash segment of a legacy `mtimeMs:size:sha256` version. */
export function hashFromVersion(version: string): string | null {
  const hash = version.split(":").at(-1);
  return hash && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

function statOf(stats: fs.Stats): DocumentStat {
  return {
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameStat(a: DocumentStat, b: DocumentStat): boolean {
  return (
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingSnapshot(): Snapshot {
  return {
    exists: false,
    available: true,
    reason: null,
    bytes: null,
    contentHash: null,
    version: null,
    stat: null,
  };
}

function unavailableSnapshot(
  reason: string,
  stat: DocumentStat | null,
): Snapshot {
  return {
    exists: true,
    available: false,
    reason,
    bytes: null,
    contentHash: null,
    version: null,
    stat,
  };
}

/**
 * Reads the bytes once through one descriptor, with an fstat before and after,
 * retrying when they differ (a write landed mid-read). Never throws.
 */
async function readSnapshot(filePath: string): Promise<Snapshot> {
  for (let attempt = 1; ; attempt += 1) {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, "r");
      const before = await handle.stat();
      if (!before.isFile()) {
        return unavailableSnapshot("Not a regular file", statOf(before));
      }
      const bytes = await handle.readFile();
      const after = statOf(await handle.stat());
      if (!sameStat(statOf(before), after) && attempt < STABLE_READ_ATTEMPTS) {
        continue;
      }
      const contentHash = sha256(bytes);
      return {
        exists: true,
        available: true,
        reason: null,
        bytes,
        contentHash,
        version: `${after.mtimeMs}:${after.size}:${contentHash}`,
        stat: after,
      };
    } catch (error) {
      if (isMissing(error)) return missingSnapshot();
      let stat: DocumentStat | null = null;
      try {
        stat = statOf(await fs.promises.stat(filePath));
      } catch (statError) {
        if (isMissing(statError)) return missingSnapshot();
      }
      return unavailableSnapshot(reasonFor(error), stat);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function pollStatFromSnapshot(snapshot: Snapshot): PollStat | null {
  if (!snapshot.stat) return null;
  return { exists: true, ...snapshot.stat, error: null };
}

function samePoll(a: PollStat, b: PollStat): boolean {
  return (
    a.exists === b.exists &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.error === b.error
  );
}

async function pollStat(filePath: string): Promise<PollStat> {
  try {
    return {
      exists: true,
      ...statOf(await fs.promises.stat(filePath)),
      error: null,
    };
  } catch (error) {
    return {
      exists: !isMissing(error),
      ino: 0,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      error: isMissing(error) ? null : (errorCode(error) ?? reasonFor(error)),
    };
  }
}

function changeFrom(
  state: DocumentState,
  origin: ChangeOrigin,
  tabId: string | null,
): DocumentChange {
  const change: DocumentChange = {
    seq: state.seq,
    exists: state.exists,
    available: state.available,
    reason: state.reason,
    version: state.version,
    contentHash: state.contentHash,
    origin,
  };
  if (origin === "tab" && tabId) change.tabId = tabId;
  return change;
}

export class DocumentWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly pollMs: number;
  private readonly rehashMs: number;
  private readonly releaseMs: number;
  private readonly fsWatch: boolean;
  private readonly writeMode: WriteMode;
  private readonly beforeWriteCommit: AtomicWriteOptions["beforeCommit"];
  private nextEpoch = 1;

  constructor(options: DocumentWatcherOptions = {}) {
    this.pollMs = options.pollMs ?? WATCH_POLL_MS;
    this.rehashMs = options.rehashMs ?? WATCH_REHASH_MS;
    this.releaseMs = options.releaseMs ?? WATCH_RELEASE_MS;
    this.fsWatch = options.fsWatch ?? true;
    this.writeMode = options.writeMode ?? writeModeFromEnv();
    this.beforeWriteCommit = options.beforeWriteCommit;
  }

  /** The last known state without touching the disk. */
  current(filePath: string): DocumentState | null {
    const state = this.entries.get(documentKey(filePath))?.state;
    return state ? structuredClone(state) : null;
  }

  /** A fresh read under the document lock, for GET. */
  read(filePath: string): Promise<DocumentRead> {
    const entry = this.entryFor(filePath);
    return entry.lock.run(async () =>
      this.apply(entry, await readSnapshot(entry.filePath)),
    );
  }

  /**
   * A fresh state: a read that starts after this call. While the document is
   * watched it joins the single-flight rescan.
   */
  async refresh(filePath: string): Promise<DocumentState> {
    const entry = this.entryFor(filePath);
    if (entry.watch) {
      await this.rescan(entry);
      return structuredClone(entry.state as DocumentState);
    }
    return (await this.read(filePath)).state;
  }

  /**
   * Subscribes, then reads, so no change can fall between the state returned
   * here and the first change delivered to the listener. Changes are held
   * until `start()`, which the caller calls once it has sent the state;
   * held changes the state already covers are dropped.
   */
  async open(
    filePath: string,
    listener: ChangeListener,
  ): Promise<{
    state: DocumentState;
    start: () => void;
    unsubscribe: () => void;
  }> {
    let initialSeq: number | null = null;
    let started = false;
    const held: DocumentChange[] = [];
    const unsubscribe = this.subscribe(filePath, (change) => {
      if (!started) held.push(change);
      else if (initialSeq === null || change.seq > initialSeq) {
        listener(change);
      }
    });
    const state = await this.refresh(filePath);
    initialSeq = state.seq;
    const start = () => {
      if (started) return;
      started = true;
      for (const change of held.splice(0)) {
        if (change.seq > state.seq) listener(change);
      }
    };
    return { state, start, unsubscribe };
  }

  subscribe(filePath: string, listener: ChangeListener): () => void {
    const entry = this.entryFor(filePath);
    const watch = this.startWatch(entry);
    watch.listeners.add(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      watch.listeners.delete(listener);
      if (watch.listeners.size === 0 && entry.watch === watch) {
        if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
        watch.releaseTimer = setTimeout(
          () => this.stopWatch(entry),
          this.releaseMs,
        );
        watch.releaseTimer.unref?.();
      }
    };
  }

  /**
   * Writes `content` when `expectedHash` matches the bytes on disk (or is
   * null: an unconditional write). Byte-identical content writes nothing. The
   * new hash is remembered as written by `tabId`, so the change it causes
   * carries `origin: "tab"`.
   */
  write(
    filePath: string,
    content: string,
    options: {
      expectedHash: string | null;
      tabId?: string | null;
      create?: boolean;
    },
  ): Promise<WriteResult> {
    return this.mutate(filePath, () => content, {
      ...options,
      // The content does not depend on what was read: an unconditional write
      // stays unconditional.
      recheck: options.expectedHash !== null,
    });
  }

  /**
   * Read, transform and write under the document lock. The write is atomic
   * (see `atomic-write.ts`) and checks right before the rename that the file
   * still holds what the transform read: writers outside Roughdraft do not
   * take this lock. When it moved, a caller with `expectedHash` gets a
   * conflict; a plain transform runs again on the new content (three tries).
   */
  mutate(
    filePath: string,
    transform: (current: string) => string,
    options: {
      expectedHash?: string | null;
      tabId?: string | null;
      recheck?: boolean;
      /** Write a file that does not exist yet (a tab recreating it from a draft). */
      create?: boolean;
    } = {},
  ): Promise<WriteResult> {
    const entry = this.entryFor(filePath);
    return entry.lock.run(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const snapshot = await readSnapshot(entry.filePath);
        const current = this.apply(entry, snapshot);
        const creating = !snapshot.exists && options.create === true;
        if (!snapshot.exists && !creating) {
          return { status: "missing", read: current };
        }
        if (!creating && !snapshot.bytes) {
          return { status: "unavailable", read: current };
        }

        const bytes = Buffer.from(transform(current.content ?? ""), "utf8");
        if (snapshot.bytes && bytes.equals(snapshot.bytes)) {
          return { status: "unchanged", read: current };
        }
        const expectedHash = options.expectedHash ?? null;
        if (expectedHash !== null && expectedHash !== snapshot.contentHash) {
          return { status: "conflict", read: current };
        }

        const hash = sha256(bytes);
        this.rememberOwnWrite(entry, hash, options.tabId ?? null);
        const written = await writeFileAtomic(entry.filePath, bytes, {
          mode: this.writeMode,
          expectedHash:
            options.recheck === false || creating ? null : snapshot.contentHash,
          beforeCommit: this.beforeWriteCommit,
        });
        if (written.status === "written") {
          return {
            status: "written",
            read: this.apply(entry, await readSnapshot(entry.filePath)),
          };
        }
        entry.ownWrites.delete(hash);
        const moved = this.apply(entry, await readSnapshot(entry.filePath));
        if (expectedHash !== null || attempt >= 3) {
          return { status: "conflict", read: moved };
        }
      }
    });
  }

  /** Documents with a live watch (subscribed, or inside the release grace). */
  activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.watch) count += 1;
    return count;
  }

  close(): void {
    for (const entry of this.entries.values()) this.stopWatch(entry);
  }

  private entryFor(filePath: string): Entry {
    const key = documentKey(filePath);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        filePath: path.resolve(filePath),
        state: null,
        stateEpoch: -1,
        ownWrites: new Map(),
        lock: new Mutex(),
        watch: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private rememberOwnWrite(
    entry: Entry,
    hash: string,
    tabId: string | null,
  ): void {
    entry.ownWrites.delete(hash);
    entry.ownWrites.set(hash, tabId);
    while (entry.ownWrites.size > OWN_WRITES_KEPT) {
      const oldest = entry.ownWrites.keys().next().value;
      if (oldest === undefined) break;
      entry.ownWrites.delete(oldest);
    }
  }

  private apply(entry: Entry, snapshot: Snapshot): DocumentRead {
    const previous = entry.state;
    const changed =
      previous === null ||
      previous.contentHash !== snapshot.contentHash ||
      previous.exists !== snapshot.exists ||
      previous.available !== snapshot.available;
    const state: DocumentState = {
      seq: changed ? (previous?.seq ?? 0) + 1 : (previous?.seq ?? 1),
      exists: snapshot.exists,
      available: snapshot.available,
      reason: snapshot.reason,
      contentHash: snapshot.contentHash,
      version: snapshot.version,
      stat: snapshot.stat,
    };

    let origin: ChangeOrigin =
      entry.watch && entry.stateEpoch === entry.watch.epoch
        ? "outside"
        : "unknown";
    let tabId: string | null = null;
    if (
      changed &&
      snapshot.contentHash &&
      entry.ownWrites.has(snapshot.contentHash)
    ) {
      origin = "tab";
      tabId = entry.ownWrites.get(snapshot.contentHash) ?? null;
      entry.ownWrites.delete(snapshot.contentHash);
    }

    entry.state = state;
    entry.stateEpoch = entry.watch ? entry.watch.epoch : -1;
    if (entry.watch) {
      entry.watch.lastPoll =
        pollStatFromSnapshot(snapshot) ??
        (snapshot.exists ? entry.watch.lastPoll : null);
    }

    if (changed && previous !== null && entry.watch) {
      const change = changeFrom(state, origin, tabId);
      for (const listener of [...entry.watch.listeners]) {
        try {
          listener(change);
        } catch {}
      }
    }

    return {
      state: structuredClone(state),
      content: snapshot.bytes ? snapshot.bytes.toString("utf8") : null,
    };
  }

  private rescan(entry: Entry): Promise<void> {
    const watch = entry.watch;
    if (!watch) {
      return this.read(entry.filePath).then(() => undefined);
    }
    if (watch.scanning) {
      watch.again = true;
      return watch.scanning;
    }
    watch.scanning = (async () => {
      do {
        watch.again = false;
        await entry.lock.run(async () =>
          this.apply(entry, await readSnapshot(entry.filePath)),
        );
      } while (watch.again);
    })()
      .catch(() => undefined)
      .finally(() => {
        watch.scanning = null;
      });
    return watch.scanning;
  }

  private async poll(entry: Entry): Promise<void> {
    const watch = entry.watch;
    if (!watch || watch.polling) return;
    watch.polling = true;
    try {
      if (!watch.dirWatcher) watch.dirWatcher = this.watchDirectory(entry);
      const current = await pollStat(entry.filePath);
      if (entry.watch !== watch) return;
      const missingBoth =
        !current.exists && watch.lastPoll === null && !entry.state?.exists;
      if (missingBoth) return;
      if (watch.lastPoll === null || !samePoll(watch.lastPoll, current)) {
        watch.lastPoll = current;
        await this.rescan(entry);
      }
    } finally {
      watch.polling = false;
    }
  }

  private watchDirectory(entry: Entry): fs.FSWatcher | null {
    if (!this.fsWatch) return null;
    const name = path.basename(entry.filePath);
    try {
      const watcher = fs.watch(
        path.dirname(entry.filePath),
        { persistent: false },
        (_event, filename) => {
          if (filename === null || filename === name) void this.rescan(entry);
        },
      );
      watcher.on("error", () => {
        watcher.close();
        if (entry.watch?.dirWatcher === watcher) entry.watch.dirWatcher = null;
      });
      return watcher;
    } catch {
      return null;
    }
  }

  private startWatch(entry: Entry): ActiveWatch {
    if (entry.watch) {
      if (entry.watch.releaseTimer) clearTimeout(entry.watch.releaseTimer);
      entry.watch.releaseTimer = null;
      return entry.watch;
    }
    const pollTimer = setInterval(() => void this.poll(entry), this.pollMs);
    pollTimer.unref?.();
    const rehashTimer = setInterval(() => {
      if (entry.watch && entry.watch.listeners.size > 0) {
        void this.rescan(entry);
      }
    }, this.rehashMs);
    rehashTimer.unref?.();
    const watch: ActiveWatch = {
      epoch: this.nextEpoch++,
      listeners: new Set(),
      dirWatcher: null,
      pollTimer,
      rehashTimer,
      releaseTimer: null,
      lastPoll: null,
      polling: false,
      scanning: null,
      again: false,
    };
    entry.watch = watch;
    watch.dirWatcher = this.watchDirectory(entry);
    return watch;
  }

  private stopWatch(entry: Entry): void {
    const watch = entry.watch;
    if (!watch) return;
    clearInterval(watch.pollTimer);
    clearInterval(watch.rehashTimer);
    if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
    watch.dirWatcher?.close();
    entry.watch = null;
  }
}
