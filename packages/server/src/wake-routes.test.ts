import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doneMessage,
  parseWakeRouteBody,
  runWakeRoute,
  shellQuote,
  testPayload,
  type WakePayload,
  type WakeRoute,
  WAKE_ROUTES_FILE,
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

    async function listen(
      status: number,
    ): Promise<{ url: string; bodies: unknown[] }> {
      const bodies: unknown[] = [];
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(status).end();
        });
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, "127.0.0.1", resolve),
      );
      const { port } = server.address() as AddressInfo;
      return { url: `http://127.0.0.1:${port}/hook`, bodies };
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

    expect(fresh.list()).toEqual([]);
    expect(fresh.warnings[0]).toContain("Moved it to");
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
