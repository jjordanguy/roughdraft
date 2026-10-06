import { describe, expect, it } from "vitest";
import { validateRoughdraftMarkdown } from "./index";

const lines = (...parts: string[]) => parts.join("\n");
const AT = '"2026-10-03T12:00:00.000Z"';

const root = (id = "c1") => [`  ${id}:`, "    by: user", `    at: ${AT}`];

function diagnosticsOf(markdown: string) {
  return validateRoughdraftMarkdown(markdown).diagnostics.map(
    (diagnostic) => `${diagnostic.severity} ${diagnostic.code}`,
  );
}

// Each case: the code, its severity, and a document that produces it.
const cases: Array<[string, "error" | "warning", string]> = [
  [
    "invalid-endmatter-yaml",
    "error",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      `   at: ${AT}`,
      "",
    ),
  ],
  [
    "duplicate-endmatter-key",
    "error",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...root(),
      ...root(),
      "",
    ),
  ],
  [
    "multiple-endmatter-blocks",
    "error",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...root(),
      "",
      "---",
      "comments:",
      "  c2:",
      "    body: Appended.",
      "    by: AI",
      `    at: ${AT}`,
      "    re: c1",
      "",
    ),
  ],
  [
    "endmatter-ignored",
    "warning",
    lines("Release notes", "", "---", "comments:", ...root(), ""),
  ],
  [
    "orphan-continuation",
    "error",
    lines("Keep {==this==}{#c1}.", "", "---", "comments:", ...root(), ""),
  ],
  [
    "continuation-target-not-comment",
    "error",
    lines(
      "Add {++this++}{#s1} and see {==that==}{#s1}.",
      "",
      "---",
      "suggestions:",
      ...root("s1"),
      "",
    ),
  ],
  [
    "replicated-comment",
    "warning",
    lines(
      '{==One==}{>>Same text<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
      "",
      '{==Two==}{>>Same text<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
      "",
    ),
  ],
  [
    "endmatter-reply-missing-body",
    "error",
    lines(
      "Keep {==this==}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Root"',
      "    by: user",
      `    at: ${AT}`,
      "  c2:",
      "    text: I fixed it.",
      "    by: AI",
      `    at: ${AT}`,
      "    re: c1",
      "",
    ),
  ],
  [
    "endmatter-body-not-string",
    "error",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...root(),
      "  c2:",
      "    body: true",
      "    by: AI",
      `    at: ${AT}`,
      "    re: c1",
      "",
    ),
  ],
  [
    "endmatter-body-truncated",
    "error",
    lines(
      "# Doc",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: See issue #42 for the source.",
      "    by: AI",
      `    at: ${AT}`,
      "",
    ),
  ],
  [
    "re-not-string",
    "error",
    lines(
      "# Doc",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Numeric re",
      "    by: user",
      `    at: ${AT}`,
      "    re: 7",
      "",
    ),
  ],
  [
    "inline-comment-blank-line",
    "error",
    'Keep {==this==}{>>First point.\n\nSecond point.<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}.\n',
  ],
  [
    "inline-reply-not-allowed",
    "error",
    lines(
      "Keep this.{>>Root<<}{#c1}{>>Inline reply<<}{#c2}",
      "",
      "---",
      "comments:",
      ...root(),
      "  c2:",
      "    by: AI",
      `    at: ${AT}`,
      "    re: c1",
      "",
    ),
  ],
  [
    "legacy-inline-body",
    "warning",
    lines(
      "Keep {==this==}{>>Needs proof<<}{#c1}.",
      "",
      "---",
      "comments:",
      ...root(),
      "",
    ),
  ],
  [
    "review-markup-in-code",
    "warning",
    lines(
      "```ts",
      'const command = "{==roughdraft open==}{>>Use the dev wrapper<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}";',
      "```",
      "",
    ),
  ],
  [
    "orphan-endmatter-entry",
    "warning",
    lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...root(),
      "  c2:",
      "    by: user",
      `    at: ${AT}`,
      "    status: resolved",
      "",
    ),
  ],
  [
    "mixed-metadata",
    "warning",
    lines(
      'Keep this.{>>Needs proof<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}',
      "",
      "---",
      "comments:",
      "  c2:",
      "    body: Added.",
      "    by: AI",
      `    at: ${AT}`,
      "    re: c1",
      "",
    ),
  ],
  [
    "missing-reply-target",
    "warning",
    lines(
      "Keep {==this==}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Root"',
      "    by: user",
      `    at: ${AT}`,
      "  c2:",
      '    body: "Reply to nothing."',
      "    by: AI",
      `    at: ${AT}`,
      "    re: c9",
      "",
    ),
  ],
];

describe("validateRoughdraftMarkdown diagnostics", () => {
  it.each(cases)("reports %s as %s", (code, severity, markdown) => {
    expect(diagnosticsOf(markdown)).toContain(`${severity} ${code}`);
    if (severity === "error") {
      expect(validateRoughdraftMarkdown(markdown).ok).toBe(false);
    }
  });

  it("never reports root-entry-has-body: a root's text belongs in its entry", () => {
    const markdown = lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Root",
      "    by: user",
      `    at: ${AT}`,
      "",
    );
    expect(diagnosticsOf(markdown)).toEqual(["warning legacy-inline-body"]);
  });

  it("reports a root whose inline text and entry body differ as a duplicate id", () => {
    const markdown = lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Another text",
      "    by: user",
      `    at: ${AT}`,
      "",
    );
    expect(diagnosticsOf(markdown)).toContain("error duplicate-id");
  });

  it("does not cascade missing-endmatter-entry for every ref when the block is invalid", () => {
    const markdown = lines(
      "Keep {==this==}{#c1} and {==that==}{#c2}.",
      "",
      "---",
      "comments:",
      ...root(),
      "  c2:",
      "    body: Fixed: added the citation.",
      "    by: AI",
      `    at: ${AT}`,
      "",
    );
    expect(diagnosticsOf(markdown)).toEqual(["error invalid-endmatter-yaml"]);
  });

  it("locates review block diagnostics at the entry, with the file line", () => {
    const markdown = lines(
      "# Doc",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Numeric re",
      "    by: user",
      `    at: ${AT}`,
      "    re: 7",
      "",
    );
    expect(validateRoughdraftMarkdown(markdown).errors[0]).toMatchObject({
      code: "re-not-string",
      line: 5,
      column: 3,
    });
  });

  it("prints the YAML error position in the message", () => {
    const markdown = lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      ...root(),
      ...root(),
      "",
    );
    expect(validateRoughdraftMarkdown(markdown).errors[0]?.message).toBe(
      "The review block at the end of this file could not be read: line 8: duplicate key c1",
    );
  });

  it("keeps summary.comments as roots plus document comments plus replies", () => {
    const result = validateRoughdraftMarkdown(
      lines(
        "Keep {==this==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Root"',
        "    by: user",
        `    at: ${AT}`,
        "  a1:",
        '    body: "Reply"',
        "    by: AI",
        `    at: ${AT}`,
        "    re: c1",
        "  c2:",
        '    body: "Global"',
        "    by: user",
        `    at: ${AT}`,
        "    scope: document",
        "",
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({
      comments: 3,
      suggestions: 0,
      legacyMetadata: 0,
      roots: 1,
      documentComments: 1,
      replies: 1,
      endmatter: "recognized",
    });
  });
});
