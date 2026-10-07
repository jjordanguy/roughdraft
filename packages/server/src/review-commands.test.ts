import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type CliDependencies, createCliDependencies, runCli } from "./cli";
import { readRoundIndex } from "./guard";
import { createApp } from "./index";

// The review commands driven through `runCli` against real `createApp`
// servers on loopback (or none). The preferred port points at a port nothing
// listens on, so no test ever reaches a real Roughdraft.

// biome-ignore lint/suspicious/noExplicitAny: envelopes are checked with matchers
type Json = any;
type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;

const serverRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const fixturesDir = path.join(serverRoot, "docs", "spec", "fixtures");

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

const TWO_THREADS = `# Plan

Keep {==this claim==}{#c1} as written.

Name {==the approver==}{#c2} here.

---
comments:
  c1:
    body: "Needs a source."
    by: user
    at: "2026-10-05T09:00:00.000Z"
  c2:
    body: "Who signs off?"
    by: user
    at: "2026-10-05T09:01:00.000Z"
`;

const LEGACY = `# Draft

Keep {==this==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"} here.
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met: ${JSON.stringify(last)}`);
    }
    await sleep(10);
    last = await read();
  }
  return last;
}

interface RunningServer {
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

interface Tab {
  socket: WebSocket;
  messages: Json[];
  presence: (update: Json) => void;
}

describe("review commands", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let doc: string;
  let unusedPort: number;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-review-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    doc = path.join(projectDir, "plan.md");
    fs.writeFileSync(doc, PLAN);
    unusedPort = await freePort();
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(
    options: Partial<AppOptions> = {},
  ): Promise<RunningServer> {
    let app: ReturnType<typeof createApp> | null = null;
    const http: Server = createHttpServer((req, res) => app?.app(req, res));
    await new Promise<void>((resolve) =>
      http.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = http.address() as AddressInfo;
    app = createApp({
      port,
      serverRoot,
      staticDirPath: tempDir,
      homeDir: tempDir,
      stateDir,
      deliveryWaitMs: 200,
      ...options,
    });
    app.attachTabChannel(http);
    fs.writeFileSync(
      path.join(stateDir, "server.json"),
      JSON.stringify({
        port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${port}`,
      }),
    );
    const close = () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
    closers.push(close);
    return {
      url: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      close,
    };
  }

  async function openTab(server: RunningServer, file = doc): Promise<Tab> {
    const query = new URLSearchParams({
      projectPath: path.dirname(file),
      path: path.basename(file),
      tabId: `tab_${Math.random().toString(16).slice(2, 10)}`,
    });
    const socket = new WebSocket(`${server.wsUrl}/api/tab?${query}`);
    closers.push(async () => {
      socket.terminate();
    });
    const messages: Json[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await waitFor(
      () => messages.some((message) => message.type === "hello"),
      Boolean,
    );
    return {
      socket,
      messages,
      presence: (update) =>
        socket.send(JSON.stringify({ type: "presence", ...update })),
    };
  }

  async function documentView(server: RunningServer, file = doc) {
    const query = new URLSearchParams({
      projectPath: path.dirname(file),
      path: path.basename(file),
    });
    const response = await fetch(`${server.url}/api/documents/one?${query}`);
    return { status: response.status, body: (await response.json()) as Json };
  }

  interface Run {
    exitCode: number;
    logs: string[];
    errors: string[];
    json: Json;
  }

  async function run(
    args: string[],
    overrides: Partial<CliDependencies> & { stdin?: string } = {},
  ): Promise<Run> {
    const logs: string[] = [];
    const errors: string[] = [];
    const { stdin, ...rest } = overrides;
    const deps = createCliDependencies({
      env: {
        PATH: process.env.PATH,
        HOME: tempDir,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_PORT: String(unusedPort),
      },
      cwd: projectDir,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      spawnServerProcess: async () => {
        throw new Error("review commands never start a server");
      },
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0",
        latestVersion: "0",
        updateAvailable: false,
        updateCommand: "",
      }),
      readStdin: async () => stdin ?? "",
      ...rest,
    });
    const exitCode = await runCli(args, deps);
    let json: Json = null;
    if (args.includes("--json")) {
      expect(logs).toHaveLength(1);
      json = JSON.parse(logs[0] ?? "null");
    }
    return { exitCode, logs, errors, json };
  }

  function entries(file = doc) {
    return extractRoughdraftReviewIndex(fs.readFileSync(file, "utf8")).items;
  }

  // ---------------------------------------------------------------- one-thread

  describe("reply, resolve, note", () => {
    it("replies on disk with no server: new aN id, breakdown, valid file", async () => {
      const result = await run(["reply", doc, "c1", "Added the 2025 survey."]);
      expect(result.exitCode).toBe(0);
      expect(result.logs[0]).toBe(
        "Replied to c1 as a1 in plan.md (written on disk).",
      );
      expect(result.logs).toContain("Doctor: passed");
      expect(result.logs).toContain(
        "Breakdown: roots 1, documentComments 0, replies 1, suggestions 0",
      );
      const reply = entries().find((item) => item.id === "a1");
      expect(reply).toMatchObject({
        kind: "reply",
        parentId: "c1",
        author: "AI",
        text: "Added the 2025 survey.",
      });
      expect(validateRoughdraftMarkdown(fs.readFileSync(doc, "utf8")).ok).toBe(
        true,
      );
      expect(fs.readdirSync(projectDir)).toEqual(["plan.md"]);
    });

    it("prints one JSON envelope with the id, the write path and the doctor", async () => {
      const server = await startServer();
      const result = await run(["reply", doc, "c1", "Done.", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        ok: true,
        status: "applied",
        exitCode: 0,
        command: "reply",
        path: doc,
        thread: "c1",
        id: "a1",
        written: true,
        writtenVia: "server",
        attempts: 1,
        doctor: { ok: true, roots: 1, replies: 1 },
      });
      // The server served the write: its registry knows the new version.
      const view = await documentView(server);
      expect(view.body.lastKnownVersion).toBe(result.json.version);
    });

    it("keeps $, backticks and quotes from stdin and drops one trailing newline", async () => {
      const text = 'Costs $5 a seat; run `npm i` and "pin" it.\nSecond line.';
      const result = await run(["reply", doc, "c1", "-"], {
        stdin: `${text}\n`,
      });
      expect(result.exitCode).toBe(0);
      expect(entries().find((item) => item.id === "a1")?.text).toBe(text);
      expect(fs.readFileSync(doc, "utf8")).toContain(
        'body: "Costs $5 a seat; run `npm i` and \\"pin\\" it.<br>Second line."',
      );
    });

    it("refuses newline-only and delimiter text with nothing written", async () => {
      const blank = await run(["reply", doc, "c1", "-", "--json"], {
        stdin: "\n\n\n",
      });
      expect(blank.exitCode).toBe(1);
      expect(blank.json).toMatchObject({
        ok: false,
        status: "refused",
        exitCode: 1,
        written: false,
        error: { code: "REVIEW_REFUSED" },
      });
      expect(blank.json.errors[0].code).toBe("empty-reply");

      const markup = await run([
        "note",
        doc,
        "Closes early <<} here",
        "--json",
      ]);
      expect(markup.exitCode).toBe(1);
      expect(markup.json.errors[0].code).toBe("markup-in-reply");
      expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);
    });

    it("refuses an old-shape file and names doctor --fix", async () => {
      fs.writeFileSync(doc, LEGACY);
      const result = await run(["reply", doc, "c1", "Done."]);
      expect(result.exitCode).toBe(1);
      expect(result.errors[0]).toContain("run roughdraft doctor --fix first");
      expect(result.errors[1]).toContain("doctor --fix --dry-run");
      expect(fs.readFileSync(doc, "utf8")).toBe(LEGACY);
    });

    it("answers usage errors with exit 2", async () => {
      expect((await run(["reply", doc, "c1"])).exitCode).toBe(2);
      expect((await run(["note", doc])).exitCode).toBe(2);
      const missing = await run([
        "reply",
        path.join(projectDir, "nope.md"),
        "c1",
        "x",
        "--json",
      ]);
      expect(missing.exitCode).toBe(2);
      expect(missing.json.error.code).toBe("PATH_NOT_FOUND");
      const unknown = await run(["reply", doc, "c9", "x", "--json"]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.json.errors[0].code).toBe("unknown-thread");
    });

    it("writes --author as the entry's by, with an aN id", async () => {
      const result = await run([
        "reply",
        doc,
        "c1",
        "On it.",
        "--author",
        "Mike",
      ]);
      expect(result.exitCode).toBe(0);
      expect(entries().find((item) => item.id === "a1")).toMatchObject({
        author: "Mike",
        parentId: "c1",
      });
    });

    it("resolves with a summary, and a second resolve writes nothing", async () => {
      const first = await run([
        "resolve",
        doc,
        "c1",
        "--summary",
        "Cited the survey.",
        "--json",
      ]);
      expect(first.json).toMatchObject({ ok: true, written: true });
      expect(entries().find((item) => item.id === "c1")).toMatchObject({
        status: "resolved",
      });
      const before = fs.readFileSync(doc, "utf8");
      const second = await run(["resolve", doc, "c1", "--json"]);
      expect(second.exitCode).toBe(0);
      expect(second.json).toMatchObject({
        status: "already-applied",
        written: false,
      });
      expect(fs.readFileSync(doc, "utf8")).toBe(before);
    });

    it("adds a round note as a document-level aN entry", async () => {
      const result = await run([
        "note",
        doc,
        "Round 1: cited the survey.",
        "--json",
      ]);
      expect(result.json).toMatchObject({ ok: true, id: "a1" });
      expect(entries().find((item) => item.id === "a1")).toMatchObject({
        scope: "document",
        author: "AI",
      });
    });
  });

  describe("accept and reject", () => {
    beforeEach(() => {
      fs.copyFileSync(path.join(fixturesDir, "canonical-suggestions.md"), doc);
    });

    it("accepts a suggestion with no replies", async () => {
      const result = await run(["accept", doc, "s2", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.report.accepted).toEqual(["s2"]);
      const after = fs.readFileSync(doc, "utf8");
      const prose = after.slice(0, after.indexOf("\n---\n"));
      // s2 and its continuation s3 go as one suggestion.
      expect(prose).not.toContain("Delta paragraph");
      expect(prose).not.toContain("Epsilon paragraph");
      expect(after).not.toContain("{#s2}");
      expect(validateRoughdraftMarkdown(after).ok).toBe(true);
    });

    it("rejects a suggestion with no replies, keeping the original text", async () => {
      const result = await run(["reject", doc, "s2"]);
      expect(result.exitCode).toBe(0);
      const after = fs.readFileSync(doc, "utf8");
      expect(after).toContain("Delta paragraph repeats the budget numbers");
      expect(after).not.toContain("{#s2}");
    });

    it("refuses a suggestion with replies until --drop-replies", async () => {
      const before = fs.readFileSync(doc, "utf8");
      const refused = await run(["accept", doc, "s1", "--json"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.json.errors[0].code).toBe("thread-has-replies");
      expect(fs.readFileSync(doc, "utf8")).toBe(before);

      const accepted = await run([
        "accept",
        doc,
        "s1",
        "--drop-replies",
        "--json",
      ]);
      expect(accepted.exitCode).toBe(0);
      expect(accepted.json.report.droppedReplies).toEqual([
        expect.objectContaining({ thread: "s1", id: "c1" }),
      ]);
      expect(fs.readFileSync(doc, "utf8")).toContain(
        "Add one concrete example to the intro.",
      );
    });

    it("rejects a suggestion with replies when --drop-replies is given", async () => {
      const result = await run(["reject", doc, "s1", "--drop-replies"]);
      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(doc, "utf8")).toContain("Add  to the intro.");
    });
  });

  // ---------------------------------------------------------------- the 409 rerun

  describe("writing through the server", () => {
    function racingFetch(times: number): {
      fetchImpl: typeof fetch;
      puts: () => number;
    } {
      let puts = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        if (
          init?.method === "PUT" &&
          String(input).includes("/api/markdown-file")
        ) {
          puts += 1;
          if (puts <= times) {
            // Someone else writes between the CLI's read and its PUT.
            const text = fs.readFileSync(doc, "utf8");
            fs.writeFileSync(
              doc,
              text.replace(
                /The pilot is small on purpose[^\n]*/,
                `The pilot is small on purpose (edit ${puts}).`,
              ),
            );
          }
        }
        return fetch(input, init);
      };
      return { fetchImpl, puts: () => puts };
    }

    it("reruns after a 409 and keeps the other writer's change", async () => {
      await startServer();
      const race = racingFetch(2);
      const result = await run(["reply", doc, "c1", "Cited.", "--json"], {
        fetchImpl: race.fetchImpl,
      });
      expect(result.exitCode).toBe(0);
      expect(result.json.attempts).toBe(3);
      expect(race.puts()).toBe(3);
      const after = fs.readFileSync(doc, "utf8");
      expect(after).toContain("(edit 2)");
      expect(entries().filter((item) => item.id === "a1")).toHaveLength(1);
    });

    it("gives up after three reruns with nothing of its own written", async () => {
      await startServer();
      const race = racingFetch(100);
      const result = await run(["reply", doc, "c1", "Cited.", "--json"], {
        fetchImpl: race.fetchImpl,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        status: "error",
        written: false,
        attempts: 4,
        error: { code: "VERSION_CONFLICT", retryable: true },
      });
      expect(race.puts()).toBe(4);
      expect(entries().some((item) => item.id === "a1")).toBe(false);
    });
  });

  describe("the round flag around a quick command", () => {
    function roundMessages(tab: Tab) {
      return tab.messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.type === "round");
    }

    it("opens the flag before the write and closes it after", async () => {
      const server = await startServer();
      const tab = await openTab(server);

      const result = await run(["reply", doc, "c1", "Cited.", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.writtenVia).toBe("server");

      const rounds = await waitFor(
        () => roundMessages(tab),
        (list) => list.at(-1)?.message.round?.state === "closed",
      );
      expect(rounds.map(({ message }) => message.round.state)).toEqual([
        "open",
        "closed",
      ]);
      const [opened, closed] = rounds;
      expect(opened?.message.round.roundId).toMatch(/^quick-reply-/);
      expect(closed?.message.round.roundId).toBe(opened?.message.round.roundId);
      // The file change reaches the tab while the flag is open.
      const change = tab.messages.findIndex(
        (message) => message.type === "change",
      );
      expect(change).toBeGreaterThan(opened?.index ?? -1);
      expect(change).toBeLessThan(closed?.index ?? -1);
      expect((await documentView(server)).body.round.state).toBe("closed");
    });

    it("closes the flag when the command is refused", async () => {
      const server = await startServer();
      const tab = await openTab(server);

      const result = await run(["reply", doc, "c9", "Cited.", "--json"]);
      expect(result.exitCode).toBe(1);
      const rounds = await waitFor(
        () => roundMessages(tab),
        (list) => list.at(-1)?.message.round?.state === "closed",
      );
      expect(rounds.map(({ message }) => message.round.state)).toEqual([
        "open",
        "closed",
      ]);
    });

    it("leaves an open round's flag alone", async () => {
      const server = await startServer();
      const tab = await openTab(server);
      await fetch(`${server.url}/api/documents/round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          path: "plan.md",
          roundId: "r-1",
          state: "open",
        }),
      });
      await waitFor(
        () => roundMessages(tab),
        (list) => list.length === 1,
      );

      const result = await run(["resolve", doc, "c1", "--json"]);
      expect(result.exitCode).toBe(0);
      await waitFor(
        () => tab.messages.some((message) => message.type === "change"),
        Boolean,
      );
      expect(roundMessages(tab)).toHaveLength(1);
      expect((await documentView(server)).body.round).toMatchObject({
        roundId: "r-1",
        state: "open",
      });
    });

