import { describe, expect, it } from "vitest";
import { splitRoughdraftDocument } from "./index";

const lines = (...parts: string[]) => parts.join("\n");

const entry = (id: string, ...fields: string[]) => [
  `  ${id}:`,
  ...fields.map((field) => `    ${field}`),
];

const cases: Array<[string, string, string]> = [
  ["a file with no block", "# Title\n\nJust prose.\n", "absent"],
  [
    "a plain horizontal rule at the end",
    lines("Intro", "", "---", "", "Closing paragraph.", ""),
    "absent",
  ],
  [
    "compact refs plus a review block",
    lines(
      "Keep {==this==}{#c1}.",
      "",
      "---",
      "comments:",
      ...entry(
        "c1",
        'body: "Why?"',
        "by: user",
        'at: "2026-10-05T09:00:00.000Z"',
      ),
      "",
    ),
    "recognized",
  ],
  [
    "R01: an inline attribute root and an endmatter reply with no {#",
    lines(
      'Keep this.{>>Needs proof<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
      "",
      "---",
      "comments:",
      ...entry(
        "c2",
        "body: Added.",
        "by: AI",
        'at: "2026-10-03T12:01:00.000Z"',
        "re: c1",
      ),
      "",
    ),
    "recognized",
  ],
  [
    "a legacy {@ block plus an endmatter reply",
    lines(
      "Keep this.{>>Needs proof<<}{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}",
      "",
      "---",
      "comments:",
      ...entry(
        "c2",
        "body: Added.",
        "by: AI",
        'at: "2026-10-03T12:01:00.000Z"',
        "re: c1",
      ),
      "",
    ),
    "recognized",
  ],
  [
    "a fence-line ref is review metadata",
    lines(
      "```ts {#c1}",
      "const a = 1;",
      "```",
      "",
      "---",
      "comments:",
      ...entry(
        "c1",
        'body: "Rename."',
        "by: user",
        'at: "2026-10-05T09:00:00.000Z"',
      ),
      "",
    ),
    "recognized",
  ],
  [
    "a document-level comment with no markup in the body",
    lines(
      "# Draft",
      "",
      "---",
      "comments:",
      ...entry(
        "c1",
        "body: Address the risks.",
        "by: user",
        'at: "2026-05-24T12:00:00.000Z"',
      ),
      "",
    ),
    "recognized",
  ],
  [
    "an ordinary final comments section with no markup and no document comment",
    lines(
      "Release notes",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: docs", 'at: "not review metadata"'),
      "",
    ),
    "ignored",
  ],
  [
    "R10: entries with an empty or numeric re are document-level comments",
    lines(
      "# Doc",
      "",
      "---",
      "comments:",
      ...entry(
        "c1",
        "body: Empty re",
        "by: user",
        'at: "2026-10-03T12:00:00.000Z"',
        're: ""',
      ),
      "",
    ),
    "recognized",
  ],
  [
    "a review block whose first key is another user key",
    lines(
      "Keep {==this==}{#c1}.",
      "",
      "---",
      "workflow:",
      "  owner: editorial",
      "comments:",
      ...entry(
        "c1",
        'body: "Why?"',
        "by: user",
        'at: "2026-10-05T09:00:00.000Z"',
      ),
      "",
    ),
    "recognized",
  ],
  [
    "a YAML example inside a fence is never the review block",
    lines(
      "Doc",
      "",
      "```yaml",
      "---",
      "comments:",
      ...entry("c1", "by: user"),
      "```",
      "",
    ),
    "absent",
  ],
  [
    "R03: an unquoted colon in a body",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
      ...entry(
        "c2",
        "body: Fixed: added the citation.",
        "by: AI",
        'at: "2026-10-03T12:01:00.000Z"',
        "re: c1",
      ),
      "",
    ),
    "invalid",
  ],
  [
    "R02: a reused id",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
      ...entry("c1", "by: AI", 'at: "2026-10-03T12:01:00.000Z"'),
      "",
    ),
    "invalid",
  ],
  [
    "comments given as a list",
    lines("Keep {==this==}{#c1}.", "", "---", "comments:", "  - c1", ""),
    "invalid",
  ],
  [
    "R13: two review blocks",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
      "",
      "---",
      "comments:",
      ...entry(
        "c2",
        "body: Appended.",
        "by: AI",
        'at: "2026-10-03T12:01:00.000Z"',
        "re: c1",
      ),
      "",
    ),
    "invalid",
  ],
  [
    "R22: a block with only `comments:` is an empty review block",
    lines("Keep this.{>>Root<<}{#c1}", "", "---", "comments:", ""),
    "recognized",
  ],
  [
    "R09: frontmatter is excluded from the search for metadata",
    lines(
      "---",
      'title: "Template {#slug}"',
      "---",
      "",
      "Plain prose.",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
      "",
    ),
    "ignored",
  ],
  [
    "a file whose only `---` lines are its frontmatter",
    lines("---", "comments: none", "---", "", "Keep {==this==}{#c1}.", ""),
    "absent",
  ],
  [
    "CRLF line endings",
    [
      "Keep {==this==}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Why?"',
      "    by: user",
      '    at: "2026-10-05T09:00:00.000Z"',
      "",
    ].join("\r\n"),
    "recognized",
  ],
];

