import { describe, expect, it } from "vitest";
import {
  changesShape,
  extractRoughdraftReviewIndex,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  reviewCleanText,
  serializeReviewModel,
} from "../src/index";
import { isCanonical, loadFixtures } from "./fixture-helpers";
import { fixture, NO_PROBLEMS, readersAccept } from "./review-helpers";

const fixtures = loadFixtures();

function normalized(markdown: string) {
  const result = normalizeRoughdraftMetadata(markdown);
  expect(result.refused).toEqual([]);
  return result;
}

const codes = (result: ReturnType<typeof normalizeRoughdraftMetadata>) =>
  result.changes.map(
    (change) =>
      `${change.code}${change.id ? `(${change.id})` : ""}@${change.line}`,
  );

/** Items every reader must agree on, before and after. */
function items(markdown: string) {
  return extractRoughdraftReviewIndex(markdown)
    .items.map(
      (item) =>
        `${item.id} ${item.kind} ${item.parentId} ${item.author} ${item.createdAt} ${item.status} ${item.resolved}: ${item.text}`,
    )
    .sort();
}

describe("serializeReviewModel", () => {
  it.each(
    fixtures.filter(isCanonical).map((item) => [item.name, item] as const),
  )("%s: comes back byte for byte", (_name, item) => {
    expect(serializeReviewModel(parseReviewModel(item.markdown))).toBe(
      item.markdown,
    );
  });

  it("throws on a file it cannot write without a decision, naming the line", () => {
    expect(() =>
      serializeReviewModel(
        parseReviewModel(fixture("probe-R02-duplicate-endmatter-key")),
      ),
    ).toThrow(/line 13: .*duplicate key c2/);
  });
});

