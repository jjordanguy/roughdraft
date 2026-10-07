// The one-thread writers behind `roughdraft_reply_to_comment`,
// `roughdraft_mark_resolved`, the Done route's comment box and the CLI quick
// commands. Since batch 3b they write the canonical shape and refuse an
// old-shape file (D11), except a person's global comment on an old file.
import { describe, expect, it } from "vitest";
import {
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
  normalizeRoughdraftMetadata,
  RoughdraftFormatError,
  validateWithLegacyReader,
} from "../src/index";
import {
  canonical,
  fixture,
  NO_PROBLEMS,
  readersAccept,
} from "./review-helpers";

const AT = "2026-10-05T10:00:00.000Z";
const prose = fixture("canonical-prose-anchor");
const continuation = fixture("canonical-continuation");

function expectCanonical(markdown: string): void {
  const again = normalizeRoughdraftMetadata(markdown);
  expect(again.changes).toEqual([]);
  expect(readersAccept(markdown)).toEqual(NO_PROBLEMS);
}

describe("appendRoughdraftReply", () => {
  it("adds an aN entry with re to the review block and leaves the prose byte for byte", () => {
    const updated = appendRoughdraftReply(continuation, {
      parentId: "c1",
      message: "Split into two lists.",
      at: AT,
    });
    expect(
      updated.startsWith(continuation.slice(0, continuation.indexOf("---\n"))),
    ).toBe(true);
    expect(updated).toBe(
      `${continuation}  a2:\n    body: "Split into two lists."\n    by: AI\n    at: "${AT}"\n    re: c1\n`,
    );
    expectCanonical(updated);
  });

  it("replies once to a comment over several blocks (never to one copy)", () => {
    const updated = appendRoughdraftReply(
      canonical(fixture("repro-case1-ui-saved")),
      { parentId: "c1", message: "Done.", at: AT },
    );
    const index = extractRoughdraftReviewIndex(updated);
    expect(index.items.filter((item) => item.kind === "reply")).toEqual([
      expect.objectContaining({ id: "a1", parentId: "c1" }),
    ]);
    expect(index.items.find((item) => item.id === "c1")?.anchors).toHaveLength(
      2,
    );
  });

  it("replies to a reply, a document comment and a suggestion", () => {
    let markdown = fixture("canonical-document-comments");
    markdown = appendRoughdraftReply(markdown, {
      parentId: "a1",
      message: "Thanks.",
      author: "user",
      at: AT,
    });
    markdown = appendRoughdraftReply(markdown, {
      parentId: "c2",
      message: "One more.",
      at: AT,
    });
    const suggestions = appendRoughdraftReply(
      fixture("canonical-suggestions"),
      { parentId: "s2", message: "Agreed.", at: AT },
    );
    const replies = extractRoughdraftReviewIndex(markdown).items.filter(
      (item) => item.kind === "reply",
    );
    expect(
      replies.map((item) => [item.id, item.parentId, item.author]),
    ).toEqual([
      ["a1", "c2", "AI"],
      ["c3", "a1", "user"],
      ["a3", "c2", "AI"],
    ]);
    expect(
      extractRoughdraftReviewIndex(suggestions).items.find(
        (item) => item.parentId === "s2",
      )?.id,
    ).toBe("a1");
    expectCanonical(markdown);
    expectCanonical(suggestions);
    expect(validateWithLegacyReader(markdown).errors).toEqual([]);
  });

  it("uses cN for a person's reply and honours an explicit id", () => {
    const user = appendRoughdraftReply(prose, {
      parentId: "c1",
      message: "Thanks.",
      author: "user",
      at: AT,
    });
    expect(user).toContain('  c3:\n    body: "Thanks."\n    by: user');
    const explicit = appendRoughdraftReply(prose, {
      parentId: "c1",
      message: "x",
      id: "a9",
      at: AT,
    });
    expect(explicit).toContain("  a9:");
    expect(() =>
      appendRoughdraftReply(prose, { parentId: "c1", message: "x", id: "c1" }),
    ).toThrow(/already in use/);
  });

  it("refuses an unknown parent, close delimiters and empty text", () => {
    expect(() =>
      appendRoughdraftReply(prose, { parentId: "c9", message: "x" }),
    ).toThrow("Review item not found: c9");
    expect(() =>
      appendRoughdraftReply(prose, {
        parentId: "c1",
        message: "This closes early <<} here.",
      }),
    ).toThrow(/CriticMarkup close delimiter/);
    expect(() =>
      appendRoughdraftReply(prose, { parentId: "c1", message: " \n " }),
    ).toThrow(/empty/);
  });

  it("refuses an old-shape file with a message naming roughdraft doctor --fix", () => {
    const old = fixture("repro-case6-ui-saved");
    expect(() =>
      appendRoughdraftReply(old, { parentId: "c1", message: "x" }),
    ).toThrow(RoughdraftFormatError);
    try {
      appendRoughdraftReply(old, { parentId: "c1", message: "x" });
    } catch (error) {
      expect((error as RoughdraftFormatError).code).toBe("legacy-format");
      expect((error as Error).message).toContain("roughdraft doctor --fix");
      expect((error as RoughdraftFormatError).line).toBe(2);
    }
  });

  it("refuses a file whose review data needs a person, naming the line", () => {
    expect(() =>
      appendRoughdraftReply(fixture("probe-R02-duplicate-endmatter-key"), {
        parentId: "c1",
        message: "x",
      }),
    ).toThrow(/line 13/);
    expect(() =>
      appendRoughdraftReply(fixture("probe-R04-body-hash"), {
        parentId: "c1",
        message: "x",
      }),
    ).toThrow(/line 8/);
  });

  it("rewrites hand-written YAML canonically (formatting only, not an old shape)", () => {
    const handWritten = fixture("suggestion-with-reply");
    const updated = appendRoughdraftReply(handWritten, {
      parentId: "s1",
      message: "Fine.",
      at: AT,
    });
    expectCanonical(updated);
  });
});

