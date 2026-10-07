import { describe, expect, it } from "vitest";
import { documentTitleFromMarkdown } from "./index";

describe("documentTitleFromMarkdown", () => {
  it("reads the first heading", () => {
    expect(
      documentTitleFromMarkdown("Intro line\n\n# Fork plan\n\n## Later\n"),
    ).toBe("Fork plan");
  });

  it("takes a lower-level heading when it comes first", () => {
    expect(documentTitleFromMarkdown("## Notes\n# Title\n")).toBe("Notes");
  });

  it("returns null when the file has no heading", () => {
    expect(documentTitleFromMarkdown("Just prose.\n\n- a list\n")).toBeNull();
    expect(documentTitleFromMarkdown("")).toBeNull();
  });

  it("skips headings in fenced code and front matter", () => {
    const markdown = [
      "---",
      "title: front",
      "# not this",
      "---",
      "```md",
      "# Not a heading",
      "```",
      "# Real title",
    ].join("\n");
    expect(documentTitleFromMarkdown(markdown)).toBe("Real title");
  });

  it("strips review markup and inline Markdown", () => {
    expect(
      documentTitleFromMarkdown(
        "# The {==**launch**==}{#c1} plan for `v2` {~~draft~>final~~}{#s1} ##\n",
      ),
    ).toBe("The launch plan for v2 draft");
    expect(documentTitleFromMarkdown("# [Spec](https://x.test) review\n")).toBe(
      "Spec review",
    );
  });

  it("ignores an empty heading", () => {
    expect(documentTitleFromMarkdown("#\n# {#c1}\n# Second\n")).toBe("Second");
  });

  it("does not read a hashtag as a heading", () => {
    expect(documentTitleFromMarkdown("#hashtag\n")).toBeNull();
  });

  it("shortens a very long heading", () => {
    const title = documentTitleFromMarkdown(`# ${"word ".repeat(60)}`);
    expect(title?.length).toBeLessThanOrEqual(120);
    expect(title?.endsWith("…")).toBe(true);
  });
});

describe("documentTitleFromMarkdown with identifiers", () => {
  it("keeps underscores inside words", () => {
    expect(
      documentTitleFromMarkdown("# Rename snake_case_name and _this_\n"),
    ).toBe("Rename snake_case_name and this");
  });
});
