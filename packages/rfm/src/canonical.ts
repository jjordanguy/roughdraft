import {
  buildReviewDoc,
  FORMATTING_CHANGES,
  type ReviewDoc,
  type RfmNormalizationChange,
  type RfmNormalizationRefusal,
  serializeDoc,
} from "./document.js";
import type { RfmReviewModel } from "./model.js";

export type RoughdraftFormatErrorCode =
  | "legacy-format"
  | "needs-a-person"
  | "document-invalid";

/**
 * Thrown by the agent-facing writers (and the round builder) on a file they
 * must not write: an older review format (D11: convert it with
 * `roughdraft doctor --fix` first), review data normalization refuses to
 * decide, or a review block that cannot be read.
 */
export class RoughdraftFormatError extends Error {
  readonly code: RoughdraftFormatErrorCode;
  readonly changes: RfmNormalizationChange[];
  readonly refused: RfmNormalizationRefusal[];
  /** First line the error concerns, when known. */
  readonly line: number | null;

  constructor(
    code: RoughdraftFormatErrorCode,
    message: string,
    details: {
      changes?: RfmNormalizationChange[];
      refused?: RfmNormalizationRefusal[];
      line?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "RoughdraftFormatError";
    this.code = code;
    this.changes = details.changes ?? [];
    this.refused = details.refused ?? [];
    this.line = details.line ?? null;
  }
}

export const LEGACY_FORMAT_MESSAGE =
  "This file uses an older review format. Run roughdraft doctor --fix on it to convert it first (roughdraft doctor --fix --dry-run shows what changes).";

export interface CanonicalDocument {
  doc: ReviewDoc;
  /** The canonical bytes of the document as it is now. */
  canonical: string;
  /** The model of `canonical`. */
  model: RfmReviewModel;
  /** What normalization changed to reach `canonical` (empty for a canonical file). */
  changes: RfmNormalizationChange[];
  bodyOffset: number;
}

/**
 * Load a document for an agent write. Refuses an old-shape file unless
 * `allowLegacy` (normalization then happens on the way and is reported).
 * Formatting-only differences in the review block (quoting, `scope:
 * document` on a legacy global comment, the blank line before the block) are
 * not an old shape: the write rewrites them canonically.
 */
export function loadCanonical(
  markdown: string,
  options: { allowLegacy?: boolean } = {},
): CanonicalDocument {
  const built = buildReviewDoc(markdown);
  if (!built.doc) {
    const first = built.refused[0];
    throw new RoughdraftFormatError(
      "document-invalid",
      `The review block at the end of this file could not be read${first ? `: line ${first.line}: ${first.message}` : "."} Fix it on disk, then run roughdraft doctor.`,
      { refused: built.refused, line: first?.line ?? null },
    );
  }
  if (built.refused.length > 0) {
    const first = built.refused[0];
    throw new RoughdraftFormatError(
      "needs-a-person",
      `This file has review data that needs a person before an agent can write to it: line ${first?.line}: ${first?.message} (roughdraft doctor lists every problem).`,
      {
        refused: built.refused,
        changes: built.changes,
        line: first?.line ?? null,
      },
    );
  }
  const shapeChanges = built.changes.filter(
    (change) => !FORMATTING_CHANGES.has(change.code),
  );
  if (shapeChanges.length > 0 && !options.allowLegacy) {
    throw new RoughdraftFormatError("legacy-format", LEGACY_FORMAT_MESSAGE, {
      changes: built.changes,
      line: shapeChanges[0]?.line ?? null,
    });
  }
  const canonical = serializeDoc(built.doc);
  // Rebuild from the canonical bytes so offsets and pieces match them.
  const again = buildReviewDoc(canonical);
  if (!again.doc) {
    throw new RoughdraftFormatError(
      "document-invalid",
      "The canonical form of this file could not be read back (a Roughdraft bug).",
    );
  }
  return {
    doc: again.doc,
    canonical,
    model: again.model,
    changes: built.changes,
    bodyOffset: again.model.split.bodyOffset,
  };
}
