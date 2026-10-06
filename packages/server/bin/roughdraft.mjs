#!/usr/bin/env node

// runCli catches every error it knows about. This is the last resort for
// anything that escapes it (a failed import, a stray rejection), so an agent
// still gets one JSON envelope with --json and exit code 1 instead of a stack.
const args = process.argv.slice(2);
const json = args.includes("--json");
let reported = false;

function lastResort(error) {
  if (reported) return;
  reported = true;
  const message =
    error instanceof Error && error.message ? error.message : String(error);
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : undefined;
  const hint =
    "This is a Roughdraft bug. Run again with ROUGHDRAFT_DEBUG=1 for a stack trace.";
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          status: "error",
          exitCode: 1,
          error: {
            code: "INTERNAL",
            message,
            retryable: false,
            hint,
            ...(code ? { cause: { code } } : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`roughdraft: ${message}\nhint: ${hint}\n`);
  }
  if (process.env.ROUGHDRAFT_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ""}\n`);
  }
  process.exit(1);
}

process.on("uncaughtException", lastResort);
process.on("unhandledRejection", lastResort);

try {
  const { runCli } = await import("../dist/cli.js");
  const exitCode = await runCli(args);
  process.exit(exitCode);
} catch (error) {
  lastResort(error);
}
