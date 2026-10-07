import {
  createLineStarts,
  locationForOffset,
  parseReviewModel,
  type RfmAnchor,
  type RfmCommentScope,
  type RfmDiagnostic,
  type RfmSuggestionKind,
} from "./model.js";
import type { RfmEndmatterStatus } from "./split.js";

export {
  applyReviewResponse,
  type RfmApplyAnchorReport,
  type RfmApplyEditReport,
  type RfmApplyError,
  type RfmApplyInput,
  type RfmApplyReport,
  type RfmApplyResult,
  type RfmEditSpec,
  type RfmRestoredItem,
  type RfmReviewResponse,
  type RfmThreadAction,
} from "./apply.js";
export {
  type CanonicalDocument,
  LEGACY_FORMAT_MESSAGE,
  RoughdraftFormatError,
  type RoughdraftFormatErrorCode,
} from "./canonical.js";
export {
  cleanOffsetToSource,
  type RfmCleanText,
  type RfmCleanTextAnchor,
  type RfmCleanTextMap,
  type RfmCleanTextRun,
  type RfmCleanTextSuggestion,
  reviewCleanText,
} from "./clean.js";
export { diffCleanText } from "./edits.js";
export {
  extractReviewIndexWithLegacyReader,
  type LegacyReviewIndex,
  type LegacyValidationResult,
  validateWithLegacyReader,
} from "./legacy.js";
export { lintRoughdraftMarkdown, type RfmLintResult } from "./lint.js";
export {
  mergeReviewEntries,
  type RfmEntriesInput,
  type RfmMergeConflict,
  type RfmMergedEntries,
  type RfmMergeResult,
} from "./merge.js";
export { type DiffHunk, diffSequences } from "./diff3.js";
export {
  type ConflictHunk,
  mergeReview,
  type RfmConflictHunk,
  type RfmConflictReason,
  type RfmMergeChoice,
  type RfmMergeReviewOptions,
  type RfmMergeReviewResult,
} from "./merge-review.js";
export {
  parseReviewModel,
  type RfmAnchor,
  type RfmAnchorKind,
  type RfmCommentScope,
  type RfmDiagnostic,
  type RfmDiagnosticSeverity,
  type RfmFence,
  type RfmMarkupRun,
  type RfmMetadataSource,
  type RfmModelComment,
  type RfmModelSuggestion,
  type RfmModelSummary,
  type RfmOrphanEntry,
  type RfmReviewModel,
  type RfmSuggestionKind,
  type RfmSuggestionPart,
  type RfmTailItem,
} from "./model.js";
export {
  changesShape,
  normalizeRoughdraftMetadata,
  type RfmNormalizationChange,
  type RfmNormalizationRefusal,
  type RfmNormalizationResult,
  serializeReviewModel,
} from "./normalize.js";
export {
  buildReviewRound,
  DEFAULT_AGENT_LABELS,
  type RfmRound,
  type RfmRoundAnchor,
  type RfmRoundOptions,
  type RfmRoundReply,
  type RfmRoundSegment,
  type RfmRoundThread,
  type RfmRoundThreadKind,
} from "./round.js";
export { sha256Hex } from "./sha256.js";
export {
  type RfmEndmatterEntries,
  type RfmEndmatterEntry,
  type RfmEndmatterStatus,
  type RfmYamlError,
  type RfmYamlErrorCode,
  type RoughdraftDocumentSplit,
  splitRoughdraftDocument,
} from "./split.js";
export {
  ENTRY_KEY_ORDER,
  type RfmEndmatterEntriesInput,
  stringifyRoughdraftEndmatter,
} from "./writer.js";
export {
  type AppendRoughdraftDocumentCommentOptions,
  type AppendRoughdraftReplyOptions,
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  type MarkRoughdraftResolvedOptions,
  markRoughdraftResolved,
} from "./writers.js";

export interface RfmValidationSummary {
  /** Roots + document-level comments + replies (the number `doctor` prints). */
  comments: number;
  suggestions: number;
  legacyMetadata: number;
  /** Comments anchored in the text: inline, code and standalone. */
  roots: number;
  /** Document-level comments, lost anchors included. */
  documentComments: number;
  replies: number;
  /** Status of the review block at the end of the file. */
  endmatter: RfmEndmatterStatus;
}

export interface RfmValidationResult {
  format: "roughdraft-flavored-markdown";
  version: "0.2";
  ok: boolean;
  diagnostics: RfmDiagnostic[];
  errors: RfmDiagnostic[];
  warnings: RfmDiagnostic[];
  summary: RfmValidationSummary;
}

export type RfmReviewItemKind = "comment" | "suggestion" | "reply";

export interface RfmReviewItemAnchor {
  kind: RfmAnchor["kind"];
  text: string;
  blockIndex: number;
  offset: number;
  endOffset: number;
  line: number;
}

