import { describe, expect, it } from "vitest";
import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

function codes(markdown: string): string[] {
  return validateRoughdraftMarkdown(markdown).diagnostics.map(
    (diagnostic) => diagnostic.code,
  );
}

describe("validateRoughdraftMarkdown", () => {
  it("accepts valid comments, anchored comments, and suggestions", () => {
    const result = validateRoughdraftMarkdown(
      [
        'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
        'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
        'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 2,
      legacyMetadata: 0,
    });
  });

  it("accepts root comments and suggestions backed by YAML endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "Add {++one concrete example++}{#s1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "suggestions:",
        "  s1:",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 1,
    });
  });

  it("does not validate CriticMarkup-looking text inside YAML endmatter bodies", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Please revisit {==this sentence==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Needs a source."',
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Contains {++not a live suggestion++} in the reply.",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 2,
      suggestions: 0,
    });
  });

  it("reports the RFM 0.2 format version", () => {
    expect(validateRoughdraftMarkdown("").version).toBe("0.2");
  });

  it("reports a missing YAML endmatter entry for compact references", () => {
    expect(codes("{>>Needs metadata<<}{#c1}\n")).toContain(
      "missing-endmatter-entry",
    );
  });

  it("accepts body-only endmatter comments as document-level feedback", () => {
    const result = validateRoughdraftMarkdown(
      [
        "{>>Root<<}{#c1}",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Reply without parent",
        "    by: AI",
        '    at: "2026-04-28T12:01:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ comments: 2 });
  });

  it("ignores review markers inside fenced code blocks and inline code spans", () => {
    const result = validateRoughdraftMarkdown(
      [
        "```md",
        "This is {>>not a comment<<}.",
        "This is {++not a suggestion++}.",
        "```",
        "Literal `{>>not a comment<<}` text.",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });

  it("does not treat fenced YAML examples as invalid review endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Doc",
        "",
        "```yaml",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "```",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });

  it("does not treat ordinary final comments sections as review endmatter without compact references", () => {
    const result = validateRoughdraftMarkdown(
      [
        "Release notes",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: docs",
        '    at: "not review metadata"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    // 3a: the block is reported as ignored instead of passing silently.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "endmatter-ignored",
    ]);
    expect(result.summary).toMatchObject({
      comments: 0,
      suggestions: 0,
      endmatter: "ignored",
    });
  });

  it("accepts document-level comments backed only by YAML endmatter", () => {
    const result = validateRoughdraftMarkdown(
      [
        "# Draft",
        "",
        "---",
        "comments:",
        "  c1:",
        "    body: Please address the risk section.",
        "    by: user",
        '    at: "2026-05-24T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      comments: 1,
      suggestions: 0,
    });
  });

  it("reports missing canonical metadata attributes", () => {
    expect(codes("{>>Needs metadata<<}\n")).toEqual([
      "missing-metadata-id",
      "missing-metadata-by",
      "missing-metadata-at",
    ]);
  });

  it("reports invalid timestamps", () => {
    expect(
      codes('{>>Bad time<<}{id="c1" by="user" at="yesterday"}\n'),
    ).toContain("invalid-metadata-at");
  });

  it("reports unclosed review markers", () => {
    expect(codes("{++unfinished\n")).toEqual(["unclosed-addition"]);
    expect(codes("{--unfinished\n")).toEqual(["unclosed-deletion"]);
    expect(codes("{~~old text\n")).toEqual(["unclosed-substitution"]);
  });

  it("reports duplicate ids across comments and suggestions", () => {
    expect(
      codes(
        [
          '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
          '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
        ].join("\n"),
      ),
    ).toContain("duplicate-id");
  });

  it("reports self replies as errors and missing reply targets as warnings", () => {
    const result = validateRoughdraftMarkdown(
      [
        '{>>Self<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z" re="c1"}',
        '{>>Missing parent<<}{id="c2" by="user" at="2026-04-28T12:01:00.000Z" re="missing"}',
      ].join("\n"),
    );

    expect(result.errors.map((diagnostic) => diagnostic.code)).toContain(
      "self-reply",
    );
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain(
      "missing-reply-target",
    );
    expect(result.ok).toBe(false);
  });

  it("accepts legacy metadata with a warning", () => {
    const result = validateRoughdraftMarkdown(
      "{>>Legacy<<}{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}\n",
    );

    expect(result.ok).toBe(true);
    // 3a: an inline comment body is the legacy form and is reported too.
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy-inline-body",
      "legacy-metadata",
    ]);
    expect(result.summary.legacyMetadata).toBe(1);
  });

  it("reports CRLF source locations with one-based line and column", () => {
    const result = validateRoughdraftMarkdown(
      "First line\r\n{>>Needs metadata<<}\r\n",
    );

    expect(result.errors[0]).toMatchObject({
      line: 2,
      column: 1,
    });
  });
});

