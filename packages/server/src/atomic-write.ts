/**
 * Safe document writes: a temp file in the target's own folder, fsync, a
 * last check that the target still holds the bytes the caller read, rename
 * over it, then fsync the folder. A reader (an agent's Read tool, the Drive
 * uploader, another tab's GET) sees the old bytes or the new ones, never a
 * truncated file.
 *
 * The real path is resolved first, so a symlinked document keeps its symlink
 * and the file it points to is replaced. The temp file takes the target's
 * permission bits and, on macOS, its extended attributes.
 *
 * `ROUGHDRAFT_WRITE_MODE=inplace` is the escape hatch if the rename ever
 * misbehaves on a synced folder (assumption 6 in the fork plan): the same
 * check, then a plain in-place write.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export type WriteMode = "atomic" | "inplace";

export function writeModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WriteMode {
  return env.ROUGHDRAFT_WRITE_MODE?.trim().toLowerCase() === "inplace"
    ? "inplace"
    : "atomic";
}

export interface AtomicWriteOptions {
  /** Default: `ROUGHDRAFT_WRITE_MODE` from the environment, else atomic. */
  mode?: WriteMode;
  /**
   * sha256 (hex) the target must still have right before the rename (or the
   * in-place write). A different hash, or a missing target, is a conflict
   * and nothing is written. Null or omitted skips the check.
   */
  expectedHash?: string | null;
  /** Runs after the temp file is synced, right before the check. Tests use it to race a writer. */
  beforeCommit?: (realPath: string) => void | Promise<void>;
}

export type AtomicWriteResult =
  | { status: "written"; path: string; mode: WriteMode }
  | { status: "conflict"; path: string; mode: WriteMode };

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** The file a write should replace: symlinks followed; the path itself when it does not exist yet. */
export async function resolveWriteTarget(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  try {
    return await fs.promises.realpath(absolute);
  } catch {
    try {
      // A missing file in an existing (maybe symlinked) folder.
      return path.join(
        await fs.promises.realpath(path.dirname(absolute)),
        path.basename(absolute),
      );
    } catch {
      return absolute;
    }
  }
}

async function stillHolds(
  target: string,
  expectedHash: string | null | undefined,
): Promise<boolean> {
  if (!expectedHash) return true;
  try {
    return sha256Hex(await fs.promises.readFile(target)) === expectedHash;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

async function copyWithAttributes(
  target: string,
  temp: string,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("/bin/cp", ["-p", target, temp]);
    return true;
  } catch {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse fsync on a directory; the rename stands.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function tempPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.roughdraft-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const target = await resolveWriteTarget(filePath);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const mode = options.mode ?? writeModeFromEnv();

  if (mode === "inplace") {
    await options.beforeCommit?.(target);
    if (!(await stillHolds(target, options.expectedHash))) {
      return { status: "conflict", path: target, mode };
    }
    await fs.promises.writeFile(target, bytes);
    return { status: "written", path: target, mode };
  }

  let permissions = 0o644;
  try {
    permissions = (await fs.promises.stat(target)).mode & 0o7777;
  } catch {}
  const dir = path.dirname(target);
  const temp = tempPathFor(target);
  let committed = false;
  try {
    // On macOS the temp file starts as `cp -p` of the target, so the rename
    // keeps its extended attributes (Finder tags, a sync client's item
    // metadata) the way an editor's safe save does; Node's copyFile drops
    // them. Its bytes are then replaced.
    const copied = await copyWithAttributes(target, temp);
    const handle = await fs.promises.open(temp, copied ? "r+" : "wx", 0o600);
    try {
      await handle.truncate(0);
      await handle.writeFile(bytes);
      await handle.chmod(permissions);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeCommit?.(target);
    if (!(await stillHolds(target, options.expectedHash))) {
      return { status: "conflict", path: target, mode };
    }
    await fs.promises.rename(temp, target);
    committed = true;
    await syncDirectory(dir);
    return { status: "written", path: target, mode };
  } finally {
    if (!committed) await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}
