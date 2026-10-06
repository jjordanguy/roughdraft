import {
  buildReviewDoc,
  FORMATTING_CHANGES,
  type RfmNormalizationChange,
  type RfmNormalizationRefusal,
  serializeDoc,
} from "./document.js";
import type { RfmReviewModel } from "./model.js";

export type {
  RfmNormalizationChange,
  RfmNormalizationRefusal,
} from "./document.js";

export interface RfmNormalizationResult {
  /** The canonical document; the input unchanged when anything was refused. */
  markdown: string;
  /** What normalization changed (or would change, when refused), each with its input line. */
  changes: RfmNormalizationChange[];
  /** What it would not decide; non-empty means nothing should be written. */
  refused: RfmNormalizationRefusal[];
}

/**
 * Rewrite a document's review data in the canonical shape: comment text and
 * metadata in the review block, compact refs in the prose, one primary anchor
 * plus continuations for a comment over several blocks, one marker per line
 * for suggestions (linked by `continues`), fence-line refs for comments on
 * code, one review block written by the canonical writer. Idempotent. Refuses
 * (and returns the input unchanged) on anything it cannot decide: two bodies
 * for one id, unparsable YAML, a ref with no metadata, any other error the
 * doctor reports. Every change and every refusal names an input line.
 */
export function normalizeRoughdraftMetadata(
  markdown: string,
): RfmNormalizationResult {
  const built = buildReviewDoc(markdown);
  const byLine = <T extends { line?: number }>(list: T[]) =>
    list
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) => (a.item.line ?? 0) - (b.item.line ?? 0) || a.index - b.index,
      )
      .map(({ item }) => item);
  const changes = byLine(built.changes);
  if (!built.doc || built.refused.length > 0) {
    return { markdown, changes, refused: byLine(built.refused) };
  }
  return { markdown: serializeDoc(built.doc), changes, refused: [] };
}

/** True when a normalization changes the file's shape, not only the review block's formatting. */
export function changesShape(changes: RfmNormalizationChange[]): boolean {
  return changes.some((change) => !FORMATTING_CHANGES.has(change.code));
}

/**
 * The canonical bytes of a parsed document. A file already in the canonical
 * shape comes back byte for byte. Throws when the model holds something that
 * has no canonical form without a decision (see `normalizeRoughdraftMetadata`).
 */
export function serializeReviewModel(model: RfmReviewModel): string {
  const source =
    (model.split.frontmatter ?? "") +
    model.split.body +
    (model.split.endmatter ?? "");
  const built = buildReviewDoc(source);
  if (!built.doc || built.refused.length > 0) {
    const first = built.refused[0];
    throw new Error(
      first
        ? `Cannot write this document in the canonical shape: line ${first.line}: ${first.message}`
        : "Cannot write this document in the canonical shape.",
    );
  }
  return serializeDoc(built.doc);
}
