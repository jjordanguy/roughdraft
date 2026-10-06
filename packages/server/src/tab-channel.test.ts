import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "./index";

// The tab channel and the markdown-file routes on a real listener (port 0),
// driven with the `ws` client the way a browser tab would.

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;
// biome-ignore lint/suspicious/noExplicitAny: messages are checked with matchers
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

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

interface TabClient {
  socket: WebSocket;
  messages: Json[];
  next: (type: string, timeoutMs?: number) => Promise<Json>;
  send: (message: Json) => void;
  closed: Promise<void>;
}

async function openTab(
  server: RunningServer,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<TabClient> {
  const socket = new WebSocket(`${server.wsUrl}/api/tab?${query(params)}`, {
    headers,
  });
  sockets.push(socket);
  const messages: Json[] = [];
  let consumed = 0;
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
  });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    messages,
    closed,
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

async function sendJson(
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method,
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

describe("tab channel and markdown-file routes on a real listener", () => {
  let projectDir: string;
  let homeDir: string;
  let stateDir: string;
  let filePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-tab-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-state-"));
    filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(filePath, "# Draft\n");
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const dir of [projectDir, homeDir, stateDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function baseOptions(overrides: Partial<AppOptions> = {}): AppOptions {
    return {
      homeDir,
      staticDirPath: projectDir,
      stateDir,
      watchPollMs: 50,
      ...overrides,
    };
  }

  function tabParams(tabId: string, file = "draft.md") {
    return { projectPath: projectDir, path: file, tabId };
  }

  const fileQuery = (file = "draft.md") =>
    query({ projectPath: projectDir, path: file });

  describe("WebSocket channel", () => {
    it("sends hello first with the document state, the watchers, the session and the latest handoff", async () => {
      const server = await startServer(baseOptions());
      const page = await getJson(
        `${server.url}/api/markdown-file?${fileQuery()}`,
      );

      const tab = await openTab(server, tabParams("tab_a"));
      const hello = await tab.next("hello");

      expect(tab.messages[0].type).toBe("hello");
      expect(hello).toMatchObject({
        type: "hello",
        instanceId: page.body.instanceId,
        tabId: "tab_a",
        document: {
          seq: page.body.seq,
          exists: true,
          available: true,
          reason: null,
          contentHash: page.body.contentHash,
          version: page.body.version,
        },
        tabs: 1,
        watchers: 0,
        session: null,
        handoff: null,
        latestSequence: 0,
      });
    });

    it("sends hello for a missing file and then the file when it appears", async () => {
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a", "later.md"));

      const hello = await tab.next("hello");
      expect(hello.document).toMatchObject({ exists: false, seq: 1 });

      fs.writeFileSync(path.join(projectDir, "later.md"), "# Later\n");
      const change = await tab.next("change");
      expect(change).toMatchObject({
        exists: true,
        contentHash: sha256("# Later\n"),
        seq: 2,
      });
    });

    it("sends change for an outside write, to every tab on the file", async () => {
      const server = await startServer(baseOptions());
      const first = await openTab(server, tabParams("tab_a"));
      const second = await openTab(server, tabParams("tab_b"));
      const hello = await first.next("hello");
      await second.next("hello");

      fs.writeFileSync(filePath, "# Draft\n\nfrom an agent\n");

      const [a, b] = await Promise.all([
        first.next("change"),
        second.next("change"),
      ]);
      for (const change of [a, b]) {
        expect(change).toMatchObject({
          type: "change",
          seq: hello.document.seq + 1,
          exists: true,
          available: true,
          reason: null,
          contentHash: sha256("# Draft\n\nfrom an agent\n"),
          origin: "outside",
        });
        expect(change.version).toMatch(/^\d+(\.\d+)?:\d+:[0-9a-f]{64}$/);
        expect(change.tabId).toBeUndefined();
      }
    });

    it("tags the change from a tab's own PUT with origin tab and its tabId", async () => {
      const server = await startServer(baseOptions());
      const writer = await openTab(server, tabParams("tab_writer"));
      const other = await openTab(server, tabParams("tab_other"));
      const hello = await writer.next("hello");
      await other.next("hello");

      const saved = await sendJson(
        "PUT",
        `${server.url}/api/markdown-file?${fileQuery()}`,
        {
          content: "# Draft\n\nsaved by a tab\n",
          expectedContentHash: hello.document.contentHash,
          tabId: "tab_writer",
        },
      );
      expect(saved.status).toBe(200);

      for (const tab of [writer, other]) {
        const change = await tab.next("change");
        expect(change).toMatchObject({
          origin: "tab",
          tabId: "tab_writer",
          seq: saved.body.seq,
          contentHash: saved.body.contentHash,
          version: saved.body.version,
        });
      }
    });

    it("sends watchers when an agent starts and stops listening", async () => {
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a"));
      await tab.next("hello");

      const controller = new AbortController();
      const stream = await fetch(
        `${server.url}/api/review-events/stream?${fileQuery()}`,
        { signal: controller.signal },
      );
      expect(stream.status).toBe(200);
      expect(await tab.next("watchers")).toEqual({
        type: "watchers",
        count: 1,
      });

      controller.abort();
      expect(await tab.next("watchers")).toEqual({
        type: "watchers",
        count: 0,
      });
    });

    it("sends handoff on record and on ack", async () => {
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a"));
      await tab.next("hello");

      const done = await sendJson("POST", `${server.url}/api/review-events`, {
        projectPath: projectDir,
        path: "draft.md",
        handoffId: "h-1",
      });
      expect(done.status).toBe(201);
      const recorded = await tab.next("handoff");
      expect(recorded.handoff).toMatchObject({
        handoffId: "h-1",
        sequence: 1,
        state: "pending",
      });

      await sendJson("POST", `${server.url}/api/review-events/ack`, {
        handoffId: "h-1",
        by: "test",
      });
      const acked = await tab.next("handoff");
      expect(acked.handoff).toMatchObject({
        handoffId: "h-1",
        state: "acknowledged",
        ackedBy: "test",
      });
    });

    it("delivers an open request to a channel tab and reads its ack", async () => {
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a"));
      await tab.next("hello");

      const opened = sendJson("POST", `${server.url}/api/open-request`, {
        path: filePath,
        url: "http://localhost:7373/?path=draft",
      });
      const request = await tab.next("open-request");
      expect(request).toMatchObject({
        type: "open-request",
        url: "http://localhost:7373/?path=draft",
        requestId: expect.any(String),
      });
      tab.send({ type: "open-request-ack", requestId: request.requestId });

      expect((await opened).body).toEqual({
        delivered: true,
        acknowledged: true,
        tabs: 1,
      });
    });

    it("sends ping with the document seq", async () => {
      const server = await startServer(baseOptions({ tabPingMs: 50 }));
      const tab = await openTab(server, tabParams("tab_a"));
      const hello = await tab.next("hello");

      const ping = await tab.next("ping");
      expect(ping).toEqual({ type: "ping", seq: hello.document.seq });
      tab.send({ type: "pong", seq: ping.seq });
    });

    it("stores presence on the registry and exposes tabs and tabsDirty", async () => {
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a"));
      const hello = await tab.next("hello");
      await openTab(server, tabParams("tab_b"));

      tab.send({
        type: "presence",
        visible: true,
        dirty: true,
        conflict: false,
        baseHash: hello.document.contentHash,
      });

      const status = await waitFor(
        () => getJson(`${server.url}/api/review-events/status?${fileQuery()}`),
        (value) => value.body.tabsDirty === 1,
      );
      expect(status.body).toMatchObject({ tabs: 2, tabsDirty: 1 });
      const documents = await getJson(`${server.url}/api/documents`);
      expect(documents.body.documents[0]).toMatchObject({
        tabs: 2,
        tabsDirty: 1,
      });
      const state = await getJson(
        `${server.url}/api/markdown-file/state?${fileQuery()}`,
      );
      expect(state.body).toMatchObject({ tabs: 2, tabsDirty: 1 });

      tab.send({
        type: "presence",
        visible: false,
        dirty: false,
        conflict: false,
        baseHash: hello.document.contentHash,
      });
      await waitFor(
        () => getJson(`${server.url}/api/review-events/status?${fileQuery()}`),
        (value) => value.body.tabsDirty === 0,
      );
    });

    it("drops a tab 30 s after its socket closes", async () => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const server = await startServer(baseOptions());
      const tab = await openTab(server, tabParams("tab_a"));
      await tab.next("hello");
      const statusUrl = `${server.url}/api/review-events/status?${fileQuery()}`;
      expect((await getJson(statusUrl)).body.tabs).toBe(1);

      tab.socket.close();
      await tab.closed;
      await sleep(50);

      vi.advanceTimersByTime(29_000);
      expect((await getJson(statusUrl)).body.tabs).toBe(1);
      vi.advanceTimersByTime(1_500);
      expect((await getJson(statusUrl)).body.tabs).toBe(0);
    });

    it("keeps the tab when it reconnects inside the grace period", async () => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const server = await startServer(baseOptions());
      const first = await openTab(server, tabParams("tab_a"));
      await first.next("hello");
      first.socket.close();
      await first.closed;
      await sleep(50);

      vi.advanceTimersByTime(10_000);
      const second = await openTab(server, tabParams("tab_a"));
      await second.next("hello");
      vi.advanceTimersByTime(25_000);

      const status = await getJson(
        `${server.url}/api/review-events/status?${fileQuery()}`,
      );
      expect(status.body.tabs).toBe(1);
    });

    it("rejects a path outside the project and an origin from another site", async () => {
      const server = await startServer(baseOptions());

      await expect(
        openTab(server, { projectPath: projectDir, path: "../x.md" }),
      ).rejects.toThrow(/404/);
      await expect(
        openTab(server, tabParams("tab_a"), {
          Origin: "https://evil.example",
        }),
      ).rejects.toThrow(/403/);
      const local = await openTab(server, tabParams("tab_b"), {
        Origin: "http://localhost:5173",
      });
      await local.next("hello");
    });

    it("requires the token when the server has one", async () => {
      const server = await startServer(baseOptions({ apiToken: "secret" }));

      await expect(openTab(server, tabParams("tab_a"))).rejects.toThrow(/401/);
      const tab = await openTab(server, {
        ...tabParams("tab_a"),
        token: "secret",
      });
      await tab.next("hello");
    });
  });

  describe("markdown-file routes", () => {
    it("GET adds contentHash, seq and instanceId", async () => {
      const server = await startServer(baseOptions());

      const page = await getJson(
        `${server.url}/api/markdown-file?${fileQuery()}`,
      );

      expect(page.body).toMatchObject({
        id: "draft",
        title: "Draft",
        content: "# Draft\n",
        contentHash: sha256("# Draft\n"),
        seq: 1,
        instanceId: expect.stringMatching(/^srv_/),
      });
      expect(page.body.version).toBe(
        `${fs.statSync(filePath).mtimeMs}:8:${sha256("# Draft\n")}`,
      );
    });

    it("state answers the cheap state, including a missing file", async () => {
      const server = await startServer(baseOptions());

      const state = await getJson(
        `${server.url}/api/markdown-file/state?${fileQuery()}`,
      );
      expect(state.status).toBe(200);
      expect(state.body).toEqual({
        exists: true,
        available: true,
        reason: null,
        version: expect.any(String),
        contentHash: sha256("# Draft\n"),
        seq: 1,
        instanceId: expect.stringMatching(/^srv_/),
        tabs: 0,
        tabsDirty: 0,
      });

      const missing = await getJson(
        `${server.url}/api/markdown-file/state?${fileQuery("gone.md")}`,
      );
      expect(missing.status).toBe(200);
      expect(missing.body).toMatchObject({
        exists: false,
        contentHash: null,
        version: null,
      });
    });

    it("state reports a change made with no watcher running", async () => {
      const server = await startServer(baseOptions());
      const before = await getJson(
        `${server.url}/api/markdown-file/state?${fileQuery()}`,
      );

      fs.writeFileSync(filePath, "# Changed\n");
      const after = await getJson(
        `${server.url}/api/markdown-file/state?${fileQuery()}`,
      );

      expect(after.body.seq).toBe(before.body.seq + 1);
      expect(after.body.contentHash).toBe(sha256("# Changed\n"));
    });
  });

  describe("legacy SSE route", () => {
    async function readEvents(
      url: string,
      until: (events: Json[]) => boolean,
      timeoutMs = 3_000,
    ) {
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let text = "";
      const events: Json[] = [];
      const deadline = Date.now() + timeoutMs;
      const parse = () => {
        events.length = 0;
        for (const block of text.split("\n\n").slice(0, -1)) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          const id = /^id: (.+)$/m.exec(block)?.[1] ?? null;
          if (event && data) events.push({ event, id, data: JSON.parse(data) });
        }
      };
      return {
        status: response.status,
        events,
        async wait(accept = until) {
          while (!accept(events)) {
            if (Date.now() > deadline) {
              throw new Error(`Timed out: ${text}`);
            }
            const chunk = await Promise.race([
              reader.read(),
              sleep(100).then(() => null),
            ]);
            if (chunk && !chunk.done) {
              text += decoder.decode(chunk.value, { stream: true });
              parse();
            }
          }
          return events;
        },
        close: () => controller.abort(),
        ...{ start: Date.now() },
      };
    }

    it("sends the current state on connect", async () => {
      const server = await startServer(baseOptions());
      const page = await getJson(
        `${server.url}/api/markdown-file?${fileQuery()}`,
      );

      const stream = await readEvents(
        `${server.url}/api/markdown-file/events?${fileQuery()}`,
        (events) => events.length > 0,
      );
      const [first] = await stream.wait();
      stream.close();

      expect(first).toMatchObject({
        event: "change",
        id: String(page.body.seq),
        data: {
          path: "draft.md",
          exists: true,
          available: true,
          version: page.body.version,
          contentHash: page.body.contentHash,
          seq: page.body.seq,
        },
      });
    });

    it("answers 200 with exists false for a missing file and reports it later", async () => {
      const server = await startServer(baseOptions());

      const stream = await readEvents(
        `${server.url}/api/markdown-file/events?${fileQuery("later.md")}`,
        (events) => events.length > 0,
      );
      expect(stream.status).toBe(200);
      const [first] = await stream.wait();
      expect(first.data).toMatchObject({ exists: false, version: null });

      fs.writeFileSync(path.join(projectDir, "later.md"), "# Later\n");
      const events = await stream.wait((all) => all.length > 1);
      stream.close();
      expect(events[1]).toMatchObject({
        event: "change",
        data: { exists: true, contentHash: sha256("# Later\n") },
      });
    });

    it("sends a named ping", async () => {
      const server = await startServer(baseOptions({ keepaliveMs: 50 }));

      const stream = await readEvents(
        `${server.url}/api/markdown-file/events?${fileQuery()}`,
        (events) => events.some((event) => event.event === "ping"),
      );
      const events = await stream.wait();
      stream.close();

      expect(events.find((event) => event.event === "ping")?.data).toEqual({
        seq: 1,
      });
    });
  });
});
