import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import { callTool } from "./mcp";

// biome-ignore lint/suspicious/noExplicitAny: tool results are checked with matchers
type Json = any;

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
  });

  const servers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((close) => close()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A real server on loopback, recorded in the state file the tools read. */
  async function startServer(
    options: { apiToken?: string } = {},
  ): Promise<{ url: string; close: () => Promise<void> }> {
    let app: ReturnType<typeof createApp>["app"] | null = null;
    const http: Server = createHttpServer((req, res) => app?.(req, res));
    await new Promise<void>((resolve) =>
      http.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = http.address() as AddressInfo;
    app = createApp({
      port,
      homeDir: tempDir,
      staticDirPath: tempDir,
      stateDir: path.dirname(stateFile),
      deliveryWaitMs: 200,
      ...options,
    }).app;
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${port}`,
      }),
    );
    let closed = false;
    const close = () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        http.closeAllConnections();
        http.close(() => resolve());
      });
    servers.push(close);
    return { url: `http://127.0.0.1:${port}`, close };
  }

  async function postDone(
    url: string,
    body: Record<string, unknown> = {},
  ): Promise<Json> {
    const response = await fetch(`${url}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        ...body,
      }),
    });
    return response.json();
  }

  const env = () => ({
    ROUGHDRAFT_STATE_FILE: stateFile,
    // Nothing listens here, so the tools never reach a real Roughdraft.
    ROUGHDRAFT_PORT: "1",
  });

  it("returns an earlier Done at once with includePending and acknowledges it (T9.2)", async () => {
    const server = await startServer();
    const done = await postDone(server.url, {
      overallComment: "Please prioritize the CLI contract.",
    });

    const result = (await callTool(
      "roughdraft_watch_review_events",
      { documentPath, timeoutSeconds: 0 },
      env(),
      fetch,
    )) as Json;

    expect(result).toMatchObject({
      status: "completed",
      timedOut: false,
      nextSequence: 2,
      handoff: { handoffId: done.handoff.handoffId },
      events: [
        {
          documentPath,
          type: "review.completed",
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
    const after = (await callTool(
      "roughdraft_get_handoffs",
      { documentPath, includeAcked: true },
      env(),
      fetch,
    )) as Json;
    expect(after.handoffs).toMatchObject([
      { state: "acknowledged", ackedBy: "roughdraft-mcp" },
    ]);

    const again = (await callTool(
      "roughdraft_watch_review_events",
      { documentPath, timeoutSeconds: 0 },
      env(),
      fetch,
    )) as Json;
    expect(again).toMatchObject({ status: "timeout", timedOut: true });
  });

  it("waits for the next Done without a server-side limit when timeoutSeconds is omitted", async () => {
    const server = await startServer();
    const streamUrls: URL[] = [];
    const recording: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/review-events/stream") streamUrls.push(url);
      return fetch(input, init);
    };

    const watch = callTool(
      "roughdraft_watch_review_events",
      { documentPath, includePending: false, ack: false },
      env(),
      recording,
    ) as Promise<Json>;
    for (let attempt = 0; attempt < 100 && streamUrls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await postDone(server.url);
    const result = await watch;

    expect(streamUrls[0]?.searchParams.has("timeoutSeconds")).toBe(false);
    expect(streamUrls[0]?.searchParams.get("includePending")).toBe("0");
    expect(result).toMatchObject({
      status: "completed",
      events: [{ sequence: 1 }],
    });
    // ack: false leaves it for the next agent.
    const pending = (await callTool(
      "roughdraft_get_handoffs",
      { documentPath },
      env(),
      fetch,
    )) as Json;
    expect(pending.handoffs).toHaveLength(1);
  });

  it("reports a server that is not running instead of fetch failed", async () => {
    await expect(
      callTool(
        "roughdraft_watch_review_events",
        { documentPath, timeoutSeconds: 1 },
        env(),
        fetch,
      ),
    ).rejects.toThrow(/Roughdraft is not running/);
  });

  it("lists open documents from the registry, and from the log on disk when the server is down (T6.3)", async () => {
    const server = await startServer();
    await callTool(
      "roughdraft_register_session",
      {
        documentPath,
        harness: "claude-code",
        label: "planning chat",
        sessionId: "local_1",
      },
      env(),
      fetch,
    );
    await postDone(server.url);

    const live = (await callTool(
      "roughdraft_get_open_documents",
      {},
      env(),
      fetch,
    )) as Json;
    expect(live).toMatchObject({
      server: { running: true, instanceId: expect.stringMatching(/^srv_/) },
      documents: [
        {
          documentPath,
          pendingHandoffs: 1,
          session: { harness: "claude-code", label: "planning chat" },
          url: expect.stringContaining(encodeURIComponent(documentPath)),
        },
      ],
    });

    await server.close();
    const down = (await callTool(
      "roughdraft_get_open_documents",
      {},
      env(),
      fetch,
    )) as Json;
    expect(down).toMatchObject({
      server: { running: false },
      documents: [
        {
          documentPath,
          pendingHandoffs: 1,
          session: { label: "planning chat" },
        },
      ],
    });
    const handoffs = (await callTool(
      "roughdraft_get_handoffs",
      {},
      env(),
      fetch,
    )) as Json;
    expect(handoffs).toMatchObject({
      source: "disk",
      handoffs: [{ documentPath, state: "pending" }],
    });
  });

  it("acknowledges handoffs by id and reports unknown ones", async () => {
    const server = await startServer();
    const done = await postDone(server.url);

    const result = await callTool(
      "roughdraft_ack_handoff",
      { handoffIds: [done.handoff.handoffId, "nope"] },
      env(),
      fetch,
    );

    expect(result).toEqual({
      acked: [done.handoff.handoffId],
      unknown: ["nope"],
    });
    const pending = (await callTool(
      "roughdraft_get_handoffs",
      { documentPath },
      env(),
      fetch,
    )) as Json;
    expect(pending.handoffs).toEqual([]);
  });

  it("adds, tests, lists and removes a wake route", async () => {
    await startServer();
    const marker = path.join(tempDir, "woke.txt");

    const added = (await callTool(
      "roughdraft_wake_routes",
      {
        action: "add",
        harness: "codex",
        kind: "command",
        command: `printf '%s' "$ROUGHDRAFT_EVENT" > ${JSON.stringify(marker)}`,
      },
      env(),
      fetch,
    )) as Json;
    expect(added).toMatchObject({ ok: true, route: { harness: "codex" } });

    const tested = (await callTool(
      "roughdraft_wake_routes",
      { action: "test", harness: "codex" },
      env(),
      fetch,
    )) as Json;
    expect(tested).toMatchObject({ ok: true, sent: true, error: null });
    expect(fs.readFileSync(marker, "utf8")).toBe("test");

    const listed = (await callTool(
      "roughdraft_wake_routes",
      { action: "list" },
      env(),
      fetch,
    )) as Json;
    expect(listed.routes).toMatchObject([
      { harness: "codex", verifiedBy: "roughdraft-mcp" },
    ]);

    const removed = await callTool(
      "roughdraft_wake_routes",
      { action: "remove", harness: "codex" },
      env(),
      fetch,
    );
    expect(removed).toEqual({ ok: true, removed: true });
  });

  it("sends the token header when ROUGHDRAFT_TOKEN is set", async () => {
    const server = await startServer({ apiToken: "tok" });
    await fetch(`${server.url}/api/review-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
    });

    const result = (await callTool(
      "roughdraft_watch_review_events",
      { documentPath, timeoutSeconds: 0 },
      { ...env(), ROUGHDRAFT_TOKEN: "tok" },
      fetch,
    )) as Json;

    expect(result.status).toBe("completed");
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});
