import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, writeFileAtomic, writeModeFromEnv } from "./atomic-write";
import { createApp } from "./index";

const serverRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-atomic-")),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const leftovers = (folder = dir) =>
  fs.readdirSync(folder).filter((name) => name.endsWith(".tmp"));

describe("writeFileAtomic", () => {
  it("replaces the file through a rename, keeps its permissions, leaves no temp file", async () => {
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "old\n");
    fs.chmodSync(file, 0o640);
    const before = fs.statSync(file).ino;
    const result = await writeFileAtomic(file, "new\n", { mode: "atomic" });
    expect(result).toEqual({ status: "written", path: file, mode: "atomic" });
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps the file's extended attributes (Finder tags) across the rename",
    async () => {
      const file = path.join(dir, "plan.md");
      fs.writeFileSync(file, "old\n");
      execFileSync("xattr", ["-w", "com.roughdraft.test-tag", "red", file]);
      const result = await writeFileAtomic(file, "new\n", { mode: "atomic" });
      expect(result.status).toBe("written");
      expect(
        execFileSync("xattr", ["-p", "com.roughdraft.test-tag", file], {
          encoding: "utf8",
        }).trim(),
      ).toBe("red");
      expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    },
  );

  it("keeps a symlinked path a symlink and writes the file it points to", async () => {
    const realDir = path.join(dir, "real");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "plan.md");
    fs.writeFileSync(real, "old\n");
    const link = path.join(dir, "plan.md");
    fs.symlinkSync(real, link);
    const result = await writeFileAtomic(link, "new\n", { mode: "atomic" });
    expect(result.status).toBe("written");
    expect(result.path).toBe(real);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(real);
    expect(fs.readFileSync(real, "utf8")).toBe("new\n");
    expect(leftovers(realDir)).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("writes in place (same inode) with ROUGHDRAFT_WRITE_MODE=inplace", async () => {
    expect(writeModeFromEnv({ ROUGHDRAFT_WRITE_MODE: "inplace" })).toBe(
      "inplace",
    );
    expect(writeModeFromEnv({ ROUGHDRAFT_WRITE_MODE: "INPLACE " })).toBe(
      "inplace",
    );
    expect(writeModeFromEnv({})).toBe("atomic");
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "old\n");
    const before = fs.statSync(file).ino;
    const result = await writeFileAtomic(file, "new\n", {
      mode: writeModeFromEnv({ ROUGHDRAFT_WRITE_MODE: "inplace" }),
      expectedHash: sha256Hex("old\n"),
    });
    expect(result.status).toBe("written");
    expect(fs.statSync(file).ino).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
  });

  it.each([
    "atomic",
    "inplace",
  ] as const)("refuses (%s) when the file changed right before the rename, and writes nothing", async (mode) => {
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "old\n");
    const result = await writeFileAtomic(file, "mine\n", {
      mode,
      expectedHash: sha256Hex("old\n"),
      beforeCommit: () => fs.writeFileSync(file, "someone else\n"),
    });
    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(file, "utf8")).toBe("someone else\n");
    expect(leftovers()).toEqual([]);
  });

  it("refuses when the file is gone before the rename", async () => {
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "old\n");
    const result = await writeFileAtomic(file, "mine\n", {
      mode: "atomic",
      expectedHash: sha256Hex("old\n"),
      beforeCommit: () => fs.rmSync(file),
    });
    expect(result.status).toBe("conflict");
    expect(fs.existsSync(file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

// A reader in another thread, reading the file as fast as it can while the
// server writes it, the way an agent's Read tool or the Drive uploader would.
const READER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const flag = new Int32Array(workerData.stop);
let reads = 0;
let partial = 0;
const samples = [];
while (Atomics.load(flag, 0) === 0) {
  let text;
  try {
    text = fs.readFileSync(workerData.file, "latin1");
  } catch {
    continue;
  }
  reads += 1;
  const fill = text.charAt(0);
  if (text.length !== workerData.size || text !== fill.repeat(workerData.size)) {
    partial += 1;
    if (samples.length < 3) samples.push(text.length);
  }
}
parentPort.postMessage({ reads, partial, samples });
`;

async function putManyWhileReading(mode: "atomic" | "inplace") {
  const size = 1024 * 1024;
  const file = path.join(dir, "big.md");
  fs.writeFileSync(file, "a".repeat(size));
  const { app } = createApp({
    homeDir: dir,
    serverRoot,
    staticDirPath: dir,
    writeMode: mode,
  });
  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(READER, {
    eval: true,
    workerData: { file, size, stop },
  });
  const report = new Promise<{
    reads: number;
    partial: number;
    samples: number[];
  }>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const statuses = new Set<number>();
  for (let index = 0; index < 200; index += 1) {
    const fill = String.fromCharCode(98 + (index % 24));
    const response = await request(app)
      .put("/api/markdown-file")
      .send({ projectPath: dir, path: "big.md", content: fill.repeat(size) });
    statuses.add(response.status);
  }
  Atomics.store(new Int32Array(stop), 0, 1);
  const result = await report;
  await worker.terminate();
  return { ...result, statuses: [...statuses], file };
}

describe("PUT /api/markdown-file is atomic", () => {
  it("a reader loop during 200 PUTs of a 1 MB body never sees a partial file", async () => {
    const result = await putManyWhileReading("atomic");
    expect(result.statuses).toEqual([200]);
    expect(result.reads).toBeGreaterThan(50);
    expect(result.partial).toBe(0);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("keeps a symlinked document a symlink", async () => {
    const realDir = path.join(dir, "real");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "plan.md");
    fs.writeFileSync(real, "# Plan\n");
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    fs.symlinkSync(real, path.join(project, "plan.md"));
    const { app } = createApp({ homeDir: dir, serverRoot, staticDirPath: dir });
    const response = await request(app)
      .put("/api/markdown-file")
      .send({ projectPath: project, path: "plan.md", content: "# Plan v2\n" });
    expect(response.status).toBe(200);
    expect(fs.lstatSync(path.join(project, "plan.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.readFileSync(real, "utf8")).toBe("# Plan v2\n");
  });

  it("writes in place (same inode) when the server runs with writeMode inplace", async () => {
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "# Plan\n");
    const inode = fs.statSync(file).ino;
    const atomic = createApp({ homeDir: dir, serverRoot, staticDirPath: dir });
    await request(atomic.app)
      .put("/api/markdown-file")
      .send({ projectPath: dir, path: "plan.md", content: "# Plan v2\n" });
    const renamedInode = fs.statSync(file).ino;
    expect(renamedInode).not.toBe(inode);
    const inplace = createApp({
      homeDir: dir,
      serverRoot,
      staticDirPath: dir,
      writeMode: "inplace",
    });
    const response = await request(inplace.app)
      .put("/api/markdown-file")
      .send({ projectPath: dir, path: "plan.md", content: "# Plan v3\n" });
    expect(response.status).toBe(200);
    expect(fs.statSync(file).ino).toBe(renamedInode);
    expect(fs.readFileSync(file, "utf8")).toBe("# Plan v3\n");
  });

  it("answers 409 when another writer lands between the server's read and its rename", async () => {
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "# Plan\n");
    let raced = false;
    const { app } = createApp({
      homeDir: dir,
      serverRoot,
      staticDirPath: dir,
      beforeWriteCommit: () => {
        if (raced) return;
        raced = true;
        fs.writeFileSync(file, "# Plan, edited by an agent\n");
      },
    });
    const response = await request(app)
      .put("/api/markdown-file")
      .send({
        projectPath: dir,
        path: "plan.md",
        content: "# Plan, from the tab\n",
        expectedContentHash: sha256Hex("# Plan\n"),
      });
    expect(response.status).toBe(409);
    expect(response.body.current).toMatchObject({
      content: "# Plan, edited by an agent\n",
      contentHash: sha256Hex("# Plan, edited by an agent\n"),
    });
    expect(fs.readFileSync(file, "utf8")).toBe("# Plan, edited by an agent\n");
  });
});
