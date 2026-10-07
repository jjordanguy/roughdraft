import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliDependencies, runCli } from "./cli";
import { GUARD_ROUND_MAX_AGE_MS, recordOpenRound } from "./guard";

// The guard as Claude Code runs it: `roughdraft guard --claude-hook` with the
// PreToolUse JSON on stdin. Deny prints the hook JSON; allow prints nothing.

const REVIEWED = `# Plan

Keep {==this claim==}{#c1} as written.

A plain paragraph with nothing on it.

\`\`\`md
Example: {==literal==}{#c9} inside a fence.
\`\`\`

---
comments:
  c1:
    body: "Needs a source."
    by: user
    at: "2026-10-05T09:00:00.000Z"
`;

describe("roughdraft guard --claude-hook", () => {
  let tempDir: string;
  let stateDir: string;
  let reviewed: string;
  let plain: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-guard-"));
    stateDir = path.join(tempDir, "state");
    reviewed = path.join(tempDir, "plan.md");
    plain = path.join(tempDir, "notes.md");
    fs.writeFileSync(reviewed, REVIEWED);
    fs.writeFileSync(plain, "# Notes\n\nNothing reviewed here.\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function hook(stdin: string | Record<string, unknown>): Promise<{
    exitCode: number;
    stdout: string;
    decision: string;
    reason: string;
  }> {
    const logs: string[] = [];
    const exitCode = await runCli(
      ["guard", "--claude-hook"],
      createCliDependencies({
        env: { ROUGHDRAFT_STATE_DIR: stateDir, ROUGHDRAFT_PORT: "9" },
        cwd: tempDir,
        log: (message) => logs.push(message),
        error: () => {},
        readStdin: async () =>
          typeof stdin === "string" ? stdin : JSON.stringify(stdin),
      }),
    );
    const stdout = logs.join("\n");
    const parsed = stdout ? JSON.parse(stdout) : null;
    return {
      exitCode,
      stdout,
      decision: parsed?.hookSpecificOutput?.permissionDecision ?? "allow",
      reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? "",
    };
  }

  function edit(
    oldString: string,
    newString: string,
    file = reviewed,
  ): Record<string, unknown> {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: file,
        old_string: oldString,
        new_string: newString,
      },
      cwd: tempDir,
    };
  }

  it("denies Edit, MultiEdit and Write on a file with an open round, naming clean.md", async () => {
    const cleanPath = path.join(stateDir, "rounds", "r-1", "clean.md");
    recordOpenRound(stateDir, {
      documentPath: reviewed,
      roundId: "r-1",
      dir: path.dirname(cleanPath),
      cleanPath,
      responsePath: path.join(path.dirname(cleanPath), "response.json"),
      openedAt: new Date().toISOString(),
    });
    for (const payload of [
      edit("A plain paragraph", "One plain paragraph"),
      {
        tool_name: "MultiEdit",
        tool_input: { file_path: reviewed, edits: [] },
      },
      { tool_name: "Write", tool_input: { file_path: reviewed, content: "x" } },
    ]) {
      const result = await hook(payload);
      expect(result.exitCode).toBe(0);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain(cleanPath);
      expect(result.reason).toContain("roughdraft apply");
    }
    expect(
      JSON.parse((await hook(edit("A plain", "One plain"))).stdout),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("r-1"),
      },
    });
  });

  it("forgets a round older than the guard window", async () => {
    recordOpenRound(stateDir, {
      documentPath: reviewed,
      roundId: "r-old",
      dir: tempDir,
      cleanPath: path.join(tempDir, "clean.md"),
      responsePath: path.join(tempDir, "response.json"),
      openedAt: new Date(
        Date.now() - GUARD_ROUND_MAX_AGE_MS - 1000,
      ).toISOString(),
    });
    expect(
      (await hook(edit("A plain paragraph", "One plain paragraph"))).decision,
    ).toBe("allow");
  });

  it("denies Write over a file with review data and allows it elsewhere", async () => {
    const write = (file: string) => ({
      tool_name: "Write",
      tool_input: { file_path: file, content: "# New\n" },
    });
    const denied = await hook(write(reviewed));
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("roughdraft round");
    expect((await hook(write(plain))).stdout).toBe("");
    expect((await hook(write(path.join(tempDir, "fresh.md")))).stdout).toBe("");
  });

  it.each([
    ["old text holds a highlight", "{==this claim==}{#c1} as", "this claim as"],
    [
      "new text adds a ref",
      "A plain paragraph",
      "A plain {==paragraph==}{#c9}",
    ],
    ["matched text overlaps a ref", "claim==}{#c1} as", "claim as"],
    [
      "edit reaches into the review block",
      'body: "Needs a source."',
      'body: "Fixed."',
    ],
    [
      "edit across the highlight's end",
      "this claim==}{#c1} as written",
      "this claim, as written",
    ],
  ])("denies an edit when the %s", async (_name, oldString, newString) => {
    const result = await hook(edit(oldString, newString));
    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("deny");
  });

  it.each([
    ["a plain paragraph", "A plain paragraph", "One plain paragraph"],
    ["text strictly inside a highlight", "this claim", "this assertion"],
    [
      "a markup example inside a fence",
      "{==literal==}{#c9}",
      "{==sample==}{#c9}",
    ],
    [
      "markup inside inline code",
      "A plain paragraph",
      "A paragraph about `{==x==}{#c1}`",
    ],
  ])("allows %s", async (_name, oldString, newString) => {
    const result = await hook(edit(oldString, newString));
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "",
      decision: "allow",
    });
  });

  it("checks every edit of a MultiEdit and every match of replace_all", async () => {
    const multi = await hook({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: reviewed,
        edits: [
          { old_string: "A plain paragraph", new_string: "One paragraph" },
          { old_string: "as written", new_string: "as written {#c4}" },
        ],
      },
    });
    expect(multi.decision).toBe("deny");
    fs.writeFileSync(
      reviewed,
      REVIEWED.replace("A plain paragraph", "Keep {==claim==}{#c2} and claim"),
    );
    const all = await hook({
      tool_name: "Edit",
      tool_input: {
        file_path: reviewed,
        old_string: "claim",
        new_string: "point",
        replace_all: false,
      },
    });
    // The first match is inside the first highlight's text: allowed.
    expect(all.decision).toBe("allow");
  });

  it("allows other tools, other files, and anything it cannot read (fails open)", async () => {
    for (const stdin of [
      "not json at all",
      "",
      "null",
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: path.join(tempDir, "a.ts") },
      }),
      JSON.stringify({ tool_name: "Edit", tool_input: "nonsense" }),
      JSON.stringify(edit("x", "y", path.join(tempDir, "missing.md"))),
    ]) {
      const result = await hook(stdin);
      expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    }
  });

  it("fails open when the rounds index is corrupt", async () => {
    fs.mkdirSync(path.join(stateDir, "rounds"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "rounds", "index.json"), "{ broken");
    expect(
      (await hook(edit("A plain paragraph", "One plain paragraph"))).stdout,
    ).toBe("");
  });
});
