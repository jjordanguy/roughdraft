import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexSessionTitle,
  currentCodexSessionId,
  wakeCodexSession,
} from "./codex-session";

/**
 * A stand-in for the codex executable: it writes its arguments, one per
 * NUL-terminated record, to `args`, prints `stderr` and exits with `exit`.
 */
function writeCodexStub(
  dir: string,
  options: {
    exit?: number;
    stderr?: string;
    sleep?: number;
    envFile?: string;
  } = {},
): { bin: string; argsFile: string; readArgs: () => string[] | null } {
  const bin = path.join(dir, "codex");
  const argsFile = path.join(dir, "codex-args");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\0' "$@" > '${argsFile}'`,
      ...(options.envFile ? [`env > '${options.envFile}'`] : []),
      ...(options.sleep ? [`sleep ${options.sleep}`] : []),
      ...(options.stderr ? [`echo '${options.stderr}' >&2`] : []),
      `exit ${options.exit ?? 0}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    bin,
    argsFile,
    readArgs: () =>
      fs.existsSync(argsFile)
        ? fs.readFileSync(argsFile, "utf8").split("\0").slice(0, -1)
        : null,
  };
}

describe("Codex sessions", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-codex-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the current session from CODEX_THREAD_ID, else CODEX_SESSION_ID", () => {
    expect(
      currentCodexSessionId({
        CODEX_THREAD_ID: "t-1",
        CODEX_SESSION_ID: "s-1",
      }),
    ).toBe("t-1");
    expect(currentCodexSessionId({ CODEX_SESSION_ID: " s-1 " })).toBe("s-1");
    expect(currentCodexSessionId({ CODEX_THREAD_ID: "  " })).toBeNull();
    expect(currentCodexSessionId({})).toBeNull();
  });

  it("finds the session title in the session index, newest entry first", () => {
    fs.writeFileSync(
      path.join(dir, "session_index.jsonl"),
      [
        JSON.stringify({
          id: "t-1",
          thread_name: "Old name",
          updated_at: "2026-10-06T09:00:00Z",
        }),
        "not json",
        JSON.stringify({
          id: "t-2",
          thread_name: "Other session",
          updated_at: "2026-10-06T11:00:00Z",
        }),
        JSON.stringify({
          id: "t-1",
          thread_name: "Plan the launch",
          updated_at: "2026-10-06T10:00:00Z",
        }),
        "",
      ].join("\n"),
    );

    expect(codexSessionTitle("t-1", { codexHome: dir })).toBe(
      "Plan the launch",
    );
    expect(codexSessionTitle("t-1", { env: { CODEX_HOME: dir } })).toBe(
      "Plan the launch",
    );
    expect(codexSessionTitle("t-9", { codexHome: dir })).toBeNull();
    expect(
      codexSessionTitle("t-1", { codexHome: path.join(dir, "missing") }),
    ).toBeNull();
  });

  it("queues the message with codex queue --thread --message", async () => {
    const stub = writeCodexStub(dir);
    const text = "I'm done reviewing plan.md.\n\nFile: /notes/plan.md";

    const error = await wakeCodexSession("t-1", text, { codexBin: stub.bin });

    expect(error).toBeNull();
    expect(stub.readArgs()).toEqual([
      "queue",
      "--thread",
      "t-1",
      "--message",
      text,
    ]);
  });

  it("finds codex on PATH and keeps ROUGHDRAFT_TOKEN out of its environment", async () => {
    const envFile = path.join(dir, "env");
    const stub = writeCodexStub(dir, { envFile });

    const error = await wakeCodexSession("t-1", "hello", {
      env: { PATH: `${dir}:/usr/bin:/bin`, ROUGHDRAFT_TOKEN: "secret" },
    });

    expect(error).toBeNull();
    expect(stub.readArgs()).toEqual([
      "queue",
      "--thread",
      "t-1",
      "--message",
      "hello",
    ]);
    expect(fs.readFileSync(envFile, "utf8")).not.toContain("ROUGHDRAFT_TOKEN");
  });

  it("says why when codex is missing, fails, or there is no session id", async () => {
    const missing = await wakeCodexSession("t-1", "hello", {
      codexBin: path.join(dir, "nope"),
    });
    expect(missing).toBe(
      `The codex command was not found (looked for ${path.join(dir, "nope")}). Install Codex, or set ROUGHDRAFT_CODEX_BIN to its path.`,
    );

    const failing = writeCodexStub(dir, {
      exit: 2,
      stderr: "no session named t-1",
    });
    expect(
      await wakeCodexSession("t-1", "hello", { codexBin: failing.bin }),
    ).toBe("codex queue exited with 2: no session named t-1");

    expect(
      await wakeCodexSession(null, "hello", { codexBin: failing.bin }),
    ).toContain("no Codex session id");
  });

  it("stops a codex queue that runs past the time limit", async () => {
    const slow = writeCodexStub(dir, { sleep: 5 });
    const startedAt = Date.now();
    expect(
      await wakeCodexSession("t-1", "hello", {
        codexBin: slow.bin,
        timeoutMs: 100,
      }),
    ).toBe("codex queue timed out after 100 ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
