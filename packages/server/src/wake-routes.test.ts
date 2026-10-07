import fs from "node:fs";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactRoute } from "./wake-route-defaults";
import {
  doneMessage,
  fillBodyTemplate,
  parseWakeRouteBody,
  runWakeRoute,
  shellQuote,
  testPayload,
  WAKE_ROUTES_FILE,
  type WakePayload,
  type WakeRoute,
  WakeRouteStore,
} from "./wake-routes";

function route(overrides: Partial<WakeRoute>): WakeRoute {
  return {
    harness: "claude-code",
    kind: "command",
    label: null,
    verifiedAt: null,
    verifiedBy: null,
    lastError: null,
    ...overrides,
  };
}

const donePayload: WakePayload = {
  event: "done",
  message: "I'm done reviewing it's plan.md. Please check my comments.",
  documentPath: "/docs/it's plan.md",
  link: "http://localhost:7373/?path=%2Fdocs%2Fplan.md",
  counts: { comments: 4, suggestions: 2, unresolved: 5 },
  handoffId: "h-123",
  session: { harness: "claude-code", label: "Plan session", sessionId: "s-9" },
};

describe("wake routes", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-wake-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command route with the Roughdraft env and quoted placeholders", async () => {
    const envFile = path.join(dir, "env.txt");
    const argsFile = path.join(dir, "args.txt");
    const command = `env | grep ^ROUGHDRAFT_ | sort > "${envFile}"; printf '%s\\n' {file} {sessionId} > "${argsFile}"`;

    const outcome = await runWakeRoute(route({ command }), donePayload, {
      env: { PATH: process.env.PATH, ROUGHDRAFT_TOKEN: "secret" },
    });

    expect(outcome).toMatchObject({ sent: true, error: null });
    const env = fs.readFileSync(envFile, "utf8");
    expect(env).toContain("ROUGHDRAFT_EVENT=done");
    expect(env).toContain("ROUGHDRAFT_FILE=/docs/it's plan.md");
    expect(env).toContain("ROUGHDRAFT_COMMENTS=4");
    expect(env).toContain("ROUGHDRAFT_SUGGESTIONS=2");
    expect(env).toContain("ROUGHDRAFT_UNRESOLVED=5");
    expect(env).toContain("ROUGHDRAFT_HANDOFF_ID=h-123");
    expect(env).toContain("ROUGHDRAFT_SESSION_LABEL=Plan session");
    expect(env).toContain("ROUGHDRAFT_SESSION_ID=s-9");
    expect(env).toContain(`ROUGHDRAFT_LINK=${donePayload.link}`);
    expect(env).not.toContain("ROUGHDRAFT_TOKEN");
    expect(fs.readFileSync(argsFile, "utf8")).toBe("/docs/it's plan.md\ns-9\n");
  });

  it("records the exit code and stderr of a failing command", async () => {
    const outcome = await runWakeRoute(
      route({ command: "echo no session >&2; exit 3" }),
      donePayload,
    );

    expect(outcome.sent).toBe(false);
    expect(outcome.error).toBe("Command exited with 3: no session");
  });

  it("stops a command that runs past the timeout", async () => {
    const outcome = await runWakeRoute(
      route({ command: "sleep 5" }),
      donePayload,
      {
        timeoutMs: 100,
      },
    );

    expect(outcome).toMatchObject({
      sent: false,
      error: "Command timed out after 100 ms",
    });
    expect(outcome.durationMs).toBeLessThan(2_000);
  });

  describe("url routes", () => {
    let server: Server | null = null;

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      server = null;
    });

    async function listen(status: number): Promise<{
      url: string;
      bodies: unknown[];
      requests: { headers: Record<string, unknown>; raw: string }[];
    }> {
      const bodies: unknown[] = [];
      const requests: { headers: Record<string, unknown>; raw: string }[] = [];
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          requests.push({ headers: req.headers, raw });
          res.writeHead(status).end();
        });
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, "127.0.0.1", resolve),
      );
      const { port } = server.address() as AddressInfo;
      return { url: `http://127.0.0.1:${port}/hook`, bodies, requests };
    }

    it("posts the Done body to a url route", async () => {
      const hook = await listen(204);

      const outcome = await runWakeRoute(
        route({ kind: "url", url: hook.url }),
        donePayload,
      );

      expect(outcome).toMatchObject({ sent: true, error: null });
      expect(hook.bodies).toEqual([
        {
          type: "roughdraft.done",
          message: donePayload.message,
          documentPath: donePayload.documentPath,
          link: donePayload.link,
          counts: donePayload.counts,
          handoffId: "h-123",
          session: donePayload.session,
        },
      ]);
    });

    it("sends a url route's headers and fills its body template (the OpenClaw wake hook)", async () => {
      const hook = await listen(200);
      const parsed = parseWakeRouteBody("openclaw", {
        kind: "url",
        url: hook.url,
        headers: ["Authorization: Bearer hooks-token-1"],
        body: '{"text": {message}, "mode": "now", "agentId": "main"}',
        label: "Mike",
      });
      if (!("route" in parsed)) throw new Error(parsed.error);

      const done = await runWakeRoute(parsed.route, {
        ...donePayload,
        message:
          'I\'m done reviewing plan.md. Please check my comments. (4 comments, 2 suggestions)\nSay "ship it".',
      });
      const tested = await runWakeRoute(parsed.route, testPayload("openclaw"));

      expect(done).toMatchObject({ sent: true, error: null });
      expect(tested).toMatchObject({ sent: true, error: null });
      expect(hook.requests[0]?.headers).toMatchObject({
        authorization: "Bearer hooks-token-1",
        "content-type": "application/json",
      });
      expect(hook.requests[0]?.raw).toBe(
        '{"text": "I\'m done reviewing plan.md. Please check my comments. (4 comments, 2 suggestions)\\nSay \\"ship it\\".", "mode": "now", "agentId": "main"}',
      );
      expect(hook.bodies).toEqual([
        {
          text: 'I\'m done reviewing plan.md. Please check my comments. (4 comments, 2 suggestions)\nSay "ship it".',
          mode: "now",
          agentId: "main",
        },
        {
          text: "Roughdraft wake route test for openclaw.",
          mode: "now",
          agentId: "main",
        },
      ]);
    });

    it("treats a non-2xx answer as a failure", async () => {
      const hook = await listen(500);

      const outcome = await runWakeRoute(
        route({ kind: "url", url: hook.url }),
        testPayload("openclaw"),
      );

      expect(outcome).toMatchObject({
        sent: false,
        error: "URL answered HTTP 500",
      });
      expect(hook.bodies).toEqual([
        expect.objectContaining({ type: "roughdraft.test" }),
      ]);
    });
  });

  it("reports an unreachable url", async () => {
    const outcome = await runWakeRoute(
      route({ kind: "url", url: "http://127.0.0.1:9/unreachable" }),
      donePayload,
    );

    expect(outcome.sent).toBe(false);
    expect(outcome.error).toMatch(/fetch failed/);
  });

  it("persists routes and moves a corrupt routes file aside", () => {
    const store = new WakeRouteStore({ stateDir: dir });
    store.put(route({ command: "true" }));
    expect(
      new WakeRouteStore({ stateDir: dir }).get("claude-code"),
    ).toMatchObject({
      command: "true",
    });

    fs.writeFileSync(path.join(dir, WAKE_ROUTES_FILE), "[]");
    const fresh = new WakeRouteStore({ stateDir: dir });

    // Nothing stored: only the built-in routes are left.
    expect(fresh.list()).toEqual([
      expect.objectContaining({
        harness: "claude-code",
        kind: "claude-session",
      }),
      expect.objectContaining({ harness: "codex", kind: "codex-queue" }),
    ]);
    expect(fresh.warnings[0]).toContain("Moved it to");
  });

  it("ships a built-in claude-code route that a stored route replaces and remove restores", () => {
    const store = new WakeRouteStore({ stateDir: dir });
    expect(store.get("claude-code")).toMatchObject({ kind: "claude-session" });
    expect(store.get("openclaw")).toBeNull();

    store.put(route({ command: "notify {message}" }));
    expect(store.get("claude-code")).toMatchObject({ kind: "command" });
    expect(store.remove("claude-code")).toBe(true);
    expect(store.get("claude-code")).toMatchObject({ kind: "claude-session" });
    expect(store.remove("openclaw")).toBe(false);

    // An outcome on the built-in route is remembered across restarts.
    store.recordOutcome(
      "claude-code",
      { sent: true, error: null, durationMs: 3 },
      { at: "2026-10-06T10:00:00.000Z", by: "test" },
    );
    expect(
      new WakeRouteStore({ stateDir: dir }).get("claude-code"),
    ).toMatchObject({
      kind: "claude-session",
      verifiedAt: "2026-10-06T10:00:00.000Z",
      verifiedBy: "test",
    });
  });

  describe("claude-session routes", () => {
    // A fake Claude Code session: its record and key under <config>/sessions
    // and a socket that records the lines it receives.
    async function fakeSession(sessionId: string, token: string | null) {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-cc-"));
      fs.mkdirSync(path.join(configDir, "sessions"));
      const socketPath = path.join(configDir, "s.sock");
      const lines: string[] = [];
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
        });
        socket.on("end", () => {
          lines.push(...buffer.split("\n").filter(Boolean));
          socket.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(
        path.join(configDir, "sessions", `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId,
          hostSessionId: "local_abc",
          name: "Plan session",
          messagingSocketPath: socketPath,
          updatedAt: 5,
        }),
      );
      if (token) {
        fs.writeFileSync(
          path.join(configDir, "sessions", `${process.pid}.deadbeef.key`),
          JSON.stringify({ peerToken: token }),
        );
      }
      return {
        configDir,
        lines,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              fs.rmSync(configDir, { recursive: true, force: true });
              resolve();
            });
          }),
      };
    }

    it("posts the Done as a user turn after the auth line", async () => {
      const session = await fakeSession("s-9", "tok-1");
      try {
        const outcome = await runWakeRoute(
          route({ kind: "claude-session" }),
          donePayload,
          { claudeConfigDir: session.configDir },
        );
        expect(outcome).toMatchObject({ sent: true, error: null });
        expect(session.lines.map((line) => JSON.parse(line))).toEqual([
          { type: "auth", token: "tok-1" },
          {
            type: "user",
            message: {
              role: "user",
              content:
                "I'm done reviewing it's plan.md. Please check my comments.\n\nFile: /docs/it's plan.md\nLink: http://localhost:7373/?path=%2Fdocs%2Fplan.md\nNext: roughdraft round '/docs/it'\\''s plan.md'",
            },
          },
        ]);
      } finally {
        await session.close();
      }
    });

    it("finds the session by the desktop app's id and sends without auth when there is no key", async () => {
      const session = await fakeSession("s-9", null);
      try {
        const outcome = await runWakeRoute(
          route({ kind: "claude-session" }),
          testPayload("claude-code", "local_abc"),
          { claudeConfigDir: session.configDir },
        );
        expect(outcome.sent).toBe(true);
        expect(session.lines).toHaveLength(1);
        expect(JSON.parse(session.lines[0]).message.content).toContain(
          "Roughdraft wake route test for claude-code. It reached this session",
        );
      } finally {
        await session.close();
      }
    });

    it("fails with a reason when the session id is missing or not running", async () => {
      const session = await fakeSession("s-9", "tok-1");
      try {
        const missing = await runWakeRoute(
          route({ kind: "claude-session" }),
          testPayload("claude-code"),
          { claudeConfigDir: session.configDir },
        );
        expect(missing.sent).toBe(false);
        expect(missing.error).toContain("no Claude Code session id");

        const unknown = await runWakeRoute(
          route({ kind: "claude-session" }),
          testPayload("claude-code", "s-other"),
          { claudeConfigDir: session.configDir },
        );
        expect(unknown.sent).toBe(false);
        expect(unknown.error).toContain(
          "No running Claude Code session has the id s-other",
        );
        expect(session.lines).toEqual([]);
      } finally {
        await session.close();
      }
    });

    it("accepts the route kind without a target", () => {
      expect(
        parseWakeRouteBody("claude-code", { kind: "claude-session" }),
      ).toEqual({
        route: route({ kind: "claude-session" }),
      });
      expect(parseWakeRouteBody("x", { kind: "other" })).toEqual({
        error:
          'kind must be "command", "url", "claude-session" or "codex-queue"',
      });
    });
  });

  it("fills every template placeholder with a JSON string and leaves other braces alone", () => {
    expect(
      JSON.parse(
        fillBodyTemplate(
          '{"m": {message}, "f": {file}, "l": {link}, "s": {sessionId}, "e": {event}, "h": {handoffId}, "x": "{other}", "n": {"k": 1}}',
          donePayload,
        ),
      ),
    ).toEqual({
      m: donePayload.message,
      f: "/docs/it's plan.md",
      l: donePayload.link,
      s: "s-9",
      e: "done",
      h: "h-123",
      x: "{other}",
      n: { k: 1 },
    });
    // A test has no file, link, handoff or session: each becomes "".
    expect(
      JSON.parse(
        fillBodyTemplate(
          "[{file}, {link}, {handoffId}, {sessionId}, {event}]",
          testPayload("openclaw"),
        ),
      ),
    ).toEqual(["", "", "", "", "test"]);
  });

  it("validates url headers and body templates", () => {
    const url = "https://hooks.example/wake";
    expect(
      parseWakeRouteBody("openclaw", {
        kind: "url",
        url,
        headers: { Authorization: " Bearer x ", "X-Mode": "now" },
        body: ' {"text": {message}} ',
      }),
    ).toEqual({
      route: route({
        harness: "openclaw",
        kind: "url",
        url,
        headers: { Authorization: "Bearer x", "X-Mode": "now" },
        body: '{"text": {message}}',
      }),
    });
    // Without headers or a body the route keeps the fixed body.
    expect(
      parseWakeRouteBody("openclaw", { kind: "url", url, body: "" }),
    ).toEqual({
      route: route({ harness: "openclaw", kind: "url", url }),
    });

    const problem = (input: Record<string, unknown>) => {
      const parsed = parseWakeRouteBody("openclaw", {
        kind: "url",
        url,
        ...input,
      });
      return "error" in parsed ? parsed.error : null;
    };
    expect(problem({ headers: ["Authorization Bearer x"] })).toBe(
      'header "Authorization Bearer x" must be written "Name: value"',
    );
    expect(problem({ headers: ["Bad Name: x"] })).toContain(
      'header name "Bad Name" must be a token',
    );
    expect(problem({ headers: { "X-Empty": " " } })).toBe(
      "header X-Empty has no value",
    );
    expect(problem({ headers: { "X-Two": "a\nb" } })).toBe(
      "header X-Two must have a one-line value",
    );
    expect(problem({ body: '{"text": "{message}"}' })).toMatch(
      /^body is not JSON once its placeholders are filled in \(.+\)\. Placeholders become quoted JSON strings, so write them bare/,
    );
    expect(problem({ body: "{text: {message}}" })).toContain(
      "body is not JSON",
    );
    expect(
      parseWakeRouteBody("x", {
        kind: "command",
        command: "true",
        headers: ["A: b"],
      }),
    ).toEqual({ error: "headers and body apply only to kind url" });
  });

  it("redacts header values and keeps the routes file private", () => {
    const tokenRoute = route({
      harness: "openclaw",
      kind: "url",
      url: "https://hooks.example/wake",
      headers: { Authorization: "Bearer secret" },
      body: '{"text": {message}}',
    });
    expect(redactRoute(tokenRoute).headers).toEqual({
      Authorization: "<set>",
    });
    expect(tokenRoute.headers?.Authorization).toBe("Bearer secret");

    // A file written before this change (0644) becomes 0600 on the next save.
    const filePath = path.join(dir, WAKE_ROUTES_FILE);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, routes: {} }),
      { mode: 0o644 },
    );
    fs.chmodSync(filePath, 0o644);
    const store = new WakeRouteStore({ stateDir: dir });
    store.put(tokenRoute);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(new WakeRouteStore({ stateDir: dir }).get("openclaw")).toEqual(
      tokenRoute,
    );
  });

  it("queues a Done for the Codex session through a codex-queue route", async () => {
    const bin = path.join(dir, "codex");
    const argsFile = path.join(dir, "args");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\n`, {
      mode: 0o755,
    });
    const codexDone = {
      ...donePayload,
      session: { ...donePayload.session, harness: "codex", sessionId: "t-7" },
    };

    const outcome = await runWakeRoute(
      route({ harness: "codex", kind: "codex-queue" }),
      codexDone,
      { codexBin: bin },
    );

    expect(outcome).toMatchObject({ sent: true, error: null });
    expect(fs.readFileSync(argsFile, "utf8").split("\0").slice(0, -1)).toEqual([
      "queue",
      "--thread",
      "t-7",
      "--message",
      "I'm done reviewing it's plan.md. Please check my comments.\n\nFile: /docs/it's plan.md\nLink: http://localhost:7373/?path=%2Fdocs%2Fplan.md\nNext: roughdraft round '/docs/it'\\''s plan.md'",
    ]);

    const store = new WakeRouteStore({ stateDir: dir });
    expect(store.get("codex")).toMatchObject({ kind: "codex-queue" });
    expect(
      parseWakeRouteBody("codex", { kind: "codex-queue", label: "mine" }),
    ).toEqual({
      route: route({ harness: "codex", kind: "codex-queue", label: "mine" }),
    });
  });

  it("validates route bodies", () => {
    expect(
      parseWakeRouteBody("bad name", { kind: "command", command: "x" }),
    ).toHaveProperty("error");
    expect(
      parseWakeRouteBody("ok", { kind: "url", url: "file:///etc" }),
    ).toEqual({
      error: "url must be an http or https URL",
    });
    expect(
      parseWakeRouteBody("ok", {
        kind: "command",
        command: " notify ",
        label: "Mac",
      }),
    ).toEqual({
      route: route({ harness: "ok", command: "notify", label: "Mac" }),
    });
  });

  it("builds the Done message with the overall comment on its own line", () => {
    expect(
      doneMessage(
        "/docs/plan.md",
        { comments: 4, replies: 1, suggestions: 2, unresolved: 5 },
        "Tighten the intro.",
      ),
    ).toBe(
      "I'm done reviewing plan.md. Please check my comments. (4 comments, 2 suggestions)\nTighten the intro.",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
