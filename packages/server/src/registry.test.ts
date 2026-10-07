import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewLog } from "./handoff-log";
import {
  DOCUMENT_IDLE_MS,
  DocumentRegistry,
  documentKey,
  identityFor,
  TAB_GRACE_MS,
} from "./registry";

describe("documentKey", () => {
  let realDir: string;
  let linkDir: string;

  beforeEach(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-real-"));
    linkDir = `${realDir}-link`;
    fs.symlinkSync(realDir, linkDir);
    fs.writeFileSync(path.join(realDir, "plan.md"), "# Plan\n");
  });

  afterEach(() => {
    fs.rmSync(linkDir, { force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it("maps two spellings of one existing file to the same key", () => {
    expect(documentKey(path.join(linkDir, "plan.md"))).toBe(
      documentKey(path.join(realDir, "plan.md")),
    );
  });

  it("keys a missing file on its real parent, so the key survives the file disappearing", () => {
    const key = documentKey(path.join(realDir, "plan.md"));
    fs.rmSync(path.join(realDir, "plan.md"));

    expect(documentKey(path.join(linkDir, "plan.md"))).toBe(key);
  });

  it("falls back to the resolved path when the parent does not exist either", () => {
    expect(documentKey(path.join(linkDir, "gone", "missing.md"))).toBe(
      path.join(linkDir, "gone", "missing.md"),
    );
  });
});

describe("DocumentRegistry", () => {
  let clock: number;
  let registry: DocumentRegistry;
  const plan = identityFor("/docs/plan.md");

  beforeEach(() => {
    clock = Date.parse("2026-10-05T12:00:00.000Z");
    const log = new ReviewLog({ now: () => new Date(clock) });
    registry = new DocumentRegistry({
      log,
      publicBaseUrl: "http://localhost:7373",
      now: () => clock,
    });
  });

  it("keeps a disconnected tab for the grace period, then drops it", () => {
    const disconnect = registry.connectTab(plan, {
      tabId: "t1",
      visible: true,
    });
    disconnect();

    clock += TAB_GRACE_MS - 1;
    registry.sweep();
    expect(registry.tabCount(plan.key)).toBe(1);

    clock += 1;
    registry.sweep();
    expect(registry.tabCount(plan.key)).toBe(0);
  });

  it("does not drop a tab that reconnected before its old connection closed", () => {
    const first = registry.connectTab(plan, { tabId: "t1", visible: true });
    registry.connectTab(plan, { tabId: "t1", visible: true });
    first();

    clock += TAB_GRACE_MS * 2;
    registry.sweep();

    expect(registry.tabCount(plan.key)).toBe(1);
  });

  it("drops an idle document after an hour when it never had a session or a Done", () => {
    registry.recordVersion(plan, "v1");

    clock += DOCUMENT_IDLE_MS - 1;
    registry.sweep();
    expect(registry.view(plan.key)).not.toBeNull();

    clock += 1;
    registry.sweep();
    expect(registry.view(plan.key)).toBeNull();
  });

  it("keeps the log entry of a document that had a Done, even after it is acknowledged", () => {
    const reviewed = identityFor("/docs/reviewed.md");
    const record = registry.log.recordHandoff(reviewed, {
      handoffId: "h-keep",
      version: "v1",
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
      overallComment: null,
      wakeRouteId: null,
    });
    registry.log.acknowledge(record, "test");

    clock += DOCUMENT_IDLE_MS * 2;
    registry.sweep();

    expect(registry.view(reviewed.key)).not.toBeNull();
    expect(registry.view(reviewed.key)?.pendingHandoffs).toBe(0);
  });

  it("keeps an idle document while a watcher is connected or a Done is pending", () => {
    const watched = identityFor("/docs/watched.md");
    registry.addWatcher(watched, {
      kind: "stream",
      client: null,
      afterSequence: 0,
    });
    const pending = identityFor("/docs/pending.md");
    registry.log.recordHandoff(pending, {
      handoffId: "h1",
      version: "v1",
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
      overallComment: null,
      wakeRouteId: null,
    });

    clock += DOCUMENT_IDLE_MS * 2;
    registry.sweep();

    expect(registry.view(watched.key)).not.toBeNull();
    expect(registry.view(pending.key)?.pendingHandoffs).toBe(1);
  });

  it("reports counts and the document link in the view", () => {
    registry.connectTab(plan, { tabId: "t1", visible: true });
    registry.addWatcher(plan, {
      kind: "long-poll",
      client: "cli watch",
      afterSequence: 3,
    });

    expect(registry.view(plan.key)).toMatchObject({
      key: "/docs/plan.md",
      tabs: 1,
      watchers: 1,
      pendingHandoffs: 0,
      url: "http://localhost:7373/?path=%2Fdocs%2Fplan.md",
    });
  });
});
