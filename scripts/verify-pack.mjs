#!/usr/bin/env node
// Pack this checkout, install the tarball into a throwaway prefix, and prove
// the installed command starts and validates a Markdown file. Run before any
// global install of the fork: `pnpm test:pack`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pack-"));
const prefix = path.join(workDir, "prefix");
fs.mkdirSync(prefix, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    console.error(
      `${command} ${args.join(" ")} failed (exit ${result.status})`,
    );
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
  return result.stdout;
}

try {
  console.log(`Packing ${manifest.name}@${manifest.version} ...`);
  const packOutput = execFileSync(
    "npm",
    ["pack", "--pack-destination", workDir, "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packed = JSON.parse(packOutput);
  const tarball = path.join(workDir, packed[0].filename);
  console.log(`Installing ${packed[0].filename} into a temporary prefix ...`);
  run("npm", [
    "install",
    "-g",
    "--prefix",
    prefix,
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
    tarball,
  ]);

  const binDir =
    process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const bin = path.join(binDir, "roughdraft");
  const version = run(bin, ["--version"]).trim();
  if (version !== manifest.version) {
    console.error(
      `Installed command reports ${version}, expected ${manifest.version}.`,
    );
    process.exit(1);
  }
  console.log(`Installed command reports version ${version}.`);

  const fixture = path.join(workDir, "fixture.md");
  fs.writeFileSync(
    fixture,
    [
      "# Fixture",
      "",
      "Keep this.{>>Needs a source.<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-05T00:00:00.000Z"',
      "",
    ].join("\n"),
  );
  const doctor = JSON.parse(run(bin, ["doctor", fixture, "--json"]));
  if (doctor.ok !== true || doctor.summary?.comments !== 1) {
    console.error(
      "doctor did not validate the fixture:",
      JSON.stringify(doctor),
    );
    process.exit(1);
  }
  console.log("Installed command validates Markdown. verify-pack passed.");
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
