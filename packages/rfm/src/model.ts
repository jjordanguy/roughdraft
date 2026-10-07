import {
  type FenceState,
  matchFence,
  type RfmEndmatterEntry,
  type RfmEndmatterStatus,
  type RoughdraftDocumentSplit,
  splitDocumentDetails,
  splitLines,
} from "./split.js";

export type RfmDiagnosticSeverity = "error" | "warning";

export interface RfmDiagnostic {
  severity: RfmDiagnosticSeverity;
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export type RfmSuggestionKind = "addition" | "deletion" | "substitution";

/** Where a comment shows: on highlighted prose, on code lines, as an anchorless card, or in the global section. */
export type RfmCommentScope = "inline" | "code" | "document" | "standalone";

/**
 * - `highlight`: `{==text==}` followed by a train or a ref.
 * - `suggestion`: a comment train or ref written after a suggestion marker.
 * - `standalone`: a bare `{#c1}` ref or a train with no highlight.
 * - `code`: a ref on the opening line of a fenced code block.
 */
export type RfmAnchorKind = "highlight" | "suggestion" | "standalone" | "code";

export interface RfmAnchor {
  kind: RfmAnchorKind;
  /** Index of the Markdown block (paragraph, heading, list item, fence...) in the body. */
  blockIndex: number;
  /** Highlighted text; the suggestion text; the code quote; empty for standalone. */
  text: string;
  /** Start of the markup (`{==`, the marker, the train or the ref). */
  offset: number;
  /** End of the highlight, marker, train or ref. */
  endOffset: number;
  /** 1-based line of `offset`. */
  line: number;
}

export type RfmMetadataSource = "endmatter" | "attribute" | "legacy" | "none";

export interface RfmModelComment {
  id: string;
  kind: "comment" | "reply";
  /** Replies take the scope of their thread root. */
  scope: RfmCommentScope;
  parentId: string | null;
  /** The thread root (a comment or a suggestion id); the comment itself for roots. */
  rootId: string;
  /** A reply whose `re` names no comment or suggestion in the file. */
  parentMissing: boolean;
  /** Every anchor of a root in document order (continuations merged). Empty for replies. */
  anchors: RfmAnchor[];
  /** The first anchor in document order. */
  primaryAnchor: RfmAnchor | null;
  /** Comment text with `<br>` decoded to line breaks. */
  body: string;
  by: string | null;
  at: string | null;
  status: string | null;
  /** Resolution summary with `<br>` decoded. */
  resolved: string | null;
  /** Code comments: highlighted lines inside the block, 1-based and inclusive. */
  lines: [number, number] | null;
  /** Code comments: the exact highlighted lines joined with newline. */
  quote: string | null;
  /** An entry with no anchor, no `re`, no `scope: document` and no `quote`. */
  lostAnchor: boolean;
  /** Direct reply ids in document order. */
  replies: string[];
  bodySource: "endmatter" | "inline";
  metadataSource: RfmMetadataSource;
  /** The raw YAML entry, unknown keys included. */
  entry: RfmEndmatterEntry | null;
  /** Inline attribute or legacy metadata, unknown attributes included. */
  attributes: Record<string, string> | null;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
}

export interface RfmSuggestionPart {
  blockIndex: number;
  text: string;
  originalText?: string;
  replacementText?: string;
  offset: number;
  endOffset: number;
  line: number;
}

export interface RfmModelSuggestion {
  id: string;
  suggestionKind: RfmSuggestionKind;
  text: string;
  originalText?: string;
  replacementText?: string;
  /** Markers carrying this id. More than one only for replicated legacy markers. */
  parts: RfmSuggestionPart[];
  /** The suggestion this one continues (`continues: s1`), else null. */
  continues: string | null;
  /** Suggestions that continue this one, in document order. */
  continuedBy: string[];
  by: string | null;
  at: string | null;
  status: string | null;
  resolved: string | null;
  replies: string[];
  metadataSource: RfmMetadataSource;
  entry: RfmEndmatterEntry | null;
  attributes: Record<string, string> | null;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
}

/** A review block entry with no anchor, no body and no `re`. */
export interface RfmOrphanEntry {
  id: string;
  section: "comments" | "suggestions";
  entry: RfmEndmatterEntry;
  offset: number;
  line: number;
}

export interface RfmModelSummary {
  /** Roots + document-level comments + replies. */
  comments: number;
  /** Comments anchored in the text (inline, code or standalone). */
  roots: number;
  /** Document-level comments, lost anchors included. */
  documentComments: number;
  replies: number;
  suggestions: number;
  legacyMetadata: number;
  endmatter: RfmEndmatterStatus;
}

/** One train or ref in the tail of a highlight, a suggestion marker or a standalone run. */
export interface RfmTailItem {
  type: "train" | "ref";
  /** The id from the train's metadata or the ref; null for a train with no metadata. */
  id: string | null;
  offset: number;
  endOffset: number;
  /** Train text between `{>>` and `<<}` (raw, `<br>` not decoded). */
  content: string | null;
  /** How the train's metadata is written; null for a ref or a train with none. */
  metadata: "reference" | "attribute" | "legacy" | null;
  /** Attribute or legacy metadata of the train, unknown attributes included. */
  attributes: Record<string, string> | null;
}

/**
 * One run of review markup in the body, in document order. Text between runs
 * is plain Markdown. Writers use these to rewrite the markup without touching
 * the prose around it.
 */
export interface RfmMarkupRun {
  /**
   * - `highlight`: `{==text==}` and the trains and refs after it.
   * - `standalone`: trains or a bare ref with no highlight before them.
   * - `suggestion`: a suggestion marker, its metadata, and the trains and refs after it.
   * - `fence-ref`: one ref on the opening line of a fenced code block.
   */
  type: "highlight" | "standalone" | "suggestion" | "fence-ref";
  offset: number;
  endOffset: number;
  /** Highlight text range (highlight runs). */
  textStart: number | null;
  textEnd: number | null;
  /** Suggestion marker fields (suggestion runs). */
  suggestionKind: RfmSuggestionKind | null;
  markerEnd: number | null;
  /** Deleted or replaced text (deletions and substitutions). */
  original: string | null;
  /** Inserted text (additions and substitutions). */
  replacement: string | null;
  /** The marker's id (suggestion runs) or the ref's id (fence-ref runs). */
  id: string | null;
  /** How the marker's metadata is written (suggestion runs). */
  metadata: "reference" | "attribute" | "legacy" | null;
  attributes: Record<string, string> | null;
  /** End of the marker's metadata (suggestion runs). */
  metadataEnd: number | null;
  /** Index into `fences` (fence-ref runs). */
  fenceIndex: number | null;
  tail: RfmTailItem[];
}

/** A fenced code block in the body. */
export interface RfmFence {
  /** Start of the opening fence line. */
  offset: number;
  /** Start of the info string (after the backticks or tildes). */
  infoOffset: number;
  /** End of the opening line (before its line break). */
  openLineEnd: number;
  /** First byte of the code (the line after the opening line). */
  codeStart: number;
  /** End of the code: the start of the closing fence line, or the end of the body. */
  codeEnd: number;
  info: string;
  codeLines: string[];
  blockIndex: number;
}

export interface RfmReviewModel {
  split: RoughdraftDocumentSplit;
  /** Every run of review markup in the body, in document order. */
  markup: RfmMarkupRun[];
  /** Every fenced code block in the body, in document order. */
  fences: RfmFence[];
  /** Roots, document-level comments and replies in document order; endmatter-only entries follow in YAML order. */
  comments: RfmModelComment[];
  suggestions: RfmModelSuggestion[];
  orphans: RfmOrphanEntry[];
  /** Every comment, suggestion and orphan id, once, in document order. */
  ids: string[];
  byId: Map<string, RfmModelComment | RfmModelSuggestion>;
  diagnostics: RfmDiagnostic[];
  summary: RfmModelSummary;
}

interface Metadata {
  attrs: Map<string, string>;
  kind: "canonical" | "legacy" | "reference";
  offset: number;
  endOffset: number;
}

interface TrainOcc {
  id: string;
  synthetic: boolean;
  content: string;
  meta: Metadata | null;
  offset: number;
  endOffset: number;
  anchor: RfmAnchor;
}

interface RefOcc {
  id: string;
  offset: number;
  endOffset: number;
  anchor: RfmAnchor;
  context: "markup" | "standalone" | "code";
  fence: FenceBlock | null;
}

interface MarkerOcc {
  id: string;
  synthetic: boolean;
  kind: RfmSuggestionKind;
  text: string;
  originalText?: string;
  replacementText?: string;
  meta: Metadata | null;
  offset: number;
  markerEnd: number;
  endOffset: number;
  blockIndex: number;
  line: number;
}

interface FenceBlock {
  offset: number;
  openLineEnd: number;
  codeEnd: number;
  infoOffset: number;
  info: string;
  codeLines: string[];
  interior: string;
  blockIndex: number;
}

type AddDiagnostic = (
  severity: RfmDiagnosticSeverity,
  code: string,
  message: string,
  offset: number,
) => void;

const requiredMetadataAttributes = ["id", "by", "at"] as const;
const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const attributeNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const refPattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}/;
const roughdraftIdPattern = /^[cas]\d+$/;
const brPattern = /<br\s*\/?>/gi;