    it("does nothing with no server", async () => {
      const result = await run(["note", doc, "Round 1: cited.", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.writtenVia).toBe("disk");
    });
  });

  // ---------------------------------------------------------------- feedback

  it("lists every thread once with context, without starting a round", async () => {
    fs.writeFileSync(doc, TWO_THREADS);
    const result = await run(["feedback", doc, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      counts: { threads: 2, needsAnswer: 2 },
      legacyFormat: false,
    });
    expect(result.json.threads[1]).toMatchObject({
      id: "c2",
      body: "Who signs off?",
      anchor: { segments: [{ text: "the approver", line: 5 }] },
    });
    expect(fs.existsSync(path.join(stateDir, "rounds"))).toBe(false);

    const human = await run(["feedback", doc]);
    expect(human.logs[0]).toContain("2 thread(s), 2 waiting for an answer");
    expect(human.logs).toContain(
      "  c1 comment by user, line 3, needs an answer: Needs a source.",
    );
  });

  // ---------------------------------------------------------------- round and apply

  describe("round and apply", () => {
    async function startRound(extra: string[] = []): Promise<Json> {
      const result = await run(["round", doc, "--json", ...extra]);
      expect(result.exitCode).toBe(0);
      return result.json;
    }

    function fillResponse(round: Json, threads: Json, note?: string): void {
      const template = JSON.parse(
        fs.readFileSync(round.files.response, "utf8"),
      );
      template.threads = threads;
      if (note === undefined) delete template.note;
      else template.note = note;
      fs.writeFileSync(round.files.response, JSON.stringify(template, null, 2));
    }

    it("writes the round files under the state dir and never the document", async () => {
      const round = await startRound();
      const dir = path.join(stateDir, "rounds", round.roundId);
      expect(round.dir).toBe(dir);
      expect(fs.readdirSync(dir).sort()).toEqual([
        "base.md",
        "clean.md",
        "response.json",
        "round.json",
        "state.json",
      ]);
      expect(fs.readFileSync(path.join(dir, "base.md"), "utf8")).toBe(PLAN);
      expect(fs.readFileSync(path.join(dir, "clean.md"), "utf8")).toBe(
        "# Plan\n\nKeep this claim as written.\n\nThe pilot is small on purpose.\n\n",
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "response.json"), "utf8")),
      ).toEqual({
        roughdraftResponse: 1,
        roundId: round.roundId,
        partial: false,
        threads: { c1: { reply: "" } },
        note: "",
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "round.json"), "utf8")),
      ).toMatchObject({ roundId: round.roundId, counts: { threads: 1 } });
      expect(round).toMatchObject({
        ok: true,
        tabDirty: false,
        tabConflict: false,
        server: { running: false },
        roundFlag: "skipped",
      });
      expect(round.ackError).toContain("not running");
      expect(Object.values(readRoundIndex(stateDir))).toEqual([
        expect.objectContaining({
          roundId: round.roundId,
          cleanPath: path.join(dir, "clean.md"),
        }),
      ]);
      expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);
    });

    it("writes to --dir and still finds the round from there", async () => {
      const dir = path.join(tempDir, "work");
      const round = await startRound(["--dir", dir]);
      expect(round.files.clean).toBe(path.join(dir, "clean.md"));
      fillResponse(round, { c1: { reply: "Cited." } }, "Round 1.");
      const applied = await run(["apply", round.files.response, "--json"]);
      expect(applied.exitCode).toBe(0);
      expect(applied.json.replies).toEqual([{ thread: "c1", id: "a1" }]);
    });

    it("refuses an old-shape file with the doctor --fix message", async () => {
      fs.writeFileSync(doc, LEGACY);
      const result = await run(["round", doc, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.json.error.code).toBe("LEGACY_FORMAT");
      expect(fs.existsSync(path.join(stateDir, "rounds"))).toBe(false);
    });

    it("applies an edited clean.md and replies, then answers a retry with already-applied", async () => {
      const round = await startRound();
      const clean = fs.readFileSync(round.files.clean, "utf8");
      fs.writeFileSync(
        round.files.clean,
        clean.replace("small on purpose", "limited to three customers"),
      );
      fillResponse(
        round,
        { c1: { reply: "Cited the 2025 survey." } },
        "Round 1: one edit.",
      );

      const applied = await run(["apply", round.files.response, "--json"]);
      expect(applied.exitCode).toBe(0);
      expect(applied.json).toMatchObject({
        ok: true,
        status: "applied",
        exitCode: 0,
        written: true,
        writtenVia: "disk",
        document: doc,
        replies: [{ thread: "c1", id: "a1" }],
        note: "a2",
        replay: false,
      });
      const after = fs.readFileSync(doc, "utf8");
      expect(after).toContain("Keep {==this claim==}{#c1} as written.");
      expect(after).toContain("The pilot is limited to three customers.");
      expect(validateRoughdraftMarkdown(after).ok).toBe(true);
      expect(validateWithLegacyReader(after).ok).toBe(true);
      expect(readRoundIndex(stateDir)).toEqual({});

      const retry = await run(["apply", round.files.response, "--json"]);
      expect(retry.exitCode).toBe(0);
      expect(retry.json).toMatchObject({
        status: "already-applied",
        written: false,
        replay: true,
      });
      expect(fs.readFileSync(doc, "utf8")).toBe(after);
    });

    it("leaves the file byte-identical on --dry-run", async () => {
      const round = await startRound();
      fillResponse(round, { c1: { reply: "Cited." } }, "Round 1.");
      const before = fs.readFileSync(doc);
      const dry = await run([
        "apply",
        round.files.response,
        "--dry-run",
        "--json",
      ]);
      expect(dry.exitCode).toBe(0);
      expect(dry.json).toMatchObject({ dryRun: true, written: false });
      expect(dry.json.replies).toEqual([{ thread: "c1", id: "a1" }]);
      expect(fs.readFileSync(doc).equals(before)).toBe(true);
      // A dry run does not close the round.
      expect(Object.keys(readRoundIndex(stateDir))).toHaveLength(1);
    });

    it("refuses an unanswered thread with exit 1 and nothing written", async () => {
      fs.writeFileSync(doc, TWO_THREADS);
      const round = await startRound();
      fillResponse(round, { c1: { reply: "Cited." } });
      const result = await run(["apply", round.files.response, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        status: "refused",
        exitCode: 1,
        written: false,
        error: { code: "REVIEW_REFUSED" },
      });
      expect(result.json.errors).toEqual([
        expect.objectContaining({ code: "unanswered-thread", thread: "c2" }),
      ]);
      expect(fs.readFileSync(doc, "utf8")).toBe(TWO_THREADS);
      const human = await run(["apply", round.files.response]);
      expect(human.errors[0]).toContain(
        "Refused, nothing written (1 problem):",
      );
      expect(human.errors.join("\n")).toContain("  c2 unanswered-thread:");
    });

    it("--skip-failed drops a failing thread with the edit tied to it", async () => {
      fs.writeFileSync(doc, TWO_THREADS);
      const round = await startRound();
      const template = JSON.parse(
        fs.readFileSync(round.files.response, "utf8"),
      );
      template.threads = {
        c1: { reply: "Cited." },
        c2: { reply: "Bad <<} reply" },
      };
      template.edits = [{ anchor: "c2", new: "Dana Ruiz" }];
      delete template.note;
      fs.writeFileSync(round.files.response, JSON.stringify(template));

      const without = await run(["apply", round.files.response, "--json"]);
      expect(without.exitCode).toBe(1);

      const result = await run([
        "apply",
        round.files.response,
        "--skip-failed",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(
        result.json.skippedUnits.map((unit: Json) => unit.unit).sort(),
      ).toEqual(["c2", "edits[0]"]);
      expect(result.json.replies).toEqual([{ thread: "c1", id: "a1" }]);
      const after = fs.readFileSync(doc, "utf8");
      expect(after).toContain("Name {==the approver==}{#c2} here.");
      expect(after).not.toContain("Dana Ruiz");
    });

    it("reads the response from stdin", async () => {
      const round = await startRound();
      const response = JSON.stringify({
        roughdraftResponse: 1,
        roundId: round.roundId,
        threads: { c1: { reply: "From `stdin` with $HOME." } },
      });
      const result = await run(["apply", "-", "--json"], { stdin: response });
      expect(result.exitCode).toBe(0);
      expect(entries().find((item) => item.id === "a1")?.text).toBe(
        "From `stdin` with $HOME.",
      );
    });

    it("answers usage errors with exit 2", async () => {
      const notJson = path.join(tempDir, "bad.json");
      fs.writeFileSync(notJson, "{ nope");
      expect((await run(["apply", notJson])).exitCode).toBe(2);
      fs.writeFileSync(
        notJson,
        JSON.stringify({ roughdraftResponse: 1, roundId: "r-missing" }),
      );
      const missing = await run(["apply", notJson, "--json"]);
      expect(missing.exitCode).toBe(2);
      expect(missing.json.error.code).toBe("ROUND_NOT_FOUND");
      expect((await run(["apply"])).exitCode).toBe(2);
    });

    it("with a server: acknowledges the Done, reports the tab and opens and closes the round flag", async () => {
      const server = await startServer();
      const done = await fetch(`${server.url}/api/review-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: projectDir, path: "plan.md" }),
      });
      expect(done.ok).toBe(true);
      const tab = await openTab(server);

      const round = await startRound();
      expect(round.acked).toHaveLength(1);
      expect(round).toMatchObject({
        roundFlag: "open",
        tabDirty: false,
        tab: { tabs: 1 },
        server: { running: true },
      });
      await waitFor(
        () => tab.messages.filter((message) => message.type === "round"),
        (list) => list.length > 0,
      );
      expect((await documentView(server)).body.round).toMatchObject({
        roundId: round.roundId,
        state: "open",
      });
      const pending = await run(["pending", doc, "--json"]);
      expect(pending.json.handoffs).toEqual([]);

      fillResponse(round, { c1: { reply: "Cited." } }, "Round 1.");
      const applied = await run(["apply", round.files.response, "--json"]);
      expect(applied.json).toMatchObject({
        writtenVia: "server",
        roundFlag: "closed",
      });
      await waitFor(
        () => tab.messages.filter((message) => message.type === "round").at(-1),
        (last) => last?.round?.state === "closed",
      );
    });

    it("reports a dirty tab at round time and exits 4 when it stays dirty", async () => {
      const server = await startServer();
      const tab = await openTab(server);
      tab.presence({ dirty: true });
      await waitFor(
        async () => (await documentView(server)).body.tabsDirty,
        (count) => count === 1,
      );
      const round = await startRound();
      expect(round).toMatchObject({ tabDirty: true, tabConflict: false });
      fillResponse(round, { c1: { reply: "Cited." } });

      const result = await run([
        "apply",
        round.files.response,
        "--wait",
        "0.3",
        "--json",
      ]);
      expect(result.exitCode).toBe(4);
      expect(result.json).toMatchObject({
        ok: false,
        written: false,
        tabsDirty: 1,
        error: { code: "TAB_DIRTY", retryable: true },
      });
      expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);

      tab.presence({ dirty: false, conflict: true });
      const conflict = await run([
        "apply",
        round.files.response,
        "--wait",
        "0",
        "--json",
      ]);
      expect(conflict.exitCode).toBe(4);
      expect(conflict.json.tabsConflict).toBe(1);

      // The tab saves while apply waits.
      tab.presence({ dirty: true, conflict: false });
      setTimeout(() => tab.presence({ dirty: false }), 300);
      const waited = await run([
        "apply",
        round.files.response,
        "--wait",
        "5",
        "--json",
      ]);
      expect(waited.exitCode).toBe(0);
    });

    it("uses a browser save after the round as the baseline, so Jordan's edit is his", async () => {
      const server = await startServer();
      const round = await startRound();
      // The browser saves an edit of Jordan's comment through the server.
      const current = fs.readFileSync(doc, "utf8");
      const put = await fetch(`${server.url}/api/markdown-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          path: "plan.md",
          content: current.replace("Needs a source.", "Needs a 2025 source."),
        }),
      });
      expect(put.status).toBe(200);
      fillResponse(round, { c1: { reply: "Cited." } });
      const result = await run(["apply", round.files.response, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.json.errors[0]).toMatchObject({
        code: "thread-changed",
        thread: "c1",
      });
      expect(result.json.rebase.baselineUsed).toBe(true);
    });

    it("restores Jordan's comment changed outside Roughdraft", async () => {
      await startServer();
      const round = await startRound();
      fs.writeFileSync(
        doc,
        fs.readFileSync(doc, "utf8").replace("Needs a source.", "Mangled."),
      );
      fillResponse(round, { c1: { reply: "Cited." } });
      const result = await run(["apply", round.files.response, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ baseline: "not-used" });
      expect(result.json.restored).toEqual([
        expect.objectContaining({ id: "c1", what: "entry" }),
      ]);
      expect(fs.readFileSync(doc, "utf8")).toContain("Needs a source.");
    });
  });

  // ---------------------------------------------------------------- doctor --fix

  describe("doctor --fix", () => {
    it("converts with a backup and passes doctor --strict after", async () => {
      fs.copyFileSync(path.join(fixturesDir, "legacy-at-block.md"), doc);
      const original = fs.readFileSync(doc, "utf8");
      const result = await run(["doctor", "--fix", doc, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        ok: true,
        result: "converted",
        written: true,
        writtenVia: "disk",
      });
      expect(result.json.changes.length).toBeGreaterThan(0);
      expect(result.json.backup).toMatch(
        new RegExp(
          `${stateDir.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")}/backups/plan\\.\\d{8}T\\d{6}Z\\.md$`,
        ),
      );
      expect(fs.readFileSync(result.json.backup, "utf8")).toBe(original);
      expect((await run(["doctor", doc, "--strict"])).exitCode).toBe(0);
      // Converted files take agent writes now.
      expect((await run(["reply", doc, "c1", "Fine."])).exitCode).toBe(0);
    });

    it("--dry-run lists the changes and leaves the bytes alone", async () => {
      fs.copyFileSync(path.join(fixturesDir, "legacy-at-block.md"), doc);
      const before = fs.readFileSync(doc);
      const result = await run(["doctor", "--fix", doc, "--dry-run"]);
      expect(result.exitCode).toBe(0);
      expect(result.logs[0]).toBe(
        `${doc}: would convert (dry run, nothing written)`,
      );
      expect(fs.readFileSync(doc).equals(before)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "backups"))).toBe(false);
    });

    it("refuses a file that needs a person, exit 1, nothing written", async () => {
      fs.writeFileSync(
        doc,
        [
          "# Two bodies",
          "",
          'First {==one==}{>>Body one<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
          "",
          'Second {==two==}{>>Body two<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
          "",
        ].join("\n"),
      );
      const before = fs.readFileSync(doc);
      const result = await run(["doctor", "--fix", doc, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.json.error.code).toBe("NORMALIZE_REFUSED");
      expect(result.json.refused.length).toBeGreaterThan(0);
      expect(fs.readFileSync(doc).equals(before)).toBe(true);
    });

    it("leaves a canonical file alone with no backup", async () => {
      const result = await run(["doctor", "--fix", doc, "--json"]);
      expect(result.json).toMatchObject({
        result: "unchanged",
        written: false,
        backup: null,
      });
      expect(fs.readFileSync(doc, "utf8")).toBe(PLAN);
    });

    it("writes one Markdown dry-run report over three fixtures", async () => {
      const names = [
        "legacy-at-block.md",
        "canonical-document-comments.md",
        "two-bodies.md",
      ];
      const copies = names.map((name) => {
        const copy = path.join(projectDir, name);
        if (name === "two-bodies.md") {
          fs.writeFileSync(
            copy,
            [
              "# Two bodies",
              "",
              'First {==one==}{>>Body one<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
              "",
              'Second {==two==}{>>Body two<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
              "",
            ].join("\n"),
          );
        } else {
          fs.copyFileSync(path.join(fixturesDir, name), copy);
        }
        return copy;
      });
      const before = copies.map((copy) => fs.readFileSync(copy));
      const out = path.join(tempDir, "notes", "dry-run.md");
      const result = await run([
        "doctor",
        "--fix",
        "--dry-run",
        "--report",
        out,
        ...copies,
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.json.counts).toEqual({
        files: 3,
        converts: 1,
        unchanged: 1,
        refused: 1,
        error: 0,
      });
      copies.forEach((copy, index) => {
        expect(fs.readFileSync(copy).equals(before[index] as Buffer)).toBe(
          true,
        );
      });
      const report = fs.readFileSync(out, "utf8");
      expect(report).toContain("# Roughdraft doctor --fix: dry run");
      for (const name of names) expect(report).toContain(`## ${name}`);
      expect(report).toContain(
        "1 would convert, 1 already in the current format, 1 refused until a person fixes them",
      );
      expect(report).toContain("`duplicate-id`");
      // The report itself is safe to open in Roughdraft: no review items.
      const check = validateRoughdraftMarkdown(report);
      expect(check.summary.comments + check.summary.suggestions).toBe(0);
      expect(check.summary.endmatter).toBe("absent");
    });

    it("answers flag misuse with exit 2", async () => {
      expect((await run(["doctor", "--fix"])).exitCode).toBe(2);
      expect(
        (await run(["doctor", "--fix", doc, "--report", "x.md"])).exitCode,
      ).toBe(2);
      expect((await run(["doctor", "--fix", doc, doc])).exitCode).toBe(2);
      expect((await run(["doctor", doc, "--dry-run"])).exitCode).toBe(2);
    });
  });

  // ---------------------------------------------------------------- the round route

  describe("POST /api/documents/round", () => {
    async function post(server: RunningServer, body: Json) {
      const response = await fetch(`${server.url}/api/documents/round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: projectDir,
          path: "plan.md",
          ...body,
        }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    }

    it("opens, shows on the views and the tab channel, and closes", async () => {
      const server = await startServer();
      const tab = await openTab(server);
      expect(tab.messages[0]).toMatchObject({ type: "hello", round: null });

      const opened = await post(server, { roundId: "r-1", state: "open" });
      expect(opened).toMatchObject({
        status: 200,
        body: {
          ok: true,
          round: { roundId: "r-1", state: "open", closedAt: null },
        },
      });
      const message = await waitFor(
        () => tab.messages.find((entry) => entry.type === "round"),
        Boolean,
      );
      expect(message.round).toMatchObject({ roundId: "r-1", state: "open" });
      expect((await documentView(server)).body.round.state).toBe("open");
      const query = new URLSearchParams({
        projectPath: projectDir,
        path: "plan.md",
      });
      const status = await (
        await fetch(`${server.url}/api/review-events/status?${query}`)
      ).json();
      expect(status).toMatchObject({
        round: { state: "open" },
        tabsConflict: 0,
      });

      expect(
        (await post(server, { roundId: "r-2", state: "closed" })).status,
      ).toBe(409);
      expect(
        await post(server, { roundId: "r-1", state: "closed" }),
      ).toMatchObject({
        status: 200,
        body: { round: { state: "closed" } },
      });
      expect(
        (await post(server, { roundId: "r-1", state: "maybe" })).status,
      ).toBe(400);
      expect((await post(server, { state: "open" })).status).toBe(400);
    });

    it("turns an open round stalled after the stall time", async () => {
      const server = await startServer({ roundStallMs: 80 });
      const tab = await openTab(server);
      await post(server, { roundId: "r-1", state: "open" });
      const stalled = await waitFor(
        () =>
          tab.messages.find(
            (entry) =>
              entry.type === "round" && entry.round?.state === "stalled",
          ),
        Boolean,
      );
      expect(stalled.round.stalledAt).toEqual(expect.any(String));
      expect((await documentView(server)).body.round.state).toBe("stalled");
      // A stalled round can still be closed by its apply.
      expect(
        (await post(server, { roundId: "r-1", state: "closed" })).status,
      ).toBe(200);
      // A closed round never stalls.
      await post(server, { roundId: "r-2", state: "open" });
      await post(server, { roundId: "r-2", state: "closed" });
      await sleep(150);
      expect((await documentView(server)).body.round.state).toBe("closed");
    });
  });
});
