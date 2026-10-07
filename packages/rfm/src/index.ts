import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  extractReviewIndexWithLegacyReader,
  legacyAppendRoughdraftDocumentComment,
  legacyAppendRoughdraftReply,
  legacyMarkRoughdraftResolved,
} from "./legacy.js";
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
  extractReviewIndexWithLegacyReader,
  type LegacyReviewIndex,
  type LegacyValidationResult,
  validateWithLegacyReader,
} from "./legacy.js";
export {
  parseReviewModel,
  type RfmAnchor,
  type RfmAnchorKind,
  type RfmCommentScope,
  type RfmDiagnostic,
  type RfmDiagnosticSeverity,
  type RfmMetadataSource,
  type RfmModelComment,
  type RfmModelSuggestion,
  type RfmModelSummary,
  type RfmOrphanEntry,
  type RfmReviewModel,
  type RfmSuggestionKind,
  type RfmSuggestionPart,
} from "./model.js";
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

export interface AppendRoughdraftReplyOptions {
  parentId: string;
  message: string;
  author?: string;
  at?: string;
  id?: string;
}

export interface AppendRoughdraftDocumentCommentOptions {
  message: string;
  author?: string;
  at?: string;
  id?: string;
}

export interface MarkRoughdraftResolvedOptions {
  targetId: string;
  summary?: string;
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

// --------------------------------------------------------------- writers
//
// The three mutation helpers keep the 0.1.10 behavior until batch 3b replaces
// them with the canonical writer. They run the frozen 0.1.10 code, with one
// fix: a reply whose parent lives only in the review block (a document-level
// comment, an endmatter reply, or a new-format root whose text is in the
// block) is written to the review block with `re`. 0.1.10 wrote it as an
// inline attribute block directly above `---`.

const CRITICMARKUP_CLOSE_DELIMITER_PATTERN = /<<}|\+\+}|--}|~~}|==}/;

function assertSafeCommentBodyText(message: string): void {
  const match = message.match(CRITICMARKUP_CLOSE_DELIMITER_PATTERN);
  if (!match) return;
  throw new Error(
    `Reply text contains CriticMarkup close delimiter "${match[0]}". Rewrite the reply without raw CriticMarkup delimiters.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plainObjectEntries(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => isPlainObject(entry)),
  );
}

function nextLegacyCommentId(items: Array<{ id: string }>): string {
  let maxId = 0;
  for (const item of items) {
    const match = item.id.match(/^c(\d+)$/);
    if (!match) continue;
    maxId = Math.max(maxId, Number.parseInt(match[1] ?? "0", 10));
  }
  return `c${maxId + 1}`;
}

/** 0.1.10's endmatter rewrite: the final block is re-serialized with yaml defaults. */
function writeLegacyEndmatterComment(
  markdown: string,
  id: string,
  entry: Record<string, unknown>,
): string {
  const last = [...markdown.matchAll(/\n---[ \t]*\r?\n/g)].at(-1);
  if (!last || last.index === undefined) {
    throw new Error("Review block not found.");
  }
  const yaml = markdown.slice(last.index).replace(/^\n---[ \t]*\r?\n/, "");
  const parsed = parseYaml(yaml) as unknown;
  const data: Record<string, unknown> = isPlainObject(parsed)
    ? { ...parsed }
    : {};
  const comments = plainObjectEntries(data.comments);
  const suggestions = plainObjectEntries(data.suggestions);
  comments[id] = entry;
  data.comments = comments;
  if (Object.keys(suggestions).length > 0) {
    data.suggestions = suggestions;
  } else {
    delete data.suggestions;
  }
  const body = markdown.slice(0, last.index).replace(/\s*$/, "\n");
  return `${body}\n---\n${stringifyYaml(data)}`;
}

export function appendRoughdraftReply(
  markdown: string,
  options: AppendRoughdraftReplyOptions,
): string {
  assertSafeCommentBodyText(options.message);
  const index = extractReviewIndexWithLegacyReader(markdown);
  const parent = index.items.find((item) => item.id === options.parentId);
  if (!parent) {
    throw new Error(`Review item not found: ${options.parentId}`);
  }

  // 0.1.10 locates review-block items at the block itself (offset equals
  // endOffset); those parents have nothing inline to attach a reply to.
  const parentOnlyInReviewBlock = parent.offset === parent.endOffset;
  if (!parentOnlyInReviewBlock) {
    return legacyAppendRoughdraftReply(markdown, options);
  }

  return writeLegacyEndmatterComment(
    markdown,
    options.id ?? nextLegacyCommentId(index.items),
    {
      body: options.message,
      by: options.author ?? "AI",
      at: options.at ?? new Date().toISOString(),
      re: options.parentId,
    },
  );
}

export function appendRoughdraftDocumentComment(
  markdown: string,
  options: AppendRoughdraftDocumentCommentOptions,
): string {
  return legacyAppendRoughdraftDocumentComment(markdown, options);
}

export function markRoughdraftResolved(
  markdown: string,
  options: MarkRoughdraftResolvedOptions,
): string {
  return legacyMarkRoughdraftResolved(markdown, options);
}