describe("normalizeRoughdraftMetadata: legacy forms", () => {
  it("moves an inline comment body and its attribute metadata into the review block", () => {
    const result = normalized(
      '# Plan\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"} as written.\n',
    );
    expect(result.markdown).toBe(
      '# Plan\n\nKeep {==this claim==}{#c1} as written.\n\n---\ncomments:\n  c1:\n    body: "Needs proof"\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n',
    );
    expect(codes(result)).toEqual([
      "attribute-metadata(c1)@3",
      "legacy-inline-body(c1)@3",
    ]);
  });

  it("converts a standalone train to a bare ref", () => {
    const result = normalized(fixture("probe-R08-inline-attr-resolved"));
    expect(result.markdown).toBe(
      'Keep this.{#c1}\n\n---\ncomments:\n  c1:\n    body: "Root"\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n    status: resolved\n    resolved: "Done."\n',
    );
    expect(codes(result)).toContain("status-attribute(c1)@1");
  });

  it("reads a legacy {@...@} block", () => {
    const result = normalized(fixture("legacy-at-block"));
    expect(result.markdown).toContain("Keep this claim.{#c1}");
    expect(codes(result)).toEqual([
      "legacy-metadata(c1)@3",
      "legacy-inline-body(c1)@3",
    ]);
  });

  it("turns replicated trains into one primary anchor plus continuations, keeping the whole selection highlighted", () => {
    const result = normalized(fixture("repro-case2-ui-saved"));
    expect(result.markdown).toContain(
      "## {==Pre-flight==}{#c1}\n{==The creator confirms the caption with ops before scheduling.==}{#c1}",
    );
    expect(result.markdown.match(/\{#c1\}/g)).toHaveLength(5);
    expect(result.markdown.match(/ {4}body:/g)).toHaveLength(1);
    expect(codes(result).filter((code) => code.startsWith("replicas"))).toEqual(
      [
        "replicas-to-continuations(c1)@4",
        "replicas-to-continuations(c1)@6",
        "replicas-to-continuations(c1)@8",
        "replicas-to-continuations(c1)@10",
      ],
    );
  });

  it("moves inline replies into the review block once per id", () => {
    const result = normalized(fixture("repro-case1-a"));
    expect(result.markdown).not.toContain("{>>");
    expect(result.markdown.match(/ {2}c2:/g)).toHaveLength(1);
    expect(result.markdown).toContain("    re: c1");
    expect(codes(result)).toContain("inline-reply(c2)@2");
  });

  it("moves an inline compact reply (R11)", () => {
    const result = normalized(fixture("probe-R11-inline-compact-reply"));
    expect(result.markdown.startsWith("Keep this.{#c1}\n\n---\n")).toBe(true);
    expect(result.markdown).toContain(
      '  c2:\n    body: "Inline reply"\n    by: AI\n    at: "2026-10-03T12:01:00.000Z"\n    re: c1',
    );
  });

  it("splits a multi-line highlight into one anchor per line and keeps line breaks in the body as <br>", () => {
    const result = normalized(fixture("legacy-multiline-span"));
    expect(result.markdown).toContain(
      "The first line of the paragraph {==runs on==}{#c1}\n{==into the second line==}{#c1} and ends here.",
    );
    expect(codes(result)).toContain("multi-line-highlight(c1)@3");
    const blankLine = normalized(fixture("repro-case4-ui-saved"));
    expect(blankLine.markdown).toContain(
      'body: "First point about scope.<br><br>Second point about timing."',
    );
  });

  it("splits a multi-line suggestion into one marker per line linked by continues", () => {
    const result = normalized(
      'Intro.\n\n{--First paragraph.\n\nSecond paragraph.--}{id="s1" by="user" at="2026-10-04T09:00:00.000Z"}\n\nTail.\n',
    );
    expect(result.markdown).toBe(
      'Intro.\n\n{--First paragraph.--}{#s1}\n\n{--Second paragraph.--}{#s2}\n\nTail.\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n  s2:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n    continues: s1\n',
    );
    expect(codes(result)).toContain("multi-line-suggestion(s1)@3");
  });

  it("links a replicated suggestion with continues (browser repro case 5)", () => {
    const result = normalized(fixture("repro-case5-ui-saved"));
    expect(result.markdown).toContain(
      "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}",
    );
    expect(result.markdown).toContain(
      "{--Epsilon paragraph repeats the timeline from the appendix.--}{#s2}",
    );
    expect(result.markdown).toContain(
      '  s2:\n    by: user\n    at: "2026-10-04T19:00:50.725Z"\n    continues: s1',
    );
  });

  it("merges two review blocks (R13)", () => {
    const result = normalized(fixture("probe-R13-two-endmatter-blocks"));
    expect(result.markdown.match(/^---$/gm)).toHaveLength(1);
    expect(codes(result)).toContain("merged-blocks@3");
    expect(items(result.markdown).map((item) => item.split(" ")[0])).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("adds scope: document to a legacy global comment so it keeps its meaning (R14)", () => {
    const result = normalized(fixture("probe-R14-doclevel"));
    expect(result.markdown).toContain(
      '  c2:\n    body: "Overall this reads well but the intro is long."\n    by: user\n    at: "2026-10-03T12:01:00.000Z"\n    scope: document',
    );
    expect(
      extractRoughdraftReviewIndex(result.markdown).items.find(
        (item) => item.id === "c2",
      ),
    ).toMatchObject({
      scope: "document",
      lostAnchor: false,
    });
  });

  it("keeps a lost anchor as a lost anchor", () => {
    expect(normalized(fixture("canonical-lost-anchor")).changes).toEqual([]);
  });

  it("moves a comment the old browser wrote inside a code block to a fence-line ref with lines and quote", () => {
    const markdown = [
      "# Setup",
      "",
      'Run the {==install==}{>>Which one?<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"} first.',
      "",
      "```ts",
      "import { start } from './server';",
      '{==const port = 3000;==}{>>Use the env.<<}{id="c2" by="user" at="2026-10-03T12:01:00.000Z"}',
      "start({ port });",
      "```",
      "",
    ].join("\n");
    const result = normalized(markdown);
    expect(result.markdown).toContain(
      "```ts {#c2}\nimport { start } from './server';\nconst port = 3000;\nstart({ port });\n```",
    );
    expect(result.markdown).toContain(
      '  c2:\n    body: "Use the env."\n    by: user\n    at: "2026-10-03T12:01:00.000Z"\n    lines: [2, 2]\n    quote: "const port = 3000;"',
    );
    expect(codes(result)).toContain("code-anchor(c2)@7");
    expect(
      extractRoughdraftReviewIndex(result.markdown).items.find(
        (item) => item.id === "c2",
      ),
    ).toMatchObject({
      scope: "code",
      lines: [2, 2],
    });
  });

  it("rewrites YAML written by hand in the canonical shape, as a formatting change only", () => {
    const result = normalized(fixture("suggestion-with-reply"));
    expect(codes(result)).toEqual(["yaml-rewritten@3"]);
    expect(changesShape(result.changes)).toBe(false);
  });
});

describe("normalizeRoughdraftMetadata: refusals (nothing written, the line named)", () => {
  const cases: Array<[string, string, string, number]> = [
    [
      "duplicate key",
      "probe-R02-duplicate-endmatter-key",
      "duplicate-endmatter-key",
      13,
    ],
    [
      "unparsable YAML",
      "probe-R03-body-colon-space",
      "invalid-endmatter-yaml",
      9,
    ],
    [
      "bad YAML indentation",
      "probe-R21-yaml-indentation",
      "invalid-endmatter-yaml",
      7,
    ],
    [
      "a body cut short at #",
      "probe-R04-body-hash",
      "endmatter-body-truncated",
      8,
    ],
    [
      "a reply with no body",
      "probe-R05-reply-without-body",
      "endmatter-reply-missing-body",
      8,
    ],
    [
      "a body that is not text",
      "probe-R06-body-not-string",
      "endmatter-body-not-string",
      8,
    ],
    [
      "markup inside code in a file with no other review data",
      "probe-R07-anchor-inside-fence",
      "markup-in-code",
      2,
    ],
    ["re that is not an id", "probe-R10-re-odd-types", "re-not-string", 5],
    [
      "a ref with no metadata",
      "probe-R16-ref-missing-entry",
      "missing-endmatter-entry",
      1,
    ],
    [
      "a ref with no metadata (null map)",
      "probe-R22-comments-null",
      "missing-endmatter-entry",
      1,
    ],
    [
      "a date-only time",
      "probe-R17-author-case-date-only",
      "invalid-endmatter-at",
      5,
    ],
    [
      "a newline in an attribute",
      "probe-R19-attr-value-newline",
      "missing-metadata-id",
      1,
    ],
  ];
  it.each(cases)("refuses %s", (_label, name, code, line) => {
    const markdown = fixture(name);
    const result = normalizeRoughdraftMetadata(markdown);
    expect(result.markdown).toBe(markdown);
    expect(result.refused[0]).toMatchObject({ code, line });
    expect(result.refused[0]?.message.length).toBeGreaterThan(10);
  });

  it("refuses two bodies for one id", () => {
    const markdown =
      'A {==x==}{>>One<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}\n\nB {==y==}{>>Two<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}\n';
    expect(normalizeRoughdraftMetadata(markdown).refused[0]).toMatchObject({
      code: "duplicate-id",
      line: 3,
    });
  });

  it("refuses two review blocks that disagree on an entry", () => {
    const markdown =
      'Keep {==this==}{#c1}.\n\n---\ncomments:\n  c1:\n    body: "One"\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n\n---\ncomments:\n  c1:\n    body: "Two"\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n';
    expect(normalizeRoughdraftMetadata(markdown).refused[0]).toMatchObject({
      code: "conflicting-blocks",
      line: 10,
    });
  });

  it("refuses a multi-line substitution whose sides have different line counts", () => {
    const markdown =
      'A {~~one\ntwo~>three~~}{id="s1" by="user" at="2026-10-03T12:00:00.000Z"}.\n';
    expect(normalizeRoughdraftMetadata(markdown).refused[0]).toMatchObject({
      code: "multi-line-substitution",
      line: 1,
    });
  });
});

describe("normalizeRoughdraftMetadata over every fixture", () => {
  it.each(
    fixtures.map((item) => [item.name, item] as const),
  )("%s", (_name, item) => {
    const result = normalizeRoughdraftMetadata(item.markdown);
    for (const change of result.changes)
      expect(change.line, change.code).toBeGreaterThan(0);
    if (result.refused.length > 0) {
      expect(result.markdown).toBe(item.markdown);
      for (const refusal of result.refused)
        expect(refusal.line).toBeGreaterThan(0);
      return;
    }
    // Idempotent.
    const again = normalizeRoughdraftMetadata(result.markdown);
    expect(again.changes).toEqual([]);
    expect(again.markdown).toBe(result.markdown);
    // Canonical files do not change.
    if (isCanonical(item)) expect(result.markdown).toBe(item.markdown);
    // No item lost or changed. New items only where the input hid them (an
    // unreadable second block) or a replicated suggestion gained a part.
    const before = items(item.markdown);
    const after = items(result.markdown);
    const invalidInput =
      parseReviewModel(item.markdown).split.status === "invalid";
    if (!invalidInput)
      for (const entry of before) expect(after).toContain(entry);
    const added = extractRoughdraftReviewIndex(result.markdown).items.filter(
      (entry) =>
        !extractRoughdraftReviewIndex(item.markdown).items.some(
          (old) => old.id === entry.id,
        ),
    );
    for (const entry of added)
      expect(invalidInput || entry.continues !== null, entry.id).toBe(true);
    // Both readers and the lint accept the result.
    expect(readersAccept(result.markdown)).toEqual(NO_PROBLEMS);
    // The prose reads the same.
    expect(reviewCleanText(result.markdown).clean.replace(/\s+$/, "")).toBe(
      reviewCleanText(item.markdown).clean.replace(/\s+$/, ""),
    );
  });
});
