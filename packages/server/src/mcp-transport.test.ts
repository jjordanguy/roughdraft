import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import { AGENT_PROCEDURE, type McpServer, startMcpServer } from "./mcp";

// The stdio transport: framing, lifecycle, errors, cancellation and exit,
// driven through PassThrough streams the way a client drives stdin/stdout.

// biome-ignore lint/suspicious/noExplicitAny: protocol messages are checked with matchers
type Json = any;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version as string;

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

async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Client {
  server: McpServer;
  input: PassThrough;
  /** Everything the server wrote, as text. */
  raw: () => string;
  exits: number[];
  /** Runs the parent watchdog once, as its timer would. */
  checkParent: () => void;
  setPpid: (pid: number) => void;
  /** The parsed messages written so far, in either framing. */
  messages: () => Json[];
  waitFor: (count: number) => Promise<Json[]>;
}

function parseOutput(text: string): Json[] {
  if (text.startsWith("Content-Length")) {
    const messages: Json[] = [];
    let rest = text;
    while (rest.length > 0) {
      const headerEnd = rest.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const length = Number(
        /Content-Length: (\d+)/.exec(rest.slice(0, headerEnd))?.[1],
      );
      const body = rest.slice(headerEnd + 4, headerEnd + 4 + length);
      if (Buffer.byteLength(body) < length) break;
      messages.push(JSON.parse(body));
      rest = rest.slice(headerEnd + 4 + length);
    }
    return messages;
  }
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

describe("mcp transport", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let documentPath: string;
  let env: NodeJS.ProcessEnv;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-io-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    // A free port, so nothing ever reaches a real Roughdraft on 7373.
    env = {
      ROUGHDRAFT_STATE_DIR: stateDir,
      ROUGHDRAFT_PORT: String(await freePort()),
    };
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function connect(options: { ppid?: number } = {}): Client {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const exits: number[] = [];
    let ppid = options.ppid ?? 4242;
    let watchdog: (() => void) | null = null;
    const server = startMcpServer({
      env,
      input,
      output,
      exit: (code) => exits.push(code),
      getPpid: () => ppid,
      setInterval: (callback) => {
        watchdog = callback;
        return 1;
      },
      clearInterval: () => {
        watchdog = null;
      },
      watchTuning: { backoffMs: [20, 50] },
    });
    cleanups.push(() => server.shutdown(0));
    const client: Client = {
      server,
      input,
      raw: () => text,
      exits,
      checkParent: () => watchdog?.(),
      setPpid: (pid) => {
        ppid = pid;
      },
      messages: () => parseOutput(text),
      waitFor: async (count) => {
        await until(
          () => client.messages().length >= count,
          `${count} message(s)`,
        );
        return client.messages();
      },
    };
    return client;
  }

  function line(message: Json): string {
    return `${JSON.stringify(message)}\n`;
  }

  function frame(message: Json, separator = "\r\n\r\n"): string {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}${separator}${body}`;
  }

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
      deliveryWaitMs: 200,
    }).app;
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({
        port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${port}`,
      }),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    return `http://127.0.0.1:${port}`;
  }

  async function watcherCount(url: string): Promise<number> {
    const query = new URLSearchParams({
      projectPath: projectDir,
      path: "draft.md",
    });
    const response = await fetch(`${url}/api/review-events/status?${query}`);
    return ((await response.json()) as Json).watcherCount;
  }

  function toolResult(message: Json): { isError: boolean; body: Json } {
    return {
      isError: message.result.isError === true,
      body: JSON.parse(message.result.content[0].text),
    };
  }

  const initialize = (id: number, protocolVersion = "2025-06-18") => ({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });

  it("answers a newline-delimited initialize with one newline-terminated JSON line", async () => {
    const client = connect();
    client.input.write(line(initialize(1)));

    const [answer] = await client.waitFor(1);

    expect(client.raw()).not.toContain("Content-Length");
    expect(client.raw().endsWith("}\n")).toBe(true);
    expect(client.raw().split("\n")).toHaveLength(2);
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "roughdraft", version: packageVersion },
      },
    });
  });

  it("reports the package version and carries the agent procedure as instructions", async () => {
    const client = connect();
    client.input.write(line(initialize(1)));

    const [answer] = await client.waitFor(1);

    expect(answer.result.serverInfo.version).toBe(packageVersion);
    expect(answer.result.instructions.startsWith(AGENT_PROCEDURE)).toBe(true);
    expect(answer.result.instructions).toContain("roughdraft_get_handoffs");
  });

  it("keeps the instructions word for word with docs/fork/agent-procedure.md", () => {
    const doc = fs.readFileSync(
      path.join(repoRoot, "docs/fork/agent-procedure.md"),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("## Replacement paragraph"));
    const quoted = section
      .split("\n")
      .filter((text) => text.startsWith("> "))
      .map((text) => text.slice(2))
      .join("\n");

    expect(quoted).toBe(AGENT_PROCEDURE);
  });

  it("echoes an older supported protocol version and answers an unknown one with its own", async () => {
    const client = connect();
    client.input.write(line(initialize(1, "2025-03-26")));
    client.input.write(line(initialize(2, "1999-01-01")));

    const [older, unknown] = await client.waitFor(2);

    expect(older.result.protocolVersion).toBe("2025-03-26");
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("keeps Content-Length framing for clients that use it, with CRLF or LF headers", async () => {
    const client = connect();
    client.input.write(frame(initialize(1)));
    client.input.write(
      frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "\n\n"),
    );

    const [init, list] = await client.waitFor(2);

    expect(client.raw().startsWith("Content-Length: ")).toBe(true);
    expect(init.result.serverInfo.name).toBe("roughdraft");
    expect(list.result.tools.length).toBeGreaterThan(10);
  });

  it("returns -32700 for a malformed line and still answers the next request", async () => {
    const client = connect();
    client.input.write("{not json\n");
    client.input.write(line({ jsonrpc: "2.0", id: 2, method: "ping" }));

    const [parseError, pong] = await client.waitFor(2);

    expect(parseError).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(pong).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(client.exits).toEqual([]);
  });

  it("returns -32700 for a malformed Content-Length frame and keeps reading frames", async () => {
    const client = connect();
    client.input.write("Content-Length: 9\r\n\r\n{not json");
    client.input.write("Content-Type: text/plain\r\n\r\n");
    client.input.write(frame({ jsonrpc: "2.0", id: 3, method: "ping" }));

    const messages = await client.waitFor(3);

    expect(messages.map((message) => message.error?.code ?? "ok")).toEqual([
      -32700,
      -32700,
      "ok",
    ]);
    expect(messages[2]).toMatchObject({ id: 3, result: {} });
  });

  it("answers ping with an empty result, including a request whose id is an empty string", async () => {
    const client = connect();
    client.input.write(line({ jsonrpc: "2.0", id: 5, method: "ping" }));
    client.input.write(line({ jsonrpc: "2.0", id: "", method: "ping" }));

    const messages = await client.waitFor(2);

    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 5, result: {} },
      { jsonrpc: "2.0", id: "", result: {} },
    ]);
  });

  it("does not reply to notifications/initialized", async () => {
    const client = connect();
    client.input.write(
      line({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    client.input.write(line({ jsonrpc: "2.0", id: 9, method: "ping" }));

    await client.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.messages()).toEqual([{ jsonrpc: "2.0", id: 9, result: {} }]);
  });

  it("returns -32600 for invalid requests and -32601 for unknown methods", async () => {
    const client = connect();
    client.input.write(line([1, 2]));
    client.input.write(line({ jsonrpc: "2.0", id: 1 }));
    client.input.write(
      line({ jsonrpc: "2.0", id: { nested: true }, method: "ping" }),
    );
    client.input.write(
      line({ jsonrpc: "2.0", id: 4, method: "resources/list" }),
    );

    const messages = await client.waitFor(4);

    expect(messages.map((message) => [message.id, message.error.code])).toEqual(
      [
        [null, -32600],
        [1, -32600],
        [null, -32600],
        [4, -32601],
      ],
    );
  });

  it("returns -32602 for an unknown tool and for arguments that are not an object", async () => {
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "roughdraft_delete_everything", arguments: {} },
      }),
    );
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "roughdraft_get_review_index", arguments: "x.md" },
      }),
    );

    const [unknown, notObject] = await client.waitFor(2);

    expect(unknown.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("roughdraft_delete_everything"),
    });
    expect(notObject.error.code).toBe(-32602);
  });

  it("reports a missing documentPath as an isError tool result with the CLI envelope", async () => {
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "roughdraft_get_review_index", arguments: {} },
      }),
    );

    const [message] = await client.waitFor(1);
    const result = toolResult(message);

    expect(message.error).toBeUndefined();
    expect(result).toMatchObject({
      isError: true,
      body: {
        ok: false,
        status: "error",
        exitCode: 2,
        error: {
          code: "USAGE",
          message: expect.stringContaining("documentPath is required"),
        },
      },
    });
  });

  it("rejects a relative documentPath", async () => {
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "roughdraft_get_review_index",
          arguments: { documentPath: "draft.md" },
        },
      }),
    );

    const [message] = await client.waitFor(1);

    expect(toolResult(message)).toMatchObject({
      isError: true,
      body: {
        error: {
          code: "USAGE",
          message: "documentPath must be an absolute path: draft.md",
        },
      },
    });
  });

  it("reports a wrong argument type and an unknown argument as isError results", async () => {
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "roughdraft_watch_review_events",
          arguments: { documentPath, timeoutSeconds: "soon", fromNow: true },
        },
      }),
    );

    const [message] = await client.waitFor(1);

    expect(toolResult(message).body.error.message).toBe(
      "Invalid arguments for roughdraft_watch_review_events: timeoutSeconds must be a number; fromNow is not an argument of roughdraft_watch_review_events.",
    );
  });

  it("reports SERVER_UNREACHABLE with the start hint when no server runs", async () => {
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "roughdraft_ack_handoff",
          arguments: { handoffIds: ["h1"] },
        },
      }),
    );

    const [message] = await client.waitFor(1);

    expect(toolResult(message)).toMatchObject({
      isError: true,
      body: {
        exitCode: 3,
        error: {
          code: "SERVER_UNREACHABLE",
          retryable: true,
          hint: expect.stringContaining("roughdraft start"),
        },
      },
    });
  });

  it("describes every tool property and marks the read tools read-only", async () => {
    const client = connect();
    client.input.write(line({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    const [message] = await client.waitFor(1);
    const tools: Json[] = message.result.tools;

    for (const tool of tools) {
      for (const [key, property] of Object.entries<Json>(
        tool.inputSchema.properties,
      )) {
        expect(
          typeof property.description === "string" &&
            property.description.length > 10,
          `${tool.name}.${key} has a description`,
        ).toBe(true);
      }
    }
    const readOnly = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(readOnly).toEqual([
      "roughdraft_get_handoffs",
      "roughdraft_get_open_documents",
      "roughdraft_get_pending_feedback",
      "roughdraft_get_review_index",
      "roughdraft_validate_document",
    ]);
  });

  it("aborts the in-flight watch when notifications/cancelled names its request id", async () => {
    const url = await startServer();
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "roughdraft_watch_review_events",
          arguments: { documentPath, includePending: false },
        },
      }),
    );
    await until(async () => (await watcherCount(url)) === 1, "the watcher");
    expect(client.server.inFlight()).toBe(1);

    client.input.write(
      line({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "user stopped" },
      }),
    );

    await until(() => client.server.inFlight() === 0, "the call to end");
    await until(async () => (await watcherCount(url)) === 0, "watchers at 0");
    client.input.write(line({ jsonrpc: "2.0", id: 8, method: "ping" }));
    await client.waitFor(1);
    // The cancelled request gets no response; the server keeps serving.
    expect(client.messages()).toEqual([{ jsonrpc: "2.0", id: 8, result: {} }]);
    expect(client.exits).toEqual([]);
  });

  it("exits 0 when stdin ends and aborts in-flight calls first", async () => {
    const url = await startServer();
    const client = connect();
    client.input.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "roughdraft_watch_review_events",
          arguments: { documentPath, includePending: false },
        },
      }),
    );
    await until(async () => (await watcherCount(url)) === 1, "the watcher");

    client.input.end();

    await until(() => client.exits.length > 0, "exit");
    expect(client.exits).toEqual([0]);
    expect(client.server.inFlight()).toBe(0);
    await until(async () => (await watcherCount(url)) === 0, "watchers at 0");
  });

  it("exits when the parent pid changes, checked on the watchdog timer", async () => {
    const client = connect();

    client.checkParent();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.exits).toEqual([]);

    client.setPpid(1);
    client.checkParent();

    await until(() => client.exits.length > 0, "exit");
    expect(client.exits).toEqual([0]);
  });

  it("exits on the first check when it started with parent pid 1 (the parent died during startup)", async () => {
    const client = connect({ ppid: 1 });

    client.checkParent();

    await until(() => client.exits.length > 0, "exit");
    expect(client.exits).toEqual([0]);
  });
});
