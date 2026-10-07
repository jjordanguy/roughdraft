import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ContentUpdate,
  DocumentSync,
  type HandoffError,
  type SyncBackend,
  type SyncEnvironmentHandlers,
} from "./document-sync";
import {
  createIndexedDbDraftStore,
  createMemoryDraftStore,
  type DraftStore,
} from "./draft-store";
import {
  type CompleteReviewOptions,
  MarkdownFileConflictError,
  MarkdownFileNotFoundError,
  type MarkdownFileState,
  type Page,
  type SaveMarkdownFileOptions,
  ServerUnreachableError,
  type TabChannelHandlers,
  type TabClientMessage,
  type TabServerMessage,
  UnsupportedRouteError,
} from "./storage";

// --- A fake server with a disk, controllable requests and tab channels -----

function hashOf(content: string) {
  return `hash:${content}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeChannel {
  sent: TabClientMessage[] = [];
  closed = false;

  constructor(readonly handlers: TabChannelHandlers) {}

  open() {
    this.handlers.onOpen();
  }

  receive(message: TabServerMessage) {
    this.handlers.onMessage(message);
  }

  drop() {
    this.handlers.onClose();
  }

  presence() {
    return this.sent.filter((message) => message.type === "presence");
  }
}

interface PutCall {
  content: string;
  expectedVersion?: string;
  options?: SaveMarkdownFileOptions;
}

class FakeServer {
  content: string;
  exists = true;
  seq = 1;
  version = 1;
  puts: PutCall[] = [];
  gets = 0;
  stateCalls = 0;
  reviews: CompleteReviewOptions[] = [];
  channels: FakeChannel[] = [];
  // When set, the next PUT waits on this instead of answering at once.
  holdPut: Deferred<void> | null = null;
  holdGet: Deferred<void> | null = null;
  putFailures = 0;
  stateUnsupported = false;
  reviewConflict = false;
  // Runs once inside the next Done request, before its version check.
  beforeReview: (() => void) | null = null;

  constructor(content: string) {
    this.content = content;
  }

  page(): Page {
    return {
      id: "doc",
      title: "Doc",
      content: this.content,
      version: `v${this.version}`,
      contentHash: hashOf(this.content),
      seq: this.seq,
    };
  }

  state(): MarkdownFileState {
    return {
      exists: this.exists,
      available: true,
      version: this.exists ? `v${this.version}` : null,
      contentHash: this.exists ? hashOf(this.content) : null,
      seq: this.seq,
    };
  }

  // An outside writer (the agent).
  write(content: string) {
    this.content = content;
    this.version += 1;
    this.seq += 1;
  }

  lastChannel(): FakeChannel {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("no channel opened");
    return channel;
  }

  backend(): SyncBackend {
    return {
      getMarkdownFile: async () => {
        this.gets += 1;
        const hold = this.holdGet;
        this.holdGet = null;
        if (hold) await hold.promise;
        return this.page();
      },
      saveMarkdownFile: async (_path, content, expectedVersion, options) => {
        this.puts.push({ content, expectedVersion, options });
        const hold = this.holdPut;
        this.holdPut = null;
        if (hold) await hold.promise;
        if (this.putFailures > 0) {
          this.putFailures -= 1;
          throw new ServerUnreachableError("PUT /api/markdown-file");
        }
        if (options?.expectedContentHash !== hashOf(this.content)) {
          throw new MarkdownFileConflictError(this.page());
        }
        if (content !== this.content) this.write(content);
        return this.page();
      },
      getMarkdownFileState: async () => {
        this.stateCalls += 1;
        if (this.stateUnsupported) {
          throw new UnsupportedRouteError("GET /api/markdown-file/state");
        }
        return this.state();
      },
      openTabChannel: (_path, _tabId, handlers) => {
        const channel = new FakeChannel(handlers);
        this.channels.push(channel);
        return {
          send: (message) => channel.sent.push(message),
          close: () => {
            channel.closed = true;
          },
        };
      },
      completeReview: async (_path, options = {}) => {
        this.reviews.push(options);
        const before = this.beforeReview;
        this.beforeReview = null;
        before?.();
        if (
          this.reviewConflict ||
          (options.expectedContentHash &&
            options.expectedContentHash !== hashOf(this.content))
        ) {
          throw new MarkdownFileConflictError(this.page());
        }
        return { delivered: true, pending: false, handoff: null, wake: null };
      },
    };
  }
}

class FakeEnvironment {
  visible = true;
  handlers: SyncEnvironmentHandlers | null = null;

  environment() {
    return {
      isVisible: () => this.visible,
      listen: (handlers: SyncEnvironmentHandlers) => {
        this.handlers = handlers;
        return () => {
          this.handlers = null;
        };
      },
    };
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.handlers?.visibility(visible);
  }
}

function hello(server: FakeServer, overrides: Partial<TabServerMessage> = {}) {
  return {
    type: "hello",
    instanceId: "instance-1",
    document: server.state(),
    tabs: 1,
    watchers: 0,
    session: null,
    handoff: null,
    latestSequence: null,
    ...overrides,
  } as TabServerMessage;
}

function change(server: FakeServer, overrides: Record<string, unknown> = {}) {
  return {
    type: "change",
    ...server.state(),
    origin: "outside",
    ...overrides,
  } as TabServerMessage;
}

// Lets awaited promise chains inside the controller run.
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const syncs: DocumentSync[] = [];

function createSync(server: FakeServer, env = new FakeEnvironment()) {
  const sync = new DocumentSync({
    backend: server.backend(),
    path: "doc.md",
    tabId: "tab-1",
    initialPage: server.page(),
    environment: env.environment(),
  });
  const updates: ContentUpdate[] = [];
  sync.onContentUpdate((update) => {
    updates.push(update);
  });
  sync.start();
  syncs.push(sync);
  return { sync, env, updates };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const sync of syncs.splice(0)) sync.dispose();
  vi.useRealTimers();
});

describe("DocumentSync saving", () => {
  it("never has two saves in flight and the second uses the base the first returned", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    const firstHold = deferred<void>();
    server.holdPut = firstHold;

    sync.edit("Start one");
    await advance(500);
    expect(server.puts).toHaveLength(1);
    expect(sync.getView().state).toEqual({ kind: "saving", again: false });

    sync.edit("Start one two");
    await advance(600);
    expect(server.puts).toHaveLength(1);
    expect(sync.getView().state).toMatchObject({ kind: "saving", again: true });

    firstHold.resolve();
    await advance(0);

    expect(server.puts).toHaveLength(2);
    expect(server.puts[1]).toMatchObject({
      content: "Start one two",
      expectedVersion: "v2",
      options: { expectedContentHash: hashOf("Start one") },
    });
    expect(server.content).toBe("Start one two");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("debounces a burst of edits into one save", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    sync.edit("Start a");
    await advance(300);
    sync.edit("Start ab");
    await advance(300);
    expect(server.puts).toHaveLength(0);
    expect(sync.getView().state).toEqual({ kind: "pending" });

    await advance(200);
    expect(server.puts.map((put) => put.content)).toEqual(["Start ab"]);
    expect(sync.getView()).toMatchObject({
      state: { kind: "synced" },
      dirty: false,
      base: { contentHash: hashOf("Start ab") },
    });
  });

  it("merges onto the 409 body's page without fetching again, then saves the merge", async () => {
    const server = new FakeServer("# T\n\nIntro.\n\nBody.\n");
    const { sync, updates } = createSync(server);

    server.write("# T\n\nIntro.\n\nBody, from the agent.\n");
    sync.edit("# T\n\nIntro, typed.\n\nBody.\n");
    await advance(500);

    expect(server.gets).toBe(0);
    expect(server.puts).toHaveLength(1);
    expect(sync.draft).toBe("# T\n\nIntro, typed.\n\nBody, from the agent.\n");
    expect(updates.at(-1)).toMatchObject({ reason: "rebase" });

    await advance(500);
    expect(server.content).toBe(
      "# T\n\nIntro, typed.\n\nBody, from the agent.\n",
    );
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("retries a failed save with 1, 2, 5, 10 and then 30 s backoff and returns to synced", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.putFailures = 6;

    sync.edit("Start offline");
    await advance(500);
    expect(server.puts).toHaveLength(1);
    expect(sync.getView().state).toMatchObject({ kind: "offline" });

    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      await advance(delay - 1);
      expect(server.puts).toHaveLength(index + 1);
      await advance(1);
      expect(server.puts).toHaveLength(index + 2);
    }

    expect(server.content).toBe("Start offline");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("retries an offline save at once when the browser comes back online", async () => {
    const server = new FakeServer("Start");
    const { sync, env } = createSync(server);
    server.putFailures = 1;

    sync.edit("Start again");
    await advance(500);
    expect(sync.getView().state.kind).toBe("offline");

    env.handlers?.online();
    await settle();

    expect(server.puts).toHaveLength(2);
    expect(server.content).toBe("Start again");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("retries an offline save at once when a reconnected socket says hello", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.putFailures = 1;

    sync.edit("Start again");
    await advance(500);
    expect(sync.getView().state.kind).toBe("offline");

    server.lastChannel().open();
    server.lastChannel().receive(hello(server));
    await settle();

    expect(server.puts).toHaveLength(2);
    expect(server.content).toBe("Start again");
  });

  it("re-checks the disk after a save error", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.putFailures = 1;

    sync.edit("Start again");
    await advance(500);

    expect(server.stateCalls).toBe(1);
  });

  it("flush saves at once and resolves after the save", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    sync.edit("Start flushed");
    const result = await sync.flush();

    expect(result).toEqual({ status: "saved" });
    expect(server.content).toBe("Start flushed");
    expect(server.puts).toHaveLength(1);
  });
});

describe("DocumentSync incoming changes", () => {
  it("ignores a change whose hash equals the base", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();

    server.lastChannel().receive(change(server));
    await settle();

    expect(server.gets).toBe(0);
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("ignores the change event for its own write, even before the PUT answers", async () => {
    const server = new FakeServer("Start");
    const { sync, updates } = createSync(server);
    server.lastChannel().open();
    const hold = deferred<void>();
    server.holdPut = hold;

    sync.edit("Start mine");
    await advance(500);
    // The server wrote and its watcher spoke before the PUT answer arrived.
    server.write("Start mine");
    server.lastChannel().receive(change(server, { origin: "unknown" }));
    await settle();
    expect(sync.getView().state.kind).toBe("saving");

    hold.resolve();
    await settle();

    expect(server.gets).toBe(0);
    expect(updates).toHaveLength(0);
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("fast-forwards a clean tab and pushes the new content to the editor", async () => {
    const server = new FakeServer("Start");
    const { sync, updates } = createSync(server);
    server.lastChannel().open();

    server.write("Start\n\nAgent reply.");
    server.lastChannel().receive(change(server));
    await settle();

    expect(sync.draft).toBe("Start\n\nAgent reply.");
    expect(sync.getView().base.contentHash).toBe(
      hashOf("Start\n\nAgent reply."),
    );
    expect(updates).toEqual([
      { content: "Start\n\nAgent reply.", epoch: 1, reason: "fast-forward" },
    ]);
  });

  it("merges a reload into a draft that became dirty during the fetch", async () => {
    // Sync finding 1: the dirty check must happen after the fetch, and the
    // agent's paragraph must never be erased.
    const server = new FakeServer("# Race\n\nOriginal.\n");
    const { sync } = createSync(server);
    server.lastChannel().open();
    const hold = deferred<void>();
    server.holdGet = hold;

    server.write("# Race\n\nOriginal.\n\nAgent paragraph.\n");
    server.lastChannel().receive(change(server));
    await settle();
    expect(server.gets).toBe(1);

    sync.edit("# Race\n\nOriginal, typed by user.\n");
    hold.resolve();
    await settle();

    expect(sync.draft).toBe(
      "# Race\n\nOriginal, typed by user.\n\nAgent paragraph.\n",
    );
    expect(sync.getView().base.content).toBe(
      "# Race\n\nOriginal.\n\nAgent paragraph.\n",
    );

    await advance(500);
    expect(server.content).toBe(
      "# Race\n\nOriginal, typed by user.\n\nAgent paragraph.\n",
    );
  });

  it("moves to unavailable when the file goes missing and saves the held draft when it returns", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();

    server.exists = false;
    server.lastChannel().receive(change(server));
    await settle();
    expect(sync.getView().state).toEqual({
      kind: "unavailable",
      reason: "missing",
    });

    sync.edit("Start, edited while missing");
    await advance(5_000);
    expect(server.puts).toHaveLength(0);

    server.exists = true;
    server.lastChannel().receive(change(server));
    await settle();
    expect(sync.getView().state).toEqual({ kind: "pending" });

    await advance(500);
    expect(server.content).toBe("Start, edited while missing");
  });

  it("clears unavailable when the file returns with the base hash", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();

    server.exists = false;
    server.lastChannel().receive(change(server));
    await settle();
    server.exists = true;
    server.lastChannel().receive(change(server));
    await settle();

    expect(sync.getView().state).toEqual({ kind: "synced" });
    expect(server.gets).toBe(0);
  });

  it("re-applies keystrokes typed on content the editor had not replaced yet", async () => {
    const server = new FakeServer("Intro.\n\nBody.");
    const { sync, updates } = createSync(server);
    server.lastChannel().open();

    server.write("Intro.\n\nBody.\n\nAgent reply.");
    server.lastChannel().receive(change(server));
    await settle();
    expect(updates.at(-1)?.epoch).toBe(1);

    // The editor still shows epoch 0 and reports a keystroke on it.
    sync.edit("Intro!\n\nBody.", 0);

    expect(sync.draft).toBe("Intro!\n\nBody.\n\nAgent reply.");
    expect(updates.at(-1)).toMatchObject({
      content: "Intro!\n\nBody.\n\nAgent reply.",
      reason: "rebase",
    });

    await advance(500);
    expect(server.content).toBe("Intro!\n\nBody.\n\nAgent reply.");
  });
});

describe("DocumentSync resync triggers", () => {
  it("re-checks the disk when the tab becomes visible and applies a newer file", async () => {
    const server = new FakeServer("Start");
    const { sync, env, updates } = createSync(server);
    server.lastChannel().open();

    env.setVisible(false);
    server.write("Written while hidden");
    env.setVisible(true);
    await settle();

    expect(server.stateCalls).toBe(1);
    expect(server.gets).toBe(1);
    expect(sync.draft).toBe("Written while hidden");
    expect(updates).toHaveLength(1);
  });

  it("only fetches the page when the state hash differs from the base", async () => {
    const server = new FakeServer("Start");
    const { env } = createSync(server);

    env.handlers?.focus();
    await settle();
    env.handlers?.pageshow();
    await settle();

    expect(server.stateCalls).toBe(2);
    expect(server.gets).toBe(0);
  });

  it("falls back to fetching the page from a server without the state route", async () => {
    const server = new FakeServer("Start");
    const { sync, env } = createSync(server);
    server.stateUnsupported = true;

    server.write("Newer");
    env.handlers?.focus();
    await settle();

    expect(server.gets).toBe(1);
    expect(sync.draft).toBe("Newer");
  });

  it("reconnects with 0.5, 1, 2 and 5 s backoff and resyncs from the next hello", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    expect(server.channels).toHaveLength(1);

    server.lastChannel().drop();
    for (const [index, delay] of [500, 1_000, 2_000, 5_000, 5_000].entries()) {
      await advance(delay - 1);
      expect(server.channels).toHaveLength(index + 1);
      await advance(1);
      expect(server.channels).toHaveLength(index + 2);
      if (index < 4) server.lastChannel().drop();
    }

    server.write("Written while the socket was down");
    server.lastChannel().open();
    server.lastChannel().receive(hello(server));
    await settle();

    expect(sync.draft).toBe("Written while the socket was down");
  });

  it("treats 35 s without a ping as a dead socket: resyncs and reconnects", async () => {
    const server = new FakeServer("Start");
    createSync(server);
    server.lastChannel().open();

    await advance(15_000);
    server.lastChannel().receive({ type: "ping", seq: 1 });
    await advance(34_999);
    expect(server.channels).toHaveLength(1);
    expect(server.stateCalls).toBe(0);

    await advance(1);
    expect(server.channels[0]?.closed).toBe(true);
    expect(server.channels).toHaveLength(2);
    expect(server.stateCalls).toBe(1);
  });

  it("answers a ping with a pong", async () => {
    const server = new FakeServer("Start");
    createSync(server);
    server.lastChannel().open();

    server.lastChannel().receive({ type: "ping", seq: 7 });

    expect(server.lastChannel().sent).toContainEqual({ type: "pong", seq: 7 });
  });

  it("closes the socket after 60 s hidden and reopens it when visible", async () => {
    const server = new FakeServer("Start");
    const { env } = createSync(server);
    server.lastChannel().open();

    env.setVisible(false);
    for (let elapsed = 0; elapsed < 45_000; elapsed += 15_000) {
      await advance(15_000);
      server.lastChannel().receive({ type: "ping", seq: elapsed });
    }
    await advance(14_999);
    expect(server.lastChannel().closed).toBe(false);
    await advance(1);
    expect(server.lastChannel().closed).toBe(true);

    await advance(30_000);
    expect(server.channels).toHaveLength(1);

    env.setVisible(true);
    expect(server.channels).toHaveLength(2);
  });
});

describe("DocumentSync channel state", () => {
  it("takes watcher count, session and handoff from socket messages", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();
    const session = {
      harness: "claude-code",
      label: "Plan chat",
      link: null,
      sessionId: null,
      routeId: null,
      registeredAt: "2026-10-05T15:00:00.000Z",
    };

    server.lastChannel().receive(hello(server, { watchers: 1, session }));
    expect(sync.getView()).toMatchObject({
      watchers: 1,
      session,
      channelSupported: true,
    });

    server.lastChannel().receive({ type: "watchers", count: 0 });
    expect(sync.getView().watchers).toBe(0);
  });

  it("reports presence on connect and when the tab becomes dirty, at most every 5 s while dirty", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    const channel = server.lastChannel();
    channel.open();

    expect(channel.presence()).toEqual([
      {
        type: "presence",
        visible: true,
        dirty: false,
        conflict: false,
        baseHash: hashOf("Start"),
      },
    ]);

    await advance(6_000);
    sync.edit("Start a");
    expect(channel.presence().at(-1)).toMatchObject({ dirty: true });
    const afterFirstEdit = channel.presence().length;

    await advance(500);
    sync.edit("Start ab");
    await advance(500);
    // Saved twice and dirty again: still inside the 5 s window.
    sync.edit("Start abc");
    expect(channel.presence()).toHaveLength(afterFirstEdit);

    await advance(5_000);
    expect(channel.presence().length).toBeGreaterThan(afterFirstEdit);
  });
});

describe("DocumentSync handoff and banner actions", () => {
  it("completes a review after the flush with the flushed base and no second PUT", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    sync.edit("Start, quick note.");
    const result = await sync.completeReview({ handoffId: "h1" });

    expect(result.delivered).toBe(true);
    expect(server.puts).toHaveLength(1);
    expect(server.reviews).toEqual([
      {
        handoffId: "h1",
        expectedVersion: "v2",
        expectedContentHash: hashOf("Start, quick note."),
      },
    ]);
  });

  it("takes a disk change that answered the review event and sends Done again", async () => {
    const server = new FakeServer("# T\n\nIntro.\n\nBody.\n");
    const { sync } = createSync(server);

    sync.edit("# T\n\nIntro, mine.\n\nBody.\n");
    // The agent writes between the flush and the Done.
    server.beforeReview = () =>
      server.write("# T\n\nIntro, mine.\n\nBody, agent.\n");
    const result = await sync.completeReview({ handoffId: "h1" });

    expect(result.delivered).toBe(true);
    expect(sync.draft).toBe("# T\n\nIntro, mine.\n\nBody, agent.\n");
    expect(server.reviews).toHaveLength(2);
    expect(server.reviews.at(-1)).toMatchObject({
      handoffId: "h1",
      expectedContentHash: hashOf("# T\n\nIntro, mine.\n\nBody, agent.\n"),
    });
  });

  it("says the server did not answer when the flush cannot save", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.putFailures = 1;

    sync.edit("Start, unsaved");
    const failure = await sync.completeReview({ handoffId: "h1" }).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as HandoffError).kind).toBe("no-answer");
    expect(server.reviews).toHaveLength(0);
  });

  it("refuses Done while an overlap waits for a choice", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    server.write(MARKUP_THEIRS);
    server.lastChannel().receive(change(server));
    await settle();
    expect(sync.getView().state.kind).toBe("conflict");

    const failure = await sync.completeReview({ handoffId: "h1" }).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as HandoffError).kind).toBe("file-changed");
    expect(server.reviews).toHaveLength(0);
  });

  it("overwrites only the version the confirmation showed", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    server.write(MARKUP_THEIRS);
    server.lastChannel().receive(change(server));
    await settle();
    const state = sync.getView().state;
    if (state.kind !== "conflict") throw new Error("expected a conflict");

    await sync.overwrite(state.theirs);

    expect(server.puts.at(-1)).toMatchObject({
      content: MARKUP_MINE,
      expectedVersion: "v2",
      options: { expectedContentHash: hashOf(MARKUP_THEIRS) },
    });
    expect(server.content).toBe(MARKUP_MINE);
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("does not overwrite a disk version newer than the one shown", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    server.write(MARKUP_THEIRS);
    server.lastChannel().receive(change(server));
    await settle();
    const state = sync.getView().state;
    if (state.kind !== "conflict") throw new Error("expected a conflict");
    const newest = MARKUP_THEIRS.replace("there me", "there us");
    server.write(newest);

    await sync.overwrite(state.theirs);

    expect(server.content).toBe(newest);
    expect(sync.getView().state).toMatchObject({
      kind: "conflict",
      theirs: { content: newest },
    });
  });

  it("reload from disk drops the draft and pushes the disk content", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync, updates } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    server.write(MARKUP_THEIRS);
    server.lastChannel().receive(change(server));
    await settle();

    await sync.reloadFromDisk();

    expect(sync.draft).toBe(MARKUP_THEIRS);
    expect(sync.getView().state).toEqual({ kind: "synced" });
    expect(updates.at(-1)).toMatchObject({
      content: MARKUP_THEIRS,
      reason: "reload",
    });
  });
});

// --- Batch 5: rebase instead of blocking ------------------------------------

const ENTRY = (id: string, extra = "") =>
  `  ${id}:\n    body: "Why?"\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n${extra}`;
const MARKUP_BASE = `# T\n\nHi {==there==}{#c1}.\n\n---\ncomments:\n${ENTRY("c1")}`;
const MARKUP_MINE = `# T\n\nHi {==there you==}{#c1}.\n\n---\ncomments:\n${ENTRY("c1")}`;
const MARKUP_THEIRS = `# T\n\nHi {==there me==}{#c1}.\n\n---\ncomments:\n${ENTRY("c1")}`;

async function agentWrites(server: FakeServer, content: string) {
  server.write(content);
  server.lastChannel().receive(change(server));
  await settle();
}

describe("DocumentSync rebase", () => {
  it("merges an agent edit in another paragraph without a conflict and saves both", async () => {
    const server = new FakeServer(
      "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n",
    );
    const { sync, updates } = createSync(server);
    server.lastChannel().open();

    sync.edit("# Plan\n\nFirst paragraph, typed.\n\nSecond paragraph.\n");
    await agentWrites(
      server,
      "# Plan\n\nFirst paragraph.\n\nSecond paragraph, by the agent.\n",
    );

    const merged =
      "# Plan\n\nFirst paragraph, typed.\n\nSecond paragraph, by the agent.\n";
    expect(sync.draft).toBe(merged);
    expect(sync.getView().base.content).toBe(
      "# Plan\n\nFirst paragraph.\n\nSecond paragraph, by the agent.\n",
    );
    expect(updates.at(-1)).toMatchObject({ content: merged, reason: "rebase" });
    expect(sync.getView().state).toEqual({ kind: "pending" });

    await advance(500);
    expect(server.content).toBe(merged);
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("keeps an overlapping edit as Jordan's suggestion against the agent's text", async () => {
    const server = new FakeServer(
      "# Plan\n\nThe pilot is limited on purpose.\n",
    );
    const { sync } = createSync(server);
    server.lastChannel().open();

    sync.edit("# Plan\n\nThe pilot is tiny on purpose.\n");
    await agentWrites(server, "# Plan\n\nThe pilot is small on purpose.\n");

    expect(sync.getView().state.kind).toBe("pending");
    expect(sync.draft).toContain(
      "The pilot is {~~small~>tiny~~}{#s1} on purpose.",
    );
    expect(sync.draft).toMatch(/suggestions:\n {2}s1:\n {4}by: user\n/);
    const notice = sync.getView().notices.find((n) => n.kind === "updated");
    expect(notice).toMatchObject({ suggestionsAdded: ["s1"] });

    await advance(500);
    expect(server.content).toBe(sync.draft);
  });

  it("keeps the draft and lists the overlap when it sits inside review markup", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync, updates } = createSync(server);
    server.lastChannel().open();

    sync.edit(MARKUP_MINE);
    await agentWrites(server, MARKUP_THEIRS);

    const state = sync.getView().state;
    expect(state).toMatchObject({
      kind: "conflict",
      theirs: { content: MARKUP_THEIRS },
      hunks: [
        {
          id: "h1",
          kind: "body",
          reason: "markup-overlap",
          choices: ["ours", "theirs"],
        },
      ],
    });
    expect(sync.draft).toBe(MARKUP_MINE);
    expect(updates).toHaveLength(0);

    // Typing goes on elsewhere; nothing is written while the overlap waits.
    sync.edit(MARKUP_MINE.replace("# T", "# Title"));
    await advance(5_000);
    expect(server.puts).toHaveLength(0);
    expect(server.content).toBe(MARKUP_THEIRS);
    expect(sync.getView().state).toMatchObject({
      kind: "conflict",
      hunks: [{ reason: "markup-overlap" }],
    });
    expect(await sync.flush()).toEqual({
      status: "blocked",
      reason: "conflict",
    });
  });

  it("settles a hunk with the disk version and saves the rest of the draft", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE.replace("# T", "# Title"));
    await agentWrites(server, MARKUP_THEIRS);
    expect(sync.getView().state.kind).toBe("conflict");

    sync.resolveHunk("h1", "theirs");

    expect(sync.draft).toBe(MARKUP_THEIRS.replace("# T", "# Title"));
    await advance(500);
    expect(server.content).toBe(MARKUP_THEIRS.replace("# T", "# Title"));
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("settles a hunk with mine", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    await agentWrites(server, MARKUP_THEIRS);

    sync.resolveHunk("h1", "ours");
    await advance(500);

    expect(server.content).toBe(MARKUP_MINE);
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("merges again once typing pauses, and leaves the conflict when the overlap is gone", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    await agentWrites(server, MARKUP_THEIRS);
    expect(sync.getView().state.kind).toBe("conflict");

    // Jordan types the agent's words himself.
    sync.edit(MARKUP_THEIRS.replace("# T", "# T2"));
    await advance(500);

    expect(sync.getView().state.kind).not.toBe("conflict");
    await advance(500);
    expect(server.content).toBe(MARKUP_THEIRS.replace("# T", "# T2"));
  });

  it("re-applies keystrokes typed on content the editor had not replaced yet", async () => {
    const server = new FakeServer("Intro.\n\nBody.\n");
    const { sync, updates } = createSync(server);
    server.lastChannel().open();

    await agentWrites(server, "Intro.\n\nBody.\n\nAgent reply.\n");
    expect(updates.at(-1)?.epoch).toBe(1);

    // The editor still shows epoch 0 and reports a keystroke on it.
    sync.edit("Intro!\n\nBody.\n", 0);

    expect(sync.draft).toBe("Intro!\n\nBody.\n\nAgent reply.\n");
    expect(updates.at(-1)).toMatchObject({
      content: "Intro!\n\nBody.\n\nAgent reply.\n",
      reason: "rebase",
    });

    await advance(500);
    expect(server.content).toBe("Intro!\n\nBody.\n\nAgent reply.\n");
  });
});

describe("DocumentSync notices", () => {
  it("says what a fast-forward changed, with the thread to show", async () => {
    const before = `# Plan\n\nSee {==this==}{#c1}.\n\n---\ncomments:\n${ENTRY("c1")}`;
    const after = `${before}  a1:\n    body: "Because."\n    by: AI\n    at: "2026-01-01T00:01:00.000Z"\n    re: c1\n`;
    const server = new FakeServer(before);
    const { sync } = createSync(server);
    server.lastChannel().open();

    await agentWrites(server, after);

    expect(sync.getView().notices).toEqual([
      {
        id: 1,
        kind: "updated",
        summary: "1 reply added",
        epoch: 1,
        commentId: "c1",
        suggestionsAdded: [],
      },
    ]);
    sync.dismissNotice(1);
    expect(sync.getView().notices).toEqual([]);
  });

  it("names the section whose text changed", async () => {
    const server = new FakeServer(
      "# Plan\n\n## Rollout\n\nTwo weeks.\n\n## Risks\n\nNone.\n",
    );
    const { sync } = createSync(server);
    server.lastChannel().open();

    await agentWrites(
      server,
      "# Plan\n\n## Rollout\n\nThree weeks.\n\n## Risks\n\nNone.\n",
    );

    expect(sync.getView().notices).toMatchObject([
      { kind: "updated", summary: "text changed in Rollout" },
    ]);
  });

  it("raises the loud notice when an outside write removes text this tab saved, and restores it as a suggestion", async () => {
    const server = new FakeServer("# Plan\n\nIntro.\n\nOutro.\n");
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit("# Plan\n\nIntro.\n\nMy point about the rollout.\n\nOutro.\n");
    await advance(500);
    expect(server.content).toContain("My point about the rollout.");

    // A blind overwrite from an old read: the paragraph is gone.
    await agentWrites(server, "# Plan\n\nIntro, agent.\n\nOutro.\n");

    const removed = sync.getView().notices.find((n) => n.kind === "removed");
    expect(removed).toMatchObject({
      kind: "removed",
      removed: [{ text: "My point about the rollout.", whole: true }],
    });
    if (!removed) throw new Error("expected the removed-text notice");

    sync.restoreRemovedText(removed.id);
    expect(sync.draft).toContain(
      "Intro, agent.\n\n{++My point about the rollout.++}{#s1}\n",
    );
    expect(sync.draft).toMatch(/suggestions:\n {2}s1:\n {4}by: user\n/);
    expect(sync.getView().notices.some((n) => n.kind === "removed")).toBe(
      false,
    );
    await advance(500);
    expect(server.content).toBe(sync.draft);
  });

  it("stays quiet about removed text saved more than five minutes ago", async () => {
    const server = new FakeServer("# Plan\n\nIntro.\n\nOutro.\n");
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit("# Plan\n\nIntro.\n\nMy point about the rollout.\n\nOutro.\n");
    await advance(500);

    await advance(5 * 60 * 1000 + 1_000);
    await agentWrites(server, "# Plan\n\nIntro, agent.\n\nOutro.\n");

    expect(sync.getView().notices.map((n) => n.kind)).toEqual(["updated"]);
  });

  it("shows nothing for the echo of its own save", async () => {
    const server = new FakeServer("# Plan\n\nIntro.\n");
    const { sync } = createSync(server);
    server.lastChannel().open();
    sync.edit("# Plan\n\nIntro, mine.\n");
    await advance(500);

    server
      .lastChannel()
      .receive(change(server, { origin: "tab", tabId: "tab-1" }));
    await settle();

    expect(sync.getView().notices).toEqual([]);
  });
});

describe("DocumentSync drafts kept in the browser", () => {
  it("writes the draft and its base 250 ms after an edit and removes it once saved", async () => {
    const server = new FakeServer("# Plan\n\nIntro.\n");
    const store = createMemoryDraftStore();
    const sync = createSyncWithStore(server, store);

    sync.edit("# Plan\n\nIntro, mine.\n");
    await advance(200);
    expect(store.records.size).toBe(0);
    await advance(50);
    await sync.whenDraftsWritten();
    expect(store.records.get("/docs/doc.md")).toMatchObject({
      draft: "# Plan\n\nIntro, mine.\n",
      base: {
        content: "# Plan\n\nIntro.\n",
        contentHash: hashOf("# Plan\n\nIntro.\n"),
      },
      tabId: "tab-1",
    });

    await advance(500);
    await sync.whenDraftsWritten();
    expect(server.content).toBe("# Plan\n\nIntro, mine.\n");
    expect(store.records.size).toBe(0);
  });

  it("keeps the draft while a conflict is open", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const store = createMemoryDraftStore();
    const sync = createSyncWithStore(server, store);
    server.lastChannel().open();
    sync.edit(MARKUP_MINE);
    await agentWrites(server, MARKUP_THEIRS);
    await advance(300);
    await sync.whenDraftsWritten();

    expect(store.records.get("/docs/doc.md")).toMatchObject({
      draft: MARKUP_MINE,
      base: { content: MARKUP_BASE },
    });
  });

  it("restores a stored draft on load, merged onto the file as it is now", async () => {
    const server = new FakeServer("# Plan\n\nIntro.\n\nBody.\n");
    const store = createMemoryDraftStore();
    const first = createSyncWithStore(server, store);
    first.edit("# Plan\n\nIntro, mine.\n\nBody.\n");
    await advance(300);
    await first.whenDraftsWritten();
    // The tab dies before the save; the agent writes meanwhile.
    first.dispose();
    server.write("# Plan\n\nIntro.\n\nBody, agent.\n");

    const second = new DocumentSync({
      backend: server.backend(),
      path: "doc.md",
      tabId: "tab-9",
      initialPage: server.page(),
      environment: new FakeEnvironment().environment(),
      draftStore: store,
      draftKey: "/docs/doc.md",
    });
    syncs.push(second);
    const updates: ContentUpdate[] = [];
    second.onContentUpdate((update) => updates.push(update));

    expect(await second.restoreDraft()).toBe(true);
    second.start();

    expect(second.draft).toBe("# Plan\n\nIntro, mine.\n\nBody, agent.\n");
    expect(second.getView().notices).toMatchObject([{ kind: "restored" }]);
    expect(updates.at(-1)).toMatchObject({ reason: "rebase" });
    await advance(500);
    await second.whenDraftsWritten();
    expect(server.content).toBe("# Plan\n\nIntro, mine.\n\nBody, agent.\n");
    expect(store.records.size).toBe(0);
  });

  it("restores into the conflict state when the stored draft overlaps the disk", async () => {
    const server = new FakeServer(MARKUP_BASE);
    const store = createMemoryDraftStore();
    await store.put({
      key: "/docs/doc.md",
      draft: MARKUP_MINE,
      base: {
        content: MARKUP_BASE,
        version: "v1",
        contentHash: hashOf(MARKUP_BASE),
        seq: 1,
      },
      tabId: "old-tab",
      savedAt: Date.now(),
    });
    server.write(MARKUP_THEIRS);
    const sync = createSyncWithStore(server, store, { start: false });
    const updates: ContentUpdate[] = [];
    sync.onContentUpdate((update) => updates.push(update));

    expect(await sync.restoreDraft()).toBe(true);

    expect(sync.draft).toBe(MARKUP_MINE);
    expect(sync.getView().state).toMatchObject({ kind: "conflict" });
    expect(updates.at(-1)).toMatchObject({
      content: MARKUP_MINE,
      reason: "restore",
    });
  });

  it("drops a stored draft that disk already holds", async () => {
    const server = new FakeServer("# Plan\n");
    const store = createMemoryDraftStore();
    await store.put({
      key: "/docs/doc.md",
      draft: "# Plan\n",
      base: {
        content: "# Old\n",
        version: "v0",
        contentHash: hashOf("# Old\n"),
        seq: 0,
      },
      tabId: "old-tab",
      savedAt: Date.now(),
    });
    const sync = createSyncWithStore(server, store, { start: false });

    expect(await sync.restoreDraft()).toBe(false);
    await sync.whenDraftsWritten();
    expect(store.records.size).toBe(0);
    expect(sync.getView().notices).toEqual([]);
  });

  it("round-trips a draft through IndexedDB", async () => {
    const store = createIndexedDbDraftStore(new IDBFactory(), "drafts-test");
    if (!store) throw new Error("expected an IndexedDB store");
    vi.useRealTimers();
    const record = {
      key: "/docs/doc.md",
      draft: "# Plan\n\nMine.\n",
      base: { content: "# Plan\n", version: "v1", contentHash: "h1", seq: 1 },
      tabId: "tab-1",
      savedAt: 1,
    };
    await store.put(record);
    expect(await store.get("/docs/doc.md")).toEqual(record);
    await store.delete("/docs/doc.md", (stored) => stored.tabId === "tab-2");
    expect(await store.get("/docs/doc.md")).toEqual(record);
    await store.delete("/docs/doc.md", (stored) => stored.tabId === "tab-1");
    expect(await store.get("/docs/doc.md")).toBeNull();
  });
});

