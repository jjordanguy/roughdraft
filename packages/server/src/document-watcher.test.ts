import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DocumentChange, DocumentWatcher } from "./document-watcher";

// The detector on its own. `fsWatch: false` leaves only the 1 s stat poll
// (shortened here), so each test proves the poll catches the case even when
// FSEvents coalesces or drops the event.

const fixed = new Date("2026-10-01T12:00:00.123Z");

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  read: () => T | undefined,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("DocumentWatcher", () => {
  let dir: string;
  let filePath: string;
  let watcher: DocumentWatcher;
  let changes: DocumentChange[];
  let unsubscribe: () => void;

  async function watch(options: { fsWatch?: boolean } = {}) {
    watcher = new DocumentWatcher({
      pollMs: 40,
      rehashMs: 200,
      releaseMs: 100,
      fsWatch: options.fsWatch ?? false,
    });
    changes = [];
    const opened = await watcher.open(filePath, (change) => {
      changes.push(change);
    });
    opened.start();
    unsubscribe = opened.unsubscribe;
    return opened.state;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-watcher-"));
    filePath = path.join(dir, "b.md");
    fs.writeFileSync(filePath, "# B\n\nalpha\n");
    fs.utimesSync(filePath, fixed, fixed);
  });

  afterEach(() => {
    unsubscribe?.();
    watcher?.close();
    try {
      fs.chmodSync(filePath, 0o644);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports the current state on open", async () => {
    const state = await watch();

    expect(state).toMatchObject({
      seq: 1,
      exists: true,
      available: true,
      reason: null,
      contentHash: sha256("# B\n\nalpha\n"),
      version: `${fixed.getTime()}:11:${sha256("# B\n\nalpha\n")}`,
    });
    expect(state.stat).toMatchObject({ size: 11, mtimeMs: fixed.getTime() });
  });

  it("detects a same-size, same-mtime in-place write (sync probe 1)", async () => {
    const before = await watch();

    fs.writeFileSync(filePath, "# B\n\nALPHA\n");
    fs.utimesSync(filePath, fixed, fixed);

    const change = await until(() => changes[0]);
    expect(change).toMatchObject({
      seq: before.seq + 1,
      exists: true,
      available: true,
      contentHash: sha256("# B\n\nALPHA\n"),
      origin: "outside",
    });
    expect(change.tabId).toBeUndefined();
  });

  it("detects a same-size, same-mtime rename-over (sync probe 2)", async () => {
    await watch();

    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, "# B\n\nbeta!\n");
    fs.utimesSync(tmp, fixed, fixed);
    fs.renameSync(tmp, filePath);

    const change = await until(() => changes[0]);
    expect(change).toMatchObject({
      exists: true,
      contentHash: sha256("# B\n\nbeta!\n"),
    });
  });

  it("does not emit for a touch, and keeps the seq", async () => {
    const before = await watch();

    fs.utimesSync(filePath, new Date(), new Date());
    // Several polls and at least one periodic rehash.
    await sleep(400);

    expect(changes).toEqual([]);
    const state = await watcher.refresh(filePath);
    expect(state.seq).toBe(before.seq);
    expect(state.contentHash).toBe(before.contentHash);
    expect(state.version).not.toBe(before.version);
  });

  it("reports a missing file and its return unchanged (sync probe 4)", async () => {
    const before = await watch();

    fs.renameSync(filePath, `${filePath}.away`);
    const gone = await until(() => changes[0]);
    expect(gone).toMatchObject({
      seq: before.seq + 1,
      exists: false,
      contentHash: null,
      version: null,
    });

    fs.renameSync(`${filePath}.away`, filePath);
    const back = await until(() => changes[1]);
    expect(back).toMatchObject({
      seq: before.seq + 2,
      exists: true,
      available: true,
      contentHash: before.contentHash,
      version: before.version,
    });
  });

  it("opens on a missing file and reports when it appears", async () => {
    fs.rmSync(filePath);
    const state = await watch();
    expect(state).toMatchObject({ exists: false, available: true });

    fs.writeFileSync(filePath, "# New\n");
    const change = await until(() => changes[0]);
    expect(change).toMatchObject({
      exists: true,
      contentHash: sha256("# New\n"),
    });
  });

  it("reports an unreadable file as unavailable and recovers (chmod 000, 644)", async () => {
    await watch();

    fs.writeFileSync(filePath, "# B, changed\n");
    fs.chmodSync(filePath, 0o000);
    const locked = await until(() => changes[0]);
    expect(locked).toMatchObject({
      exists: true,
      available: false,
      contentHash: null,
      version: null,
    });
    expect(locked.reason).toMatch(/EACCES/);

    fs.chmodSync(filePath, 0o644);
    const unlocked = await until(() => changes[1]);
    expect(unlocked).toMatchObject({
      exists: true,
      available: true,
      reason: null,
      contentHash: sha256("# B, changed\n"),
    });
  });

  it("delivers a change through the directory watcher as well", async () => {
    watcher = new DocumentWatcher({
      pollMs: 60_000,
      rehashMs: 60_000,
      releaseMs: 100,
      fsWatch: true,
    });
    changes = [];
    const opened = await watcher.open(filePath, (change) => {
      changes.push(change);
    });
    opened.start();
    unsubscribe = opened.unsubscribe;

    fs.writeFileSync(filePath, "# B\n\nvia fs.watch\n");

    // FSEvents delivery can lag by seconds while the whole suite runs.
    const change = await until(() => changes[0], 15_000);
    expect(change.contentHash).toBe(sha256("# B\n\nvia fs.watch\n"));
  });

  it("tags a change it wrote itself with origin tab and the tab id", async () => {
    const before = await watch();

    const result = await watcher.write(filePath, "# B\n\nfrom tab\n", {
      expectedHash: before.contentHash,
      tabId: "tab_1",
    });

    expect(result.status).toBe("written");
    const change = await until(() => changes[0]);
    expect(change).toMatchObject({
      origin: "tab",
      tabId: "tab_1",
      contentHash: sha256("# B\n\nfrom tab\n"),
      seq: before.seq + 1,
    });
    await sleep(200);
    expect(changes).toHaveLength(1);
  });

  it("serializes writes that carry the same expected hash", async () => {
    const before = await watch();

    const [first, second] = await Promise.all([
      watcher.write(filePath, "one\n", { expectedHash: before.contentHash }),
      watcher.write(filePath, "two\n", { expectedHash: before.contentHash }),
    ]);

    expect([first.status, second.status]).toEqual(["written", "conflict"]);
    expect(second.read.content).toBe("one\n");
    expect(fs.readFileSync(filePath, "utf8")).toBe("one\n");
  });

  it("releases the entry after the last subscriber leaves plus the grace", async () => {
    await watch();
    expect(watcher.activeCount()).toBe(1);

    unsubscribe();
    expect(watcher.activeCount()).toBe(1);
    await until(() => (watcher.activeCount() === 0 ? true : undefined));
  });
});
