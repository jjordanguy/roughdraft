import crypto from "node:crypto";
import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import { callToolResult, startMcpServer } from "./mcp";

// The MCP review tools: one-thread transactions with expectedVersion, the
// round tools, validation, and refusals as `isError` results.

// biome-ignore lint/suspicious/noExplicitAny: tool results are checked with matchers
type Json = any;

const PLAN = `# Plan

Keep {==this claim==}{#c1} as written.

The pilot is small on purpose.

---
comments:
  c1:
    body: "Needs a source."
    by: user
    at: "2026-10-05T09:00:00.000Z"
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("mcp review tools", () => {
  let tempDir: string;
  let stateDir: string;
  let doc: string;
  let env: NodeJS.ProcessEnv;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-review-"));
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    doc = path.join(tempDir, "plan.md");
    fs.writeFileSync(doc, PLAN);
    env = {
      ROUGHDRAFT_STATE_DIR: stateDir,
      ROUGHDRAFT_PORT: String(await freePort()),
    };
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<string> {
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
      stateDir,
    }).app;
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({ port, pid: process.pid, startedAt: "", url: "" }),
    );
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    return `http://127.0.0.1:${port}`;
  }

  async function call(name: string, args: Json) {
    const result = await callToolResult(name, args, env);
    return {
      isError: result.isError === true,
      body: JSON.parse(result.content[0]?.text ?? "null") as Json,
    };
  }

  function version(): string {
    const bytes = fs.readFileSync(doc);
    const stat = fs.statSync(doc);
    return `${stat.mtimeMs}:${stat.size}:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  }

  it("lists the new tools and expectedVersion on the write tools", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    startMcpServer({
      env,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    for (let i = 0; i < 100 && chunks.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const tools: Json[] = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4))
      .result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "roughdraft_start_round",
      "roughdraft_apply_round",
      "roughdraft_add_document_comment",
      "roughdraft_validate_document",
    ]) {
      expect(byName.has(name)).toBe(true);
    }
    for (const name of [
      "roughdraft_reply_to_comment",
      "roughdraft_mark_resolved",
      "roughdraft_add_document_comment",
    ]) {
      expect(byName.get(name).inputSchema.properties).toHaveProperty(
        "expectedVersion",
      );
    }
    // The existing names keep their required arguments.
    expect(
      byName.get("roughdraft_reply_to_comment").inputSchema.required,
    ).toEqual(["documentPath", "parentId", "message"]);
  });

  it("replies as a one-thread transaction and returns the new id", async () => {
    const result = await call("roughdraft_reply_to_comment", {
      documentPath: doc,
      parentId: "c1",
      message: "Cited the survey.",
    });
    expect(result).toMatchObject({
      isError: false,
      body: {
        ok: true,
        id: "a1",
        thread: "c1",
        written: true,
        doctor: { replies: 1 },
      },
    });
  });

  it("refuses with an isError result and writes nothing", async () => {
    const refused = await call("roughdraft_reply_to_comment", {
      documentPath: doc,
      parentId: "c1",
      message: "Ends early ==} here",
    });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({
      ok: false,
      status: "refused",
      written: false,
      error: { code: "REVIEW_REFUSED" },
      errors: [expect.objectContaining({ code: "markup-in-reply" })],
    });
    const empty = await call("roughdraft_add_document_comment", {
      documentPath: doc,
      message: "\n\n",
    });
    expect(empty.isError).toBe(true);
    expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);
  });

  it("checks expectedVersion on reply, resolve and note", async () => {
    const stale = "1:2:0000";
    for (const [name, args] of [
      ["roughdraft_reply_to_comment", { parentId: "c1", message: "x" }],
      ["roughdraft_mark_resolved", { targetId: "c1" }],
      ["roughdraft_add_document_comment", { message: "Round 1." }],
    ] as const) {
      const result = await call(name, {
        documentPath: doc,
        expectedVersion: stale,
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(result.body.error.code).toBe("VERSION_CONFLICT");
    }
    expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);

    const resolved = await call("roughdraft_mark_resolved", {
      documentPath: doc,
      targetId: "c1",
      summary: "Cited.",
      expectedVersion: version(),
    });
    expect(resolved).toMatchObject({ isError: false, body: { written: true } });
    const note = await call("roughdraft_add_document_comment", {
      documentPath: doc,
      message: "Round 1: cited the survey.",
      expectedVersion: version(),
    });
    expect(note.body).toMatchObject({ id: "a1", written: true });
    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(doc, "utf8"),
    ).items;
    expect(items.find((item) => item.id === "c1")?.status).toBe("resolved");
    expect(items.find((item) => item.id === "a1")?.scope).toBe("document");
  });

  it("refuses an old-shape file with the doctor --fix message", async () => {
    fs.writeFileSync(
      doc,
      '# Draft\n\n{==x==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n',
    );
    const result = await call("roughdraft_mark_resolved", {
      documentPath: doc,
      targetId: "c1",
    });
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatchObject({ code: "LEGACY_FORMAT" });
    expect(result.body.error.message).toContain("doctor --fix");
  });

  it("validates a document", async () => {
    const result = await call("roughdraft_validate_document", {
      documentPath: doc,
    });
    expect(result.body).toMatchObject({
      ok: true,
      summary: { roots: 1, comments: 1 },
    });
  });

  it("returns the round list shape from get_pending_feedback", async () => {
    const result = await call("roughdraft_get_pending_feedback", {
      documentPath: doc,
    });
    expect(result.body).toMatchObject({
      fileVersion: version(),
      counts: { threads: 1, needsAnswer: 1 },
      threads: [
        {
          id: "c1",
          needsAnswer: true,
          anchor: { segments: [{ text: "this claim", line: 3 }] },
        },
      ],
    });
    expect(result.body.items.map((item: Json) => item.id)).toEqual(["c1"]);
  });

  it("starts and applies a round, and a retry is already-applied", async () => {
    const url = await startServer();
    const started = await call("roughdraft_start_round", { documentPath: doc });
    expect(started.isError).toBe(false);
    expect(started.body).toMatchObject({
      tabDirty: false,
      tabConflict: false,
      roundFlag: "open",
      round: { counts: { threads: 1 } },
      cleanText: expect.stringContaining("Keep this claim as written."),
    });
    expect(started.body.round).not.toHaveProperty("clean");

    const response = {
      roughdraftResponse: 1,
      roundId: started.body.roundId,
      threads: { c1: { reply: "Cited." } },
      note: "Round 1.",
    };
    const cleanText = started.body.cleanText.replace(
      "small on purpose",
      "limited to three customers",
    );
    const missing = await call("roughdraft_apply_round", {
      response: { ...response, threads: {} },
    });
    expect(missing.isError).toBe(true);
    expect(missing.body.errors[0].code).toBe("unanswered-thread");

    const applied = await call("roughdraft_apply_round", {
      response,
      cleanText,
    });
    expect(applied.body).toMatchObject({
      status: "applied",
      written: true,
      writtenVia: "server",
      roundFlag: "closed",
    });
    expect(fs.readFileSync(doc, "utf8")).toContain(
      "limited to three customers",
    );
    const retry = await call("roughdraft_apply_round", {
      response: JSON.stringify(response),
      cleanText,
    });
    expect(retry.body).toMatchObject({
      status: "already-applied",
      written: false,
    });
    expect(url).toContain("127.0.0.1");
  });
});
