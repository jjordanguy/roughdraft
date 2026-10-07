import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
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

  describe("review feedback tools", () => {
    // One canonical-format file with every case the pending filter decides:
    // a resolved root with a user reply under it, an inline thread with an
    // agent reply and a user follow-up, a code block comment, two
    // document-level comments with agent replies (one `aN` id, one `cN` id
    // written by AI), an agent's own document-level note, and a suggestion.
    const reviewed = [
      "# Plan",
      "",
      "Keep {==this claim==}{#c1} as written.",
      "",
      "The {==retry loop==}{#c3} needs a cap, and {++a timeout++}{#s1} too.",
      "",
      "```ts {#c5}",
      "const a = 1;",
      "const b = 2;",
      "```",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Needs a source."',
      "    by: user",
      '    at: "2026-10-05T09:00:00.000Z"',
      "    status: resolved",
      '    resolved: "Added the citation."',
      "  c2:",
      '    body: "Thanks, that works."',
      "    by: user",
      '    at: "2026-10-05T09:10:00.000Z"',
      "    re: c1",
      "  c3:",
      '    body: "Cap it at five."',
      "    by: user",
      '    at: "2026-10-05T09:01:00.000Z"',
      "  a1:",
      '    body: "Capped at five."',
      "    by: AI",
      '    at: "2026-10-05T10:00:00.000Z"',
      "    re: c3",
      "  c4:",
      '    body: "Why five?"',
      "    by: user",
      '    at: "2026-10-05T10:05:00.000Z"',
      "    re: a1",
      "  c5:",
      '    body: "Use let here."',
      "    by: user",
      '    at: "2026-10-05T09:02:00.000Z"',
      "    lines: [2, 2]",
      '    quote: "const b = 2;"',
      "  c6:",
      '    body: "Overall fine.<br>Ship it after the cap."',
      "    by: user",
      '    at: "2026-10-05T09:03:00.000Z"',
      "    scope: document",
      "  a2:",
      '    body: "Will do."',
      "    by: Claude",
      '    at: "2026-10-05T10:01:00.000Z"',
      "    re: c6",
      "  c7:",
      '    body: "One more: add a summary."',
      "    by: user",
      '    at: "2026-10-05T09:04:00.000Z"',
      "    scope: document",
      "  c8:",
      '    body: "Added a summary."',
      "    by: AI",
      '    at: "2026-10-05T10:02:00.000Z"',
      "    re: c7",
      "  a3:",
      '    body: "Round 1 done: three comments answered."',
      "    by: AI",
      '    at: "2026-10-05T10:03:00.000Z"',
      "    scope: document",
      "suggestions:",
      "  s1:",
      "    by: user",
      '    at: "2026-10-05T09:05:00.000Z"',
      "",
    ].join("\n");

    beforeEach(() => {
      fs.writeFileSync(documentPath, reviewed);
    });

    it("lists document-level roots first, then the rest in document order", async () => {
      const result = (await callTool(
        "roughdraft_get_pending_feedback",
        { documentPath },
        env(),
      )) as Json;

      expect(result.items.map((item: Json) => item.id)).toEqual([
        "c6",
        "c7",
        "c3",
        "s1",
        "c5",
        "c4",
      ]);
    });

    it("leaves out resolved items, replies under resolved roots, agent-written replies and agent notes", async () => {
      const result = (await callTool(
        "roughdraft_get_pending_feedback",
        { documentPath },
        env(),
      )) as Json;
      const ids = result.items.map((item: Json) => item.id);

      expect(ids).not.toContain("c1");
      expect(ids).not.toContain("c2");
      expect(ids).not.toContain("a1");
      expect(ids).not.toContain("a2");
      expect(ids).not.toContain("c8");
      expect(ids).not.toContain("a3");
      // A user's reply to an agent reply is still feedback.
      expect(ids).toContain("c4");
    });

    it("returns the new item fields and a summary of what is pending", async () => {
      const result = (await callTool(
        "roughdraft_get_pending_feedback",
        { documentPath },
        env(),
      )) as Json;
      const byId = new Map(
        result.items.map((item: Json) => [item.id, item] as const),
      );

      expect(byId.get("c6")).toMatchObject({
        kind: "comment",
        scope: "document",
        text: "Overall fine.\nShip it after the cap.",
        anchors: [],
        lines: null,
        quote: null,
        continues: null,
        resolved: null,
        lostAnchor: false,
      });
      expect(byId.get("c5")).toMatchObject({
        kind: "comment",
        scope: "code",
        lines: [2, 2],
        quote: "const b = 2;",
        anchors: [expect.objectContaining({ kind: "code" })],
      });
      expect(byId.get("c3")).toMatchObject({
        scope: "inline",
        anchorText: "retry loop",
        anchors: [expect.objectContaining({ text: "retry loop" })],
      });
      expect(byId.get("c4")).toMatchObject({
        kind: "reply",
        parentId: "a1",
        scope: "inline",
      });
      expect(byId.get("s1")).toMatchObject({
        kind: "suggestion",
        scope: "inline",
        continues: null,
      });
      expect(result.summary).toEqual({
        items: 6,
        comments: 5,
        roots: 2,
        documentComments: 2,
        replies: 1,
        suggestions: 1,
        endmatter: "recognized",
        leftOut: {
          resolved: 1,
          repliesUnderResolvedRoots: 1,
          agentReplies: 3,
          agentNotes: 1,
        },
      });
      // The whole file: c1, c3, c5, c6, c7, a3; replies c2, a1, c4, a2, c8.
      expect(result.fileSummary).toMatchObject({
        comments: 6,
        replies: 5,
        suggestions: 1,
      });
    });

    it("returns the review index unchanged from rfm, agent replies and resolved threads included", async () => {
      const result = (await callTool(
        "roughdraft_get_review_index",
        { documentPath },
        env(),
      )) as Json;

      expect(result).toEqual({
        documentPath,
        ...extractRoughdraftReviewIndex(reviewed),
      });
      expect(result.items.map((item: Json) => item.id)).toEqual(
        expect.arrayContaining(["c1", "c2", "a1", "a2", "c8", "a3"]),
      );
      expect(result.items.find((item: Json) => item.id === "c5")).toMatchObject(
        { scope: "code", lines: [2, 2], quote: "const b = 2;" },
      );
    });
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
        // Port 9 (discard) has no listener: the write path never probes a real server.
        { ROUGHDRAFT_STATE_FILE: stateFile, ROUGHDRAFT_PORT: "9" },
      ),
    ).rejects.toThrow(/contains CriticMarkup/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});
