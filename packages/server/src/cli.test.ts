import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCliDependencies,
  createDefaultOpenUrl,
  ensureServerRunning,
  getServerStateFilePath,
  runCli,
} from "./cli";
import { createApp } from "./index";
import { ROUGHDRAFT_DEFAULT_PORT } from "./network";

interface StartedServer {
  close: () => Promise<void>;
}

async function listenOnLoopbackServers(
  port: number,
  app: ReturnType<typeof createApp>["app"],
): Promise<StartedServer> {
  const servers: Server[] = [];

  for (const host of ["127.0.0.1", "::1"]) {
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
            resolve();
            return;
          }

          reject(error);
        });

        server.listen(port, host, () => resolve());
      });
      if (server.listening) {
        servers.push(server);
      }
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      throw error;
    }
  }

  return {
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections?.();
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
    },
  };
}

describe("cli", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let devFrontendStateFile: string;
  let nextPid: number;
  let runningPids: Set<number>;
  let serverByPid: Map<number, StartedServer>;
  let portByPid: Map<number, number>;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const cliVersion = (
    JSON.parse(
      fs.readFileSync(path.join(serverRoot, "package.json"), "utf8"),
    ) as { version: string }
  ).version;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    devFrontendStateFile = path.join(tempDir, "dev-frontend.json");
    fs.mkdirSync(projectDir, { recursive: true });
    nextPid = 1000;
    runningPids = new Set<number>();
    serverByPid = new Map<number, StartedServer>();
    portByPid = new Map<number, number>();
  });

  function expectedOpenUrl(baseUrl: string, documentPath: string): string {
    const url = new URL(baseUrl);
    url.pathname = "/";
    url.searchParams.set("path", documentPath);
    return url.toString();
  }

  function parseOnlyJsonLog<T>(logs: string[]): T {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0] ?? "{}") as T;
  }

  function extractHelpExample(
    logs: string[],
    startLine: string,
    stopLine: string,
  ): string {
    const startIndex = logs.indexOf(startLine);
    const stopIndex = logs.indexOf(stopLine);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(startIndex);

    // Blank lines inside the example are kept (the review block needs the
    // blank line before `---`); leading and trailing ones are dropped.
    return `${logs
      .slice(startIndex + 1, stopIndex)
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim()}\n`;
  }

  async function noUpdateStatus() {
    return {
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
      updateCommand: "npm i -g roughdraft@latest",
    };
  }

  afterEach(async () => {
    await Promise.all(
      Array.from(serverByPid.values(), (server) => server.close()),
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestDependencies() {
    const logs: string[] = [];
    const errors: string[] = [];
    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        const port = Number.parseInt(url.port || "80", 10);
        const hasActiveServer = Array.from(portByPid.entries()).some(
          ([pid, activePort]) => runningPids.has(pid) && activePort === port,
        );

        if (url.pathname === "/api/status" && !hasActiveServer) {
          throw new Error("connect ECONNREFUSED");
        }

        return fetch(input, init);
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawnCount += 1;
        const pid = nextPid;
        nextPid += 1;
        const { app } = createApp({
          port,
          projectDir: nextProjectDir,
          serverRoot,
          staticDirPath: nextProjectDir,
        });
        const started = await listenOnLoopbackServers(port, app);
        runningPids.add(pid);
        serverByPid.set(pid, started);
        portByPid.set(pid, port);
        return { pid };
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
    });

    return {
      deps,
      logs,
      errors,
      getLastOpenedUrl: () => lastOpenedUrl,
      getSpawnCount: () => spawnCount,
    };
  }

  it("writes server state and reuses a running background server", async () => {
    const test = createTestDependencies();

    const first = await ensureServerRunning(test.deps, { projectDir });
    const second = await ensureServerRunning(test.deps, { projectDir });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.server.url).toBe(`http://localhost:${first.server.port}`);
    expect(test.getSpawnCount()).toBe(1);

    const stateFilePath = getServerStateFilePath(test.deps.env);
    const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as {
      port: number;
      pid: number;
      startedAt: string;
      url: string;
    };

    expect(persisted).toMatchObject({
      port: first.server.port,
      pid: first.server.pid,
      url: first.server.url,
    });
    expect(typeof persisted.startedAt).toBe("string");
  });

  it("auto-starts from open and opens the requested markdown file URL", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeTruthy();
  });

  it("prints an update notice after a successful human-readable command", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.1",
        latestVersion: "0.1.3",
        updateAvailable: true,
        updateCommand: "npm i -g roughdraft@latest",
      }),
    });

    expect(exitCode).toBe(0);
    expect(test.logs.at(-1)).toBe(
      "Roughdraft update available: 0.1.1 -> 0.1.3. Run `npm i -g roughdraft@latest` to update.",
    );
  });

  it("does not add an update notice to JSON command output", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      {
        ...test.deps,
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.1",
          latestVersion: "0.1.3",
          updateAvailable: true,
          updateCommand: "npm i -g roughdraft@latest",
        }),
      },
    );
    const payload = parseOnlyJsonLog<{ opened: boolean }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.opened).toBe(true);
  });

  it("keeps the original command result when the update check fails", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => {
        throw new Error("registry unavailable");
      },
    });

    expect(exitCode).toBe(0);
    expect(test.logs).not.toContain("registry unavailable");
  });

  it("reuses a connected document window before opening another browser window", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    let postedOpenRequest: { path?: string; url?: string } | null = null;
    let lastOpenedUrl: string | null = null;
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/open-request" && init?.method === "POST") {
          postedOpenRequest = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({ delivered: true, acknowledged: true, tabs: 1 }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "browser";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(postedOpenRequest).toEqual({
      path: documentPath,
      url: expectedOpenUrl(
        `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
        documentPath,
      ),
    });
    expect(lastOpenedUrl).toBeNull();
  });

  it("opens the default browser on macOS when Chrome is installed but not the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          expect(args?.join(" ")).toContain(
            "com.apple.launchservices.secure.plist",
          );
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.apple.Safari",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      { command: "open", args: ["http://localhost:4020/?file=draft.md"] },
    ]);
  });

  it("opens a Chrome app window on macOS when Chrome is the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.google.Chrome",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("chrome-app");
    expect(opened).toEqual([
      {
        command: "open",
        args: [
          "-na",
          "Google Chrome",
          "--args",
          "--app=http://localhost:4020/?file=draft.md",
        ],
      },
    ]);
  });

  it("opens the default browser on Windows without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "win32",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Windows");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "cmd",
        args: ["/c", "start", "", "http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  it("opens the default browser on Linux without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "linux",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Linux");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "xdg-open",
        args: ["http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  it("prints only the document URL from open --print-url", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--print-url"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.logs).toEqual([
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    ]);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("emits JSON from open --no-watch --json without scraping human prose", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };
    const payload = parseOnlyJsonLog<{
      opened: boolean;
      url: string;
      serverUrl: string;
      path: string;
      openMode: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      ok: true,
      status: "ok",
      exitCode: 0,
      opened: true,
      url: expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
      serverUrl: `http://localhost:${persisted.port}`,
      path: documentPath,
      openMode: "disabled",
      session: null,
    });
  });

  it("prefers the live dev frontend URL when it matches this checkout", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return fetch(input, init);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
  });

  it("posts the default open watcher to the dev API behind the live frontend", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let watchUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, _init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        // The dev API is an older-style server: no event stream capability,
        // so the watcher falls back to bounded long polls.
        if (
          url.pathname === "/api/status" &&
          (url.port === "5173" || url.port === "3000")
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: 3000,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/review-events/watch") {
          watchUrl = url.toString();
          return new Response(
            JSON.stringify({
              events: [{ documentPath, type: "review.completed" }],
              timedOut: false,
              nextSequence: 2,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected request: ${url.toString()}`);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
      resolveUpdateStatus: noUpdateStatus,
    });

    const exitCode = await runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
    expect(watchUrl).toBe("http://localhost:3000/api/review-events/watch");
  });

  it("falls back to the api server URL when the dev frontend hint is stale", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    const test = createTestDependencies();
    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
  });

  it("uses the preview-web frontend URL when that workflow is active", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: null,
          appPort: 5174,
          mode: "preview-web",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5174",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.href === "http://localhost:5174/") {
          return new Response("<!doctype html><html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5174", documentPath),
    );
  });

  it("rejects missing markdown files before opening", async () => {
    const test = createTestDependencies();
    const missingPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["open", missingPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(`roughdraft: Path not found: ${missingPath}`);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("stops the running server and removes persisted state", async () => {
    const test = createTestDependencies();

    await ensureServerRunning(test.deps, { projectDir });
    const stopExitCode = await runCli(["stop"], test.deps);
    const statusExitCode = await runCli(["status"], test.deps);

    expect(stopExitCode).toBe(0);
    expect(statusExitCode).toBe(1);
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeFalsy();
    expect(test.logs).toContain(
      "Roughdraft is not running. Start it with `roughdraft start`.",
    );
  });

  it("returns successful JSON status when Roughdraft is not running", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      stateFile: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      ok: true,
      status: "ok",
      exitCode: 0,
      running: false,
      stateFile: getServerStateFilePath(test.deps.env),
      source: "disk",
      pendingHandoffs: 0,
    });
  });

  it("emits JSON from status when Roughdraft is running", async () => {
    const test = createTestDependencies();
    const result = await ensureServerRunning(test.deps, { projectDir });

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      url: string;
      port: number;
      pid: number;
      startedAt: string;
      stateFile: string;
      managed: boolean;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      ok: true,
      status: "ok",
      exitCode: 0,
      running: true,
      url: result.server.url,
      port: result.server.port,
      pid: result.server.pid,
      startedAt: result.server.startedAt,
      stateFile: getServerStateFilePath(test.deps.env),
      managed: true,
      serverVersion: cliVersion,
      cliVersion,
      versionMatches: true,
      instanceId: expect.stringMatching(/^srv_/),
      documents: [],
      pendingHandoffs: 0,
    });
  });

  it("prints watch and mcp in top-level help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("watch <path>");
    expect(test.logs.join("\n")).toContain("mcp");
  });

  it("waits for a review completed event from watch --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const watchPromise = runCli(
      [
        "watch",
        documentPath,
        "--json",
        "--timeout",
        "2",
        "--batch-window",
        "0",
      ],
      test.deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "Please prioritize the CLI contract.",
      }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{
        documentPath: string;
        overallComment?: string;
        type: string;
      }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.timedOut).toBe(false);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      documentPath,
      overallComment: "Please prioritize the CLI contract.",
      type: "review.completed",
    });
  });

  it("arms the watcher before opening the window, so a Done clicked as the window opens is returned (T10.1)", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    const order: string[] = [];
    let streamUrl: URL | null = null;
    let donePosted: Promise<Response> | null = null;
    const deps = {
      ...test.deps,
      fetchImpl: async (input: Parameters<typeof fetch>[0], init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (url.pathname === "/api/review-events/stream") {
          order.push("stream");
          streamUrl = url;
        }
        return test.deps.fetchImpl(input, init);
      },
      openUrl: (url: string) => {
        order.push("open");
        // The Done lands while the CLI is still printing "Opened ...".
        donePosted = fetch(new URL("/api/review-events", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
        });
        return "chrome-app" as const;
      },
    };

    const exitCode = await runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      { ...deps, env: { ...deps.env, ROUGHDRAFT_NO_OPEN: "" } },
    );
    await donePosted;
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };
    const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

    expect(exitCode).toBe(0);
    expect(order).toEqual(["stream", "open"]);
    expect(streamUrl?.searchParams.has("timeoutSeconds")).toBe(false);
    expect(streamUrl?.searchParams.get("includePending")).toBe("1");
    expect(payload).toMatchObject({
      ok: true,
      status: "completed",
      exitCode: 0,
      path: documentPath,
      url: expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
      serverUrl: `http://localhost:${persisted.port}`,
      openMode: "chrome-app",
      session: null,
      server: {
        url: `http://localhost:${persisted.port}`,
        instanceId: expect.stringMatching(/^srv_/),
      },
      handoff: { sequence: 1, state: "delivered" },
      timedOut: false,
      nextSequence: 2,
      events: [{ documentPath, type: "review.completed", sequence: 1 }],
    });
    // One progress line on stderr (plus a busy-port note on some machines).
    expect(
      test.errors.filter((line) => !line.startsWith("Preferred port")),
    ).toEqual([
      `Opened Roughdraft in a Chrome app window: ${payload.url}. Waiting for Done Reviewing.`,
    ]);
  });

  it("cleans stale state during status checks", async () => {
    const test = createTestDependencies();
    const stateFilePath = getServerStateFilePath(test.deps.env);

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: 3999,
        pid: 999999,
        startedAt: new Date().toISOString(),
        url: "http://localhost:3999",
      }),
    );

    const exitCode = await runCli(["status"], test.deps);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("reports and reuses an unmanaged server when the tracked pid is stale", async () => {
    const logs: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const statusExitCode = await runCli(["status"], deps);
    const openExitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      deps,
    );

    expect(statusExitCode).toBe(0);
    expect(openExitCode).toBe(0);
    expect(logs).toContain(
      `Roughdraft is running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
    );
    expect(logs).toContain(
      `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("rejects directories before opening", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", projectDir], test.deps);

    expect(exitCode).toBe(2);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(
      `roughdraft: Roughdraft can only open .md files: ${projectDir}`,
    );
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("cleans stale state and warns when another Roughdraft instance owns the port during stop", async () => {
    const errors: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: () => {},
      error: (message) => errors.push(message),
    });

    const stopExitCode = await runCli(["stop"], deps);

    expect(stopExitCode).toBe(1);
    expect(errors).toContain(
      `Stopped tracked Roughdraft process 424242, but another Roughdraft instance is still running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("stops a confidently identified unmanaged server with stop --all", async () => {
    const logs: string[] = [];
    let unmanagedRunning = true;
    let stoppedPid: number | null = null;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          unmanagedRunning &&
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              pid: 4242,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: (pid) => unmanagedRunning && pid === 4242,
      stopProcess: async (pid) => {
        stoppedPid = pid;
        unmanagedRunning = false;
      },
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["stop", "--all"], deps);

    expect(exitCode).toBe(0);
    expect(stoppedPid).toBe(4242);
    expect(logs).toContain(
      `Stopped unmanaged Roughdraft at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
  });

  it("describes the canonical review format in criticmarkup help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);
    const text = test.logs.join("\n");

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  A comment is an anchor in the prose plus an entry in the review block at the end of the file.",
    );
    expect(test.logs).toContain(
      "  Comment text never sits in the prose. The prose keeps only the anchor: {==the highlighted words==}{#c1}.",
    );
    expect(test.logs).toContain(
      "  Replies live only in the review block, as entries with `re: <parent id>`. Never write a reply in the prose.",
    );
    expect(text).toContain("A file has one review block");
    expect(text).toContain("<br>");
    expect(text).toContain("`a1`, `a2` for every entry an agent writes");
    expect(text).toContain("opening fence line");
    expect(text).toContain("`lines: [start, end]`");
    expect(text).toContain("`quote`");
    expect(text).toContain("`scope: document`");
    expect(test.logs).toContain("Older forms (read, never write):");
    expect(text).toContain("{>>text<<}{#c1}");
    expect(text).toContain('{id="c1" by="user" at="..."}');
    expect(text).toContain("{@id:c1; by:AI; at:...@}");
    expect(text).not.toContain("Prefer compact references like {>>Comment<<}");
    expect(test.logs).toContain(
      "  https://roughdraft.md/spec/roughdraft-flavored-markdown.md",
    );
  });

  it.each([
    {
      start: "Comment with a reply:",
      stop: "Comment on a code block:",
      summary: { roots: 1, documentComments: 0, replies: 1, suggestions: 0 },
    },
    {
      start: "Comment on a code block:",
      stop: "Document-level comments:",
      summary: { roots: 1, documentComments: 0, replies: 0, suggestions: 0 },
    },
    {
      start: "Document-level comments:",
      stop: "Suggested changes:",
      summary: { roots: 0, documentComments: 2, replies: 0, suggestions: 0 },
    },
    {
      start: "Suggested changes:",
      stop: "Older forms (read, never write):",
      summary: { roots: 0, documentComments: 0, replies: 0, suggestions: 2 },
    },
  ])("prints a copyable '$start' example that passes doctor with no diagnostics", async ({
    start,
    stop,
    summary,
  }) => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);
    const example = extractHelpExample(test.logs, start, stop);
    const validation = validateRoughdraftMarkdown(example);

    expect(exitCode).toBe(0);
    expect(validation.diagnostics).toEqual([]);
    expect(validation.summary).toMatchObject({
      ...summary,
      endmatter: "recognized",
    });
  });

  it("prints a code block example whose lines and quote match the block", async () => {
    const test = createTestDependencies();

    await runCli(["help", "criticmarkup"], test.deps);
    const example = extractHelpExample(
      test.logs,
      "Comment on a code block:",
      "Document-level comments:",
    );
    const index = extractRoughdraftReviewIndex(example);

    expect(index.items).toEqual([
      expect.objectContaining({
        id: "c1",
        scope: "code",
        lines: [1, 1],
        quote: "const port = 3000;",
      }),
    ]);
  });

  it("points general help to agent setup", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  help agent         Print the agent setup prompt",
    );
    expect(test.logs).toContain("Agent setup: https://roughdraft.md/setup.md");
    expect(test.logs).toContain(
      "Use `roughdraft help agent` for a copyable setup prompt.",
    );
  });

  it("prints a copyable agent setup prompt", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "agent"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "To set up your coding agent, paste this into it:",
    );
    expect(test.logs).toContain(
      "Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.",
    );
    expect(test.logs).toContain(
      "This command only prints setup text. It does not edit agent instruction files.",
    );
  });

  it("describes the review format in the agent setup text", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "agent"], test.deps);
    const text = test.logs.join(" ");

    expect(exitCode).toBe(0);
    expect(text).toContain("Comment text never sits in the prose.");
    expect(text).toContain("{==highlighted words==}{#c1}");
    expect(text).toContain("opening fence line");
    expect(text).toContain("`lines` and `quote`");
    expect(text).toContain("`scope: document`");
    expect(text).toContain("Replies live only in the review block");
    expect(text).toContain("`a1`, `a2`");
    expect(text).toContain("<br>");
    expect(text).toContain("roughdraft doctor <file>");
    expect(text).toContain("roughdraft help criticmarkup");
  });

  it("keeps CLAUDE.md as a short compatibility shim to AGENTS.md", () => {
    const claudePath = path.join(serverRoot, "CLAUDE.md");
    const claude = fs.readFileSync(claudePath, "utf8");

    expect(claude.length).toBeLessThan(200);
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain("compatibility shim");
    expect(fs.lstatSync(claudePath).isSymbolicLink()).toBe(false);
  });

  it("treats removed install command as an unknown command", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["install"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain("roughdraft: Unknown command: install.");
    expect(test.logs).toEqual([]);
  });

  it("prints package version only for --version", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--version"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows per-command help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  roughdraft open <path> [--no-open] [--no-watch] [--print-url] [--port <port>]",
    );
    expect(test.logs).toContain(
      "  --no-watch                Open the file without waiting",
    );
    expect(test.logs).toContain(
      "  --timeout <seconds>       Give up after this long (exit 4); omitted means no limit",
    );
    expect(test.logs.join("\n")).not.toContain("ROUGHDRAFT_HOST");
    expect(test.logs.join("\n")).not.toMatch(/remote mode/i);
  });

  it("shows doctor help with the optional markdown path", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["doctor", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("  roughdraft doctor [path] [--json]");
  });

  it("rejects unknown command typos with suggestions", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["stats"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      "roughdraft: Unknown command: stats. Did you mean status?",
    );
  });

  it("supports agent-setup as a direct setup helper", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["agent-setup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "Live setup instructions: https://roughdraft.md/setup.md",
    );
  });

  it("reports dev wrapper metadata from doctor --json", async () => {
    const logs: string[] = [];
    const wrapperPath = path.join(tempDir, "bin", "roughdraft-dev-lyon-v2");
    const devStateDir = path.join(
      tempDir,
      ".roughdraft",
      "dev",
      "roughdraft-dev-lyon-v2",
    );
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_DEV_WRAPPER_NAME: "roughdraft-dev-lyon-v2",
        ROUGHDRAFT_DEV_WRAPPER_PATH: wrapperPath,
        ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT: serverRoot,
        ROUGHDRAFT_STATE_DIR: devStateDir,
      },
      cwd: projectDir,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["doctor", "--json"], deps);
    const payload = parseOnlyJsonLog<{
      devWrapper: {
        commandName: string;
        path: string;
        repoRoot: string;
        repoRootMatches: boolean;
        stateDir: string;
      };
    }>(logs);

    expect(exitCode).toBe(0);
    expect(payload.devWrapper).toEqual({
      commandName: "roughdraft-dev-lyon-v2",
      path: wrapperPath,
      repoRoot: serverRoot,
      repoRootMatches: true,
      stateDir: devStateDir,
    });
  });

  it("validates a conforming markdown file from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    // Batch 3a: an inline comment body is the legacy form and now carries a
    // `legacy-inline-body` warning, so a conforming file uses the current
    // format (anchor in the text, comment text in the review block).
    fs.writeFileSync(
      documentPath,
      [
        "Please revisit {==this sentence==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Needs a source."',
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("Roughdraft Markdown doctor: draft.md");
    expect(test.logs).toContain("Status: passed");
    expect(test.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
  });

  it("returns validation errors from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "{>>Needs metadata<<}\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.logs).toContain("Status: failed");
    expect(test.logs).toContain("Errors:");
    expect(test.logs).toContain(
      "  1:1  Missing required metadata attribute `id`.",
    );
  });

  it("emits JSON validation output from doctor path --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      [
        '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
      ].join("\n"),
    );

    const exitCode = await runCli(
      ["doctor", documentPath, "--json"],
      test.deps,
    );
    const payload = parseOnlyJsonLog<{
      kind: string;
      path: string;
      ok: boolean;
      errors: Array<{ code: string }>;
      summary: { comments: number; suggestions: number };
    }>(test.logs);

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({
      kind: "markdown",
      path: documentPath,
      ok: false,
      summary: {
        comments: 1,
        suggestions: 1,
      },
    });
    expect(payload.errors.map((error) => error.code)).toContain("duplicate-id");
  });

  it("rejects missing markdown files from doctor path before validation", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      `roughdraft: Path not found: ${documentPath}`,
    );
  });

  it("rejects non-markdown doctor paths as usage errors", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.txt");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      `roughdraft: Roughdraft doctor can only validate .md files: ${documentPath}`,
    );
  });

  describe("doctor <file> counts and breakdown", () => {
    const fixturesDir = path.join(serverRoot, "docs", "spec", "fixtures");

    function copyFixture(name: string): string {
      const target = path.join(projectDir, name);
      fs.copyFileSync(path.join(fixturesDir, name), target);
      return target;
    }

    /** A final `---` section that looks like a review block, in a file with no review markup. */
    function writeIgnoredBlockFile(): string {
      const target = path.join(projectDir, "ignored.md");
      fs.writeFileSync(
        target,
        [
          "# Notes",
          "",
          "Plain prose, no review markup.",
          "",
          "---",
          "comments:",
          "  c1:",
          '    by: "user"',
          "",
        ].join("\n"),
      );
      return target;
    }

    it("prints the count line and the breakdown when warnings are present", async () => {
      const test = createTestDependencies();
      const documentPath = copyFixture("legacy-at-block.md");

      const exitCode = await runCli(["doctor", documentPath], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain("Status: passed");
      expect(test.logs).toContain("Warnings:");
      expect(test.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
      expect(test.logs).toContain(
        "Breakdown: roots 1, documentComments 0, replies 0, suggestions 0, endmatter absent",
      );
    });

    it("prints the breakdown for a canonical file with document comments and replies", async () => {
      const test = createTestDependencies();
      const documentPath = copyFixture("canonical-document-comments.md");

      const exitCode = await runCli(["doctor", documentPath], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain("Found 4 comment(s) and 0 suggestion(s).");
      expect(test.logs).toContain(
        "Breakdown: roots 1, documentComments 2, replies 1, suggestions 0, endmatter recognized",
      );
      expect(test.logs).not.toContain("Warnings:");
    });

    it("prints each diagnostic with its line and column, plus the counts, for an invalid file", async () => {
      const test = createTestDependencies();
      const documentPath = copyFixture("probe-R13-two-endmatter-blocks.md");

      const exitCode = await runCli(["doctor", documentPath], test.deps);

      expect(exitCode).toBe(1);
      expect(test.logs).toContain("Status: failed");
      expect(test.logs).toContain("Errors:");
      expect(test.logs.some((line) => /^ {2}\d+:\d+ {2}\S/.test(line))).toBe(
        true,
      );
      expect(test.logs).toContain(
        "Breakdown: roots 1, documentComments 0, replies 0, suggestions 0, endmatter invalid",
      );
    });

    it("fails on a warning with --strict (exit 1) and passes the same file without it", async () => {
      const documentPath = copyFixture("legacy-at-block.md");

      const lenient = createTestDependencies();
      expect(await runCli(["doctor", documentPath], lenient.deps)).toBe(0);

      const strict = createTestDependencies();
      const exitCode = await runCli(
        ["doctor", documentPath, "--strict"],
        strict.deps,
      );

      expect(exitCode).toBe(1);
      expect(strict.logs).toContain("Status: failed (--strict: 2 warning(s))");
      expect(strict.logs).toContain("Warnings:");
      expect(strict.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
    });

    it("passes a clean canonical file with --strict", async () => {
      const test = createTestDependencies();
      const documentPath = copyFixture("canonical-code-block.md");

      const exitCode = await runCli(
        ["doctor", documentPath, "--strict", "--json"],
        test.deps,
      );
      const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({ ok: true, status: "ok", strict: true });
    });

    it("reports a strict warning failure in the JSON envelope", async () => {
      const test = createTestDependencies();
      const documentPath = copyFixture("legacy-at-block.md");

      const exitCode = await runCli(
        ["doctor", documentPath, "--strict", "--json"],
        test.deps,
      );
      const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

      expect(exitCode).toBe(1);
      expect(payload).toMatchObject({
        ok: false,
        status: "error",
        exitCode: 1,
        strict: true,
        errors: [],
      });
      expect(payload.warnings).toHaveLength(2);
    });

    it("rejects --strict without a file as a usage error", async () => {
      const test = createTestDependencies();

      const exitCode = await runCli(["doctor", "--strict"], test.deps);

      expect(exitCode).toBe(2);
      expect(test.errors.join("\n")).toContain("--strict");
    });

    it.each([
      {
        label: "canonical",
        file: "canonical-document-comments.md",
        exitCode: 0,
        summary: {
          comments: 4,
          roots: 1,
          documentComments: 2,
          replies: 1,
          suggestions: 0,
          endmatter: "recognized",
        },
      },
      {
        label: "legacy",
        file: "probe-R14-doclevel.md",
        exitCode: 0,
        summary: {
          comments: 2,
          roots: 1,
          documentComments: 1,
          replies: 0,
          suggestions: 0,
          endmatter: "recognized",
        },
      },
      {
        label: "ignored",
        file: null,
        exitCode: 0,
        summary: {
          comments: 0,
          roots: 0,
          documentComments: 0,
          replies: 0,
          suggestions: 0,
          endmatter: "ignored",
        },
      },
      {
        label: "invalid",
        file: "probe-R02-duplicate-endmatter-key.md",
        exitCode: 1,
        summary: {
          comments: 1,
          roots: 1,
          documentComments: 0,
          replies: 0,
          suggestions: 0,
          endmatter: "invalid",
        },
      },
    ])("emits the breakdown and endmatter status in JSON for a $label file", async ({
      file,
      exitCode: expectedExit,
      summary,
    }) => {
      const test = createTestDependencies();
      const documentPath = file ? copyFixture(file) : writeIgnoredBlockFile();

      const exitCode = await runCli(
        ["doctor", documentPath, "--json"],
        test.deps,
      );
      const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

      expect(exitCode).toBe(expectedExit);
      expect(payload).toMatchObject({
        kind: "markdown",
        path: documentPath,
        ok: expectedExit === 0,
        exitCode: expectedExit,
        strict: false,
        endmatter: summary.endmatter,
        summary,
      });
      expect(summary.comments).toBe(
        summary.roots + summary.documentComments + summary.replies,
      );
    });
  });

  it("starts a new server when the preferred port belongs to another checkout", async () => {
    const stateFilePath = path.join(stateDir, "server.json");
    const otherServerRoot = path.join(tempDir, "other-checkout");
    let spawnedPort: number | null = null;
    let spawnedProjectDir: string | null = null;
    let spawned = false;

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname !== "/api/status") {
          throw new Error("Unexpected request");
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT)) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir: path.join(tempDir, "other-project"),
              serverRoot: otherServerRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT + 1) && spawned) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: cliVersion,
              port: ROUGHDRAFT_DEFAULT_PORT + 1,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      findAvailablePortImpl: async () => ROUGHDRAFT_DEFAULT_PORT + 1,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawned = true;
        spawnedPort = port;
        spawnedProjectDir = nextProjectDir;
        return { pid: 1001 };
      },
      isProcessRunning: (pid) => pid === 424242,
      stopProcess: async () => {},
      openUrl: () => "disabled",
      log: () => {},
      error: () => {},
    });

    const result = await ensureServerRunning(deps, { projectDir });

    expect(result.reused).toBe(false);
    expect(spawnedPort).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
    expect(spawnedProjectDir).toBe(projectDir);
    expect(result.server.port).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
  });

  it("refuses to reuse a running server of another version and points at restart", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const deps = createCliDependencies({
      env: { ...process.env, ROUGHDRAFT_STATE_DIR: stateDir },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              version: "0.1.10",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error("connect ECONNREFUSED");
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async () => {
        throw new Error("should not spawn while a mismatched server runs");
      },
      isProcessRunning: () => false,
    });

    expect(await runCli(["start"], deps)).toBe(3);
    expect(errors[0]).toContain("version 0.1.10");
    expect(errors[1]).toContain("roughdraft restart");

    const jsonExit = await runCli(["start", "--json"], deps);
    expect(jsonExit).toBe(3);
    const payload = JSON.parse(logs.at(-1) ?? "{}") as {
      ok: boolean;
      exitCode: number;
      error: { code: string; hint: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.exitCode).toBe(3);
    expect(payload.error.code).toBe("SERVER_VERSION_MISMATCH");
    expect(payload.error.hint).toContain("roughdraft restart");

    const statusExit = await runCli(["status", "--json"], deps);
    expect(statusExit).toBe(0);
    const status = JSON.parse(logs.at(-1) ?? "{}") as {
      running: boolean;
      serverVersion: string;
      cliVersion: string;
      versionMatches: boolean;
    };
    expect(status.running).toBe(true);
    expect(status.serverVersion).toBe("0.1.10");
    expect(status.cliVersion).toBe(cliVersion);
    expect(status.versionMatches).toBe(false);
  });

  it("keeps server.json and refuses when the tracked server was installed elsewhere", async () => {
    const stateFilePath = path.join(stateDir, "server.json");
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 515151,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );
    const errors: string[] = [];
    const deps = createCliDependencies({
      env: { ...process.env, ROUGHDRAFT_STATE_DIR: stateDir },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (url.pathname === "/api/status") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              pid: 515151,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot: "/opt/homebrew/lib/node_modules/roughdraft",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error("connect ECONNREFUSED");
      },
      log: () => {},
      error: (message) => errors.push(message),
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async () => {
        throw new Error("should not spawn beside another install's server");
      },
      isProcessRunning: (pid) => pid === 515151,
    });

    expect(await runCli(["start"], deps)).toBe(3);
    expect(errors[0]).toContain("older than 0.2.0");
    expect(fs.existsSync(stateFilePath)).toBe(true);
  });

  it("treats a server without a version as older and refuses it", async () => {
    const errors: string[] = [];
    const deps = createCliDependencies({
      env: { ...process.env, ROUGHDRAFT_STATE_DIR: stateDir },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (url.pathname === "/api/status") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error("connect ECONNREFUSED");
      },
      log: () => {},
      error: (message) => errors.push(message),
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
    });

    expect(await runCli(["start"], deps)).toBe(3);
    expect(errors[0]).toContain("older than 0.2.0");
  });

  it("restart stops the managed server and starts this version", async () => {
    const { deps, logs, getSpawnCount } = createTestDependencies();

    expect(await runCli(["start", "--json"], deps)).toBe(0);
    const started = JSON.parse(logs.at(-1) ?? "{}") as {
      pid: number;
      serverVersion: string;
      versionMatches: boolean;
    };
    expect(started.versionMatches).toBe(true);
    expect(started.serverVersion).toBe(cliVersion);

    expect(await runCli(["restart", "--json"], deps)).toBe(0);
    const restarted = JSON.parse(logs.at(-1) ?? "{}") as {
      running: boolean;
      pid: number;
      restarted: boolean;
      stoppedPid: number | null;
    };
    expect(restarted.running).toBe(true);
    expect(restarted.restarted).toBe(true);
    expect(restarted.stoppedPid).toBe(started.pid);
    expect(restarted.pid).not.toBe(started.pid);
    expect(getSpawnCount()).toBe(2);
    expect(runningPids.has(started.pid)).toBe(false);
    expect(runningPids.has(restarted.pid)).toBe(true);
  });

  it("restart with no server running simply starts one", async () => {
    const { deps, logs } = createTestDependencies();
    expect(await runCli(["restart"], deps)).toBe(0);
    expect(logs.at(-1)).toMatch(/^Roughdraft running at http:\/\/localhost:/);
  });
});
