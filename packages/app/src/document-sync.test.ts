import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ContentUpdate,
  DocumentSync,
  HandoffError,
  mergeSingleEdit,
  type SyncBackend,
  type SyncEnvironmentHandlers,
} from "./document-sync";
import {
  type CompleteReviewOptions,
  MarkdownFileConflictError,
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

  it("keeps the draft and uses the 409 body's page without fetching again", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    server.write("Agent text");
    sync.edit("Start mine");
    await advance(500);

    expect(server.gets).toBe(0);
    expect(sync.draft).toBe("Start mine");
    expect(sync.getView().state).toEqual({
      kind: "conflict",
      theirs: {
        content: "Agent text",
        version: "v2",
        contentHash: hashOf("Agent text"),
        seq: 2,
      },
    });
    expect(sync.getView().base.content).toBe("Start");
    expect(server.content).toBe("Agent text");
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

  it("does not apply a reload over a draft that became dirty during the fetch", async () => {
    // Sync finding 1: the dirty check must happen after the fetch.
    const server = new FakeServer("Original.");
    const { sync, updates } = createSync(server);
    server.lastChannel().open();
    const hold = deferred<void>();
    server.holdGet = hold;

    server.write("Original.\n\nAgent paragraph.");
    server.lastChannel().receive(change(server));
    await settle();
    expect(server.gets).toBe(1);

    sync.edit("Original.\n\nTyped by user.");
    hold.resolve();
    await settle();

    expect(updates).toHaveLength(0);
    expect(sync.draft).toBe("Original.\n\nTyped by user.");
    expect(sync.getView().base.content).toBe("Original.");
    expect(sync.getView().state).toMatchObject({
      kind: "changed",
      theirs: { content: "Original.\n\nAgent paragraph." },
    });

    await advance(5_000);
    expect(server.puts).toHaveLength(0);
    expect(server.content).toBe("Original.\n\nAgent paragraph.");
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

  it("maps a 409 from the review event to the conflict state", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    server.write("Agent wrote first");
    const failure = await sync.completeReview({ handoffId: "h1" }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HandoffError);
    expect((failure as HandoffError).kind).toBe("file-changed");
    expect(sync.getView().state).toMatchObject({
      kind: "conflict",
      theirs: { content: "Agent wrote first" },
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

  it("overwrites with the version the banner shows as expectedVersion", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    server.write("Agent text");
    sync.edit("Start mine");
    await advance(500);
    expect(sync.getView().state.kind).toBe("conflict");

    await sync.overwrite();

    expect(server.puts.at(-1)).toMatchObject({
      content: "Start mine",
      expectedVersion: "v2",
      options: { expectedContentHash: hashOf("Agent text") },
    });
    expect(server.content).toBe("Start mine");
    expect(sync.getView().state).toEqual({ kind: "synced" });
  });

  it("does not overwrite a newer disk version than the one shown", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);

    server.write("Agent text");
    sync.edit("Start mine");
    await advance(500);
    server.write("Agent text, edited again");

    await sync.overwrite();

    expect(server.content).toBe("Agent text, edited again");
    expect(sync.getView().state).toMatchObject({
      kind: "conflict",
      theirs: { content: "Agent text, edited again" },
    });
  });

  it("shows changes that arrive while autosave is paused", async () => {
    const server = new FakeServer("Start");
    const { sync } = createSync(server);
    server.lastChannel().open();

    server.write("Agent text");
    sync.edit("Start mine");
    await advance(500);
    sync.keepEditing();
    expect(sync.getView().paused).toBe(true);

    server.write("Agent text, edited again");
    server.lastChannel().receive(change(server));
    await settle();

    expect(sync.getView()).toMatchObject({
      paused: true,
      theirsUpdates: 1,
      state: { theirs: { content: "Agent text, edited again" } },
    });
  });

  it("reload from disk drops the draft and pushes the disk content", async () => {
    const server = new FakeServer("Start");
    const { sync, updates } = createSync(server);

    server.write("Agent text");
    sync.edit("Start mine");
    await advance(500);

    await sync.reloadFromDisk();

    expect(sync.draft).toBe("Agent text");
    expect(sync.getView().state).toEqual({ kind: "synced" });
    expect(updates.at(-1)).toMatchObject({
      content: "Agent text",
      reason: "reload",
    });
  });
});

describe("mergeSingleEdit", () => {
  it("places an edit before or after a non-overlapping change", () => {
    expect(mergeSingleEdit("a b c", "a B c", "a b c d")).toBe("a B c d");
    expect(mergeSingleEdit("a b c", "a b c!", "z a b c")).toBe("z a b c!");
  });

  it("refuses overlapping edits", () => {
    expect(mergeSingleEdit("a b c", "a X c", "a Y c")).toBeNull();
  });
});