function decodeBreaks(text: string): string {
  return text.replace(brPattern, "\n");
}

function isValidDateTime(value: string): boolean {
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}

export function createLineStarts(markdown: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") lineStarts.push(index + 1);
  }
  return lineStarts;
}

export function locationForOffset(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return { line: middle + 1, column: offset - lineStart + 1 };
    }
  }
  const lastLineStart = lineStarts[lineStarts.length - 1] ?? 0;
  return { line: lineStarts.length, column: offset - lastLineStart + 1 };
}

/**
 * Block starts used for `blockIndex`. A block is a paragraph, heading, list
 * item, thematic break, table run or fenced code block; blank lines end
 * blocks. This is an approximation of CommonMark block structure that is
 * enough to tell continuation anchors apart.
 */
function computeBlockStarts(
  markdown: string,
  from: number,
  to: number,
): number[] {
  const starts: number[] = [];
  let open = false;
  let fence: FenceState | null = null;
  for (const line of splitLines(markdown)) {
    if (line.start < from || line.start >= to) continue;
    if (fence) {
      if (matchFence(line.text, fence)) {
        fence = null;
        open = false;
      }
      continue;
    }
    const fenceOpen = matchFence(line.text, null);
    if (fenceOpen) {
      starts.push(line.start);
      fence = fenceOpen;
      open = true;
      continue;
    }
    if (line.text.trim() === "") {
      open = false;
      continue;
    }
    const heading = /^ {0,3}#{1,6}(?:\s|$)/.test(line.text);
    const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.text);
    const listItem = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line.text);
    if (heading || rule) {
      starts.push(line.start);
      open = false;
      continue;
    }
    if (listItem || !open) {
      starts.push(line.start);
      open = true;
    }
  }
  return starts;
}

function blockIndexFor(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function isLineStart(markdown: string, offset: number): boolean {
  return offset === 0 || markdown[offset - 1] === "\n";
}

function nextLineOffset(markdown: string, offset: number): number {
  const nextNewline = markdown.indexOf("\n", offset);
  return nextNewline === -1 ? markdown.length : nextNewline + 1;
}

/**
 * CommonMark code spans: a backtick run closes on the next run of exactly the
 * same length inside the same paragraph. An unmatched run is literal text and
 * is skipped whole. (0.1.10 closed on any longer run too, so a double-backtick
 * span around a fence such as `` ```ts `` flipped every later span.)
 */
function matchInlineCodeSpan(markdown: string, offset: number): number | null {
  if (markdown[offset] !== "`") return null;
  let length = 1;
  while (markdown[offset + length] === "`") length += 1;
  const paragraphEnd = markdown.slice(offset).search(/\n[ \t]*\r?\n/);
  const limit = paragraphEnd === -1 ? markdown.length : offset + paragraphEnd;
  let cursor = offset + length;
  while (cursor < limit) {
    const start = markdown.indexOf("`", cursor);
    if (start === -1 || start >= limit) break;
    let end = start;
    while (markdown[end] === "`") end += 1;
    if (end - start === length) return end;
    cursor = end;
  }
  return offset + length;
}

function skipSpaces(markdown: string, offset: number): number {
  let cursor = offset;
  while (markdown[cursor] === " " || markdown[cursor] === "\t") cursor += 1;
  return cursor;
}

function looksLikeMetadata(markdown: string, offset: number): boolean {
  const close = markdown.indexOf("}", offset + 1);
  if (close === -1) return false;
  return /\b(?:id|by|at|re)\b/.test(markdown.slice(offset + 1, close));
}

function parseIdReference(markdown: string, offset: number): Metadata | null {
  const match = markdown.slice(offset, offset + 200).match(refPattern);
  if (!match) return null;
  return {
    attrs: new Map([["id", match[1] ?? ""]]),
    kind: "reference",
    offset,
    endOffset: offset + match[0].length,
  };
}

function parseCanonicalMetadata(
  markdown: string,
  offset: number,
): Metadata | null {
  let cursor = offset + 1;
  const attrs = new Map<string, string>();
  let sawAttribute = false;
  while (cursor < markdown.length) {
    cursor = skipSpaces(markdown, cursor);
    if (markdown[cursor] === "}") {
      if (!sawAttribute) return null;
      return { attrs, kind: "canonical", offset, endOffset: cursor + 1 };
    }
    const nameStart = cursor;
    while (
      cursor < markdown.length &&
      /[A-Za-z0-9_-]/.test(markdown[cursor] ?? "")
    ) {
      cursor += 1;
    }
    const name = markdown.slice(nameStart, cursor);
    if (!attributeNamePattern.test(name) || markdown[cursor] !== "=") {
      return null;
    }
    cursor += 1;
    if (markdown[cursor] !== '"') return null;
    cursor += 1;
    let value = "";
    let closed = false;
    while (cursor < markdown.length) {
      const character = markdown[cursor];
      if (character === "\\") {
        const next = markdown[cursor + 1];
        if (next === undefined) return null;
        value += next;
        cursor += 2;
        continue;
      }
      if (character === '"') {
        cursor += 1;
        attrs.set(name, value);
        sawAttribute = true;
        closed = true;
        break;
      }
      if (character === "\n" || character === "\r") return null;
      value += character;
      cursor += 1;
    }
    if (!closed) return null;
  }
  return null;
}

function parseLegacyAttributes(metadata: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const part of metadata.split(";")) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();
    if (!key || !value) continue;
    attrs.set(key, value);
  }
  return attrs;
}

