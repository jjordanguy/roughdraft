import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../server/src/index";

// Each run gets its own state directory, so handoffs and wake routes from an
// earlier run (or from the real ~/.roughdraft) never leak into the tests.
const stateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "roughdraft-e2e-state-"),
);
const removeStateDir = () => {
  fs.rmSync(stateDir, { recursive: true, force: true });
};
process.on("exit", removeStateDir);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

await createServer(Number(process.env.API_PORT ?? 4317), undefined, stateDir);
