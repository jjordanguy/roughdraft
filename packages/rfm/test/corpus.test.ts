// Jordan's real review documents, copied into the git-ignored
// packages/rfm/test/corpus/ folder. They are private, so the folder is never
// committed and this suite skips when it is absent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractReviewIndexWithLegacyReader,
  extractRoughdraftReviewIndex,
  parseReviewModel,
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

// Errors the fork reports where 0.1.10 passed the file but silently lost or
// misread part of it: a second review block (0.1.10 reads only the last one,
// dropping every entry in the first) and a blank line inside an inline
// comment (the browser cannot read such a comment back).
const DEFECTS_LEGACY_HIDES = new Set([
  "multiple-endmatter-blocks",
  "inline-comment-blank-line",
]);

describe.skipIf(files.length === 0)("real review documents", () => {
  it.each(files)("%s", (file) => {
    const markdown = fs.readFileSync(path.join(corpusDir, file), "utf8");
    const model = parseReviewModel(markdown);

    const unexpectedErrors = model.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !DEFECTS_LEGACY_HIDES.has(diagnostic.code),
    );
    expect(unexpectedErrors).toEqual([]);

    // The model lists every id once.
    expect(new Set(model.ids).size).toBe(model.ids.length);
    const listed = [
      ...model.comments.map((item) => item.id),
      ...model.suggestions.map((item) => item.id),
      ...model.orphans.map((item) => item.id),
    ];
    expect(new Set(listed)).toEqual(new Set(model.ids));
    expect(listed.length).toBe(model.ids.length);

    // Every reply hangs under an existing parent.
    for (const reply of model.comments.filter(
      (item) => item.kind === "reply",
    )) {
      expect(reply.parentMissing, reply.id).toBe(false);
      expect(model.byId.get(reply.parentId ?? "")?.replies).toContain(reply.id);
    }

    const legacy = validateWithLegacyReader(markdown);
    if (!legacy.ok || model.split.status === "invalid") return;

    const legacyItems = extractReviewIndexWithLegacyReader(markdown).items;
    const forkItems = extractRoughdraftReviewIndex(markdown).items;
    const forkById = new Map(forkItems.map((item) => [item.id, item]));
    for (const item of legacyItems) {
      expect(forkById.get(item.id), item.id).toMatchObject({
        kind: item.kind,
        parentId: item.parentId,
      });
    }

    // 0.1.10 ignores a review block when the text has no `{#` and the block
    // has no document comment (format review R01: inline attribute roots plus
    // replies in the block). The fork reads those entries; nothing else may
    // differ.
    const legacyIds = new Set(legacyItems.map((item) => item.id));
    const recovered = forkItems.filter((item) => !legacyIds.has(item.id));
    if (recovered.length > 0) {
      expect(model.split.body.includes("{#")).toBe(false);
      for (const item of recovered) {
        expect(model.split.entries.comments.has(item.id), item.id).toBe(true);
      }
    }
    expect(forkItems.length).toBe(legacyItems.length + recovered.length);
  });
});
