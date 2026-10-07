// The rfm reader and writers exactly as published in roughdraft 0.1.10, frozen
// in packages/rfm/legacy/index-0.1.10.js. Used to prove that files the fork
// writes still read correctly on a machine running 0.1.10 (the apply gate), and
// for the one write the fork keeps in the 0.1.10 shape: a person's global
// comment on a file still in the old format (see writers.ts).
import * as frozen from "../legacy/index-0.1.10.js";

export interface LegacyDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface LegacyValidationResult {
  format: "roughdraft-flavored-markdown";
  version: "0.2";
  ok: boolean;
  diagnostics: LegacyDiagnostic[];
  errors: LegacyDiagnostic[];
  warnings: LegacyDiagnostic[];
  summary: { comments: number; suggestions: number; legacyMetadata: number };
}

export interface LegacyReviewItem {
  id: string;
  kind: "comment" | "suggestion" | "reply";
  suggestionKind?: "addition" | "deletion" | "substitution";
  parentId: string | null;
  author: string | null;
  createdAt: string | null;
  status: string | null;
  text: string;
  originalText?: string;
  replacementText?: string;
  anchorText?: string;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
}

export interface LegacyReviewIndex {
  format: "roughdraft-flavored-markdown";
  version: "0.2";
  items: LegacyReviewItem[];
  diagnostics: LegacyDiagnostic[];
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
}

/** `roughdraft doctor` as the published 0.1.10 runs it. */
export function validateWithLegacyReader(
  markdown: string,
): LegacyValidationResult {
  return frozen.validateRoughdraftMarkdown(markdown) as LegacyValidationResult;
}

/** The 0.1.10 review index (what `roughdraft_get_review_index` returns on 0.1.10). */
export function extractReviewIndexWithLegacyReader(
  markdown: string,
): LegacyReviewIndex {
  return frozen.extractRoughdraftReviewIndex(markdown) as LegacyReviewIndex;
}

export const legacyAppendRoughdraftDocumentComment =
  frozen.appendRoughdraftDocumentComment as (
    markdown: string,
    options: { message: string; author?: string; at?: string; id?: string },
  ) => string;