function parseMetadata(
  markdown: string,
  offset: number,
  allowLegacy: boolean,
  addDiagnostic: AddDiagnostic,
): Metadata | null {
  if (allowLegacy && markdown.startsWith("{@", offset)) {
    const close = markdown.indexOf("@}", offset + 2);
    if (close === -1) {
      addDiagnostic(
        "error",
        "invalid-metadata-syntax",
        "Legacy metadata is missing closing `@}`.",
        offset,
      );
      return null;
    }
    return {
      attrs: parseLegacyAttributes(markdown.slice(offset + 2, close)),
      kind: "legacy",
      offset,
      endOffset: close + 2,
    };
  }
  if (markdown[offset] !== "{") return null;
  const reference = parseIdReference(markdown, offset);
  if (reference) return reference;
  const parsed = parseCanonicalMetadata(markdown, offset);
  if (parsed) return parsed;
  if (looksLikeMetadata(markdown, offset)) {
    addDiagnostic(
      "error",
      "invalid-metadata-syntax",
      "Metadata must use a compact reference such as `{#c1}` backed by final YAML endmatter, or a valid compatibility attribute block.",
      offset,
    );
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonStringBody(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseLines(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return null;
  }
  return [start, end];
}

function attrsRecord(meta: Metadata | null): Record<string, string> | null {
  if (!meta || meta.kind === "reference") return null;
  return Object.fromEntries(meta.attrs);
}

function metadataSourceOf(meta: Metadata | null): RfmMetadataSource {
  if (!meta) return "none";
  if (meta.kind === "reference") return "endmatter";
  return meta.kind === "legacy" ? "legacy" : "attribute";
}

function idList(ids: string[]): string {
  const shown = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${shown} and ${ids.length - 5} more` : shown;
}

/**
 * Parse a document into one review model: every comment, reply, document
 * comment and suggestion, whatever form it is stored in, with the
 * diagnostics `roughdraft doctor` reports.
 */
export function parseReviewModel(markdown: string): RfmReviewModel {
  const split = splitDocumentDetails(markdown);
  const lineStarts = createLineStarts(markdown);
  const diagnostics: RfmDiagnostic[] = [];
  const addDiagnostic: AddDiagnostic = (severity, code, message, offset) => {
    diagnostics.push({
      severity,
      code,
      message,
      offset,
      ...locationForOffset(lineStarts, offset),
    });
  };
  const lineOf = (offset: number) => locationForOffset(lineStarts, offset).line;

  const scanStart = split.bodyOffset;
  const scanEnd = split.blockOffset ?? markdown.length;
  const blockStarts = computeBlockStarts(markdown, scanStart, scanEnd);
  const blockOf = (offset: number) => blockIndexFor(blockStarts, offset);
  const entries = split.entries;
  const endmatterInvalid = split.status === "invalid";

  if (split.yamlError) {
    addDiagnostic(
      "error",
      split.yamlError.code,
      `The review block at the end of this file could not be read: ${split.yamlError.message}`,
      split.yamlError.offset,
    );
  }
  if (split.status === "ignored" && split.blockOffset !== null) {
    addDiagnostic(
      "warning",
      "endmatter-ignored",
      "The final `comments:` / `suggestions:` block is not treated as review data because the text has no review markup and the block has no document-level comment.",
      split.blockOffset,
    );
  }
  for (const invalidEntry of split.invalidEntries) {
    addDiagnostic(
      "error",
      "invalid-endmatter-yaml",
      `Review block entry \`${invalidEntry.id}\` under \`${invalidEntry.section}\` must be a map of fields.`,
      invalidEntry.offset,
    );
  }

  const trains: TrainOcc[] = [];
  const refs: RefOcc[] = [];
  const runs: RfmMarkupRun[] = [];
  const emptyRun = (
    type: RfmMarkupRun["type"],
    offset: number,
  ): RfmMarkupRun => ({
    type,
    offset,
    endOffset: offset,
    textStart: null,
    textEnd: null,
    suggestionKind: null,
    markerEnd: null,
    original: null,
    replacement: null,
    id: null,
    metadata: null,
    attributes: null,
    metadataEnd: null,
    fenceIndex: null,
    tail: [],
  });
  const metadataKindOf = (meta: Metadata | null): RfmTailItem["metadata"] => {
    if (!meta) return null;
    if (meta.kind === "reference") return "reference";
    return meta.kind === "legacy" ? "legacy" : "attribute";
  };
  const markers: MarkerOcc[] = [];
  const fences: FenceBlock[] = [];
  let legacyMetadata = 0;
  let firstInlineMetadataOffset: number | null = null;

  const isQualifiedBareRef = (id: string) =>
    entries.comments.has(id) ||
    entries.suggestions.has(id) ||
    roughdraftIdPattern.test(id);

  const validateInlineMetadata = (
    meta: Metadata | null,
    markerOffset: number,
  ) => {
    if (!meta) {
      for (const attribute of requiredMetadataAttributes) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          markerOffset,
        );
      }
      return;
    }
    if (meta.kind === "reference") return;
    firstInlineMetadataOffset ??= meta.offset;
    if (meta.kind === "legacy") {
      legacyMetadata += 1;
      addDiagnostic(
        "warning",
        "legacy-metadata",
        "Legacy metadata is accepted, but canonical attribute metadata is preferred.",
        meta.offset,
      );
    }
    for (const attribute of requiredMetadataAttributes) {
      if (!meta.attrs.get(attribute)) {
        addDiagnostic(
          "error",
          `missing-metadata-${attribute}`,
          `Missing required metadata attribute \`${attribute}\`.`,
          meta.offset,
        );
      }
    }
    const at = meta.attrs.get("at");
    if (at && !isValidDateTime(at)) {
      addDiagnostic(
        "error",
        "invalid-metadata-at",
        "Metadata attribute `at` must be an ISO 8601 date-time.",
        meta.offset,
      );
    }
  };

  const parseTrain = (offset: number, anchor: RfmAnchor): TrainOcc | null => {
    const close = markdown.indexOf("<<}", offset + 3);
    if (close === -1) {
      addDiagnostic(
        "error",
        "unclosed-comment",
        "Comment marker is missing closing `<<}`.",
        offset,
      );
      return null;
    }
    const meta = parseMetadata(markdown, close + 3, true, addDiagnostic);
    validateInlineMetadata(meta, offset);
    const id = meta?.attrs.get("id");
    const train: TrainOcc = {
      id: id || `comment-${offset.toString()}`,
      synthetic: !id,
      content: markdown.slice(offset + 3, close),
      meta,
      offset,
      endOffset: meta?.endOffset ?? close + 3,
      anchor,
    };
    if (/\n[ \t]*\r?\n/.test(train.content)) {
      addDiagnostic(
        "error",
        "inline-comment-blank-line",
        `Comment \`${train.id}\` has a blank line inside its inline text; Markdown splits it into two paragraphs and the comment cannot be read back.`,
        offset,
      );
    }
    trains.push(train);
    return train;
  };

  const parseTail = (
    from: number,
    anchor: RfmAnchor,
    tail: RfmTailItem[] = [],
  ): number => {
    let cursor = from;
    for (;;) {
      if (markdown.startsWith("{>>", cursor)) {
        const train = parseTrain(cursor, anchor);
        if (!train) break;
        tail.push({
          type: "train",
          id: train.synthetic ? null : train.id,
          offset: train.offset,
          endOffset: train.endOffset,
          content: train.content,
          metadata: metadataKindOf(train.meta),
          attributes: attrsRecord(train.meta),
        });
        cursor = train.endOffset;
        continue;
      }
      const ref = markdown.slice(cursor, cursor + 200).match(refPattern);
      if (ref) {
        const end = cursor + ref[0].length;
        tail.push({
          type: "ref",
          id: ref[1] ?? "",
          offset: cursor,
          endOffset: end,
          content: null,
          metadata: null,
          attributes: null,
        });
        refs.push({
          id: ref[1] ?? "",
          offset: cursor,
          endOffset: end,
          anchor,
          context: "markup",
          fence: null,
        });
        cursor = end;
        continue;
      }
      break;
    }
    return cursor;
  };

  const parseSuggestionMarker = (offset: number): MarkerOcc | null => {
    let kind: RfmSuggestionKind;
    let markerEnd: number;
    let text: string;
    let originalText: string | undefined;
    let replacementText: string | undefined;

    if (
      markdown.startsWith("{++", offset) ||
      markdown.startsWith("{--", offset)
    ) {
      const addition = markdown.startsWith("{++", offset);
      const closeToken = addition ? "++}" : "--}";
      const close = markdown.indexOf(closeToken, offset + 3);
      if (close === -1) {
        addDiagnostic(
          "error",
          addition ? "unclosed-addition" : "unclosed-deletion",
          addition
            ? "Addition marker is missing closing `++}`."
            : "Deletion marker is missing closing `--}`.",
          offset,
        );
        return null;
      }
      kind = addition ? "addition" : "deletion";
      markerEnd = close + 3;
      text = markdown.slice(offset + 3, close);
      if (!addition) originalText = text;
    } else if (markdown.startsWith("{~~", offset)) {
      const separator = markdown.indexOf("~>", offset + 3);
      const close =
        separator === -1 ? -1 : markdown.indexOf("~~}", separator + 2);
      if (separator === -1 || close === -1) {
        addDiagnostic(
          "error",
          "unclosed-substitution",
          "Substitution marker is missing `~>` or closing `~~}`.",
          offset,
        );
        return null;
      }
      kind = "substitution";
      markerEnd = close + 3;
      text = markdown.slice(separator + 2, close);
      originalText = markdown.slice(offset + 3, separator);
      replacementText = text;
    } else {
      return null;
    }

    const meta = parseMetadata(markdown, markerEnd, false, addDiagnostic);
    validateInlineMetadata(meta, offset);
    const id = meta?.attrs.get("id");
    const marker: MarkerOcc = {
      id: id || `suggestion-${offset.toString()}`,
      synthetic: !id,
      kind,
      text,
      originalText,
      replacementText,
      meta,
      offset,
      markerEnd,
      endOffset: meta?.endOffset ?? markerEnd,
      blockIndex: blockOf(offset),
      line: lineOf(offset),
    };
    markers.push(marker);
    return marker;
  };

  // The scan mirrors rfm 0.1.10 (fence and inline code rules included) so the
  // two readers agree on what is code and what is review markup.
  let offset = scanStart;
  let fence: FenceState | null = null;
  let currentFence: FenceBlock | null = null;

  while (offset < scanEnd) {
    if (isLineStart(markdown, offset)) {
      const lineEnd = nextLineOffset(markdown, offset);
      const lineText = markdown.slice(offset, lineEnd).replace(/\r?\n$/, "");
      const fenceMatch = matchFence(lineText, fence);
      if (fenceMatch) {
        if (fence) {
          if (currentFence) currentFence.codeEnd = offset;
          fence = null;
          currentFence = null;
        } else {
          fence = fenceMatch;
          const markerMatch = lineText.match(/^[ \t]{0,3}(?:`{3,}|~{3,})/);
          const infoOffset = offset + (markerMatch?.[0].length ?? 0);
          currentFence = {
            offset,
            openLineEnd: offset + lineText.length,
            codeEnd: scanEnd,
            infoOffset,
            info: markdown.slice(infoOffset, offset + lineText.length),
            codeLines: [],
            interior: "",
            blockIndex: blockOf(offset),
          };
          fences.push(currentFence);
        }
        offset = lineEnd;
        continue;
      }
    }

    if (fence) {
      const lineEnd = nextLineOffset(markdown, offset);
      const lineText = markdown.slice(offset, lineEnd);
      if (currentFence) {
        currentFence.codeLines.push(lineText.replace(/\r?\n$/, ""));
        currentFence.interior += lineText;
      }
      offset = lineEnd;
      continue;
    }

    const codeSpanEnd = matchInlineCodeSpan(markdown, offset);
    if (codeSpanEnd !== null) {
      offset = codeSpanEnd;
      continue;
    }

    if (markdown.startsWith("{==", offset)) {
      const close = markdown.indexOf("==}", offset + 3);
      if (close === -1) {
        addDiagnostic(
          "error",
          "unclosed-highlight",
          "Highlight marker is missing closing `==}`.",
          offset,
        );
        offset += 3;
        continue;
      }
      const anchor: RfmAnchor = {
        kind: "highlight",
        blockIndex: blockOf(offset),
        text: markdown.slice(offset + 3, close),
        offset,
        endOffset: close + 3,
        line: lineOf(offset),
      };
      const run = emptyRun("highlight", offset);
      run.textStart = offset + 3;
      run.textEnd = close;
      const tailEnd = parseTail(close + 3, anchor, run.tail);
      run.endOffset = Math.max(tailEnd, close + 3);
      runs.push(run);
      offset = tailEnd > close + 3 ? tailEnd : close + 3;
      continue;
    }

    if (markdown.startsWith("{>>", offset)) {
      const anchor: RfmAnchor = {
        kind: "standalone",
        blockIndex: blockOf(offset),
        text: "",
        offset,
        endOffset: offset,
        line: lineOf(offset),
      };
      const before = trains.length;
      const run = emptyRun("standalone", offset);
      const tailEnd = parseTail(offset, anchor, run.tail);
      if (trains.length > before) {
        anchor.endOffset = trains[before]?.endOffset ?? tailEnd;
        run.endOffset = tailEnd;
        runs.push(run);
        offset = tailEnd;
        continue;
      }
    }

    const marker = parseSuggestionMarker(offset);
    if (marker) {
      const anchor: RfmAnchor = {
        kind: "suggestion",
        blockIndex: marker.blockIndex,
        text: marker.text,
        offset: marker.offset,
        endOffset: marker.markerEnd,
        line: marker.line,
      };
      const run = emptyRun("suggestion", marker.offset);
      run.suggestionKind = marker.kind;
      run.markerEnd = marker.markerEnd;
      run.original = marker.originalText ?? null;
      run.replacement =
        marker.kind === "deletion"
          ? null
          : (marker.replacementText ?? marker.text);
      run.id = marker.synthetic ? null : marker.id;
      run.metadata = metadataKindOf(marker.meta);
      run.attributes = attrsRecord(marker.meta);
      run.metadataEnd = marker.meta ? marker.meta.endOffset : null;
      offset = parseTail(marker.endOffset, anchor, run.tail);
      run.endOffset = offset;
      runs.push(run);
      continue;
    }

    if (markdown[offset] === "{") {
      const ref = markdown.slice(offset, offset + 200).match(refPattern);
      const id = ref?.[1];
      if (ref && id && isQualifiedBareRef(id)) {
        const end = offset + ref[0].length;
        const run = emptyRun("standalone", offset);
        run.endOffset = end;
        run.tail.push({
          type: "ref",
          id,
          offset,
          endOffset: end,
          content: null,
          metadata: null,
          attributes: null,
        });
        runs.push(run);
        refs.push({
          id,
          offset,
          endOffset: end,
          anchor: {
            kind: "standalone",
            blockIndex: blockOf(offset),
            text: "",
            offset,
            endOffset: end,
            line: lineOf(offset),
          },
          context: "standalone",
          fence: null,
        });
        offset = end;
        continue;
      }
    }

    offset += 1;
  }

  // Fence-line refs and review markup inside code.
  for (const block of fences) {
    for (const match of block.info.matchAll(/\{#([A-Za-z][A-Za-z0-9_-]*)\}/g)) {
      const id = match[1] ?? "";
      if (!isQualifiedBareRef(id)) continue;
      const refOffset = block.infoOffset + (match.index ?? 0);
      const run = emptyRun("fence-ref", refOffset);
      run.endOffset = refOffset + match[0].length;
      run.id = id;
      run.fenceIndex = fences.indexOf(block);
      runs.push(run);
      refs.push({
        id,
        offset: refOffset,
        endOffset: refOffset + match[0].length,
        anchor: {
          kind: "code",
          blockIndex: block.blockIndex,
          text: block.codeLines.join("\n"),
          offset: refOffset,
          endOffset: refOffset + match[0].length,
          line: lineOf(block.offset),
        },
        context: "code",
        fence: block,
      });
    }
    // What the 0.1.10 browser wrote inside fences (attribute or legacy
    // metadata after a train or marker), and refs to ids that are real entries
    // of this file's review block. Markup examples in documentation (compact
    // refs with no matching entry) are left alone.
    const attributeMarkup =
      block.interior.match(
        /(?:<<\}|\+\+\}|--\}|~~\})(?:\{[^}\n]*\bid="|\{@)/g,
      ) ?? [];
    const liveRefs = [
      ...block.interior.matchAll(/\{#([A-Za-z][A-Za-z0-9_-]*)\}/g),
    ].filter(
      (match) =>
        entries.comments.has(match[1] ?? "") ||
        entries.suggestions.has(match[1] ?? ""),
    );
    const inCode = attributeMarkup.length + liveRefs.length;
    if (inCode > 0) {
      addDiagnostic(
        "warning",
        "review-markup-in-code",
        `This code block contains ${inCode} piece(s) of review markup with an id; markup inside code is literal text that rfm, the doctor and agents never read as a comment. Anchor a comment on code with a ref on the fence line instead.`,
        nextLineOffset(markdown, block.offset),
      );
    }
  }

  // ------------------------------------------------------------ suggestions
  const markersById = new Map<string, MarkerOcc[]>();
  for (const marker of markers) {
    const list = markersById.get(marker.id) ?? [];
    list.push(marker);
    markersById.set(marker.id, list);
  }
  const suggestionIds = new Set<string>([
    ...markersById.keys(),
    ...entries.suggestions.keys(),
  ]);

  const entryOffsetOf = (section: "comments" | "suggestions", id: string) =>
    split.entryOffsets[section].get(id) ?? split.blockOffset ?? markdown.length;

  const truncated = new Set(
    split.truncatedBodies.map((item) => `${item.section}:${item.id}`),
  );

  const validateEntryFields = (
    id: string,
    entry: RfmEndmatterEntry,
    at: number,
  ) => {
    for (const attribute of ["by", "at"] as const) {
      if (typeof entry[attribute] !== "string" || !entry[attribute]) {
        addDiagnostic(
          "error",
          `missing-endmatter-${attribute}`,
          `Missing required YAML endmatter attribute \`${attribute}\` for \`${id}\`.`,
          at,
        );
      }
    }
    if (typeof entry.at === "string" && !isValidDateTime(entry.at)) {
      addDiagnostic(
        "error",
        "invalid-endmatter-at",
        `YAML endmatter attribute \`at\` for \`${id}\` must be an ISO 8601 date-time.`,
        at,
      );
    }
  };

  const suggestions: RfmModelSuggestion[] = [];
  for (const [id, list] of markersById) {
    const first = list[0];
    if (!first) continue;
    const entry = entries.suggestions.get(id) ?? null;
    const fromEndmatter = first.meta?.kind === "reference";
    if (fromEndmatter && !entry && !endmatterInvalid) {
      addDiagnostic(
        "error",
        "missing-endmatter-entry",
        `Missing YAML endmatter entry for review id \`${id}\`.`,
        first.meta?.offset ?? first.offset,
      );
    }
    if (fromEndmatter && entry) {
      validateEntryFields(id, entry, entryOffsetOf("suggestions", id));
    }
    if (list.length > 1 && !first.synthetic) {
      addDiagnostic(
        "warning",
        "replicated-comment",
        `Suggestion \`${id}\` is written on ${list.length} blocks under one id (legacy form); it is read as one suggestion.`,
        list[1]?.offset ?? first.offset,
      );
    }
    const fields: Record<string, unknown> = fromEndmatter
      ? (entry ?? {})
      : Object.fromEntries(first.meta?.attrs ?? []);
    const continues = stringOrNull(fields.continues);
    suggestions.push({
      id,
      suggestionKind: first.kind,
      text: first.text,
      originalText: first.originalText,
      replacementText: first.replacementText,
      parts: list.map((marker) => ({
        blockIndex: marker.blockIndex,
        text: marker.text,
        originalText: marker.originalText,
        replacementText: marker.replacementText,
        offset: marker.offset,
        endOffset: marker.markerEnd,
        line: marker.line,
      })),
      continues: continues || null,
      continuedBy: [],
      by: stringOrNull(fields.by),
      at: stringOrNull(fields.at),
      status: stringOrNull(fields.status),
      resolved:
        typeof fields.resolved === "string"
          ? decodeBreaks(fields.resolved)
          : null,
      replies: [],
      metadataSource: metadataSourceOf(first.meta),
      entry: fromEndmatter ? entry : null,
      attributes: attrsRecord(first.meta),
      offset: first.offset,
      endOffset: first.endOffset,
      ...locationForOffset(lineStarts, first.offset),
    });
  }
  const suggestionById = new Map(suggestions.map((item) => [item.id, item]));
  for (const suggestion of suggestions) {
    if (!suggestion.continues) continue;
    suggestionById.get(suggestion.continues)?.continuedBy.push(suggestion.id);
  }

  // --------------------------------------------------------------- comments
  const trainsById = new Map<string, TrainOcc[]>();
  for (const train of trains) {
    const list = trainsById.get(train.id) ?? [];
    list.push(train);
    trainsById.set(train.id, list);
  }
  const refsById = new Map<string, RefOcc[]>();
  for (const ref of refs) {
    if (suggestionIds.has(ref.id)) {
      addDiagnostic(
        "error",
        "continuation-target-not-comment",
        `\`{#${ref.id}}\` names suggestion \`${ref.id}\`; an anchor ref must name a comment.`,
        ref.offset,
      );
      continue;
    }
    const list = refsById.get(ref.id) ?? [];
    list.push(ref);
    refsById.set(ref.id, list);
  }

  const commentOrder: string[] = [];
  const seen = new Set<string>();
  const occurrences = [
    ...trains.map((train) => ({ id: train.id, offset: train.offset })),
    ...[...refsById.values()].flat().map((ref) => ({
      id: ref.id,
      offset: ref.offset,
    })),
  ].sort((a, b) => a.offset - b.offset);
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.id)) continue;
    seen.add(occurrence.id);
    commentOrder.push(occurrence.id);
  }
  for (const id of entries.comments.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    commentOrder.push(id);
  }

  const comments: RfmModelComment[] = [];
  const orphans: RfmOrphanEntry[] = [];
  const lostAnchorCandidates: Array<{ id: string; offset: number }> = [];
  const inlineBodyIds: string[] = [];
  let firstInlineBodyOffset: number | null = null;

  for (const id of commentOrder) {
    const idTrains = trainsById.get(id) ?? [];
    const idRefs = refsById.get(id) ?? [];
    const entry = entries.comments.get(id) ?? null;
    const entryOffset = entryOffsetOf("comments", id);
    const attrTrain = idTrains.find(
      (train) => train.meta && train.meta.kind !== "reference",
    );
    const metaForm: RfmMetadataSource = attrTrain
      ? metadataSourceOf(attrTrain.meta)
      : idTrains.length > 0 && idTrains.every((train) => !train.meta)
        ? "none"
        : "endmatter";

    if (suggestionIds.has(id) && idTrains.length > 0) {
      addDiagnostic(
        "error",
        "duplicate-id",
        `Duplicate review id \`${id}\`.`,
        idTrains[0]?.offset ?? 0,
      );
    }

    let fields: Record<string, unknown>;
    if (attrTrain) {
      fields = Object.fromEntries(attrTrain.meta?.attrs ?? []);
      if (entry && (entry.body !== undefined || entry.re !== undefined)) {
        addDiagnostic(
          "error",
          "duplicate-id",
          `Duplicate review id \`${id}\`: it has inline metadata and a review block entry.`,
          entryOffset,
        );
      }
    } else if (metaForm === "none") {
      fields = {};
    } else {
      fields = entry ?? {};
      if (!entry && !endmatterInvalid) {
        const firstRef =
          idTrains.find((train) => train.meta)?.meta?.offset ??
          idRefs[0]?.offset;
        if (firstRef !== undefined) {
          addDiagnostic(
            "error",
            "missing-endmatter-entry",
            `Missing YAML endmatter entry for review id \`${id}\`.`,
            firstRef,
          );
        }
      }
    }

    const rawRe = fields.re;
    let parentId: string | null = null;
    if (typeof rawRe === "string" && rawRe) {
      parentId = rawRe;
    } else if (rawRe !== undefined && rawRe !== "" && !attrTrain) {
      addDiagnostic(
        "error",
        "re-not-string",
        `\`re\` of \`${id}\` must be the id of the comment or suggestion it replies to.`,
        entryOffset,
      );
    } else if (rawRe === "" && !attrTrain) {
      addDiagnostic(
        "error",
        "re-not-string",
        `\`re\` of \`${id}\` is empty; remove it for a document-level comment or name the parent id.`,
        entryOffset,
      );
    }
    const isReply = parentId !== null;

    // Attribute trains under one id must agree on being a reply.
    if (attrTrain && idTrains.length > 1) {
      const reValues = new Set(
        idTrains.map((train) => train.meta?.attrs.get("re") ?? ""),
      );
      if (reValues.size > 1) {
        addDiagnostic(
          "error",
          "duplicate-id",
          `Duplicate review id \`${id}\`: one copy is a reply and another is not.`,
          idTrains[1]?.offset ?? 0,
        );
      }
    }

    // Bodies: one per id.
    let body: string;
    let bodySource: "endmatter" | "inline";
    const firstTrain = idTrains[0];
    if (firstTrain) {
      bodySource = "inline";
      body = decodeBreaks(firstTrain.content);
      if (!firstTrain.synthetic) {
        inlineBodyIds.push(id);
        firstInlineBodyOffset ??= firstTrain.offset;
      }
      const distinct = new Set(idTrains.map((train) => train.content));
      if (idTrains.length > 1 && !firstTrain.synthetic) {
        if (distinct.size > 1) {
          addDiagnostic(
            "error",
            "duplicate-id",
            `Duplicate review id \`${id}\`: ${idTrains.length} inline comments share it with different text.`,
            idTrains.find((train) => train.content !== firstTrain.content)
              ?.offset ?? firstTrain.offset,
          );
        } else {
          addDiagnostic(
            "warning",
            "replicated-comment",
            `Comment \`${id}\` is written in full on ${idTrains.length} blocks (legacy replicas); it is read as one comment with ${idTrains.length} anchors.`,
            idTrains[1]?.offset ?? firstTrain.offset,
          );
        }
      }
      if (
        !attrTrain &&
        entry &&
        typeof entry.body === "string" &&
        entry.body !== firstTrain.content
      ) {
        addDiagnostic(
          "error",
          "duplicate-id",
          `Duplicate review id \`${id}\`: it has one text inline and a different \`body\` in the review block.`,
          entryOffset,
        );
      }
      if (isReply && firstTrain.meta?.kind === "reference") {
        addDiagnostic(
          "error",
          "inline-reply-not-allowed",
          `Reply \`${id}\` is written inline; replies live only in the review block with \`re\`.`,
          firstTrain.offset,
        );
      }
    } else {
      bodySource = "endmatter";
      const rawBody = entry?.body;
      if (typeof rawBody === "string") {
        body = decodeBreaks(rawBody);
      } else if (rawBody !== undefined) {
        addDiagnostic(
          "error",
          "endmatter-body-not-string",
          `\`body\` of \`${id}\` is not text; quote it in double quotes.`,
          entryOffset,
        );
        body = nonStringBody(rawBody);
      } else {
        body = "";
        if (isReply) {
          addDiagnostic(
            "error",
            "endmatter-reply-missing-body",
            `Reply \`${id}\` has no \`body\`.`,
            entryOffset,
          );
        } else if (idRefs.length > 0) {
          if (entry) {
            addDiagnostic(
              "error",
              "orphan-continuation",
              `Anchor \`{#${id}}\` has no comment text anywhere: the review block entry has no \`body\` and no inline comment carries it.`,
              idRefs[0]?.offset ?? entryOffset,
            );
          }
        } else if (entry) {
          addDiagnostic(
            "warning",
            "orphan-endmatter-entry",
            `Review block entry \`${id}\` has no anchor in the text, no \`body\` and no \`re\`.`,
            entryOffset,
          );
          orphans.push({
            id,
            section: "comments",
            entry,
            offset: entryOffset,
            line: lineOf(entryOffset),
          });
          continue;
        }
      }
    }
    if (bodySource === "endmatter" && truncated.has(`comments:${id}`)) {
      addDiagnostic(
        "error",
        "endmatter-body-truncated",
        `\`body\` of \`${id}\` is cut short at \` #\` (YAML reads the rest as a comment); quote it in double quotes.`,
        entryOffset,
      );
    }

    // Anchors.
    let anchors: RfmAnchor[] = [];
    if (isReply) {
      for (const ref of idRefs) {
        addDiagnostic(
          "error",
          "inline-reply-not-allowed",
          `\`{#${id}}\` anchors reply \`${id}\` in the text; replies live only in the review block with \`re\`.`,
          ref.offset,
        );
      }
    } else {
      const byOffset = new Map<number, RfmAnchor>();
      for (const train of idTrains)
        byOffset.set(train.anchor.offset, train.anchor);
      for (const ref of idRefs) {
        if (!byOffset.has(ref.anchor.offset)) {
          byOffset.set(ref.anchor.offset, ref.anchor);
        }
      }
      anchors = [...byOffset.values()].sort((a, b) => a.offset - b.offset);
    }

    const scopeField = stringOrNull(fields.scope);
    let lines = parseLines(fields.lines);
    let quote = stringOrNull(fields.quote);
    const primaryAnchor = anchors[0] ?? null;
    let scope: RfmCommentScope;
    if (!primaryAnchor) {
      scope = "document";
    } else if (primaryAnchor.kind === "code") {
      scope = "code";
    } else if (primaryAnchor.kind === "standalone") {
      scope = "standalone";
    } else {
      scope = "inline";
    }

    if (primaryAnchor?.kind === "code") {
      const codeRef = idRefs.find((ref) => ref.context === "code");
      const codeLines = codeRef?.fence?.codeLines ?? [];
      if (lines && lines[1] > codeLines.length) lines = null;
      if (quote === null && lines) {
        quote = codeLines.slice(lines[0] - 1, lines[1]).join("\n");
      }
      for (const anchor of anchors) {
        if (anchor.kind === "code" && quote !== null) anchor.text = quote;
      }
    }

    // Decided after every comment is read (see `currentFormat` below).
    const anchorlessUnscoped =
      !isReply &&
      anchors.length === 0 &&
      scopeField !== "document" &&
      quote === null;
    if (anchorlessUnscoped) {
      lostAnchorCandidates.push({ id, offset: entryOffset });
    }

    if (metaForm === "endmatter" && entry) {
      validateEntryFields(id, entry, entryOffset);
    }

    const location = firstTrain?.offset ?? primaryAnchor?.offset ?? entryOffset;
    const endLocation =
      firstTrain?.endOffset ?? primaryAnchor?.endOffset ?? entryOffset;

    comments.push({
      id,
      kind: isReply ? "reply" : "comment",
      scope,
      parentId,
      rootId: id,
      parentMissing: false,
      anchors,
      primaryAnchor,
      body,
      by: stringOrNull(fields.by),
      at: stringOrNull(fields.at),
      status: stringOrNull(fields.status),
      resolved:
        typeof fields.resolved === "string"
          ? decodeBreaks(fields.resolved)
          : null,
      lines,
      quote,
      lostAnchor: false,
      replies: [],
      bodySource,
      metadataSource: metaForm,
      entry: attrTrain ? null : entry,
      attributes: attrsRecord(attrTrain?.meta ?? null),
      offset: location,
      endOffset: endLocation,
      ...locationForOffset(lineStarts, location),
    });
  }

  // Suggestion entries with no marker.
  for (const [id, entry] of entries.suggestions) {
    if (markersById.has(id)) continue;
    const entryOffset = entryOffsetOf("suggestions", id);
    if (entries.comments.has(id)) continue;
    addDiagnostic(
      "warning",
      "orphan-endmatter-entry",
      `Suggestion entry \`${id}\` has no suggestion marker in the text.`,
      entryOffset,
    );
    orphans.push({
      id,
      section: "suggestions",
      entry,
      offset: entryOffset,
      line: lineOf(entryOffset),
    });
  }
  for (const id of entries.suggestions.keys()) {
    if (entries.comments.has(id)) {
      addDiagnostic(
        "error",
        "duplicate-id",
        `Duplicate review id \`${id}\` across comments and suggestions endmatter.`,
        entryOffsetOf("suggestions", id),
      );
    }
  }

  comments.sort((a, b) => a.offset - b.offset);
  const commentById = new Map(comments.map((item) => [item.id, item]));

  // Lost anchors. An entry with a body, no anchor, no `re`, no `scope` and no
  // `quote` is a document-level comment in a legacy file (0.1.10 and the Done
  // handoff write global comments that way), but in a file whose anchored
  // roots keep their text in the review block (the current format) it is a
  // comment whose highlight was deleted from the text. A `scope: document`
  // entry alone does not make a file current-format: a new global comment
  // added to an old file must not turn its older global comments into lost
  // anchors.
  const currentFormat = comments.some(
    (item) =>
      item.kind === "comment" &&
      item.bodySource === "endmatter" &&
      item.anchors.length > 0,
  );
  if (currentFormat) {
    for (const candidate of lostAnchorCandidates) {
      const comment = commentById.get(candidate.id);
      if (!comment) continue;
      comment.lostAnchor = true;
      addDiagnostic(
        "warning",
        "orphan-endmatter-entry",
        `Comment \`${candidate.id}\` has no anchor in the text and no \`scope: document\`; it is shown with the document comments as a comment whose anchor was lost.`,
        candidate.offset,
      );
    }
  }

  // Threads.
  for (const comment of comments) {
    const parentId = comment.parentId;
    if (!parentId) continue;
    if (parentId === comment.id) {
      addDiagnostic(
        "error",
        "self-reply",
        `Comment \`${comment.id}\` must not reply to itself.`,
        comment.offset,
      );
      comment.parentMissing = true;
      continue;
    }
    const parent = commentById.get(parentId) ?? suggestionById.get(parentId);
    if (!parent) {
      addDiagnostic(
        "warning",
        "missing-reply-target",
        `Comment reply \`re="${parentId}"\` points to a missing id.`,
        comment.offset,
      );
      comment.parentMissing = true;
      continue;
    }
    parent.replies.push(comment.id);
  }
  for (const comment of comments) {
    if (comment.kind !== "reply") continue;
    const visited = new Set<string>([comment.id]);
    let current: RfmModelComment | undefined = comment;
    let rootId = comment.id;
    let scope: RfmCommentScope = "document";
    while (current?.parentId && !current.parentMissing) {
      const parentId: string = current.parentId;
      if (visited.has(parentId)) break;
      visited.add(parentId);
      const suggestion = suggestionById.get(parentId);
      if (suggestion) {
        rootId = parentId;
        scope = "inline";
        break;
      }
      current = commentById.get(parentId);
      if (!current) break;
      rootId = current.id;
      if (current.kind === "comment") {
        scope = current.scope;
        break;
      }
    }
    comment.rootId = rootId;
    comment.scope = scope;
  }

  // File-level notes.
  if (inlineBodyIds.length > 0 && firstInlineBodyOffset !== null) {
    addDiagnostic(
      "warning",
      "legacy-inline-body",
      `${inlineBodyIds.length} comment(s) keep their text inline (${idList(inlineBodyIds)}), the legacy form; the current format keeps every comment's text in the review block at the end of the file.`,
      firstInlineBodyOffset,
    );
  }
  if (split.status === "recognized" && firstInlineMetadataOffset !== null) {
    addDiagnostic(
      "warning",
      "mixed-metadata",
      "This file mixes inline attribute or legacy metadata with a review block at the end; the current format keeps all metadata in the review block.",
      firstInlineMetadataOffset,
    );
  }

  diagnostics.sort((a, b) => a.offset - b.offset);

  const byId = new Map<string, RfmModelComment | RfmModelSuggestion>();
  for (const comment of comments) byId.set(comment.id, comment);
  for (const suggestion of suggestions) {
    if (!byId.has(suggestion.id)) byId.set(suggestion.id, suggestion);
  }

  const located = [
    ...comments.map((item) => ({ id: item.id, offset: item.offset })),
    ...suggestions.map((item) => ({ id: item.id, offset: item.offset })),
    ...orphans.map((item) => ({ id: item.id, offset: item.offset })),
  ].sort((a, b) => a.offset - b.offset);
  const ids: string[] = [];
  const listed = new Set<string>();
  for (const item of located) {
    if (listed.has(item.id)) continue;
    listed.add(item.id);
    ids.push(item.id);
  }

  const roots = comments.filter(
    (item) => item.kind === "comment" && item.scope !== "document",
  ).length;
  const documentComments = comments.filter(
    (item) => item.kind === "comment" && item.scope === "document",
  ).length;
  const replies = comments.filter((item) => item.kind === "reply").length;

  return {
    split: {
      frontmatter: split.frontmatter,
      body: split.body,
      endmatter: split.endmatter,
      status: split.status,
      entries: split.entries,
      yamlError: split.yamlError,
      bodyOffset: split.bodyOffset,
      endmatterOffset: split.endmatterOffset,
    },
    markup: runs.sort((a, b) => a.offset - b.offset),
    fences: fences.map((block) => ({
      offset: block.offset,
      infoOffset: block.infoOffset,
      openLineEnd: block.openLineEnd,
      codeStart: nextLineOffset(markdown, block.offset),
      codeEnd: block.codeEnd,
      info: block.info,
      codeLines: block.codeLines,
      blockIndex: block.blockIndex,
    })),
    comments,
    suggestions,
    orphans,
    ids,
    byId,
    diagnostics,
    summary: {
      comments: roots + documentComments + replies,
      roots,
      documentComments,
      replies,
      suggestions: suggestions.length,
      legacyMetadata,
      endmatter: split.status,
    },
  };
}
