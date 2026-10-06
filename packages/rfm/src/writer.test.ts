import { describe, expect, it } from "vitest";
import {
  parseReviewModel,
  splitRoughdraftDocument,
  stringifyRoughdraftEndmatter,
} from "./index";

const AT = "2026-10-03T13:00:00.000Z";

// Format review W9: reply bodies that YAML defaults or hand-written YAML get
// wrong (plain scalars with `: `, ` #`, keywords, numbers, dates, quotes,
// leading indicators, trailing space, tabs, line breaks).
const W9 = [
  "plain sentence",
  "Fixed: added the citation",
  "See issue #42",
  "#leading hash",
  "- leading dash",
  "true",
  "null",
  "no",
  "123",
  "1.5",
  "2026-10-03",
  '"quoted" text',
  "it's fine",
  "trailing space ",
  "multi\nline",
  "multi\n\nparagraph",
  "line with --- inside",
  "{>> looks like markup",
  "@mention",
  "`code`",
  "*emphasis*",
  "[link]",
  "& ampersand",
  "! bang",
  "% pct",
  "> quote",
  "| pipe",
  "?question",
  ": colon first",
  "tab\there",
];

function w9Entries() {
  const comments = new Map<string, Record<string, unknown>>([
    ["c1", { body: "Root", by: "user", at: AT }],
  ]);
  W9.forEach((body, index) => {
    comments.set(`a${index + 1}`, { body, by: "AI", at: AT, re: "c1" });
  });
  return { comments };
}

describe("stringifyRoughdraftEndmatter", () => {
  it("writes the W9 bodies one per line, double-quoted, line breaks as <br>", () => {
    const block = stringifyRoughdraftEndmatter(w9Entries());
    const bodies = block
      .split("\n")
      .filter((line) => line.startsWith("    body: "));
    expect(bodies).toMatchInlineSnapshot(`
      [
        "    body: "Root"",
        "    body: "plain sentence"",
        "    body: "Fixed: added the citation"",
        "    body: "See issue #42"",
        "    body: "#leading hash"",
        "    body: "- leading dash"",
        "    body: "true"",
        "    body: "null"",
        "    body: "no"",
        "    body: "123"",
        "    body: "1.5"",
        "    body: "2026-10-03"",
        "    body: "\\"quoted\\" text"",
        "    body: "it's fine"",
        "    body: "trailing space "",
        "    body: "multi<br>line"",
        "    body: "multi<br><br>paragraph"",
        "    body: "line with --- inside"",
        "    body: "{>> looks like markup"",
        "    body: "@mention"",
        "    body: "\`code\`"",
        "    body: "*emphasis*"",
        "    body: "[link]"",
        "    body: "& ampersand"",
        "    body: "! bang"",
        "    body: "% pct"",
        "    body: "> quote"",
        "    body: "| pipe"",
        "    body: "?question"",
        "    body: ": colon first"",
        "    body: "tab\\there"",
      ]
    `);
  });

  it("writes whole entries in the canonical key order", () => {
    expect(
      stringifyRoughdraftEndmatter({
        comments: {
          c1: { by: "user", body: "Root", at: AT },
          a1: {
            priority: "high",
            re: "c1",
            at: AT,
            by: "AI",
            body: "Done.",
            status: "resolved",
            resolved: "Fixed.",
          },
          c2: {
            quote: 'const a = "1";\nconst b = 2;',
            lines: [2, 3],
            scope: "document",
            body: "On code.",
            by: "user",
            at: AT,
            tags: ["a", "b c"],
          },
        },
        suggestions: {
          s2: { continues: "s1", by: "user", at: AT },
        },
        extra: { workflow: { owner: "editorial" } },
      }),
    ).toBe(
      [
        "---",
        "comments:",
        "  c1:",
        '    body: "Root"',
        "    by: user",
        `    at: "${AT}"`,
        "  a1:",
        '    body: "Done."',
        "    by: AI",
        `    at: "${AT}"`,
        "    re: c1",
        "    status: resolved",
        '    resolved: "Fixed."',
        "    priority: high",
        "  c2:",
        '    body: "On code."',
        "    by: user",
        `    at: "${AT}"`,
        "    scope: document",
        "    lines: [2, 3]",
        '    quote: "const a = \\"1\\";\\nconst b = 2;"',
        '    tags: [a, "b c"]',
        "suggestions:",
        "  s2:",
        "    by: user",
        `    at: "${AT}"`,
        "    continues: s1",
        "workflow:",
        "  owner: editorial",
        "",
      ].join("\n"),
    );
  });

  it("quotes labels and ids that a YAML 1.1 or 1.2 reader would not read back as the same text", () => {
    const block = stringifyRoughdraftEndmatter({
      comments: new Map([
        ["c1", { body: "x", by: "yes", at: AT }],
        ["2", { body: "x", by: "Nathan Baschez", at: AT, re: "c1" }],
        ["c3", { body: "x", by: "Off", at: AT, re: "null" }],
      ]),
    });
    expect(block).toContain('    by: "yes"\n');
    expect(block).toContain('  "2":\n');
    expect(block).toContain('    by: "Nathan Baschez"\n');
    expect(block).toContain('    by: "Off"\n    at:');
    expect(block).toContain('    re: "null"\n');
  });

  it("never folds a long body onto a second line", () => {
    const body = "word ".repeat(60).trim();
    const block = stringifyRoughdraftEndmatter({
      comments: { c1: { body, by: "user", at: AT } },
    });
    expect(block.split("\n")).toContain(`    body: "${body}"`);
  });

  it("escapes characters YAML must not see raw", () => {
    const block = stringifyRoughdraftEndmatter({
      comments: { c1: { body: "a\u2028b\u0085c\u0001d", by: "user", at: AT } },
    });
    expect(block).toContain('    body: "a\\u2028b\\u0085c\\u0001d"');
  });

  it("returns an empty string when there is nothing to write", () => {
    expect(stringifyRoughdraftEndmatter({})).toBe("");
    expect(stringifyRoughdraftEndmatter({ comments: new Map() })).toBe("");
  });

  it("reads back every W9 body unchanged through the model", () => {
    const markdown = `Keep {==this==}{#c1}.\n\n${stringifyRoughdraftEndmatter(w9Entries())}`;
    const model = parseReviewModel(markdown);
    expect(model.diagnostics).toEqual([]);
    expect(
      model.comments
        .filter((item) => item.kind === "reply")
        .map((item) => item.body),
    ).toEqual(W9);
  });

  it("round-trips its own output through the split byte for byte", () => {
    const block = stringifyRoughdraftEndmatter(w9Entries());
    const split = splitRoughdraftDocument(`Keep {==this==}{#c1}.\n\n${block}`);
    expect(split.status).toBe("recognized");
    expect(stringifyRoughdraftEndmatter(split.entries)).toBe(block);
  });

  it("parses Jordan's hand-written style to the same values it writes", () => {
    const handWritten = [
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      `    at: "${AT}"`,
      "  c2:",
      "    body: I can make that edit.",
      "    by: AI",
      `    at: "${AT}"`,
      "    re: c1",
      "",
    ].join("\n");
    const split = splitRoughdraftDocument(
      `Keep {>>Why?<<}{#c1}.\n\n${handWritten}`,
    );
    expect(split.entries.comments.get("c2")).toEqual({
      body: "I can make that edit.",
      by: "AI",
      at: AT,
      re: "c1",
    });
    expect(stringifyRoughdraftEndmatter(split.entries)).toContain(
      '    body: "I can make that edit."\n    by: AI\n',
    );
  });
});