describe("extractRoughdraftReviewIndex", () => {
  it("extracts comments, anchored comments, replies, and suggestions", () => {
    const index = extractRoughdraftReviewIndex(
      [
        'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
        '{>>I added one.<<}{id="c2" by="AI" at="2026-04-28T12:02:00.000Z" re="c1"}',
        'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
        'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 2,
      unresolved: 4,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["c2", "reply"],
      ["s1", "suggestion"],
      ["s2", "suggestion"],
    ]);
    expect(index.items[0]).toMatchObject({
      anchorText: "this sentence",
      author: "user",
      line: 1,
      column: 35,
      text: "Needs a source.",
    });
    expect(index.items[3]).toMatchObject({
      suggestionKind: "substitution",
      originalText: "rough",
      replacementText: "specific",
    });
  });

  it("extracts equivalent review items from YAML endmatter metadata", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "Add {++one concrete example++}{#s1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: I added one.",
        "    by: AI",
        '    at: "2026-04-28T12:02:00.000Z"',
        "    re: c1",
        "suggestions:",
        "  s1:",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    status: resolved",
        "",
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 1,
      unresolved: 2,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["s1", "suggestion"],
      ["c2", "reply"],
    ]);
    expect(index.items[0]).toMatchObject({
      anchorText: "this sentence",
      author: "user",
      text: "Needs a source.",
    });
    expect(index.items[2]).toMatchObject({
      parentId: "c1",
      author: "AI",
      text: "I added one.",
    });
  });

  it("extracts document-level comments backed only by YAML endmatter", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "# Draft",
        "",
        "---",
        "comments:",
        "  c1:",
        "    body: Please address the risk section.",
        "    by: user",
        '    at: "2026-05-24T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 0,
      suggestions: 0,
      unresolved: 1,
    });
    expect(index.items[0]).toMatchObject({
      id: "c1",
      kind: "comment",
      parentId: null,
      author: "user",
      createdAt: "2026-05-24T12:00:00.000Z",
      text: "Please address the risk section.",
    });
  });

  it("does not extract CriticMarkup-looking text inside YAML endmatter bodies", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  c2:",
        "    body: Contains {++not a live suggestion++} in the reply.",
        "    by: AI",
        '    at: "2026-04-28T12:05:00.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    );

    expect(index.version).toBe("0.2");
    expect(index.summary).toMatchObject({
      comments: 1,
      replies: 1,
      suggestions: 0,
    });
    expect(index.items.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["c2", "reply"],
    ]);
    expect(index.items[1]).toMatchObject({
      text: "Contains {++not a live suggestion++} in the reply.",
    });
  });

  it("preserves literal CriticMarkup inside inline code and fenced code blocks", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "```md",
        '{>>not a comment<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        "```",
        'Literal `{++not a suggestion++}{id="s1" by="AI" at="2026-04-28T12:01:00.000Z"}` text.',
      ].join("\n"),
    );

    expect(index.items).toEqual([]);
    expect(index.summary).toMatchObject({
      comments: 0,
      replies: 0,
      suggestions: 0,
      unresolved: 0,
    });
  });

  it("uses only the final YAML block as Roughdraft endmatter", () => {
    const index = extractRoughdraftReviewIndex(
      [
        "Intro",
        "",
        "---",
        "",
        "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({
      id: "c1",
      author: "user",
    });
  });

  it("gives items scope, anchors, lines, quote and continues", () => {
    const markdown = [
      "{==First block==}{#c1}",
      "",
      "{==Second block==}{#c1}",
      "",
      "```ts {#c2}",
      "const a = 1;",
      "```",
      "",
      "{--One--}{#s1}",
      "",
      "{--Two--}{#s2}",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Across two blocks."',
      "    by: user",
      '    at: "2026-10-05T09:00:00.000Z"',
      "  c2:",
      '    body: "On code."',
      "    by: user",
      '    at: "2026-10-05T09:01:00.000Z"',
      "    lines: [1, 1]",
      '    quote: "const a = 1;"',
      "  c3:",
      '    body: "Global."',
      "    by: user",
      '    at: "2026-10-05T09:02:00.000Z"',
      "    scope: document",
      "suggestions:",
      "  s1:",
      "    by: user",
      '    at: "2026-10-05T09:03:00.000Z"',
      "  s2:",
      "    by: user",
      '    at: "2026-10-05T09:03:00.000Z"',
      "    continues: s1",
      "",
    ].join("\n");

    const index = extractRoughdraftReviewIndex(markdown);

    expect(index.diagnostics).toEqual([]);
    expect(
      index.items.map((item) => [
        item.id,
        item.kind,
        item.scope,
        item.anchorText,
        item.anchors.map((anchor) => anchor.text),
      ]),
    ).toEqual([
      [
        "c1",
        "comment",
        "inline",
        "First block",
        ["First block", "Second block"],
      ],
      ["c2", "comment", "code", "const a = 1;", ["const a = 1;"]],
      ["s1", "suggestion", "inline", undefined, ["One"]],
      ["s2", "suggestion", "inline", undefined, ["Two"]],
      ["c3", "comment", "document", undefined, []],
    ]);
    expect(index.items[1]).toMatchObject({
      lines: [1, 1],
      quote: "const a = 1;",
    });
    expect(index.items[3]).toMatchObject({ continues: "s1" });
    expect(index.summary).toMatchObject({
      comments: 3,
      roots: 2,
      documentComments: 1,
      replies: 0,
      suggestions: 2,
      endmatter: "recognized",
    });
  });
});