describe("DocumentSync offline and unavailable", () => {
  it("goes offline on a failed save with a retry time and saves when the server is back", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.putFailures = 1;

    sync.edit("Start, mine");
    await advance(500);
    const state = sync.getView().state;
    expect(state.kind).toBe("offline");
    if (state.kind === "offline") {
      expect(state.retryAt - Date.now()).toBe(1_000);
    }

    await advance(1_000);
    expect(server.content).toBe("Start, mine");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("goes unavailable when the file disappears and recreates it from the draft", async () => {
    const server = new FakeServer("# Plan\n");
    let created: string | null = null;
    const backend = server.backend();
    const sync = new DocumentSync({
      backend: {
        ...backend,
        saveMarkdownFile: async (path, content, expected, options) => {
          if (options?.create) {
            server.exists = true;
            server.write(content);
            created = content;
            return server.page();
          }
          return backend.saveMarkdownFile(path, content, expected, options);
        },
      },
      path: "doc.md",
      tabId: "tab-1",
      initialPage: server.page(),
      environment: new FakeEnvironment().environment(),
    });
    syncs.push(sync);
    sync.start();
    server.lastChannel().open();

    server.exists = false;
    server.lastChannel().receive(change(server));
    await settle();
    expect(sync.getView().state).toEqual({
      kind: "unavailable",
      reason: "missing",
    });

    sync.edit("# Plan\n\nMine.\n");
    expect(await sync.recreateFromDraft()).toBe(true);
    expect(created).toBe("# Plan\n\nMine.\n");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("says when the server cannot recreate a missing file", async () => {
    const server = new FakeServer("# Plan\n");
    const backend = server.backend();
    const sync = new DocumentSync({
      backend: {
        ...backend,
        saveMarkdownFile: async () => {
          throw new MarkdownFileNotFoundError("doc.md", "not found");
        },
      },
      path: "doc.md",
      tabId: "tab-1",
      initialPage: server.page(),
      environment: new FakeEnvironment().environment(),
    });
    syncs.push(sync);
    sync.start();
    server.lastChannel().open();
    server.exists = false;
    server.lastChannel().receive(change(server));
    await settle();

    expect(await sync.recreateFromDraft()).toBe(false);
    expect(sync.getView().state.kind).toBe("unavailable");
    expect(sync.getView().lastError).toMatch(/cannot recreate a missing file/);
  });
});

function createSyncWithStore(
  server: FakeServer,
  store: DraftStore,
  { start = true }: { start?: boolean } = {},
) {
  const sync = new DocumentSync({
    backend: server.backend(),
    path: "doc.md",
    tabId: "tab-1",
    initialPage: server.page(),
    environment: new FakeEnvironment().environment(),
    draftStore: store,
    draftKey: "/docs/doc.md",
  });
  if (start) sync.start();
  syncs.push(sync);
  return sync;
}

describe("DocumentSync and the open documents list", () => {
  it("takes a new session from the channel", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();
    server.lastChannel().receive(hello(server));
    await settle();
    expect(sync.getView().session).toBeNull();

    server.lastChannel().receive({
      type: "session",
      session: {
        harness: "claude-code",
        label: "Fork Roughdraft",
        link: null,
        sessionId: "s1",
        routeId: null,
        registeredAt: "2026-10-06T10:00:00.000Z",
      },
    });
    expect(sync.getView().session?.label).toBe("Fork Roughdraft");
    server.lastChannel().receive({ type: "session", session: null });
    expect(sync.getView().session).toBeNull();
  });

  it("saves typed text before it reports the close", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();
    server.lastChannel().receive(hello(server));
    await settle();

    sync.edit("Start, typed just now");
    server.lastChannel().receive({ type: "close" });
    await advance(0);

    expect(server.content).toBe("Start, typed just now");
    expect(sync.getView().closedByList).toBe(true);
  });
});