describe("splitRoughdraftDocument", () => {
  it.each(cases)("%s", (_name, markdown, status) => {
    const split = splitRoughdraftDocument(markdown);
    expect(split.status).toBe(status);
    expect(
      `${split.frontmatter ?? ""}${split.body}${split.endmatter ?? ""}`,
    ).toBe(markdown);
  });

  it("returns the entries of a recognized block in file order, unknown keys kept", () => {
    const split = splitRoughdraftDocument(
      lines(
        "Keep {==this==}{#c2} and {==that==}{#c1}.",
        "",
        "---",
        "comments:",
        ...entry(
          "c2",
          'body: "First."',
          "by: user",
          'at: "2026-10-05T09:00:00.000Z"',
          "priority: high",
        ),
        ...entry(
          "c1",
          'body: "Second."',
          "by: user",
          'at: "2026-10-05T09:01:00.000Z"',
        ),
        "suggestions:",
        "workflow:",
        "  owner: editorial",
        "",
      ),
    );
    expect(split.status).toBe("recognized");
    expect([...split.entries.comments.keys()]).toEqual(["c2", "c1"]);
    expect(split.entries.comments.get("c2")).toEqual({
      body: "First.",
      by: "user",
      at: "2026-10-05T09:00:00.000Z",
      priority: "high",
    });
    expect(split.entries.suggestions.size).toBe(0);
    expect([...split.entries.extra]).toEqual([
      ["workflow", { owner: "editorial" }],
    ]);
    expect(split.endmatter?.startsWith("---\ncomments:\n")).toBe(true);
    expect(split.body.endsWith("\n\n")).toBe(true);
  });

  it("keeps an invalid block out of the body and reports the file line of the YAML error", () => {
    const markdown = lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
      ...entry(
        "c2",
        "body: First reply.",
        "by: AI",
        'at: "2026-10-03T12:01:00.000Z"',
        "re: c1",
      ),
      ...entry(
        "c2",
        "body: Second reply.",
        "by: AI",
        'at: "2026-10-03T12:02:00.000Z"',
        "re: c1",
      ),
      "",
    );
    const split = splitRoughdraftDocument(markdown);
    expect(split.status).toBe("invalid");
    expect(split.body).toBe("Keep this.{>>Root<<}{#c1}\n\n");
    expect(split.endmatter?.startsWith("---\ncomments:")).toBe(true);
    expect(split.entries.comments.size).toBe(0);
    expect(split.yamlError).toMatchObject({
      code: "duplicate-endmatter-key",
      message: "line 13: duplicate key c2",
      line: 13,
      column: 3,
    });
  });

  it("reports line and column for a YAML syntax error", () => {
    const split = splitRoughdraftDocument(
      lines(
        "Keep this.{>>Root<<}{#c1}",
        "",
        "---",
        "comments:",
        ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
        ...entry(
          "c2",
          "body: Fixed: added the citation.",
          "by: AI",
          'at: "2026-10-03T12:01:00.000Z"',
          "re: c1",
        ),
        "",
      ),
    );
    expect(split.yamlError).toMatchObject({
      code: "invalid-endmatter-yaml",
      line: 9,
      column: 11,
    });
    expect(split.yamlError?.message).toMatch(/^line 9, column 11: /);
  });

  it("names both blocks when a file has two review blocks", () => {
    const split = splitRoughdraftDocument(
      lines(
        "Keep this.{>>Root<<}{#c1}",
        "",
        "---",
        "comments:",
        ...entry("c1", "by: user", 'at: "2026-10-03T12:00:00.000Z"'),
        "",
        "---",
        "comments:",
        ...entry(
          "c2",
          "body: Appended.",
          "by: AI",
          'at: "2026-10-03T12:01:00.000Z"',
          "re: c1",
        ),
        "",
      ),
    );
    expect(split.status).toBe("invalid");
    expect(split.yamlError).toMatchObject({
      code: "multiple-endmatter-blocks",
      line: 3,
    });
    expect(split.yamlError?.message).toContain("lines 3 and 9");
    expect(split.body).toBe("Keep this.{>>Root<<}{#c1}\n\n");
  });

  it("includes the frontmatter and its trailing blank lines in `frontmatter`", () => {
    const split = splitRoughdraftDocument(
      lines("---", "title: Plan", "---", "", "# Plan", ""),
    );
    expect(split.frontmatter).toBe("---\ntitle: Plan\n---\n\n");
    expect(split.body).toBe("# Plan\n");
    expect(split.bodyOffset).toBe(split.frontmatter?.length);
  });
});
