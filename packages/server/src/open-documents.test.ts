import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ReviewLog } from "./handoff-log";
import { createApp } from "./index";
import { groupOpenDocuments } from "./open-documents";
import { DocumentRegistry, identityFor, localMidnight } from "./registry";
import { sessionStateResolver } from "./session-state";

// The open documents list on a real listener: the fields /api/documents gains,
// Close over the tab channel, Close all finished, Drop, reopening, and the
// midnight sweep. Tabs are `ws` clients, as in tab-channel.test.ts.

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;
// biome-ignore lint/suspicious/noExplicitAny: bodies are checked with matchers
type Json = any;

interface RunningServer {
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

async function startServer(options: AppOptions): Promise<RunningServer> {
  const { app, attachTabChannel } = createApp(options);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  attachTabChannel(server);
  const { port } = server.address() as AddressInfo;
  const running = {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(running);
  return running;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TabClient {
  socket: WebSocket;
  messages: Json[];
  next: (type: string, timeoutMs?: number) => Promise<Json>;
  send: (message: Json) => void;
}

async function openTab(
  server: RunningServer,
  params: Record<string, string>,
): Promise<TabClient> {
  const socket = new WebSocket(
    `${server.wsUrl}/api/tab?${new URLSearchParams(params)}`,
  );
  sockets.push(socket);
  const messages: Json[] = [];
  let consumed = 0;
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    async next(type, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = messages
          .slice(consumed)
          .findIndex((message) => message.type === type);
        if (index !== -1) {
          consumed += index + 1;
          return messages[consumed - 1];
        }
        if (Date.now() > deadline) {
          throw new Error(
            `No ${type} message; got ${JSON.stringify(messages)}`,
          );
        }
        await sleep(10);
      }
    },
  };
}

async function getJson(url: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met: ${JSON.stringify(last)}`);
    }
    await sleep(20);
    last = await read();
  }
  return last;
}

/** A Claude Code session record the way Claude Code writes it, for a live pid. */
function writeClaudeSession(configDir: string, sessionId: string): void {
  const sessions = path.join(configDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({
      sessionId,
      name: "Live session",
      messagingSocketPath: path.join(configDir, "none.sock"),
      updatedAt: Date.now(),
    }),
  );
}

describe("open documents", () => {
  let projectDir: string;
  let stateDir: string;
  let claudeDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-open-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-state-"));
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-claude-"));
    fs.writeFileSync(
      path.join(projectDir, "plan.md"),
      "# Fork plan\n\nText.\n",
    );
    fs.writeFileSync(path.join(projectDir, "notes.md"), "No heading here.\n");
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const dir of [projectDir, stateDir, claudeDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function options(overrides: Partial<AppOptions> = {}): AppOptions {
    return {
      homeDir: projectDir,
      staticDirPath: projectDir,
      stateDir,
      claudeConfigDir: claudeDir,
      watchPollMs: 50,
      deliveryWaitMs: 50,
      ...overrides,
    };
  }

  const target = (file = "plan.md") => ({
    projectPath: projectDir,
    path: file,
  });

  async function register(
    server: RunningServer,
    file: string,
    session: Record<string, unknown>,
  ) {
    const response = await postJson(`${server.url}/api/documents/session`, {
      ...target(file),
      ...session,
    });
    expect(response.status).toBe(200);
  }

  async function documentFor(server: RunningServer, file = "plan.md") {
    const listed = await getJson(`${server.url}/api/documents`);
    return listed.body.documents.find(
      (document: Json) => path.basename(document.documentPath) === file,
    );
  }

  it("lists each document with its title, session state, latest Done and closedAt", async () => {
    writeClaudeSession(claudeDir, "live-session");
    const server = await startServer(options());
    await register(server, "plan.md", {
      harness: "claude-code",
      label: "Fork Roughdraft",
      sessionId: "live-session",
    });
    await register(server, "notes.md", {
      harness: "claude-code",
      label: "Gone session",
      sessionId: "ended-session",
    });
    const done = await postJson(`${server.url}/api/review-events`, target());

    const plan = await documentFor(server);
    expect(plan).toMatchObject({
      title: "Fork plan",
      sessionState: "live",
      closedAt: null,
      tabsDirty: 0,
      latestHandoff: {
        handoffId: done.body.handoff.handoffId,
        state: "pending",
        createdAt: done.body.handoff.createdAt,
        wakeState: expect.any(String),
        ackedAt: null,
      },
    });
    const notes = await documentFor(server, "notes.md");
    expect(notes).toMatchObject({
      title: null,
      sessionState: "ended",
      latestHandoff: null,
    });

    // The title follows the file.
    fs.writeFileSync(path.join(projectDir, "notes.md"), "# Notes now\n");
    expect((await documentFor(server, "notes.md")).title).toBe("Notes now");
  });

  it("reports unknown for harnesses whose sessions it cannot see", async () => {
    const server = await startServer(options());
    await register(server, "plan.md", { harness: "openclaw", label: "Mike" });
    await register(server, "notes.md", {
      harness: "codex",
      label: "Tickets",
      sessionId: "019a-codex",
    });
    expect((await documentFor(server)).sessionState).toBe("unknown");
    expect((await documentFor(server, "notes.md")).sessionState).toBe(
      "unknown",
    );
  });

  it("Close tells the tabs, ends the session, keeps the Done and leaves the file alone", async () => {
    const server = await startServer(options());
    await register(server, "plan.md", {
      harness: "openclaw",
      label: "Resnick proposal",
    });
    const tab = await openTab(server, { ...target(), tabId: "tab_a" });
    await tab.next("hello");
    const done = await postJson(`${server.url}/api/review-events`, target());

    const closed = await postJson(
      `${server.url}/api/documents/close`,
      target(),
    );
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      ok: true,
      closedTabs: 1,
      document: {
        closedAt: expect.any(String),
        session: null,
        lastSession: { label: "Resnick proposal" },
      },
    });
    expect(await tab.next("close")).toEqual({ type: "close" });
    expect(fs.readFileSync(path.join(projectDir, "plan.md"), "utf8")).toBe(
      "# Fork plan\n\nText.\n",
    );
    const plan = await documentFor(server);
    expect(plan.pendingHandoffs).toBe(1);
    expect(plan.latestHandoff.handoffId).toBe(done.body.handoff.handoffId);

    const unknown = await postJson(`${server.url}/api/documents/close`, {
      projectPath: projectDir,
      path: "never-opened.md",
    });
    expect(unknown).toMatchObject({
      status: 404,
      body: { code: "DOCUMENT_NOT_FOUND" },
    });
  });

  it("refuses to close a document while a tab holds unsaved text", async () => {
    const server = await startServer(options());
    const tab = await openTab(server, { ...target(), tabId: "tab_a" });
    const hello = await tab.next("hello");
    tab.send({
      type: "presence",
      visible: true,
      dirty: true,
      conflict: false,
      baseHash: hello.document.contentHash,
    });
    await waitFor(
      async () => (await documentFor(server)).tabsDirty,
      (dirty) => dirty === 1,
    );

    const refused = await postJson(
      `${server.url}/api/documents/close`,
      target(),
    );
    expect(refused).toMatchObject({
      status: 409,
      body: { code: "TAB_DIRTY", document: { closedAt: null } },
    });
    await sleep(50);
    expect(tab.messages.some((message) => message.type === "close")).toBe(
      false,
    );
  });

  it("Close all finished closes picked-up and ended-session documents and skips the rest", async () => {
    fs.writeFileSync(path.join(projectDir, "waiting.md"), "# Waiting\n");
    fs.writeFileSync(path.join(projectDir, "dirty.md"), "# Dirty\n");
    const server = await startServer(options());
    // Picked up.
    await register(server, "plan.md", { harness: "openclaw", label: "A" });
    const picked = await postJson(`${server.url}/api/review-events`, target());
    await postJson(`${server.url}/api/review-events/ack`, {
      handoffId: picked.body.handoff.handoffId,
    });
    // Session ended (a Claude Code session with no live record).
    fs.mkdirSync(path.join(claudeDir, "sessions"));
    await register(server, "notes.md", {
      harness: "claude-code",
      label: "B",
      sessionId: "gone",
    });
    // A Done still waiting.
    await register(server, "waiting.md", { harness: "openclaw", label: "C" });
    await postJson(`${server.url}/api/review-events`, target("waiting.md"));
    // Picked up, but a tab has unsaved text.
    await register(server, "dirty.md", { harness: "openclaw", label: "D" });
    const dirtyDone = await postJson(
      `${server.url}/api/review-events`,
      target("dirty.md"),
    );
    await postJson(`${server.url}/api/review-events/ack`, {
      handoffId: dirtyDone.body.handoff.handoffId,
    });
    const tab = await openTab(server, { ...target("dirty.md"), tabId: "t" });
    const hello = await tab.next("hello");
    tab.send({
      type: "presence",
      visible: true,
      dirty: true,
      conflict: false,
      baseHash: hello.document.contentHash,
    });
    await waitFor(
      async () => (await documentFor(server, "dirty.md")).tabsDirty,
      (dirty) => dirty === 1,
    );

    const result = await postJson(
      `${server.url}/api/documents/close-finished`,
      {},
    );
    expect(result.status).toBe(200);
    const names = (list: Json[]) =>
      list
        .map((entry: Json) =>
          path.basename(entry.documentPath ?? entry.document.documentPath),
        )
        .sort();
    expect(names(result.body.closed)).toEqual(["notes.md", "plan.md"]);
    expect(names(result.body.skipped)).toEqual(["dirty.md"]);
    expect(result.body.skipped[0].reason).toBe("TAB_DIRTY");
    expect((await documentFor(server, "waiting.md")).closedAt).toBeNull();
  });

  it("Drop takes a waiting Done out of pending, watch and the counts", async () => {
    const server = await startServer(options());
    const done = await postJson(`${server.url}/api/review-events`, target());
    expect((await documentFor(server)).pendingHandoffs).toBe(1);

    const dropped = await postJson(`${server.url}/api/review-events/drop`, {
      handoffId: done.body.handoff.handoffId,
    });
    expect(dropped).toMatchObject({
      status: 200,
      body: {
        ok: true,
        handoff: { state: "dropped", droppedAt: expect.any(String) },
      },
    });
    const plan = await documentFor(server);
    expect(plan.pendingHandoffs).toBe(0);
    expect(plan.latestHandoff).toMatchObject({ state: "dropped" });

    // A watcher asking for a waiting Done gets nothing and times out.
    const watched = await postJson(`${server.url}/api/review-events/watch`, {
      ...target(),
      includePending: true,
      timeoutSeconds: 0.1,
    });
    expect(watched.body).toMatchObject({ events: [], timedOut: true });

    // The log on disk records it.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(stateDir, "review-log.json"), "utf8"),
    );
    const record = Object.values(onDisk.documents as Record<string, Json>)[0];
    expect(record.handoffs[0]).toMatchObject({
      state: "dropped",
      droppedAt: expect.any(String),
    });

    expect(
      await postJson(`${server.url}/api/review-events/drop`, {
        handoffId: "nope",
      }),
    ).toMatchObject({ status: 404, body: { code: "HANDOFF_NOT_FOUND" } });
  });

  it("reopens on a session, an open request or a new window, and tells a closed tab that comes back", async () => {
    const server = await startServer(options());
    await register(server, "plan.md", { harness: "openclaw", label: "One" });
    const tab = await openTab(server, { ...target(), tabId: "tab_old" });
    await tab.next("hello");
    tab.socket.terminate();
    await postJson(`${server.url}/api/documents/close`, target());

    // The old tab reconnects (it was hidden): told to close, nothing reopens.
    const back = await openTab(server, { ...target(), tabId: "tab_old" });
    await back.next("hello");
    expect(await back.next("close")).toEqual({ type: "close" });
    expect((await documentFor(server)).closedAt).not.toBeNull();

    // A session registers: open again, with a session message to the tabs.
    const watching = await openTab(server, { ...target(), tabId: "tab_new" });
    await watching.next("hello");
    expect((await documentFor(server)).closedAt).toBeNull();
    await postJson(`${server.url}/api/documents/close`, target());
    await register(server, "plan.md", { harness: "openclaw", label: "Two" });
    // Close ended the session (null), the registration starts the next one.
    expect(await watching.next("session")).toEqual({
      type: "session",
      session: null,
    });
    expect(await watching.next("session")).toMatchObject({
      session: { label: "Two" },
    });
    expect((await documentFor(server)).closedAt).toBeNull();

    // An open request (the page's Reopen) opens it too.
    await postJson(`${server.url}/api/documents/close`, target());
    await postJson(`${server.url}/api/open-request`, {
      path: path.join(projectDir, "plan.md"),
      url: "http://localhost/?path=x",
    });
    expect((await documentFor(server)).closedAt).toBeNull();
  });

  it("reports the peer Roughdraft in /api/status", async () => {
    const server = await startServer(
      options({ peerUrl: "http://100.64.0.2:7373" }),
    );
    expect((await getJson(`${server.url}/api/status`)).body.peerUrl).toBe(
      "http://100.64.0.2:7373/",
    );
    const none = await startServer(options({ peerUrl: "not a url" }));
    expect((await getJson(`${none.url}/api/status`)).body.peerUrl).toBeNull();
  });
});

describe("the midnight sweep", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-sweep-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("takes documents closed before today's midnight off the list unless a Done waits", () => {
    let nowMs = new Date(2026, 9, 6, 18, 0).getTime();
    const log = new ReviewLog({ stateDir: dir, now: () => new Date(nowMs) });
    const registry = new DocumentRegistry({
      log,
      publicBaseUrl: "http://localhost:7373",
      now: () => nowMs,
    });
    const quiet = identityFor(path.join(dir, "quiet.md"));
    const waiting = identityFor(path.join(dir, "waiting.md"));
    for (const identity of [quiet, waiting]) {
      registry.setSession(identity, {
        harness: "openclaw",
        label: "Evening",
        link: null,
        sessionId: null,
        routeId: null,
      });
    }
    log.recordHandoff(waiting, {
      handoffId: "h1",
      version: "v",
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
      overallComment: null,
      wakeRouteId: null,
    });
    registry.close(quiet.key);
    registry.close(waiting.key);

    // Still today: both in Earlier today.
    let list = groupOpenDocuments(registry.list());
    expect(
      list.earlier.map((view) => path.basename(view.documentPath)),
    ).toEqual(expect.arrayContaining(["quiet.md", "waiting.md"]));

    // Past midnight.
    nowMs = localMidnight(nowMs) + 25 * 60 * 60 * 1000;
    registry.sweep();
    list = groupOpenDocuments(registry.list());
    expect(
      list.earlier.map((view) => path.basename(view.documentPath)),
    ).toEqual(["waiting.md"]);
    // Still in the log file as history.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "review-log.json"), "utf8"),
    );
    expect(onDisk.documents[quiet.key]).toMatchObject({
      sweptAt: expect.any(String),
      lastSession: { label: "Evening" },
    });
  });
});

describe("sessionStateResolver", () => {
  it("answers unknown when the machine has no Claude Code session records", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-none-"));
    try {
      const stateOf = sessionStateResolver({ configDir: empty })();
      expect(
        stateOf({
          harness: "claude-code",
          label: "x",
          link: null,
          sessionId: "abc",
          routeId: null,
          registeredAt: "",
        }),
      ).toBe("unknown");
      expect(stateOf(null)).toBe("unknown");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