export interface RfmReviewItem {
  id: string;
  kind: RfmReviewItemKind;
  suggestionKind?: RfmSuggestionKind;
  parentId: string | null;
  author: string | null;
  createdAt: string | null;
  status: string | null;
  text: string;
  originalText?: string;
  replacementText?: string;
  /** Text of the primary anchor (first in document order). */
  anchorText?: string;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
  /** Where the item shows; replies take their thread root's scope, suggestions are `inline`. */
  scope: RfmCommentScope;
  /** Every anchor of a root comment (continuations included) or every marker of a suggestion; empty for replies and document comments. */
  anchors: RfmReviewItemAnchor[];
  /** Code comments: highlighted lines inside the block. */
  lines: [number, number] | null;
  /** Code comments: the highlighted lines joined with newline. */
  quote: string | null;
  /** Suggestions: the suggestion this one continues. */
  continues: string | null;
  /** Resolution summary, when resolved. */
  resolved: string | null;
  /** A comment whose anchor is gone from the text (shown with the document comments). */
  lostAnchor: boolean;
}

export interface RfmReviewIndexSummary {
  /** Roots plus document-level comments (items of kind `comment`). */
  comments: number;
  replies: number;
  suggestions: number;
  unresolved: number;
  roots: number;
  documentComments: number;
  endmatter: RfmEndmatterStatus;
}

export interface RfmReviewIndex {
  format: "roughdraft-flavored-markdown";
  version: "0.2";
  items: RfmReviewItem[];
  diagnostics: RfmDiagnostic[];
  summary: RfmReviewIndexSummary;
}

const RFM_VERSION = "0.2" as const;

export function validateRoughdraftMarkdown(
  markdown: string,
): RfmValidationResult {
  const model = parseReviewModel(markdown);
  const errors = model.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const warnings = model.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );
  return {
    format: "roughdraft-flavored-markdown",
    version: RFM_VERSION,
    ok: errors.length === 0,
    diagnostics: model.diagnostics,
    errors,
    warnings,
    summary: {
      comments: model.summary.comments,
      suggestions: model.summary.suggestions,
      legacyMetadata: model.summary.legacyMetadata,
      roots: model.summary.roots,
      documentComments: model.summary.documentComments,
      replies: model.summary.replies,
      endmatter: model.summary.endmatter,
    },
  };
}

function itemAnchor(anchor: RfmAnchor): RfmReviewItemAnchor {
  return {
    kind: anchor.kind,
    text: anchor.text,
    blockIndex: anchor.blockIndex,
    offset: anchor.offset,
    endOffset: anchor.endOffset,
    line: anchor.line,
  };
}

export function extractRoughdraftReviewIndex(markdown: string): RfmReviewIndex {
  const model = parseReviewModel(markdown);
  const lineStarts = createLineStarts(markdown);
  const items: RfmReviewItem[] = [];

  for (const comment of model.comments) {
    items.push({
      id: comment.id,
      kind: comment.kind,
      parentId: comment.parentId,
      author: comment.by,
      createdAt: comment.at,
      status: comment.status,
      text: comment.body,
      anchorText:
        comment.primaryAnchor && comment.primaryAnchor.kind !== "standalone"
          ? comment.primaryAnchor.text
          : undefined,
      offset: comment.offset,
      endOffset: comment.endOffset,
      ...locationForOffset(lineStarts, comment.offset),
      scope: comment.scope,
      anchors: comment.anchors.map(itemAnchor),
      lines: comment.lines,
      quote: comment.quote,
      continues: null,
      resolved: comment.resolved,
      lostAnchor: comment.lostAnchor,
    });
  }

  for (const suggestion of model.suggestions) {
    items.push({
      id: suggestion.id,
      kind: "suggestion",
      suggestionKind: suggestion.suggestionKind,
      parentId: null,
      author: suggestion.by,
      createdAt: suggestion.at,
      status: suggestion.status,
      text: suggestion.text,
      originalText: suggestion.originalText,
      replacementText: suggestion.replacementText,
      offset: suggestion.offset,
      endOffset: suggestion.endOffset,
      ...locationForOffset(lineStarts, suggestion.offset),
      scope: "inline",
      anchors: suggestion.parts.map((part) => ({
        kind: "suggestion" as const,
        text: part.text,
        blockIndex: part.blockIndex,
        offset: part.offset,
        endOffset: part.endOffset,
        line: part.line,
      })),
      lines: null,
      quote: null,
      continues: suggestion.continues,
      resolved: suggestion.resolved,
      lostAnchor: false,
    });
  }

  items.sort((a, b) => a.offset - b.offset);

  return {
    format: "roughdraft-flavored-markdown",
    version: RFM_VERSION,
    items,
    diagnostics: model.diagnostics,
    summary: {
      comments: items.filter((item) => item.kind === "comment").length,
      replies: items.filter((item) => item.kind === "reply").length,
      suggestions: items.filter((item) => item.kind === "suggestion").length,
      unresolved: items.filter((item) => item.status !== "resolved").length,
      roots: model.summary.roots,
      documentComments: model.summary.documentComments,
      endmatter: model.summary.endmatter,
    },
  };
}