describe("appendRoughdraftDocumentComment", () => {
  it("adds a scope: document entry with an aN id for the agent", () => {
    const updated = appendRoughdraftDocumentComment(prose, {
      message: "Round 1 done.",
      at: AT,
    });
    expect(updated).toContain(
      `  a2:\n    body: "Round 1 done."\n    by: AI\n    at: "${AT}"\n    scope: document\n`,
    );
    expectCanonical(updated);
  });

  it("creates the review block on a file with none, keeping <br> for line breaks", () => {
    const updated = appendRoughdraftDocumentComment("# Plan\n\nText.\n", {
      message: "First line.\nSecond line.",
      author: "user",
      at: AT,
    });
    expect(updated).toBe(
      `# Plan\n\nText.\n\n---\ncomments:\n  c1:\n    body: "First line.<br>Second line."\n    by: user\n    at: "${AT}"\n    scope: document\n`,
    );
    expect(extractRoughdraftReviewIndex(updated).items[0]).toMatchObject({
      scope: "document",
      text: "First line.\nSecond line.",
    });
  });

  it("refuses an old-shape file for the agent, but writes a person's comment the 0.1.10 way", () => {
    const old = fixture("repro-case6-ui-saved");
    expect(() =>
      appendRoughdraftDocumentComment(old, { message: "Note." }),
    ).toThrow(/roughdraft doctor --fix/);
    const done = appendRoughdraftDocumentComment(old, {
      message: "Please review.",
      author: "user",
      at: AT,
    });
    expect(done.startsWith(old.trimEnd())).toBe(true);
    expect(
      extractRoughdraftReviewIndex(done).items.find(
        (item) => item.text === "Please review.",
      ),
    ).toMatchObject({ scope: "document" });
  });

  it("refuses to add a second block after a final comments: section that is text", () => {
    const ignored =
      '# Doc\n\nText.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n';
    expect(() =>
      appendRoughdraftDocumentComment(ignored, { message: "x" }),
    ).toThrow(/second block/);
  });
});

describe("markRoughdraftResolved", () => {
  it("sets status and the summary on a comment or a suggestion", () => {
    const comment = markRoughdraftResolved(prose, {
      targetId: "c1",
      summary: "Cited the report.",
    });
    expect(comment).toContain(
      '    status: resolved\n    resolved: "Cited the report."',
    );
    const suggestion = markRoughdraftResolved(
      fixture("canonical-suggestions"),
      { targetId: "s1" },
    );
    expect(
      extractRoughdraftReviewIndex(suggestion).items.find(
        (item) => item.id === "s1",
      )?.status,
    ).toBe("resolved");
    expectCanonical(comment);
    expectCanonical(suggestion);
  });

  it("refuses an unknown target and an old-shape file", () => {
    expect(() => markRoughdraftResolved(prose, { targetId: "c9" })).toThrow(
      "Review item not found: c9",
    );
    expect(() =>
      markRoughdraftResolved(fixture("probe-R08-inline-attr-resolved"), {
        targetId: "c1",
      }),
    ).toThrow(/roughdraft doctor --fix/);
  });
});
