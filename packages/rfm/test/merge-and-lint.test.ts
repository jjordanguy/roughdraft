import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintRoughdraftMarkdown, mergeReviewEntries } from "../src/index";
import { loadFixtures } from "./fixture-helpers";

describe("mergeReviewEntries", () => {
  const base = {
    comments: {
      c1: { body: "Root", by: "user", at: "t1" },
      c2: { body: "Other", by: "user", at: "t2" },
      c3: { body: "Gone", by: "user", at: "t3" },
    },
  };

  it("unions by id: ours first, then ids only theirs has", () => {
    const ours = {
      comments: {
        ...base.comments,
        c4: { body: "Mine", by: "user", at: "t4" },
      },
    };
    const theirs = {
      comments: {
        ...base.comments,
        a1: { body: "Reply", by: "AI", at: "t5", re: "c1" },
      },
    };
    const { entries, conflicts } = mergeReviewEntries(base, ours, theirs);
    expect([...entries.comments.keys()]).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "a1",
    ]);
    expect(conflicts).toEqual([]);
  });

  it("merges key by key: each side's own change lands", () => {
    const ours = {
      comments: {
        ...base.comments,
        c1: { ...base.comments.c1, status: "resolved" },
      },
    };
    const theirs = {
      comments: {
        ...base.comments,
        c1: { ...base.comments.c1, resolved: "Done." },
      },
    };
    const { entries, conflicts } = mergeReviewEntries(base, ours, theirs);
    expect(entries.comments.get("c1")).toEqual({
      body: "Root",
      by: "user",
      at: "t1",
      status: "resolved",
      resolved: "Done.",
    });
    expect(conflicts).toEqual([]);
  });

  it("reports a key both sides changed differently and keeps ours", () => {
    const ours = {
      comments: {
        ...base.comments,
        c2: { ...base.comments.c2, body: "Edited in the tab" },
      },
    };
    const theirs = {
      comments: {
        ...base.comments,
        c2: { ...base.comments.c2, body: "Edited by the agent" },
      },
    };
    const { entries, conflicts } = mergeReviewEntries(base, ours, theirs);
    expect(conflicts).toEqual([
      {
        section: "comments",
        id: "c2",
        key: "body",
        base: "Other",
        ours: "Edited in the tab",
        theirs: "Edited by the agent",
      },
    ]);
    expect(entries.comments.get("c2")?.body).toBe("Edited in the tab");
  });

  it("drops an entry one side removed, unless the other side changed it", () => {
    const removedByTheirs = mergeReviewEntries(base, base, {
      comments: { c1: base.comments.c1, c2: base.comments.c2 },
    });
    expect(removedByTheirs.entries.comments.has("c3")).toBe(false);
    expect(removedByTheirs.conflicts).toEqual([]);
    const changedByOurs = mergeReviewEntries(
      base,
      {
        comments: {
          ...base.comments,
          c3: { ...base.comments.c3, body: "Kept" },
        },
      },
      { comments: { c1: base.comments.c1, c2: base.comments.c2 } },
    );
    expect(changedByOurs.conflicts).toEqual([
      expect.objectContaining({ id: "c3", key: null }),
    ]);
    expect(changedByOurs.entries.comments.get("c3")?.body).toBe("Kept");
  });

  it("merges suggestions and the other top-level keys the same way", () => {
    const { entries, conflicts } = mergeReviewEntries(
      {
        suggestions: new Map([["s1", { by: "user", at: "t" }]]),
        extra: { workflow: { owner: "a" } },
      },
      {
        suggestions: new Map([["s1", { by: "user", at: "t" }]]),
        extra: { workflow: { owner: "b" } },
      },
      { suggestions: new Map(), extra: { workflow: { owner: "a" } } },
    );
    expect(entries.suggestions.size).toBe(0);
    expect(entries.extra.get("workflow")).toEqual({ owner: "b" });
    expect(conflicts).toEqual([]);
  });
});

describe("lintRoughdraftMarkdown (the rd-lint.mjs rules)", () => {
  it("fails a newline inside a span, mixed regimes and mixed anchors", () => {
    expect(lintRoughdraftMarkdown("A {>>one\ntwo<<}{#c1}\n").fails).toEqual([
      'newline inside span: "{>>one\\ntwo<<}"',
    ]);
    const mixed =
      'A {>>x<<}{id="c1" by="user" at="t"} and {==y==}{#c2}\n\n---\ncomments:\n  c2:\n    by: user\n';
    expect(lintRoughdraftMarkdown(mixed).fails).toEqual([
      'mixed regimes: inline-attribute roots ({id="...stuff"}) coexist with YAML endmatter; the renderer drops the endmatter and everything in it',
      "mixed anchors: {#cN}/{#sN} compact refs alongside inline-attribute roots",
    ]);
  });

  it("warns on replicated attribute ids and trains in headings, and ignores fenced code", () => {
    const result = lintRoughdraftMarkdown(
      '## {==H==}{>>x<<}{id="c1" by="u" at="t"}\n{==P==}{>>x<<}{id="c1" by="u" at="t"}\n\n```\n{>>a\nb<<}\n```\n',
    );
    expect(result.fails).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
});

// The port against the real script, when this machine has it.
const realLint = path.join(
  os.homedir(),
  "Documents/OpenMike-ops/skills/roughdraft-review/scripts/rd-lint.mjs",
);
describe.skipIf(!fs.existsSync(realLint))(
  "lint port agrees with the real rd-lint.mjs",
  () => {
    it("on every spec fixture", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfm-lint-"));
      try {
        for (const fixture of loadFixtures()) {
          const file = path.join(dir, `${fixture.name}.md`);
          fs.writeFileSync(file, fixture.markdown);
          let exitCode = 0;
          try {
            execFileSync("node", [realLint, file], { stdio: "pipe" });
          } catch (error) {
            exitCode = (error as { status: number }).status;
          }
          expect(exitCode === 1, fixture.name).toBe(
            lintRoughdraftMarkdown(fixture.markdown).fails.length > 0,
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
