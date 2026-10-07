// `roughdraft doctor --fix` over copies of Jordan's real review documents
// (git-ignored packages/rfm/test/corpus/; the suite skips without them). Each
// document either normalizes cleanly or refuses with a named line; which one
// is pinned below so a change in either direction is a visible decision.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReviewRound,
  extractRoughdraftReviewIndex,
  lintRoughdraftMarkdown,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  reviewCleanText,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "../src/index";

const corpusDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "corpus",
);
const files = fs.existsSync(corpusDir)
  ? fs
      .readdirSync(corpusDir)
      .filter((file) => file.endsWith(".md"))
      .sort()
  : [];

/** Documents normalization refuses, with the lines it names. */
const REFUSED: Record<string, Array<{ code: string; line: number }>> = {
  // Attribute-metadata examples inside fenced code, and no review data
  // outside code: documentation or a comment written inside code? A person
  // decides.
};

/** Documents already in the canonical shape (nothing to change). */
const UNCHANGED = new Set([
  "OpenMike-ops--TOOLS.md",
  // Markup examples inside fenced code are literal, so nothing to convert.
  "roughdraft-review--SKILL.md",
]);

const itemLine = (
  item: ReturnType<typeof extractRoughdraftReviewIndex>["items"][number],
) =>
  `${item.id} ${item.kind} ${item.parentId} ${item.author} ${item.createdAt} ${item.status} ${item.resolved}: ${item.text}`;

describe.skipIf(files.length === 0)("doctor --fix on real documents", () => {
  it("covers every document in the corpus", () => {
    expect(files.length).toBeGreaterThanOrEqual(26);
  });

  it.each(files)("%s", (file) => {
    const markdown = fs.readFileSync(path.join(corpusDir, file), "utf8");
    const result = normalizeRoughdraftMetadata(markdown);
    const expectedRefusals = REFUSED[file];
    if (expectedRefusals) {
      expect(result.refused.map(({ code, line }) => ({ code, line }))).toEqual(
        expectedRefusals,
      );
      expect(result.markdown).toBe(markdown);
      return;
    }
    expect(result.refused).toEqual([]);
    if (UNCHANGED.has(file)) expect(result.changes).toEqual([]);
    else expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes) expect(change.line).toBeGreaterThan(0);

    // Idempotent.
    const again = normalizeRoughdraftMetadata(result.markdown);
    expect(again.changes).toEqual([]);
    expect(again.markdown).toBe(result.markdown);

    // No item lost or changed (a file whose second review block hid items
    // gains them).
    const before = extractRoughdraftReviewIndex(markdown).items.map(itemLine);
    const after = extractRoughdraftReviewIndex(result.markdown).items.map(
      itemLine,
    );
    if (parseReviewModel(markdown).split.status !== "invalid") {
      expect(after.sort()).toEqual(before.sort());
    } else {
      expect(after.length).toBeGreaterThan(0);
    }

    // The fork, the frozen 0.1.10 reader and the rd-lint rules accept it.
    expect(validateRoughdraftMarkdown(result.markdown).errors).toEqual([]);
    // The 0.1.10 reader mistakes frontmatter for a review block in a file
    // with markup examples; only converted review documents must satisfy it.
    if (!UNCHANGED.has(file)) {
      expect(validateWithLegacyReader(result.markdown).errors).toEqual([]);
    }
    expect(lintRoughdraftMarkdown(result.markdown).fails).toEqual([]);

    // The prose is untouched and a round can start on it.
    expect(reviewCleanText(result.markdown).clean.replace(/\s+$/, "")).toBe(
      reviewCleanText(markdown).clean.replace(/\s+$/, ""),
    );
    expect(() => buildReviewRound(result.markdown)).not.toThrow();
  });
});
