import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliDependencies,
  createCliDependencies,
  type InterruptSignal,
  runCli,
} from "./cli";
import { createApp } from "./index";

// Real `createApp` servers on loopback, the CLI driven through `runCli` with
// injected dependencies. Ports are picked by the OS; the preferred port points
// at a port nothing listens on, so no test ever reaches a real Roughdraft.

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;
// biome-ignore lint/suspicious/noExplicitAny: envelopes are checked with matchers
type Json = any;

interface RunningServer {
  pid: number;
  port: number;
  url: string;
  stateDir: string;
  close: () => Promise<void>;
}

const serverRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met in ${timeoutMs} ms: ${String(last)}`);
    }
    await sleep(10);
    last = await read();
  }
  return last;
}

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

describe("cli watch, handoffs and wake routes", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let documentPath: string;
  let unusedPort: number;
  let nextPid: number;
  const running = new Map<number, RunningServer>();

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-watch-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    documentPath = path.join(projectDir, "plan.md");
    fs.writeFileSync(documentPath, "# Plan\n\nSome text.\n");
    unusedPort = await freePort();
    nextPid = 5000;
  });

  afterEach(async () => {
    await Promise.all([...running.values()].map((server) => server.close()));
    running.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(
    options: Partial<AppOptions> & { port?: number; record?: boolean } = {},
  ): Promise<RunningServer> {
    const { port: requestedPort, record = true, ...appOptions } = options;
    const serverStateDir = appOptions.stateDir ?? stateDir;
    const pid = nextPid;
    nextPid += 1;
    const placeholderPort = requestedPort ?? 0;
    let app: ReturnType<typeof createApp>["app"] | null = null;
    const http: Server = createHttpServer((req, res) => app?.(req, res));
    await new Promise<void>((resolve) =>
      http.listen(placeholderPort, "127.0.0.1", () => resolve()),
    );
    const { port } = http.address() as AddressInfo;
    app = createApp({
      port,
      serverRoot,
      staticDirPath: tempDir,
      homeDir: tempDir,
      stateDir: serverStateDir,
      deliveryWaitMs: 300,
      ...appOptions,
    }).app;
    const server: RunningServer = {
      pid,
      port,
      url: `http://127.0.0.1:${port}`,
      stateDir: serverStateDir,
      close: () =>
        new Promise<void>((resolve) => {
          running.delete(pid);
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    };
    running.set(pid, server);
    if (record) {
      fs.writeFileSync(
        path.join(stateDir, "server.json"),
        `${JSON.stringify({
          port,
          pid,
          startedAt: new Date().toISOString(),
          url: `http://localhost:${port}`,
        })}\n`,
      );
    }
    return server;
  }

  interface Harness {
    deps: CliDependencies;
    logs: string[];
    errors: string[];
    opened: string[];
    interrupt: (signal: InterruptSignal) => void;
  }

  function harness(overrides: Partial<CliDependencies> = {}): Harness {
    const logs: string[] = [];
    const errors: string[] = [];
    const opened: string[] = [];
    let interruptHandler: ((signal: InterruptSignal) => void) | null = null;
    const deps = createCliDependencies({
      env: {
        PATH: process.env.PATH,
        HOME: tempDir,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_PORT: String(unusedPort),
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "dev.json"),
      },
      cwd: projectDir,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      openUrl: (url) => {
        opened.push(url);
        return "browser";
      },
      isProcessRunning: (pid) => running.has(pid),
      stopProcess: async (pid) => {
        await running.get(pid)?.close();
      },
      spawnServerProcess: async () => {
        throw new Error("these tests start their own servers");
      },
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0",
        latestVersion: "0",
        updateAvailable: false,
        updateCommand: "",
      }),
      onInterrupt: (handler) => {
        interruptHandler = handler;
        return () => {
          interruptHandler = null;
        };
      },
      watchTuning: { backoffMs: [20, 40], reconnectMs: 5_000 },
      ...overrides,
    });
    return {
      deps,
      logs,
      errors,
      opened,
      interrupt: (signal) => {
        if (!interruptHandler) throw new Error("no watch is running");
        interruptHandler(signal);
      },
    };
  }

  function onlyEnvelope(logs: string[]): Json {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0] ?? "{}");
  }

  async function postDone(
    server: RunningServer,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Json> {
    const response = await fetch(`${server.url}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "plan.md",
        ...body,
      }),
    });
    return response.json();
  }

  async function watcherCount(server: RunningServer): Promise<number> {
    const response = await fetch(
      `${server.url}/api/review-events/status?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
    );
    return ((await response.json()) as { watcherCount: number }).watcherCount;
  }

  async function latestHandoff(server: RunningServer): Promise<Json> {
    const response = await fetch(
      `${server.url}/api/review-events/status?projectPath=${encodeURIComponent(projectDir)}&path=plan.md`,
    );
    return ((await response.json()) as { handoff: Json }).handoff;
  }

  /** A fetch whose /api/status no longer offers the event stream. */
  function withoutStreamCapability(
    record?: (url: URL, init?: RequestInit) => void,
    baseFetch: typeof fetch = fetch,
  ): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      record?.(url, init);
      const response = await baseFetch(input, init);
      if (url.pathname !== "/api/status") return response;
      const payload = (await response.json()) as Json;
      payload.capabilities = { ...payload.capabilities };
      delete payload.capabilities.reviewEventStream;
      return new Response(JSON.stringify(payload), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  // --- F1: the waiter never dies at five minutes -------------------------

  it("keeps waiting across bounded polls and exits 0 when the third poll returns the event", async () => {
    const server = await startServer();
    const pollBodies: Json[] = [];
    const test = harness({
      fetchImpl: withoutStreamCapability((url, init) => {
        if (url.pathname === "/api/review-events/watch") {
          pollBodies.push(JSON.parse(String(init?.body)));
        }
      }),
      watchTuning: { pollSeconds: 0.2, backoffMs: [20] },
    });

    const watch = runCli(
      ["watch", documentPath, "--json", "--batch-window", "0"],
      test.deps,
    );
    await waitFor(
      () => pollBodies.length,
      (count) => count >= 3,
    );
    await postDone(server, { overallComment: "Tighten section 2." });
    const exitCode = await watch;
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(0);
    expect(pollBodies[0]).toMatchObject({ fromNow: true, timeoutSeconds: 0.2 });
    expect(pollBodies[0]).not.toHaveProperty("afterSequence");
    expect(pollBodies[0]).toHaveProperty("includePending", true);
    for (const body of pollBodies.slice(1)) {
      expect(body).toMatchObject({ fromNow: false, afterSequence: 0 });
      expect(body.timeoutSeconds).toBeLessThanOrEqual(240);
    }
    expect(envelope).toMatchObject({
      ok: true,
      status: "completed",
      exitCode: 0,
      path: documentPath,
      timedOut: false,
      events: [{ overallComment: "Tighten section 2.", sequence: 1 }],
      handoff: { sequence: 1 },
    });
    // The Done is acknowledged after the result was printed.
    expect(await latestHandoff(server)).toMatchObject({
      state: "acknowledged",
      ackedBy: "roughdraft-cli watch",
    });
  });

  it("enforces --timeout locally when it is above the 240 s poll bound (fake clock)", async () => {
    let fakeNow = 1_000_000;
    const pollTimeouts: number[] = [];
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({
        port: 4999,
        pid: 4999,
        startedAt: new Date().toISOString(),
        url: "http://localhost:4999",
      }),
    );
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const version = (
      JSON.parse(
        fs.readFileSync(path.join(serverRoot, "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    const test = harness({
      isProcessRunning: (pid) => pid === 4999,
      now: () => fakeNow,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.port !== "4999") throw new TypeError("fetch failed");
        if (url.pathname === "/api/status") {
          return json({
            backend: "local-files",
            port: 4999,
            serverRoot,
            version,
            instanceId: "srv_fake",
            capabilities: {},
          });
        }
        if (url.pathname === "/api/review-events/watch") {
          const body = JSON.parse(String(init?.body)) as {
            timeoutSeconds: number;
          };
          pollTimeouts.push(body.timeoutSeconds);
          fakeNow += body.timeoutSeconds * 1000;
          return json({
            events: [],
            timedOut: true,
            nextSequence: 1,
            instanceId: "srv_fake",
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    const exitCode = await runCli(
      ["watch", documentPath, "--json", "--timeout", "600"],
      test.deps,
    );
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(4);
    expect(pollTimeouts).toEqual([240, 240, 120]);
    expect(envelope).toMatchObject({
      ok: false,
      status: "timeout",
      exitCode: 4,
      path: documentPath,
      timedOut: true,
      events: [],
      error: { code: "WATCH_TIMEOUT", retryable: true },
    });
    expect(envelope.error.hint).toContain("roughdraft pending");
  });

  it("reconnects after the server goes away and resets the cursor when a new instance answers", async () => {
    const first = await startServer();
    // Three Dones on another file move the global cursor to 3.
    fs.writeFileSync(path.join(projectDir, "other.md"), "# Other\n");
    for (let round = 0; round < 3; round += 1) {
      await postDone(first, { path: "other.md" });
    }
    const test = harness();
    const watch = runCli(
      ["watch", documentPath, "--json", "--no-pending", "--batch-window", "0"],
      test.deps,
    );
    await waitFor(
      () => watcherCount(first),
      (count) => count === 1,
    );

    await first.close();
    await sleep(100);
    // The restarted server has a fresh log, so its sequences start at 1 and
    // a watcher that kept cursor 3 would never see its Done.
    const second = await startServer({
      stateDir: path.join(tempDir, "state-b"),
    });
    await waitFor(
      () => watcherCount(second),
      (count) => count === 1,
    );
    await postDone(second);
    const exitCode = await watch;
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(0);
    expect(envelope.events).toHaveLength(1);
    expect(envelope.events[0]).toMatchObject({ sequence: 1 });
    expect(envelope.server.url).toBe(`http://localhost:${second.port}`);
    expect(test.errors.join("\n")).toContain("lost the connection");
    expect(test.errors.join("\n")).toContain("reconnected");
  });

  it("returns SERVER_LOST with exit 3 when the server stays down past --reconnect", async () => {
    const server = await startServer();
    const test = harness();
    const watch = runCli(
      ["watch", documentPath, "--json", "--reconnect", "0.3"],
      test.deps,
    );
    await waitFor(
      () => watcherCount(server),
      (count) => count === 1,
    );
    await server.close();
    const exitCode = await watch;
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(3);
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      exitCode: 3,
      path: documentPath,
      events: [],
      timedOut: false,
      error: { code: "SERVER_LOST", retryable: true },
    });
    expect(envelope.error.hint).toContain(
      `roughdraft pending ${documentPath} --json`,
    );
  });

  it("aborts the in-flight request and exits 130 with an interrupted envelope on SIGINT", async () => {
    const server = await startServer();
    let streamSignal: AbortSignal | null = null;
    const test = harness({
      fetchImpl: async (input, init) => {
        if (String(input).includes("/api/review-events/stream")) {
          streamSignal = init?.signal ?? null;
        }
        return fetch(input, init);
      },
    });
    const watch = runCli(["watch", documentPath, "--json"], test.deps);
    await waitFor(
      () => watcherCount(server),
      (count) => count === 1,
    );

    test.interrupt("SIGINT");
    const exitCode = await watch;
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(130);
    expect(envelope).toMatchObject({
      ok: false,
      status: "interrupted",
      exitCode: 130,
      signal: "SIGINT",
      path: documentPath,
      events: [],
      error: { code: "INTERRUPTED" },
    });
    expect((streamSignal as AbortSignal | null)?.aborted).toBe(true);
    await waitFor(
      () => watcherCount(server),
      (count) => count === 0,
    );
  });

  it("exits 143 on SIGTERM with the same envelope shape", async () => {
    const server = await startServer();
    const test = harness();
    const watch = runCli(["watch", documentPath, "--json"], test.deps);
    await waitFor(
      () => watcherCount(server),
      (count) => count === 1,
    );
    test.interrupt("SIGTERM");
    expect(await watch).toBe(143);
    expect(onlyEnvelope(test.logs)).toMatchObject({
      status: "interrupted",
      exitCode: 143,
      signal: "SIGTERM",
    });
  });

  // --- F3: one envelope on every exit path ---------------------------------

  it("prints exactly one JSON envelope for every open --json exit path", async () => {
    const cases: Array<{
      name: string;
      args: string[];
      during?: (server: RunningServer, test: Harness) => Promise<void>;
      exitCode: number;
      status: string;
      code?: string;
    }> = [
      {
        name: "completed",
        args: [],
        during: async (server) => {
          await waitFor(
            () => watcherCount(server),
            (count) => count === 1,
          );
          await postDone(server);
        },
        exitCode: 0,
        status: "completed",
      },
      {
        name: "timeout",
        args: ["--timeout", "0.2"],
        exitCode: 4,
        status: "timeout",
        code: "WATCH_TIMEOUT",
      },
      {
        name: "server lost",
        args: ["--reconnect", "0.2"],
        during: async (server) => {
          await waitFor(
            () => watcherCount(server),
            (count) => count === 1,
          );
          await server.close();
        },
        exitCode: 3,
        status: "error",
        code: "SERVER_LOST",
      },
      {
        name: "interrupted",
        args: [],
        during: async (server, test) => {
          await waitFor(
            () => watcherCount(server),
            (count) => count === 1,
          );
          test.interrupt("SIGINT");
        },
        exitCode: 130,
        status: "interrupted",
        code: "INTERRUPTED",
      },
    ];

    for (const testCase of cases) {
      const server = await startServer();
      const test = harness();
      const run = runCli(
        ["open", documentPath, "--json", ...testCase.args],
        test.deps,
      );
      await testCase.during?.(server, test);
      const exitCode = await run;
      const envelope = onlyEnvelope(test.logs);
      expect({ name: testCase.name, exitCode }).toEqual({
        name: testCase.name,
        exitCode: testCase.exitCode,
      });
      expect(envelope).toMatchObject({
        ok: testCase.exitCode === 0,
        status: testCase.status,
        exitCode: testCase.exitCode,
        path: documentPath,
        url: expect.stringContaining(encodeURIComponent(documentPath)),
        openMode: "browser",
      });
      if (testCase.code) expect(envelope.error.code).toBe(testCase.code);
      await server.close();
    }

    for (const [name, target, code] of [
      ["missing", path.join(projectDir, "missing.md"), "PATH_NOT_FOUND"],
      ["not markdown", path.join(projectDir, "notes.txt"), "NOT_MARKDOWN"],
    ] as const) {
      if (name === "not markdown") fs.writeFileSync(target, "text");
      const test = harness();
      const exitCode = await runCli(["open", target, "--json"], test.deps);
      const envelope = onlyEnvelope(test.logs);
      expect({ name, exitCode }).toEqual({ name, exitCode: 2 });
      expect(envelope).toMatchObject({
        ok: false,
        status: "error",
        exitCode: 2,
        path: target,
        error: { code },
      });
    }
  });

  it("never rejects: an unexpected dependency failure becomes INTERNAL with exit 1", async () => {
    const test = harness({
      fetchImpl: async () => {
        throw new Error("boom");
      },
      findAvailablePortImpl: async () => {
        throw new RangeError("port table exploded");
      },
    });
    const exitCode = await runCli(["start", "--json"], test.deps);
    expect(exitCode).toBe(1);
    expect(onlyEnvelope(test.logs)).toMatchObject({
      ok: false,
      status: "error",
      exitCode: 1,
      error: { code: "INTERNAL", message: "port table exploded" },
    });

    const human = harness({
      findAvailablePortImpl: async () => {
        throw new RangeError("port table exploded");
      },
    });
    expect(await runCli(["start"], human.deps)).toBe(1);
    expect(human.errors[0]).toBe("roughdraft: port table exploded");
    expect(human.errors.join("\n")).not.toContain("at ");
  });

  // --- F2: a Done nobody waited for ----------------------------------------

  it("watch --pending --timeout 0 returns an earlier Done and acks it; a second call times out", async () => {
    const server = await startServer();
    const done = await postDone(server, { overallComment: "Round one." });
    expect(done).toMatchObject({ delivered: false, pending: true });

    const first = harness();
    const exitCode = await runCli(
      ["watch", documentPath, "--pending", "--timeout", "0", "--json"],
      first.deps,
    );
    const envelope = onlyEnvelope(first.logs);
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      status: "completed",
      handoff: { handoffId: done.handoff.handoffId },
      events: [{ overallComment: "Round one." }],
    });
    expect(await latestHandoff(server)).toMatchObject({
      state: "acknowledged",
    });

    const second = harness();
    expect(
      await runCli(
        ["watch", documentPath, "--pending", "--timeout", "0", "--json"],
        second.deps,
      ),
    ).toBe(4);
    expect(onlyEnvelope(second.logs).status).toBe("timeout");
  });

  it("watch --no-ack leaves the Done for the next agent", async () => {
    const server = await startServer();
    await postDone(server);
    const test = harness();
    expect(
      await runCli(
        ["watch", documentPath, "--timeout", "0", "--no-ack", "--json"],
        test.deps,
      ),
    ).toBe(0);
    expect((await latestHandoff(server)).state).not.toBe("acknowledged");
  });

  it("pending reads the session log from disk when the server is down, and acks through the server when it is up", async () => {
    const server = await startServer();
    const done = await postDone(server, { overallComment: "Please check." });

    const live = harness();
    expect(await runCli(["pending", documentPath, "--json"], live.deps)).toBe(
      0,
    );
    expect(onlyEnvelope(live.logs)).toMatchObject({
      source: "server",
      path: documentPath,
      handoffs: [
        {
          handoffId: done.handoff.handoffId,
          documentPath,
          overallComment: "Please check.",
        },
      ],
    });

    await server.close();
    const down = harness();
    expect(await runCli(["pending", documentPath, "--json"], down.deps)).toBe(
      0,
    );
    expect(onlyEnvelope(down.logs)).toMatchObject({
      ok: true,
      status: "ok",
      exitCode: 0,
      source: "disk",
      handoffs: [{ handoffId: done.handoff.handoffId }],
    });

    const status = harness();
    expect(await runCli(["status", "--json"], status.deps)).toBe(0);
    expect(onlyEnvelope(status.logs)).toMatchObject({
      running: false,
      source: "disk",
      pendingHandoffs: 1,
    });

    const humanStatus = harness();
    expect(await runCli(["status"], humanStatus.deps)).toBe(1);
    expect(humanStatus.logs).toContain(
      "1 Done waiting in the session log. Run `roughdraft pending` to see them.",
    );

    // Back up: --ack acknowledges what it returned, the next call is empty.
    const restarted = await startServer();
    const ack = harness();
    expect(
      await runCli(["pending", documentPath, "--json", "--ack"], ack.deps),
    ).toBe(0);
    expect(onlyEnvelope(ack.logs)).toMatchObject({
      handoffs: [{ handoffId: done.handoff.handoffId }],
      acked: [done.handoff.handoffId],
    });
    const after = harness();
    expect(await runCli(["pending", documentPath, "--json"], after.deps)).toBe(
      0,
    );
    expect(onlyEnvelope(after.logs).handoffs).toEqual([]);
    const all = harness();
    await runCli(["pending", "--all", "--json"], all.deps);
    expect(onlyEnvelope(all.logs).handoffs).toMatchObject([
      { handoffId: done.handoff.handoffId, state: "acknowledged" },
    ]);
    await restarted.close();
  });

  it("ack reports unknown ids and exits 2 when none is known", async () => {
    const server = await startServer();
    const done = await postDone(server);

    const unknown = harness();
    expect(await runCli(["ack", "nope", "--json"], unknown.deps)).toBe(2);
    expect(onlyEnvelope(unknown.logs)).toMatchObject({
      ok: false,
      exitCode: 2,
      acked: [],
      unknown: ["nope"],
      error: { code: "HANDOFF_NOT_FOUND" },
    });

    const mixed = harness();
    expect(
      await runCli(
        ["ack", done.handoff.handoffId, "nope", "--json"],
        mixed.deps,
      ),
    ).toBe(0);
    expect(onlyEnvelope(mixed.logs)).toMatchObject({
      ok: true,
      acked: [done.handoff.handoffId],
      unknown: ["nope"],
    });
  });

  // --- Sessions, log, status ------------------------------------------------

  it("open registers the session before the window opens and log shows it with the latest Done", async () => {
    const server = await startServer();
    const calls: string[] = [];
    const test = harness({
      env: {
        PATH: process.env.PATH,
        HOME: tempDir,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_PORT: String(unusedPort),
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "dev.json"),
        // Remote mode is gone: this variable no longer changes anything.
        ROUGHDRAFT_HOST: "http://192.0.2.1:9",
        ROUGHDRAFT_SESSION_LINK: "https://example.test/session/1",
      },
      fetchImpl: async (input, init) => {
        calls.push(new URL(String(input)).pathname);
        return fetch(input, init);
      },
      openUrl: (url) => {
        calls.push(`open ${url}`);
        return "browser";
      },
    });

    const exitCode = await runCli(
      [
        "open",
        documentPath,
        "--no-watch",
        "--harness",
        "claude-code",
        "--session-label",
        "test session",
        "--session-id",
        "local_x",
        "--json",
      ],
      test.deps,
    );
    const envelope = onlyEnvelope(test.logs);

    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      opened: true,
      openMode: "browser",
      serverUrl: `http://localhost:${server.port}`,
      session: {
        harness: "claude-code",
        label: "test session",
        sessionId: "local_x",
        link: "https://example.test/session/1",
        routeId: "claude-code",
      },
    });
    const sessionIndex = calls.indexOf("/api/documents/session");
    const openIndex = calls.findIndex((call) => call.startsWith("open "));
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(sessionIndex);
    expect(calls.some((call) => call.includes("remote-document"))).toBe(false);

    await postDone(server, { overallComment: "Looks close." });
    const log = harness();
    expect(await runCli(["log"], log.deps)).toBe(0);
    const text = log.logs.join("\n");
    expect(text).toContain(documentPath);
    expect(text).toContain(
      `Link: http://localhost:${server.port}/?path=${encodeURIComponent(documentPath)}`,
    );
    expect(text).toContain(
      "Session: test session (claude-code, id local_x) https://example.test/session/1",
    );
    // The built-in claude-code route ran on the Done and found no session
    // with that id; the log says so.
    expect(text).toContain(
      "Wake route: claude-code (claude-session the Claude Code session that opened the file), last test failed: No running Claude Code session has the id local_x",
    );
    expect(text).toMatch(
      /Latest Done: .* \(1 comment, 0 suggestions, 1 unresolved\), waiting/,
    );
    expect(text).toContain(
      "Wake: failed (claude-code): No running Claude Code session has the id local_x",
    );

    const logJson = harness();
    expect(await runCli(["log", "--json"], logJson.deps)).toBe(0);
    expect(onlyEnvelope(logJson.logs)).toMatchObject({
      source: "server",
      documents: [
        {
          documentPath,
          session: { label: "test session" },
          latestHandoff: { state: "pending", overallComment: "Looks close." },
          pendingHandoffs: 1,
        },
      ],
      routes: [{ harness: "claude-code", kind: "claude-session" }],
    });
  });

  it("status --json lists documents with pendingHandoffs, and human status prints one line per document", async () => {
    const server = await startServer();
    await postDone(server);

    const json = harness();
    expect(await runCli(["status", "--json"], json.deps)).toBe(0);
    expect(onlyEnvelope(json.logs)).toMatchObject({
      ok: true,
      running: true,
      instanceId: expect.stringMatching(/^srv_/),
      pendingHandoffs: 1,
      documents: [
        {
          documentPath,
          pendingHandoffs: 1,
          tabs: 0,
          watchers: 0,
          url: `http://localhost:${server.port}/?path=${encodeURIComponent(documentPath)}`,
        },
      ],
    });

    const human = harness();
    expect(await runCli(["status"], human.deps)).toBe(0);
    expect(human.logs.join("\n")).toMatch(
      /plan\.md: 0 tabs, no agent listening, Done waiting since .+ \(0 comments\)/,
    );
  });

  it("open reports existing-window only when a tab acknowledges the open request", async () => {
    const server = await startServer();
    for (const acknowledged of [false, true]) {
      const test = harness({
        fetchImpl: async (input, init) => {
          if (new URL(String(input)).pathname === "/api/open-request") {
            return new Response(
              JSON.stringify({ delivered: true, acknowledged, tabs: 1 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return fetch(input, init);
        },
      });
      expect(
        await runCli(["open", documentPath, "--no-watch", "--json"], test.deps),
      ).toBe(0);
      expect(onlyEnvelope(test.logs).openMode).toBe(
        acknowledged ? "existing-window" : "browser",
      );
      expect(test.opened).toHaveLength(acknowledged ? 0 : 1);
    }
    await server.close();
  });

  // --- Wake routes ----------------------------------------------------------

  it("route add then route test runs the command, and a failing route exits 3", async () => {
    await startServer();
    const marker = path.join(tempDir, "wake.txt");

    const add = harness();
    expect(
      await runCli(
        [
          "route",
          "add",
          "test-harness",
          "--command",
          `printf '%s|%s' "$ROUGHDRAFT_EVENT" "$ROUGHDRAFT_MESSAGE" > ${JSON.stringify(marker)}`,
          "--label",
          "Test harness",
          "--json",
        ],
        add.deps,
      ),
    ).toBe(0);
    expect(onlyEnvelope(add.logs)).toMatchObject({
      route: {
        harness: "test-harness",
        kind: "command",
        label: "Test harness",
      },
    });

    const tested = harness();
    expect(
      await runCli(["route", "test", "test-harness", "--json"], tested.deps),
    ).toBe(0);
    expect(onlyEnvelope(tested.logs)).toMatchObject({
      ok: true,
      harness: "test-harness",
      sent: true,
    });
    expect(fs.readFileSync(marker, "utf8")).toBe(
      "test|Roughdraft wake route test for test-harness.",
    );

    const list = harness();
    expect(await runCli(["route", "list", "--json"], list.deps)).toBe(0);
    expect(onlyEnvelope(list.logs).routes).toMatchObject([
      { harness: "claude-code", kind: "claude-session" },
      { harness: "test-harness", verifiedBy: "roughdraft-cli route test" },
    ]);

    const failing = harness();
    await runCli(
      ["route", "add", "broken", "--command", "echo nope >&2; exit 7"],
      failing.deps,
    );
    const failed = harness();
    expect(
      await runCli(["route", "test", "broken", "--json"], failed.deps),
    ).toBe(3);
    expect(onlyEnvelope(failed.logs)).toMatchObject({
      ok: false,
      exitCode: 3,
      sent: false,
      error: { code: "WAKE_ROUTE_FAILED" },
    });

    const missing = harness();
    expect(await runCli(["route", "test", "ghost"], missing.deps)).toBe(2);
    expect(missing.errors[0]).toBe("roughdraft: No wake route for ghost.");

    const usage = harness();
    expect(
      await runCli(
        ["route", "add", "both", "--command", "true", "--url", "http://x.test"],
        usage.deps,
      ),
    ).toBe(2);

    const removed = harness();
    expect(
      await runCli(["route", "remove", "broken", "--json"], removed.deps),
    ).toBe(0);
    expect(onlyEnvelope(removed.logs)).toMatchObject({ removed: true });
  });

  // --- Token ------------------------------------------------------------------

  it("inside Claude Code, open registers the session by itself and Done lands in it as a message", async () => {
    // A fake Claude Code session: its record and key under a config dir,
    // and a socket that keeps the lines it receives.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-cc-"));
    fs.mkdirSync(path.join(configDir, "sessions"));
    const socketPath = path.join(configDir, "s.sock");
    const received: string[] = [];
    const inbox = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("end", () => {
        received.push(...buffer.split("\n").filter(Boolean));
        socket.end();
      });
    });
    await new Promise<void>((resolve) => inbox.listen(socketPath, resolve));
    fs.writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "conv-1",
        name: "Plan the launch",
        messagingSocketPath: socketPath,
      }),
    );
    fs.writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.k.key`),
      JSON.stringify({ peerToken: "tok-1" }),
    );
    const server = await startServer({ claudeConfigDir: configDir });
    const inClaude = (overrides: Partial<CliDependencies> = {}) =>
      harness({
        env: {
          PATH: process.env.PATH,
          HOME: tempDir,
          ROUGHDRAFT_STATE_DIR: stateDir,
          ROUGHDRAFT_PORT: String(unusedPort),
          ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "dev.json"),
          CLAUDE_CODE_SESSION_ID: "conv-1",
          CLAUDE_CONFIG_DIR: configDir,
        },
        ...overrides,
      });

    try {
      const tested = inClaude();
      expect(
        await runCli(["route", "test", "claude-code", "--json"], tested.deps),
      ).toBe(0);
      expect(onlyEnvelope(tested.logs)).toMatchObject({ ok: true, sent: true });
      expect(received.map((line) => JSON.parse(line))).toEqual([
        { type: "auth", token: "tok-1" },
        {
          type: "user",
          message: {
            role: "user",
            content: expect.stringContaining(
              "Roughdraft wake route test for claude-code.",
            ),
          },
        },
      ]);
      received.length = 0;

      const opened = inClaude();
      expect(
        await runCli(
          ["open", documentPath, "--no-watch", "--no-open", "--json"],
          opened.deps,
        ),
      ).toBe(0);
      expect(onlyEnvelope(opened.logs).session).toMatchObject({
        harness: "claude-code",
        label: "Plan the launch",
        sessionId: "conv-1",
        routeId: "claude-code",
      });

      await postDone(server, { overallComment: "Ship it." });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const turn = received.map((line) => JSON.parse(line)).at(-1);
      expect(turn.message.content).toBe(
        `I'm done reviewing plan.md. Please check my comments. (1 comments, 0 suggestions)\nShip it.\n\nFile: ${documentPath}\nLink: http://localhost:${server.port}/?path=${encodeURIComponent(documentPath)}\nNext: roughdraft round '${documentPath}'`,
      );
      const log = inClaude();
      expect(await runCli(["log", "--json"], log.deps)).toBe(0);
      expect(onlyEnvelope(log.logs)).toMatchObject({
        documents: [
          {
            documentPath,
            session: { label: "Plan the launch" },
            latestHandoff: { wake: { routeId: "claude-code", state: "sent" } },
          },
        ],
        routes: [{ harness: "claude-code", verifiedAt: expect.any(String) }],
      });
    } finally {
      await new Promise<void>((resolve) => inbox.close(() => resolve()));
      fs.rmSync(configDir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("sends Authorization: Bearer on every request when ROUGHDRAFT_TOKEN is set", async () => {
    const token = "s3cret-token";
    const server = await startServer({ apiToken: token });
    await postDone(server, {}, { Authorization: `Bearer ${token}` });
    const seen: Array<{ path: string; auth: string | null }> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      seen.push({
        path: new URL(String(input)).pathname,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return fetch(input, init);
    };
    const env = {
      PATH: process.env.PATH,
      HOME: tempDir,
      ROUGHDRAFT_STATE_DIR: stateDir,
      ROUGHDRAFT_PORT: String(unusedPort),
      ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "dev.json"),
      ROUGHDRAFT_TOKEN: token,
    };

    for (const args of [
      ["status", "--json"],
      ["pending", documentPath, "--json"],
      ["watch", documentPath, "--timeout", "0", "--json"],
      ["route", "list", "--json"],
      ["log", "--json"],
    ]) {
      const test = harness({ env, fetchImpl: recordingFetch });
      const exitCode = await runCli(args, test.deps);
      expect({ args, exitCode }).toEqual({ args, exitCode: 0 });
    }

    const toServer = seen.filter((request) => request.path.startsWith("/api/"));
    expect(toServer.length).toBeGreaterThan(5);
    expect(
      toServer.filter((request) => request.auth !== `Bearer ${token}`),
    ).toEqual([]);
    expect(toServer.map((request) => request.path)).toContain(
      "/api/review-events/ack",
    );

    // Without the token the same server refuses, and the CLI says why.
    const refused = harness({ env: { ...env, ROUGHDRAFT_TOKEN: "" } });
    expect(await runCli(["ack", "whatever", "--json"], refused.deps)).toBe(3);
  });

  // --- The five-minute bug at 1/1000 scale ----------------------------------

  it("survives undici's header and body timeouts: 300 ms limits, 50 ms keepalive, Done at 1 s", async () => {
    const server = await startServer({ keepaliveMs: 50 });
    const agent = new Agent({ headersTimeout: 300, bodyTimeout: 300 });
    const strictFetch = ((
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        { ...(init as object), dispatcher: agent } as Parameters<
          typeof undiciFetch
        >[1],
      )) as unknown as typeof fetch;

    for (const transport of ["stream", "long-poll"] as const) {
      const test = harness({
        fetchImpl:
          transport === "stream"
            ? strictFetch
            : withoutStreamCapability(undefined, strictFetch),
        // Any reconnect would show up as a stderr notice.
        watchTuning: { reconnectMs: 5_000, backoffMs: [20] },
      });
      const startedAt = Date.now();
      const watch = runCli(["watch", documentPath, "--json"], test.deps);
      setTimeout(() => {
        void postDone(server);
      }, 1_000);
      const exitCode = await watch;
      expect({ transport, exitCode }).toEqual({ transport, exitCode: 0 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect(onlyEnvelope(test.logs).status).toBe("completed");
      expect(test.errors.filter((line) => line.includes("lost"))).toEqual([]);
    }
    await agent.close();
  }, 10_000);
});
