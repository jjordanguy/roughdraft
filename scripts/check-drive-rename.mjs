#!/usr/bin/env node
// Assumption 6 in the fork plan: Roughdraft writes documents with a temp file
// and a rename. Before that ships for Google Drive folders, run this on a
// scratch Markdown file inside Drive and check in the Drive web UI that the
// file kept its version history (three new versions), its sharing and its
// link.
//
//   pnpm build
//   node scripts/check-drive-rename.mjs "/Users/you/Library/CloudStorage/GoogleDrive-.../My Drive/rename-check.md"
//
// It writes the file three times through the server's own atomic writer
// (packages/server/dist/atomic-write.js), each time adding one check line to
// the end, and prints the inode, mtime and size before and after each write.
// A new inode on every write is expected: that is the rename. `--inplace`
// runs the same writes in place (the ROUGHDRAFT_WRITE_MODE=inplace escape
// hatch) for comparison. A missing file is created first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
const inplace = args.includes("--inplace");
const target = args.find((arg) => !arg.startsWith("--"));

if (!target || args.includes("--help")) {
  console.log(
    "Usage: node scripts/check-drive-rename.mjs <file.md> [--inplace]",
  );
  process.exit(target ? 0 : 2);
}

const writerPath = path.join(repoRoot, "packages/server/dist/atomic-write.js");
if (!fs.existsSync(writerPath)) {
  console.error(
    `check-drive-rename: ${writerPath} is missing; run \`pnpm build\` first.`,
  );
  process.exit(2);
}
const { resolveWriteTarget, sha256Hex, writeFileAtomic } = await import(
  pathToFileURL(writerPath).href
);

const file = path.resolve(target);
if (!file.toLowerCase().endsWith(".md")) {
  console.error("check-drive-rename: pass a .md file.");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, "# Roughdraft rename check\n\nA scratch file.\n");
  console.log(`Created ${file}`);
}

const mode = inplace ? "inplace" : "atomic";
const real = await resolveWriteTarget(file);
const original = fs.readFileSync(real, "utf8").replace(/\n?$/, "\n");

/** Extended attribute names (macOS), where a sync client may keep its item metadata. */
function attributes() {
  if (process.platform !== "darwin") return "";
  try {
    const names = execFileSync("/usr/bin/xattr", [real], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    return `  xattrs ${names.length > 0 ? names.join(", ") : "none"}`;
  } catch {
    return "";
  }
}

function describe(label) {
  const stat = fs.statSync(real);
  return `${label.padEnd(8)} inode ${String(stat.ino).padEnd(12)} mtime ${stat.mtime.toISOString()}  size ${stat.size}${attributes()}`;
}

console.log(`File: ${file}`);
if (real !== file) console.log(`Real path (symlink followed): ${real}`);
console.log(
  `Mode: ${mode === "atomic" ? "atomic (temp file in the same folder, fsync, rename)" : "in place"}`,
);
console.log(describe("before"));

const inodes = [fs.statSync(real).ino];
for (let write = 1; write <= 3; write += 1) {
  const current = fs.readFileSync(real);
  const content = `${original}\nRoughdraft rename check ${write} of 3 at ${new Date().toISOString()}.\n`;
  const result = await writeFileAtomic(file, content, {
    mode,
    expectedHash: sha256Hex(current),
  });
  if (result.status !== "written") {
    console.error(
      `write ${write}: the file changed while writing; nothing written. Run again.`,
    );
    process.exit(1);
  }
  if (fs.readFileSync(real, "utf8") !== content) {
    console.error(`write ${write}: the file does not hold what was written.`);
    process.exit(1);
  }
  inodes.push(fs.statSync(real).ino);
  console.log(describe(`write ${write}`));
  // Give a sync client a moment to see each version on its own.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const leftovers = fs
  .readdirSync(path.dirname(real))
  .filter(
    (name) =>
      name.startsWith(`.${path.basename(real)}.roughdraft-`) &&
      name.endsWith(".tmp"),
  );
const inodeChanges = inodes
  .slice(1)
  .filter((inode, index) => inode !== inodes[index]).length;
console.log("");
console.log(
  `Inode changed on ${inodeChanges} of 3 writes (expected ${mode === "atomic" ? "3" : "0"}). Temp files left: ${leftovers.length}.`,
);
console.log(
  "Now check in Google Drive (drive.google.com, right-click the file): Manage versions lists the new versions, Share shows the same people, and the file's link opens the same file.",
);
