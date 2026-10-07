import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

const servers: RunningServer[] = [];

async function startServer(options: AppOptions): Promise<RunningServer> {
  const { app } = createApp(options);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const running = {
    url: `http://127.0.0.1:${port}`,
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

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Condition not met in ${timeoutMs} ms: ${JSON.stringify(last)}`,
      );
    }
    await sleep(10);
    last = await read();
  }
  return last;
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked with matchers
type Json = any;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json() };
}

interface SseEvent {
  id: string | null;
  event: string;
  data: Json;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .slice(0, -1)
    .map((block) => {
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      return {
        id,
        event,
        data: data.length ? JSON.parse(data.join("\n")) : null,
      };
    })
    .filter((parsed) => parsed.data !== null);
}

async function openStream(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const body = response.body;
  if (!body) throw new Error("Expected a streaming body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let consumed = 0;
  let done = false;
  let pendingRead: Promise<void> | null = null;

  const readMore = (): Promise<void> => {
    pendingRead ??= reader
      .read()
      .then((chunk) => {
        if (chunk.done) done = true;
        else text += decoder.decode(chunk.value, { stream: true });
      })
      .catch(() => {
        done = true;
      })
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  };

  const waitFor = async (
    accept: (text: string) => boolean,
    timeoutMs = 2_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!accept(text)) {
      if (done) throw new Error(`Stream ended before condition: ${text}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Stream condition not met: ${text}`);
      await Promise.race([readMore(), sleep(remaining)]);
    }
    return text;
  };

  return {
    response,
    waitFor,
    async next(eventName: string, timeoutMs = 2_000): Promise<SseEvent> {
      let found: SseEvent | undefined;
      await waitFor(() => {
        const events = parseSse(text).slice(consumed);
        const index = events.findIndex((event) => event.event === eventName);
        if (index === -1) return false;
        consumed += index + 1;
        found = events[index];
        return true;
      }, timeoutMs);
      if (!found) throw new Error(`No ${eventName} event`);
      return found;
    },
    async ended(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (!done) {
        if (Date.now() > deadline) throw new Error("Stream did not end");
        await Promise.race([readMore(), sleep(50)]);
      }
    },
    close: () => controller.abort(),
  };
}

describe("review event routes on a real listener", () => {
  let projectDir: string;
  let homeDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-routes-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-state-"));
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const dir of [projectDir, homeDir, stateDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function baseOptions(overrides: Partial<AppOptions> = {}): AppOptions {
    return { homeDir, staticDirPath: projectDir, stateDir, ...overrides };
  }

  function statusUrl(server: RunningServer, relativePath = "draft.md"): string {
    const query = new URLSearchParams({
      projectPath: projectDir,
      path: relativePath,
    });
    return `${server.url}/api/review-events/status?${query}`;
  }

  describe("legacy long poll", () => {
    it("sends headers at once, newline keepalives, then a parseable JSON body", async () => {
      const server = await startServer(baseOptions({ keepaliveMs: 20 }));

      const response = await fetch(`${server.url}/api/review-events/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          path: "draft.md",
          batchWindowSeconds: 0,
        }),
      });
      expect(response.status).toBe(200);

      await sleep(80);
      const done = await postJson(`${server.url}/api/review-events`, {
        projectPath: projectDir,
        path: "draft.md",
      });
      const text = await response.text();

      expect(text.match(/^\n+/)?.[0].length ?? 0).toBeGreaterThanOrEqual(2);
      const body = JSON.parse(text);
      expect(body).toMatchObject({
        timedOut: false,
        events: [{ type: "review.completed", relativePath: "draft.md" }],
        instanceId: expect.stringMatching(/^srv_/),
        handoffs: [{ sequence: body.events[0].sequence }],
      });
      expect(done.body.delivered).toBe(true);
    });

    it("keeps a connected watcher counted after the request body is consumed", async () => {
      const server = await startServer(baseOptions());
      const controller = new AbortController();
      const watching = fetch(`${server.url}/api/review-events/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
        signal: controller.signal,
      }).catch(() => null);

      await sleep(500);
      const status = await getJson(statusUrl(server));

      expect(status.body).toMatchObject({ watching: true, watcherCount: 1 });
      controller.abort();
      await watching;
    });

    it("drops an aborted watcher at once so the next Done is saved for later", async () => {
      const server = await startServer(baseOptions());
      const controller = new AbortController();
      const watching = fetch(`${server.url}/api/review-events/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
        signal: controller.signal,
      }).catch(() => null);
      await waitFor(
        () => getJson(statusUrl(server)),
        (status) => status.body.watcherCount === 1,
      );

      controller.abort();
      await watching;
      const startedAt = Date.now();
      await waitFor(
        () => getJson(statusUrl(server)),
        (status) => status.body.watcherCount === 0,
        200,
      );
      expect(Date.now() - startedAt).toBeLessThan(200);

      const done = await postJson(`${server.url}/api/review-events`, {
        projectPath: projectDir,
        path: "draft.md",
      });
      expect(done.status).toBe(201);
      expect(done.body).toMatchObject({ delivered: false, pending: true });
    });
  });

  function query(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  function doneUrl(server: RunningServer): string {
    return `${server.url}/api/review-events`;
  }

  function streamUrl(
    server: RunningServer,
    params: Record<string, string> = {},
  ): string {
    return `${server.url}/api/review-events/stream?${query({
      projectPath: projectDir,
      path: "draft.md",
      ...params,
    })}`;
  }

  async function documentView(
    server: RunningServer,
    relativePath = "draft.md",
  ) {
    return getJson(
      `${server.url}/api/documents/one?${query({ projectPath: projectDir, path: relativePath })}`,
    );
  }

  describe("long poll extras", () => {
    it("returns an unacknowledged Done at once with includePending", async () => {
      const server = await startServer(baseOptions());
      const done = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });

      const watch = await postJson(`${server.url}/api/review-events/watch`, {
        projectPath: projectDir,
        path: "draft.md",
        includePending: true,
      });

      expect(watch.body).toMatchObject({
        timedOut: false,
        events: [{ sequence: done.body.handoff.sequence }],
        handoffs: [{ handoffId: done.body.handoff.handoffId }],
        instanceId: done.body.instanceId,
      });
      const view = await documentView(server);
      expect(view.body.handoffs[0].state).toBe("delivered");
    });

    it("treats a finished legacy long poll as the acknowledgement", async () => {
      const server = await startServer(baseOptions());
      await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });

      await postJson(`${server.url}/api/review-events/watch`, {
        projectPath: projectDir,
        path: "draft.md",
        fromNow: false,
        timeoutSeconds: 1,
      });

      const view = await documentView(server);
      expect(view.body.handoffs[0]).toMatchObject({
        state: "acknowledged",
        ackedBy: "long-poll",
      });
      expect(view.body.pendingHandoffs).toBe(0);
    });

    it("honors a timeout above the old five minute clamp without firing early", async () => {
      const server = await startServer(baseOptions());
      const controller = new AbortController();
      const watching = fetch(`${server.url}/api/review-events/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          path: "draft.md",
          timeoutSeconds: 2 ** 31,
        }),
        signal: controller.signal,
      });
      const response = await watching;

      await sleep(50);
      const status = await getJson(statusUrl(server));
      expect(response.status).toBe(200);
      expect(status.body.watcherCount).toBe(1);
      controller.abort();
    });
  });

  describe("agent event stream", () => {
    it("sends hello, keepalives and each Done with its sequence as the event id", async () => {
      const server = await startServer(baseOptions({ keepaliveMs: 20 }));
      const stream = await openStream(streamUrl(server, { client: "test" }));

      const hello = await stream.next("hello");
      expect(hello.data).toMatchObject({
        instanceId: expect.stringMatching(/^srv_/),
        logId: expect.any(String),
        latestSequence: 0,
        afterSequence: 0,
        pending: [],
      });
      await stream.waitFor((text) => text.includes(": keepalive"));
      expect((await getJson(statusUrl(server))).body.watcherCount).toBe(1);

      const done = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const event = await stream.next("review.completed");

      expect(done.body).toMatchObject({ delivered: true, pending: false });
      expect(event.id).toBe(String(done.body.handoff.sequence));
      expect(event.data).toMatchObject({
        type: "review.completed",
        sequence: done.body.handoff.sequence,
        handoff: { handoffId: done.body.handoff.handoffId, state: "delivered" },
      });
      expect(done.body.handoff.state).toBe("delivered");
      expect(done.body.handoff.deliveredTo).toHaveLength(1);

      stream.close();
      await waitFor(
        () => getJson(statusUrl(server)),
        (status) => status.body.watcherCount === 0,
      );
    });

    it("ends with a timeout event that carries the next sequence", async () => {
      const server = await startServer(baseOptions());
      const stream = await openStream(
        streamUrl(server, { timeoutSeconds: "0.05" }),
      );

      const timeout = await stream.next("timeout");
      await stream.ended();

      expect(timeout.data).toEqual({ nextSequence: 1 });
    });
  });

  describe("handoff log across restarts", () => {
    it("keeps a Done nobody received through a restart until it is acknowledged", async () => {
      const first = await startServer(baseOptions());
      const done = await postJson(doneUrl(first), {
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "Tighten the intro.",
      });
      expect(done.body).toMatchObject({
        delivered: false,
        pending: true,
        handoff: { state: "pending", overallComment: "Tighten the intro." },
        wake: { routeId: null, state: "none" },
      });
      await first.close();

      const second = await startServer(baseOptions());
      const listed = await getJson(`${second.url}/api/documents`);
      expect(listed.body.logId).toBe(
        JSON.parse(
          fs.readFileSync(path.join(stateDir, "review-log.json"), "utf8"),
        ).logId,
      );
      expect(listed.body.documents).toEqual([
        expect.objectContaining({
          relativePath: "draft.md",
          pendingHandoffs: 1,
          tabs: 0,
          watchers: 0,
          url: expect.stringContaining("/?path="),
          handoffs: [
            expect.objectContaining({ handoffId: done.body.handoff.handoffId }),
          ],
        }),
      ]);

      const ack = await postJson(`${second.url}/api/review-events/ack`, {
        handoffId: done.body.handoff.handoffId,
        by: "cli pending",
      });
      expect(ack.body).toMatchObject({
        ok: true,
        handoff: { state: "acknowledged", ackedBy: "cli pending" },
      });
      await second.close();

      const third = await startServer(baseOptions());
      const after = await documentView(third);
      expect(after.body.pendingHandoffs).toBe(0);
    });

    it("resumes from Last-Event-ID and continues sequences after a restart", async () => {
      const first = await startServer(baseOptions());
      const one = await postJson(doneUrl(first), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const two = await postJson(doneUrl(first), {
        projectPath: projectDir,
        path: "draft.md",
      });
      await first.close();

      const second = await startServer(baseOptions());
      const stream = await openStream(streamUrl(second), {
        "Last-Event-ID": String(one.body.handoff.sequence),
      });
      const hello = await stream.next("hello");
      const replayed = await stream.next("review.completed");
      const three = await postJson(doneUrl(second), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const live = await stream.next("review.completed");

      expect(hello.data.afterSequence).toBe(one.body.handoff.sequence);
      expect(
        hello.data.pending.map(
          (record: { sequence: number }) => record.sequence,
        ),
      ).toEqual([two.body.handoff.sequence]);
      expect(replayed.id).toBe(String(two.body.handoff.sequence));
      expect(three.body.handoff.sequence).toBe(two.body.handoff.sequence + 1);
      expect(live.id).toBe(String(three.body.handoff.sequence));
      stream.close();
    });

    it("replays the pending Done to a fresh stream that asks for it", async () => {
      const server = await startServer(baseOptions());
      const done = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });

      const stream = await openStream(
        streamUrl(server, { includePending: "true" }),
      );
      await stream.next("hello");
      const event = await stream.next("review.completed");

      expect(event.data.handoff.handoffId).toBe(done.body.handoff.handoffId);
      stream.close();
    });

    it("supersedes the older pending Done when a new one arrives", async () => {
      const server = await startServer(baseOptions());
      await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });

      const view = await documentView(server);

      expect(
        view.body.handoffs.map((record: { state: string }) => record.state),
      ).toEqual(["superseded", "pending"]);
      expect(view.body.pendingHandoffs).toBe(1);
    });

    it("returns the existing record for a repeated handoffId and writes the comment once", async () => {
      const server = await startServer(baseOptions());
      const body = {
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "Please address the risk section.",
        handoffId: "tab-handoff-1",
      };

      const first = await postJson(doneUrl(server), body);
      const retry = await postJson(doneUrl(server), body);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body.handoff).toEqual(first.body.handoff);
      const saved = fs.readFileSync(path.join(projectDir, "draft.md"), "utf8");
      expect(saved.match(/Please address the risk section\./g)).toHaveLength(1);
    });

    it("reports a corrupt log in the status warnings", async () => {
      fs.writeFileSync(path.join(stateDir, "review-log.json"), "nope");
      const server = await startServer(baseOptions());

      const status = await getJson(`${server.url}/api/status`);

      expect(status.body.stateDir).toBe(stateDir);
      expect(status.body.warnings).toEqual([
        expect.stringContaining("review-log.json was unreadable"),
      ]);
    });
  });

  describe("document registry", () => {
    let linkDir: string;

    beforeEach(() => {
      linkDir = `${projectDir}-link`;
      fs.symlinkSync(projectDir, linkDir);
    });

    afterEach(() => {
      fs.rmSync(linkDir, { force: true });
    });

    it("joins two spellings of one file so a Done reaches the other spelling's watcher", async () => {
      const server = await startServer(baseOptions());
      const watching = postJson(`${server.url}/api/review-events/watch`, {
        projectPath: linkDir,
        path: "draft.md",
        batchWindowSeconds: 0,
      });
      await waitFor(
        () => getJson(statusUrl(server)),
        (status) => status.body.watcherCount === 1,
      );

      const done = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const watched = await watching;
      const listed = await getJson(`${server.url}/api/documents`);

      expect(done.body.delivered).toBe(true);
      expect(watched.body.events).toHaveLength(1);
      expect(listed.body.documents).toHaveLength(1);
    });

    it("routes an open request across spellings and waits for the tab to acknowledge it", async () => {
      const server = await startServer(baseOptions());
      const tab = await openStream(
        `${server.url}/api/open-requests?${query({ path: path.join(linkDir, "draft.md"), tabId: "tab-1" })}`,
      );
      await tab.next("connected");

      const opening = postJson(`${server.url}/api/open-request`, {
        path: path.join(projectDir, "draft.md"),
        url: "http://localhost:7373/?path=draft",
      });
      const request = await tab.next("open-request");
      await postJson(`${server.url}/api/open-request/ack`, {
        requestId: request.data.requestId,
      });
      const opened = await opening;

      expect(opened.body).toEqual({
        delivered: true,
        acknowledged: true,
        tabs: 1,
      });
      const view = await documentView(server);
      expect(view.body).toMatchObject({
        tabs: 1,
        lastOpenRequestAt: expect.any(String),
      });
      tab.close();
    });

    it("reports an unacknowledged open request after the wait", async () => {
      const server = await startServer(baseOptions({ openRequestAckMs: 50 }));
      const tab = await openStream(
        `${server.url}/api/open-requests?${query({ path: path.join(projectDir, "draft.md") })}`,
      );
      await tab.next("connected");

      const opened = await postJson(`${server.url}/api/open-request`, {
        path: path.join(projectDir, "draft.md"),
        url: "http://localhost:7373/?path=draft",
      });

      expect(opened.body).toEqual({
        delivered: true,
        acknowledged: false,
        tabs: 1,
      });
      tab.close();
    });

    it("reports available false when the file watcher cannot read the file", async () => {
      const filePath = path.join(projectDir, "draft.md");
      const server = await startServer(baseOptions());
      const events = await openStream(
        `${server.url}/api/markdown-file/events?${query({ projectPath: projectDir, path: "draft.md" })}`,
      );
      await events.waitFor((text) => text.includes("retry:"));

      fs.writeFileSync(filePath, "# Draft, changed\n");
      fs.chmodSync(filePath, 0o000);
      try {
        const change = await events.next("change", 3_000);
        expect(change.data).toMatchObject({
          exists: true,
          version: null,
          available: false,
        });
      } finally {
        fs.chmodSync(filePath, 0o644);
        events.close();
      }
    });

    it("registers a session and reports it in the document status", async () => {
      const server = await startServer(baseOptions());

      const registered = await postJson(`${server.url}/api/documents/session`, {
        projectPath: projectDir,
        path: "draft.md",
        harness: "claude-code",
        label: "Plan review",
        sessionId: "s-1",
      });
      const status = await getJson(statusUrl(server));

      expect(registered.body).toMatchObject({
        ok: true,
        session: {
          harness: "claude-code",
          label: "Plan review",
          link: null,
          sessionId: "s-1",
          routeId: null,
        },
      });
      expect(status.body.session).toEqual(registered.body.session);
      expect(status.body).toMatchObject({ tabs: 0, handoff: null });
    });
  });

  describe("wake routes", () => {
    async function putRoute(
      server: RunningServer,
      harness: string,
      body: unknown,
    ) {
      const response = await fetch(`${server.url}/api/wake-routes/${harness}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }

    async function registerSession(server: RunningServer, harness: string) {
      return postJson(`${server.url}/api/documents/session`, {
        projectPath: projectDir,
        path: "draft.md",
        harness,
        label: "Plan review",
        sessionId: "s-1",
      });
    }

    async function settledWake(server: RunningServer) {
      const view = await waitFor(
        () => documentView(server),
        (result) => result.body.handoffs.at(-1)?.wake.state !== "none",
        5_000,
      );
      return view.body.handoffs.at(-1).wake;
    }

    it("fires a command route after a Done and records that it was sent", async () => {
      const envFile = path.join(stateDir, "wake-env.txt");
      const server = await startServer(baseOptions());
      await putRoute(server, "claude-code", {
        kind: "command",
        command: `env | grep ^ROUGHDRAFT_ > "${envFile}"`,
      });
      const session = await registerSession(server, "claude-code");
      expect(session.body.session.routeId).toBe("claude-code");

      const done = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      expect(done.body.wake).toMatchObject({
        routeId: "claude-code",
        state: "none",
      });

      expect(await settledWake(server)).toMatchObject({
        routeId: "claude-code",
        state: "sent",
        error: null,
      });
      const env = fs.readFileSync(envFile, "utf8");
      expect(env).toContain("ROUGHDRAFT_EVENT=done");
      expect(env).toContain("ROUGHDRAFT_MESSAGE=I'm done reviewing draft.md.");
      expect(env).toContain(
        `ROUGHDRAFT_HANDOFF_ID=${done.body.handoff.handoffId}`,
      );
      expect(env).toContain("ROUGHDRAFT_SESSION_LABEL=Plan review");
    });

    it("fires a url route after a Done", async () => {
      const bodies: unknown[] = [];
      const hook = createHttpServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200).end("ok");
        });
      });
      await new Promise<void>((resolve) =>
        hook.listen(0, "127.0.0.1", resolve),
      );
      const hookPort = (hook.address() as AddressInfo).port;
      try {
        const server = await startServer(baseOptions());
        await putRoute(server, "openclaw", {
          kind: "url",
          url: `http://127.0.0.1:${hookPort}/wake`,
        });
        await registerSession(server, "openclaw");

        await postJson(doneUrl(server), {
          projectPath: projectDir,
          path: "draft.md",
        });

        expect(await settledWake(server)).toMatchObject({ state: "sent" });
        expect(bodies).toEqual([
          expect.objectContaining({
            type: "roughdraft.done",
            documentPath: path.join(projectDir, "draft.md"),
            session: {
              harness: "openclaw",
              label: "Plan review",
              sessionId: "s-1",
            },
          }),
        ]);
      } finally {
        await new Promise<void>((resolve) => hook.close(() => resolve()));
      }
    });

    it("records a failing command and an unreachable url on the handoff", async () => {
      const server = await startServer(baseOptions());
      await putRoute(server, "broken", { kind: "command", command: "exit 7" });
      await registerSession(server, "broken");
      await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      expect(await settledWake(server)).toMatchObject({
        state: "failed",
        error: "Command exited with 7",
      });

      await putRoute(server, "broken", {
        kind: "url",
        url: "http://127.0.0.1:9/",
      });
      await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const wake = await settledWake(server);
      expect(wake.state).toBe("failed");
      expect(wake.error).toMatch(/fetch failed/);
    });

    it("tests a route, records verifiedAt on success and the error on failure", async () => {
      const server = await startServer(baseOptions());
      await putRoute(server, "ok", {
        kind: "command",
        command: "true",
        label: "Mac",
      });
      await putRoute(server, "bad", { kind: "command", command: "exit 1" });

      const passed = await postJson(`${server.url}/api/wake-routes/ok/test`, {
        by: "agent",
      });
      const failed = await postJson(
        `${server.url}/api/wake-routes/bad/test`,
        {},
      );
      const missing = await postJson(
        `${server.url}/api/wake-routes/none/test`,
        {},
      );
      const routes = await getJson(`${server.url}/api/wake-routes`);

      expect(passed.body).toMatchObject({ ok: true, sent: true, error: null });
      expect(passed.body.durationMs).toEqual(expect.any(Number));
      expect(failed.body).toMatchObject({
        ok: false,
        sent: false,
        error: "Command exited with 1",
      });
      expect(missing.status).toBe(404);
      expect(routes.body.routes).toEqual([
        expect.objectContaining({
          harness: "bad",
          verifiedAt: null,
          lastError: "Command exited with 1",
        }),
        expect.objectContaining({
          harness: "ok",
          label: "Mac",
          verifiedAt: expect.any(String),
          verifiedBy: "agent",
        }),
      ]);
      expect(fs.existsSync(path.join(stateDir, "wake-routes.json"))).toBe(true);
    });

    it("refuses wake route changes from another origin", async () => {
      const server = await startServer(baseOptions());

      const response = await fetch(`${server.url}/api/wake-routes/evil`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({ kind: "command", command: "true" }),
      });
      const removed = await fetch(`${server.url}/api/wake-routes/evil`, {
        method: "DELETE",
      });

      expect(response.status).toBe(403);
      expect(await removed.json()).toEqual({ ok: true, removed: false });
    });
  });

  describe("token gate", () => {
    it("requires the bearer token on every /api route when one is configured", async () => {
      const server = await startServer(baseOptions({ apiToken: "s3cret" }));
      const auth = { Authorization: "Bearer s3cret" };

      const denied = await getJson(`${server.url}/api/documents`);
      const allowed = await getJson(`${server.url}/api/documents`, auth);
      const deniedDone = await postJson(doneUrl(server), {
        projectPath: projectDir,
        path: "draft.md",
      });
      const deniedQueryPost = await postJson(
        `${doneUrl(server)}?token=s3cret`,
        {
          projectPath: projectDir,
          path: "draft.md",
        },
      );
      const status = await getJson(`${server.url}/api/status`, auth);

      expect(denied.status).toBe(401);
      expect(denied.body.code).toBe("UNAUTHORIZED");
      expect(allowed.status).toBe(200);
      expect(deniedDone.status).toBe(401);
      expect(deniedQueryPost.status).toBe(401);
      expect(status.body.capabilities.tokenRequired).toBe(true);
    });

    it("accepts ?token= on a GET event stream", async () => {
      const server = await startServer(baseOptions({ apiToken: "s3cret" }));

      const stream = await openStream(streamUrl(server, { token: "s3cret" }));
      await stream.next("hello");

      expect(stream.response.status).toBe(200);
      stream.close();
    });

    it("requires nothing when no token is configured", async () => {
      const server = await startServer(baseOptions());

      expect((await getJson(`${server.url}/api/documents`)).status).toBe(200);
    });
  });
});
