import { createServer } from "./index.js";
import path from "node:path";
import fs from "node:fs";
import { findAvailablePort } from "./ports.js";
import { ROUGHDRAFT_DEFAULT_API_PORT } from "../defaults.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const projectDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "sandbox");

fs.mkdirSync(projectDir, { recursive: true });

const preferredPort = parseInt(
  process.env.API_PORT || String(ROUGHDRAFT_DEFAULT_API_PORT),
  10,
);
const port = await findAvailablePort(preferredPort);

if (port !== preferredPort) {
  console.log(
    `Preferred API port ${preferredPort} is busy, using ${port} instead.`,
  );
}

const stateDir =
  process.env.ROUGHDRAFT_STATE_DIR?.trim() ||
  path.join(repoRoot, ".roughdraft-state");

await createServer(port, projectDir, stateDir);
