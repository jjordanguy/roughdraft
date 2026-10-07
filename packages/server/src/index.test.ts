import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

describe("createApp", () => {
  let projectDir: string;
  let homeDir: string;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-server-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates a markdown page on disk", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app)
      .post("/api/pages")
      .send({ title: "Draft", projectPath: projectDir });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: "untitled-1",
      title: "Draft",
      content: "# Draft\n",
    });
    expect(response.body.version).toEqual(expect.any(String));

    const filePath = path.join(projectDir, "untitled-1.md");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# Draft\n");
  });

  it("reads nested markdown files inside the project", async () => {
    const nestedDir = path.join(projectDir, "notes");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# Nested draft\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "notes/draft.md",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "notes/draft",
      title: "Nested draft",
      content: "# Nested draft\n",
    });
    expect(response.body.version).toEqual(expect.any(String));
  });

  it("lists, updates, and deletes page-backed markdown files", async () => {
    fs.writeFileSync(path.join(projectDir, "alpha.md"), "# Alpha\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const listResponse = await request(app).get("/api/pages").query({
      projectPath: projectDir,
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual([
      { id: "alpha", title: "Alpha", content: "# Alpha\n" },
    ]);

    const readResponse = await request(app).get("/api/pages/alpha").query({
      projectPath: projectDir,
    });
    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual({
      id: "alpha",
      title: "Alpha",
      content: "# Alpha\n",
    });

    const updateResponse = await request(app)
      .put("/api/pages/alpha")
      .query({ projectPath: projectDir })
      .send({ content: "# Beta\n" });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body).toEqual({
      id: "alpha",
      title: "Beta",
      content: "# Beta\n",
    });
    expect(fs.readFileSync(path.join(projectDir, "alpha.md"), "utf-8")).toBe(
      "# Beta\n",
    );

    const deleteResponse = await request(app).delete("/api/pages/alpha").query({
      projectPath: projectDir,
    });
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body).toEqual({ ok: true });
    expect(fs.existsSync(path.join(projectDir, "alpha.md"))).toBe(false);
  });

  it("saves a markdown file when the expected version matches", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Original\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "draft.md",
    });

    const saveResponse = await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "draft.md" })
      .send({
        content: "# Saved\n",
        expectedVersion: readResponse.body.version,
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toMatchObject({
      id: "draft",
      title: "Saved",
      content: "# Saved\n",
    });
    expect(saveResponse.body.version).toEqual(expect.any(String));
    expect(fs.readFileSync(path.join(projectDir, "draft.md"), "utf-8")).toBe(
      "# Saved\n",
    );
  });

  it("creates a missing markdown file when the save asks for it", async () => {
    const { app } = createApp({ homeDir, staticDirPath: projectDir });
    const missing = await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "recreated.md" })
      .send({ content: "# Back\n\nFrom the draft.\n" });
    expect(missing.status).toBe(404);

    const created = await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "recreated.md" })
      .send({ content: "# Back\n\nFrom the draft.\n", create: true });
    expect(created.status).toBe(200);
    expect(created.body.content).toBe("# Back\n\nFrom the draft.\n");
    expect(fs.readFileSync(path.join(projectDir, "recreated.md"), "utf8")).toBe(
      "# Back\n\nFrom the draft.\n",
    );
  });

  it("rejects stale markdown-file writes", async () => {
    const nestedDir = path.join(projectDir, "notes");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# Original\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "notes/draft.md",
    });

    fs.writeFileSync(path.join(nestedDir, "draft.md"), "# External change\n");

    const staleWriteResponse = await request(app)
      .put("/api/markdown-file")
      .query({
        projectPath: projectDir,
        path: "notes/draft.md",
      })
      .send({
        content: "# Roughdraft change\n",
        expectedVersion: readResponse.body.version,
      });

    expect(staleWriteResponse.status).toBe(409);
    expect(staleWriteResponse.body).toMatchObject({
      error: "Markdown file changed on disk",
      current: {
        id: "notes/draft",
        title: "External change",
        content: "# External change\n",
      },
    });
    expect(staleWriteResponse.body.current.version).toEqual(expect.any(String));
    expect(fs.readFileSync(path.join(nestedDir, "draft.md"), "utf-8")).toBe(
      "# External change\n",
    );
  });

  it("rejects stale markdown-file writes when file metadata is unchanged", async () => {
    const filePath = path.join(projectDir, "draft.md");
    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    fs.writeFileSync(filePath, "# Original\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const readResponse = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "draft.md",
    });

    fs.writeFileSync(filePath, "# External\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    const staleWriteResponse = await request(app)
      .put("/api/markdown-file")
      .query({
        projectPath: projectDir,
        path: "draft.md",
      })
      .send({
        content: "# Roughdraft\n",
        expectedVersion: readResponse.body.version,
      });

    expect(staleWriteResponse.status).toBe(409);
    expect(staleWriteResponse.body).toMatchObject({
      error: "Markdown file changed on disk",
      current: {
        id: "draft",
        title: "External",
        content: "# External\n",
      },
    });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("# External\n");
  });

  describe("markdown-file equality on content", () => {
    const sha256 = (content: string | Buffer) =>
      crypto.createHash("sha256").update(content).digest("hex");

    function appFor() {
      return createApp({ homeDir, staticDirPath: projectDir }).app;
    }

    function read(app: ReturnType<typeof appFor>, file = "draft.md") {
      return request(app)
        .get("/api/markdown-file")
        .query({ projectPath: projectDir, path: file });
    }

    function write(
      app: ReturnType<typeof appFor>,
      body: Record<string, unknown>,
      file = "draft.md",
    ) {
      return request(app)
        .put("/api/markdown-file")
        .query({ projectPath: projectDir, path: file })
        .send(body);
    }

    it("PUT accepts a version whose content hash matches after a metadata-only change", async () => {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "# Original\n");
      const app = appFor();
      const page = await read(app);

      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(filePath, later, later);

      const saved = await write(app, {
        content: "# Saved\n",
        expectedVersion: page.body.version,
      });

      expect(saved.status).toBe(200);
      expect(fs.readFileSync(filePath, "utf8")).toBe("# Saved\n");
    });

    it("PUT decides on expectedContentHash and answers 409 with contentHash and seq", async () => {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "# Original\n");
      const app = appFor();
      const page = await read(app);
      fs.writeFileSync(filePath, "# Outside\n");

      const stale = await write(app, {
        content: "# Mine\n",
        expectedContentHash: page.body.contentHash,
      });

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        error: "Markdown file changed on disk",
        current: {
          id: "draft",
          content: "# Outside\n",
          contentHash: sha256("# Outside\n"),
          seq: page.body.seq + 1,
        },
      });

      const retried = await write(app, {
        content: "# Mine\n",
        expectedContentHash: stale.body.current.contentHash,
        // A stale expectedVersion is ignored when the hash is given.
        expectedVersion: page.body.version,
      });
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        content: "# Mine\n",
        contentHash: sha256("# Mine\n"),
        seq: page.body.seq + 2,
      });
    });

    it("GET and PUT agree on the version of a file with an invalid UTF-8 byte (probe F)", async () => {
      const filePath = path.join(projectDir, "latin1.md");
      const bytes = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
      fs.writeFileSync(filePath, bytes);
      const app = appFor();

      const page = await read(app, "latin1.md");
      expect(page.body.contentHash).toBe(sha256(bytes));
      expect(page.body.version.split(":").at(-1)).toBe(sha256(bytes));

      const saved = await write(
        app,
        {
          content: `${page.body.content}more\n`,
          expectedVersion: page.body.version,
        },
        "latin1.md",
      );

      expect(saved.status).toBe(200);
      expect(fs.readFileSync(filePath, "utf8")).toBe("# Caf�\nmore\n");
    });

    it("an identical-content PUT does not rewrite the file", async () => {
      const filePath = path.join(projectDir, "draft.md");
      const fixed = new Date("2026-01-01T00:00:00.000Z");
      fs.writeFileSync(filePath, "# Same\n");
      fs.utimesSync(filePath, fixed, fixed);
      const app = appFor();
      const page = await read(app);
      const statBefore = fs.statSync(filePath);

      const saved = await write(app, {
        content: "# Same\n",
        expectedVersion: page.body.version,
      });

      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        content: "# Same\n",
        version: page.body.version,
        contentHash: page.body.contentHash,
        seq: page.body.seq,
      });
      const statAfter = fs.statSync(filePath);
      expect(statAfter.mtimeMs).toBe(fixed.getTime());
      expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);
    });

    it("overlapping PUTs with the same base: one lands, the other conflicts (probe H)", async () => {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "# Base\n");
      const app = appFor();
      const page = await read(app);

      const [first, second] = await Promise.all([
        write(app, {
          content: "# Base\none\n",
          expectedVersion: page.body.version,
        }),
        write(app, {
          content: "# Base\none\ntwo\n",
          expectedVersion: page.body.version,
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);
    });
  });

  it("rejects markdown-file reads outside the project directory", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/markdown-file").query({
      projectPath: projectDir,
      path: "../secrets.md",
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Markdown file not found" });
  });

  it("accepts review completed events for a markdown file inside the project", async () => {
    fs.writeFileSync(
      path.join(projectDir, "draft.md"),
      [
        "# Draft",
        "",
        'Needs {==support==}{>>Add a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
      ].join("\n"),
    );
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).post("/api/review-events").send({
      projectPath: projectDir,
      path: "draft.md",
      overallComment: "Please address the risk section.",
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      delivered: false,
      event: {
        type: "review.completed",
        documentPath: path.join(projectDir, "draft.md"),
        projectPath: projectDir,
        relativePath: "draft.md",
        sequence: 1,
        overallComment: "Please address the risk section.",
        summary: {
          comments: 2,
          replies: 0,
          suggestions: 0,
          unresolved: 2,
        },
      },
    });
    expect(response.body.event.version).toEqual(expect.any(String));
    expect(response.body.event.createdAt).toEqual(expect.any(String));
  });

  it("persists an overall review comment as document-level YAML feedback before emitting the event", async () => {
    const filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      filePath,
      [
        "# Draft",
        "",
        "Needs {==support==}{>>Add a source<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "workflow:",
        "  owner: editorial",
        "",
      ].join("\n"),
    );
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).post("/api/review-events").send({
      projectPath: projectDir,
      path: "draft.md",
      overallComment: "Please address the risk section.",
    });

    const saved = fs.readFileSync(filePath, "utf-8");
    expect(response.status).toBe(201);
    expect(saved).toContain("workflow:\n  owner: editorial");
    expect(saved).toContain("  c1:");
    expect(saved).toContain("  c2:");
    expect(saved).toContain("    body: Please address the risk section.");
    expect(saved).toContain("    by: user");
    expect(response.body.event.summary).toMatchObject({
      comments: 2,
      replies: 0,
      suggestions: 0,
      unresolved: 2,
    });
  });

  it("omits whitespace-only overall comments from review events", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).post("/api/review-events").send({
      projectPath: projectDir,
      path: "draft.md",
      overallComment: "   \n\t  ",
    });

    expect(response.status).toBe(201);
    expect(response.body.event).not.toHaveProperty("overallComment");
  });

  it("rejects over-limit overall comments", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app)
      .post("/api/review-events")
      .send({
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "x".repeat(4001),
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "overallComment must be 4000 characters or fewer",
    });
  });

  it("rejects review events without a projectPath", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app)
      .post("/api/review-events")
      .send({ path: "draft.md" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "projectPath is required" });
  });

  it("rejects review events outside the project", async () => {
    const outsideFile = path.join(homeDir, "outside.md");
    fs.writeFileSync(outsideFile, "# Outside\n");
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app)
      .post("/api/review-events")
      .send({ projectPath: projectDir, path: "../outside.md" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Markdown file not found" });
  });

  it("returns retained review events to watchers", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const emitted = await request(app)
      .post("/api/review-events")
      .send({ projectPath: projectDir, path: "draft.md" });
    const watchResponse = await request(app)
      .post("/api/review-events/watch")
      .send({
        projectPath: projectDir,
        path: "draft.md",
        fromNow: false,
        timeoutSeconds: 1,
        batchWindowSeconds: 0,
      });

    expect(emitted.body.delivered).toBe(false);
    expect(watchResponse.status).toBe(200);
    expect(watchResponse.body).toMatchObject({
      timedOut: false,
      events: [
        {
          type: "review.completed",
          documentPath: path.join(projectDir, "draft.md"),
          relativePath: "draft.md",
        },
      ],
    });
  });

  it("reports active review watchers for a markdown file", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const waiting = request(app).post("/api/review-events/watch").send({
      projectPath: projectDir,
      path: "draft.md",
      timeoutSeconds: 1,
      batchWindowSeconds: 0,
    });
    const waitingPromise = waiting.then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const statusResponse = await request(app)
      .get("/api/review-events/status")
      .query({ projectPath: projectDir, path: "draft.md" });

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({
      watching: true,
      watcherCount: 1,
      documentPath: path.join(projectDir, "draft.md"),
    });

    await request(app)
      .post("/api/review-events")
      .send({ projectPath: projectDir, path: "draft.md" });
    await waitingPromise;
  });

  it("rejects page ids that resolve outside the project directory", async () => {
    const outsideName = `${path.basename(projectDir)}-secret`;
    const outsideFilePath = path.join(
      path.dirname(projectDir),
      `${outsideName}.md`,
    );
    fs.writeFileSync(outsideFilePath, "# Secret\n");

    try {
      const { app } = createApp({
        homeDir,
        staticDirPath: projectDir,
      });
      const traversalPath = `/api/pages/${encodeURIComponent(`../${outsideName}`)}`;

      const readResponse = await request(app).get(traversalPath).query({
        projectPath: projectDir,
      });
      const updateResponse = await request(app)
        .put(traversalPath)
        .query({
          projectPath: projectDir,
        })
        .send({ content: "# Updated\n" });
      const deleteResponse = await request(app).delete(traversalPath).query({
        projectPath: projectDir,
      });

      expect(readResponse.status).toBe(404);
      expect(readResponse.body).toEqual({ error: "Page not found" });
      expect(updateResponse.status).toBe(404);
      expect(updateResponse.body).toEqual({ error: "Page not found" });
      expect(deleteResponse.status).toBe(404);
      expect(deleteResponse.body).toEqual({ error: "Page not found" });
      expect(fs.readFileSync(outsideFilePath, "utf-8")).toBe("# Secret\n");
    } finally {
      fs.rmSync(outsideFilePath, { force: true });
    }
  });

  it("requires projectPath on project-backed routes", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/pages");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "projectPath is required" });
  });

  it("reports neutral server status without an active project", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4312,
    });

    const response = await request(app).get("/api/status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      backend: "local-files",
      pid: process.pid,
      port: 4312,
      serverRoot,
      version: expect.any(String),
      instanceId: expect.stringMatching(/^srv_/),
      stateless: true,
      stateDir: null,
      capabilities: {
        projectPathRequired: true,
        fileSystemBrowsing: true,
        reviewEventStream: true,
        documentRegistry: true,
        handoffLog: true,
        wakeRoutes: true,
        reviewRounds: true,
        tokenRequired: false,
      },
      warnings: [],
    });
    expect(response.body).not.toHaveProperty("projectDir");
  });

  it("reports update status with the registry check disabled", async () => {
    const packageJsonPath = path.join(projectDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "roughdraft", version: "0.1.0" }),
    );

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      packageJsonPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "0.2.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const response = await request(app).get("/api/update-status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: null,
      updateAvailable: false,
      updateCommand: "npm i -g roughdraft@latest",
    });
  });

  it("lists directories from the home directory when no path is provided", async () => {
    fs.mkdirSync(path.join(homeDir, "docs"));

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/directories");

    expect(response.status).toBe(200);
    expect(response.body.path).toBe(homeDir);
    expect(response.body.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docs",
          path: path.join(homeDir, "docs"),
        }),
      ]),
    );
  });

  it("lists markdown files and directories for the file picker", async () => {
    fs.mkdirSync(path.join(homeDir, "docs"));
    fs.writeFileSync(path.join(homeDir, "draft.md"), "# Draft\n");
    fs.writeFileSync(path.join(homeDir, "ignored.txt"), "Nope\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/fs/list");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      path: homeDir,
      displayPath: "~",
      parentPath: null,
    });
    expect(response.body.directories).toEqual([
      {
        name: "docs",
        path: path.join(homeDir, "docs"),
        kind: "directory",
      },
    ]);
    expect(response.body.files).toEqual([
      {
        name: "draft.md",
        path: path.join(homeDir, "draft.md"),
        kind: "file",
      },
    ]);
  });

  it("returns project tree paths with directories before files", async () => {
    fs.mkdirSync(path.join(projectDir, "notes", "nested"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(projectDir, "zeta.md"), "# Zeta\n");
    fs.writeFileSync(path.join(projectDir, "notes", "alpha.md"), "# Alpha\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const response = await request(app).get("/api/file-tree").query({
      projectPath: projectDir,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      paths: ["notes/", "notes/nested/", "notes/alpha.md", "zeta.md"],
    });
  });

  it("opens and creates project directories", async () => {
    const createdDir = path.join(projectDir, "created", "workspace");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4321,
    });

    const openResponse = await request(app)
      .post("/api/project/open")
      .send({ path: projectDir });
    expect(openResponse.status).toBe(200);
    expect(openResponse.body).toEqual({
      backend: "local-files",
      projectDir,
      port: 4321,
    });

    const createResponse = await request(app)
      .post("/api/project/create")
      .send({ path: createdDir });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toEqual({
      backend: "local-files",
      projectDir: createdDir,
      port: 4321,
    });
    expect(fs.statSync(createdDir).isDirectory()).toBe(true);
  });

  it("reports an undelivered open request when no matching window is listening", async () => {
    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
      port: 4312,
    });

    const response = await request(app)
      .post("/api/open-request")
      .send({
        path: path.join(projectDir, "draft.md"),
        url: "http://localhost:4312/?path=/tmp/draft.md",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      delivered: false,
      acknowledged: false,
      tabs: 0,
    });
  });

  it("serves local files and stores uploaded assets inside the project", async () => {
    fs.writeFileSync(path.join(projectDir, "image.txt"), "asset text\n");

    const { app } = createApp({
      homeDir,
      staticDirPath: projectDir,
    });

    const fileResponse = await request(app).get("/api/files").query({
      projectPath: projectDir,
      path: "image.txt",
    });
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.text).toBe("asset text\n");

    const assetResponse = await request(app)
      .post("/api/assets")
      .send({
        projectPath: projectDir,
        filename: "My Sketch.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("png bytes").toString("base64"),
      });

    expect(assetResponse.status).toBe(201);
    expect(assetResponse.body).toMatchObject({
      markdownPath: "./.roughdraft-assets/My-Sketch.png",
      mimeType: "image/png",
    });
    expect(assetResponse.body.previewUrl).toContain("/api/files?");
    expect(
      fs.readFileSync(
        path.join(projectDir, ".roughdraft-assets", "My-Sketch.png"),
        "utf-8",
      ),
    ).toBe("png bytes");
  });
});
