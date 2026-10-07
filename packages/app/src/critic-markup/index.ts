import {
  changesShape,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  type RfmEndmatterStatus,
  type RfmModelComment,
  type RfmModelSuggestion,
  type RfmReviewModel,
  stringifyRoughdraftEndmatter,
} from "@roughdraft/rfm";
import { generateHTML, generateJSON, type JSONContent } from "@tiptap/core";
import {
  Marked,
  type RendererThis,
  type Token,
  type TokenizerAndRendererExtension,
  type TokenizerThis,
  type Tokens,
} from "marked";
import type TurndownService from "turndown";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type CodeCommentAnchor,
  type CriticChangeAttrs,
  type CriticChangeKind,
  createEditorExtensions,
  parseCodeCommentAnchors,
} from "../editor-extensions";
import {
  appendYamlEndmatter,
  createMarkedRenderer,
  createTurndownService,
  type MarkdownOptions,
  normalizeBlockSpacing,
  prependYamlFrontmatter,
  protectRichTextRoundTripMarkdown,
  usesLegacyListSpacing,
  usesLooseHeadingSpacing,
  yamlDocumentMetadataFromSplit,
} from "../markdown";

/** Where a thread shows: on prose, on code lines, as an anchorless card, or in the global section. */
export type CriticCommentScope = "inline" | "code" | "document" | "standalone";

// What a comment looked like when the file was read. A save compares against
// it so an unchanged comment is written back with its original bytes.
interface CriticCommentSource {
  content: string;
  /** The inline text exactly as written (before `<br>` decoding), for inline bodies. */
  rawContent: string | null;
  /** The text came from the comment's review block entry. */
  bodyFromEntry: boolean;
  /** The time the editor showed at load (a generated one when the file had none). */
  createdAt: string;
  by: string | null;
  status: string | null;
  resolved: string | null;
  /** Inline attribute or legacy metadata, unknown attributes included, in file order. */
  attributes: Record<string, string> | null;
}

export interface CriticComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: CriticCommentScope;
  status?: string | null;
  /** Resolution summary. */
  resolved?: string | null;
  /** A comment whose highlight is gone from the text (shown in the global section). */
  lostAnchor?: boolean;
  /** Code comments: highlighted lines inside the block, 1-based and inclusive. */
  codeLines?: [number, number] | null;
  /** Code comments: the highlighted lines. */
  quote?: string | null;
  /** A root whose text lives in the review block, anchored by `{#id}` refs only. */
  bodyInEndmatter?: boolean;
  /**
   * Markup the editor cannot place (an inline comment split by a blank line,
   * markup inside a raw HTML block) stays literal text; the comment and its
   * inline replies are kept out of the rail and written back untouched.
   */
  literal?: boolean;
  source?: CriticCommentSource;
}

export interface CriticCommentThread {
  comment: CriticComment;
  replies: CriticCommentThread[];
}

export type { CriticChangeAttrs, CriticChangeKind };

/** The banner text for a file whose review block could not be read. */
export function describeReviewBlockError(message: string): string {
  return `The review block at the end of this file could not be read: ${message}`;
}

/**
 * How the browser writes review data for a file (decision D11):
 * - `canonical`: the file is in the current shape or has no review items
 *   yet. Every item is written in the canonical shape: anchors in the prose,
 *   every body in the review block through rfm's writer.
 * - `legacy`: the file uses an older shape. Its review markup is written back
 *   unchanged and new items take the shape the file already uses; nothing
 *   converts on save (`roughdraft doctor --fix` does that).
 */
export type ReviewFormat = "canonical" | "legacy";

/** The one-line notice shown on a file that uses an older review format. */
export const REVIEW_FORMAT_NOTICE =
  "This file uses an older review format. Run roughdraft doctor --fix to convert it.";

/**
 * Which writer a file gets. rfm's normalization decides what an old shape
 * is: a file it would change (beyond the review block's formatting) or one
 * it refuses to convert is written back as it is. A file with no review data
 * at all always gets the canonical writer.
 */
export function getReviewFormat(markdown: string): ReviewFormat {
  const normalized = normalizeRoughdraftMetadata(markdown);
  if (normalized.refused.length === 0 && !changesShape(normalized.changes)) {
    return "canonical";
  }
  return hasReviewData(markdown) ? "legacy" : "canonical";
}

function hasReviewData(markdown: string): boolean {
  const model = parseReviewModel(markdown);
  const { entries } = model.split;
  return (
    model.comments.length > 0 ||
    model.suggestions.length > 0 ||
    model.orphans.length > 0 ||
    entries.comments.size > 0 ||
    entries.suggestions.size > 0
  );
}

/** A line break in a comment body is stored as `<br>` (D7). */
export function encodeBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "<br>");
}

const reviewCloseDelimiters = ["<<}", "++}", "--}", "~~}", "==}"] as const;

/**
 * The first review-markup close delimiter in a comment, or null. Comment text
 * that contains one cannot be stored safely, so the composer refuses it.
 */
export function findReviewDelimiter(text: string): string | null {
  let first: { delimiter: string; index: number } | null = null;
  for (const delimiter of reviewCloseDelimiters) {
    const index = text.indexOf(delimiter);
    if (index !== -1 && (!first || index < first.index)) {
      first = { delimiter, index };
    }
  }
  return first?.delimiter ?? null;
}

/** The message the composer shows when it refuses a delimiter. */
export function describeReviewDelimiter(delimiter: string): string {
  return `Comments cannot contain "${delimiter}" (it closes review markup). Remove it to save.`;
}

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  refOnlyIds: string[];
  sourceTail: string | null;
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
  refOnlyIds: string[];
  sourceTail: string | null;
}

interface CriticChangeToken {
  type: "criticChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  refOnlyIds: string[];
  sourceTail: string | null;
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
}

// What the marked extensions read while tokenizing: the rfm model decides
// which ids exist, which are replies and what every body says; the
// extensions only find the markers so the editor can render them.
interface ReviewLoadContext {
  model: RfmReviewModel;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  /** Root ids the editor shows an anchor for. */
  placedIds: Set<string>;
  /** Ids whose markup stays literal text (see `CriticComment.literal`). */
  literalIds: Set<string>;
  /** Numbers each comment tail read, so a save can tell split copies apart. */
  tailCount: number;
  /** Suggestion ids the editor shows (first parts and later parts). */
  placedSuggestionIds: Set<string>;
}

const extensions = createEditorExtensions("");
const criticCommentAnchorPattern = /^\{==([\s\S]+?)==\}/;
const attributeValuePattern = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const attributeBlockSource = String.raw`\{(?:\s*[A-Za-z][A-Za-z0-9_-]*=${attributeValuePattern})+\s*\}`;
const criticCommentBlockPattern = new RegExp(
  String.raw`^\{>>([\s\S]*?)<<\}(?:(\{@([\s\S]+?)@\})|(${attributeBlockSource})|(\{#[A-Za-z][A-Za-z0-9_-]*\}))?`,
);
const bareRefPattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}/;
const criticAdditionPattern = /^\{\+\+([\s\S]+?)\+\+\}/;
const criticDeletionPattern = /^\{--([\s\S]+?)--\}/;
const criticSubstitutionPattern = /^\{~~([\s\S]+?)~>([\s\S]+?)~~\}/;
const attributeMetadataBlockPattern = new RegExp(`^${attributeBlockSource}`);
const metadataAttributePattern = new RegExp(
  `([A-Za-z][A-Za-z0-9_-]*)=(${attributeValuePattern})`,
  "g",
);
const metadataReferencePattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}$/;
const roughdraftIdPattern = /^[cas]\d+$/;
const fenceRefPattern = /\{#([A-Za-z][A-Za-z0-9_-]*)\}/g;
const unanchoredCommentSentinel = "⁠";

interface ParsedEndmatter {
  comments: Map<string, Record<string, unknown>>;
  suggestions: Map<string, Record<string, unknown>>;
  data: Record<string, unknown> | null;
}

function decodeBreaks(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function authorFields(by: string | null | undefined) {
  const author = by ?? "user";
  const isAi = author.toUpperCase() === "AI";

  return {
    authorType: isAi ? ("ai" as const) : ("user" as const),
    authorId: isAi ? null : author,
  };
}

function authorLabel(comment: Pick<CriticComment, "authorType" | "authorId">) {
  return comment.authorType === "ai" ? "AI" : comment.authorId || "user";
}

function sameAuthor(stored: unknown, label: string): boolean {
  if (typeof stored !== "string") return false;
  const { authorType, authorId } = authorFields(stored);
  return authorLabel({ authorType, authorId }) === label;
}

function parseLegacyMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  const fields = new Map<string, string>();

  for (const part of metadataText?.split(";") ?? []) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();

    if (!key || !value) continue;
    fields.set(key, value);
  }

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    ...authorFields(fields.get("by")),
    parentCommentId: fields.get("re") ?? null,
  };
}

function unescapeMetadataAttributeValue(value: string): string {
  return value.replaceAll(/\\([\s\S])/g, "$1");
}

function escapeMetadataAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseAttributeMap(metadataText?: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!metadataText?.startsWith("{") || !metadataText.endsWith("}")) {
    return fields;
  }

  for (const match of metadataText
    .slice(1, -1)
    .matchAll(metadataAttributePattern)) {
    fields.set(
      match[1] ?? "",
      unescapeMetadataAttributeValue((match[2] ?? '""').slice(1, -1)),
    );
  }

  return fields;
}

function parseAttributeMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  const fields = parseAttributeMap(metadataText);
  if (fields.size === 0) return {};

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    ...authorFields(fields.get("by")),
    parentCommentId: fields.get("re") ?? null,
  };
}

// --------------------------------------------------------------- the model

// A comment as rfm reads it, in the shape the editor and the rail use.
function commentFromModel(
  item: RfmModelComment,
  markdown: string,
): CriticComment {
  // The inline text as written, so `<br>` and other bytes survive a save.
  let rawContent: string | null = null;
  if (item.bodySource === "inline" && markdown.startsWith("{>>", item.offset)) {
    const close = markdown.indexOf("<<}", item.offset + 3);
    if (close !== -1) rawContent = markdown.slice(item.offset + 3, close);
  }

  const createdAt = item.at ?? new Date().toISOString();

  return {
    id: item.id,
    content: item.body,
    createdAt,
    ...authorFields(item.by),
    parentCommentId: item.parentId,
    scope: item.scope,
    status: item.status,
    resolved: item.resolved,
    lostAnchor: item.lostAnchor,
    codeLines: item.lines,
    quote: item.quote,
    bodyInEndmatter:
      item.kind === "comment" &&
      item.bodySource === "endmatter" &&
      item.anchors.length > 0,
    source: {
      content: item.body,
      rawContent,
      bodyFromEntry: item.bodySource === "endmatter",
      createdAt,
      by: item.by,
      status: item.status,
      resolved: item.resolved,
      attributes: item.attributes,
    },
  };
}

function isModelSuggestion(
  item: RfmModelComment | RfmModelSuggestion | undefined,
): item is RfmModelSuggestion {
  return Boolean(item && "suggestionKind" in item);
}

function createReviewLoadContext(markdown: string): ReviewLoadContext {
  const model = parseReviewModel(markdown);
  const comments = new Map<string, CriticComment>();

  for (const item of model.comments) {
    // Comments with no id at all (a bare `{>>text<<}`) get a document-local
    // id from the tokenizer below, the way the browser always named them.
    if (item.metadataSource === "none") continue;
    comments.set(item.id, commentFromModel(item, markdown));
  }

  return {
    model,
    comments,
    changes: new Map(),
    placedIds: new Set(),
    literalIds: new Set(),
    tailCount: 0,
    placedSuggestionIds: new Set(),
  };
}

// A reply whose parent is a comment or a suggestion of this file. Such a
// reply never sits on a mark: it is shown and saved from the comment map.
function isNestedReply(
  comment: CriticComment | undefined,
  comments: ReadonlyMap<string, CriticComment>,
  model?: RfmReviewModel,
): boolean {
  const parentId = comment?.parentCommentId;
  if (!comment || !parentId || parentId === comment.id) return false;
  return comments.has(parentId) || isModelSuggestion(model?.byId.get(parentId));
}

function isQualifiedBareRef(id: string, context: ReviewLoadContext): boolean {
  const entries = context.model.split.entries;
  return (
    entries.comments.has(id) ||
    entries.suggestions.has(id) ||
    roughdraftIdPattern.test(id)
  );
}

// ---------------------------------------------------------- the review block

function parseReviewEndmatter(endmatter?: string | null): ParsedEndmatter {
  if (!endmatter) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const record = parsed as Record<string, unknown>;
  return {
    comments: parseEndmatterMap(record.comments),
    suggestions: parseEndmatterMap(record.suggestions),
    data: record,
  };
}

function parseEndmatterMap(
  value: unknown,
): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function areValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => areValuesEqual(value, right[index]))
    );
  }
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ]);
    for (const key of keys) {
      if (!areValuesEqual(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

function areEndmatterMapsEqual(
  left: Map<string, Record<string, unknown>>,
  right: Map<string, Record<string, unknown>>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, leftEntry] of left) {
    const rightEntry = right.get(id);
    if (!rightEntry || !areValuesEqual(leftEntry, rightEntry)) {
      return false;
    }
  }

  return true;
}

// `status` and `resolved` written only when they changed in the editor.
function applyResolution(
  next: Record<string, unknown>,
  comment: CriticComment,
) {
  const source = comment.source;
  const status = comment.status ?? null;
  const resolved = comment.resolved ?? null;

  if (!source || status !== source.status) {
    if (status) next.status = status;
    else delete next.status;
  }
  if (!source || resolved !== source.resolved) {
    if (resolved) next.resolved = resolved;
    else delete next.resolved;
  }
}

function endmatterEntryForComment(
  comment: CriticComment,
  existing: Record<string, unknown> | undefined,
  options: { bodyInEntry?: boolean } = {},
): Record<string, unknown> {
  const source = comment.source;
  const by = authorLabel(comment);
  const next: Record<string, unknown> = { ...existing };
  const unchanged = (value: unknown, sourceValue: unknown) =>
    existing !== undefined && source !== undefined && value === sourceValue;

  if (!sameAuthor(existing?.by, by)) next.by = by;
  // An entry keeps its `at` (even a missing one) while the time is unchanged.
  if (!unchanged(comment.createdAt, source?.createdAt)) {
    next.at = comment.createdAt;
  }

  const isReply = Boolean(comment.parentCommentId);
  const keepsBodyInEntry =
    options.bodyInEntry === true ||
    comment.scope === "document" ||
    comment.lostAnchor === true ||
    isReply ||
    comment.bodyInEndmatter === true ||
    (typeof existing?.body === "string" && existing.body === comment.content);

  if (keepsBodyInEntry) {
    // The entry's own text is kept byte for byte (`<br>`, quoting) while the
    // editor shows the same words. A changed body stores its line breaks as
    // `<br>` (D7).
    const entryBodyMatches =
      source?.bodyFromEntry === true ||
      (typeof existing?.body === "string" &&
        decodeBreaks(existing.body) === comment.content);
    if (!(unchanged(comment.content, source?.content) && entryBodyMatches)) {
      next.body = encodeBreaks(comment.content);
    }
  } else {
    delete next.body;
  }

  if (isReply) {
    next.re = comment.parentCommentId;
  } else if (typeof next.re === "string" && next.re !== "") {
    delete next.re;
  }

  // A new global comment says so in its entry, as rfm's writer does; an
  // existing entry keeps its keys as they are.
  if (!existing && !isReply && comment.scope === "document") {
    next.scope = "document";
  }

  applyResolution(next, comment);
  return next;
}

// A comment on code lines records them (and their text) in its entry.
function applyCodeAnchor(
  next: Record<string, unknown>,
  comment: CriticComment,
) {
  if (comment.codeLines && !areValuesEqual(next.lines, comment.codeLines)) {
    next.lines = [...comment.codeLines];
  }
  if (
    comment.codeLines &&
    typeof comment.quote === "string" &&
    next.quote !== comment.quote
  ) {
    next.quote = comment.quote;
  }
}

function endmatterEntryForChange(
  change: CriticChangeAttrs,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const next: Record<string, unknown> = { ...existing };

  if (!sameAuthor(existing?.by, by)) next.by = by;
  if (existing?.at !== change.createdAt) next.at = change.createdAt;

  return next;
}

// A later part of a suggestion over several blocks keeps its own entry and
// names the first part (`continues`).
function endmatterEntryForChangePart(
  part: ChangePart,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (existing) {
    return existing.continues === part.root
      ? existing
      : { ...existing, continues: part.root };
  }
  return {
    ...endmatterEntryForChange(part.change, undefined),
    continues: part.root,
  };
}

/** A comment the composer opened but nothing was typed into yet. */
function isUnsavedDraft(comment: CriticComment): boolean {
  return !comment.source && comment.content.trim() === "";
}

function suggestionEntriesFor(
  parsed: ParsedEndmatter,
  changes: Map<string, CriticChangeAttrs>,
  parts: ChangePartsState,
): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>();
  const build = (id: string) => {
    const change = changes.get(id);
    if (change) {
      return endmatterEntryForChange(change, parsed.suggestions.get(id));
    }
    const part = parts.partOf.get(id);
    if (part) {
      return endmatterEntryForChangePart(part, parsed.suggestions.get(id));
    }
    return null;
  };
  const ordered = [
    ...parsed.suggestions.keys(),
    ...parts.order,
    ...changes.keys(),
  ];
  for (const id of ordered) {
    if (entries.has(id)) continue;
    const entry = build(id);
    if (entry) entries.set(id, entry);
  }
  return entries;
}

// Entries the browser never showed (no anchor, no body, no `re`) stay as
// they are; nothing in the editor can have deleted them.
function preserveOrphanEntries(
  parsed: ParsedEndmatter,
  commentEntries: Map<string, Record<string, unknown>>,
  suggestionEntries: Map<string, Record<string, unknown>>,
  preservedEntryIds: readonly string[],
) {
  for (const id of preservedEntryIds) {
    const comment = parsed.comments.get(id);
    if (comment && !commentEntries.has(id)) commentEntries.set(id, comment);
    const suggestion = parsed.suggestions.get(id);
    if (suggestion && !suggestionEntries.has(id)) {
      suggestionEntries.set(id, suggestion);
    }
  }
}

function inFileOrder(
  entries: Map<string, Record<string, unknown>>,
  fileOrder: Iterable<string>,
) {
  const sorted = new Map<string, Record<string, unknown>>();
  for (const id of fileOrder) {
    const entry = entries.get(id);
    if (entry) sorted.set(id, entry);
  }
  for (const [id, entry] of entries) {
    if (!sorted.has(id)) sorted.set(id, entry);
  }
  return sorted;
}

// The review block of an older-format file: entries keep their bytes while
// nothing changed, and the block is never created (D11).
function serializeLegacyEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  parts: ChangePartsState,
  preservedEntryIds: readonly string[] = [],
  inlineMetadataIds: ReadonlySet<string> = new Set(),
): string | null {
  if (!existingEndmatter) return null;

  const parsed = parseReviewEndmatter(existingEndmatter);
  const commentEntries = new Map<string, Record<string, unknown>>();

  for (const comment of comments.values()) {
    const existing = parsed.comments.get(comment.id);
    if (comment.literal) {
      // Its markup is still literal text in the body; the entry stays as is.
      if (existing) commentEntries.set(comment.id, existing);
      continue;
    }
    if (isUnsavedDraft(comment)) continue;
    // Nothing converts on save: an unchanged comment keeps its entry as it
    // is, or stays without one.
    if (isCommentUnchanged(comment)) {
      if (existing) commentEntries.set(comment.id, existing);
      continue;
    }
    // A comment whose metadata stays inline (attribute form) has no entry
    // unless the file already gave it one.
    if (!existing && inlineMetadataIds.has(comment.id)) continue;
    commentEntries.set(comment.id, endmatterEntryForComment(comment, existing));
  }

  const suggestionEntries = suggestionEntriesFor(parsed, changes, parts);
  preserveOrphanEntries(
    parsed,
    commentEntries,
    suggestionEntries,
    preservedEntryIds,
  );

  if (
    areEndmatterMapsEqual(parsed.comments, commentEntries) &&
    areEndmatterMapsEqual(parsed.suggestions, suggestionEntries)
  ) {
    return existingEndmatter;
  }

  const data: Record<string, unknown> = { ...(parsed.data ?? {}) };
  if (commentEntries.size > 0) {
    data.comments = Object.fromEntries(commentEntries);
  } else {
    delete data.comments;
  }
  if (suggestionEntries.size > 0) {
    data.suggestions = Object.fromEntries(suggestionEntries);
  } else {
    delete data.suggestions;
  }

  if (Object.keys(data).length === 0) return null;

  return `---\n${stringifyYaml(data)}`;
}

// The review block of a canonical file (or one with no review items yet):
// every comment's text, author, time, replies and status, in the file's
// entry order with new entries after it, written by rfm's canonical writer.
// The block is created when the file had none; unchanged entries keep the
// block's bytes.
function serializeCanonicalEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  parts: ChangePartsState,
  preservedEntryIds: readonly string[] = [],
): string | null {
  const parsed = parseReviewEndmatter(existingEndmatter);
  const commentEntries = new Map<string, Record<string, unknown>>();
  const ordered = [
    ...parsed.comments.keys(),
    ...[...comments.keys()].filter((id) => !parsed.comments.has(id)),
  ];

  for (const id of ordered) {
    const comment = comments.get(id);
    const existing = parsed.comments.get(id);
    if (!comment) continue;
    if (comment.literal) {
      if (existing) commentEntries.set(id, existing);
      continue;
    }
    if (isUnsavedDraft(comment)) continue;
    const next = endmatterEntryForComment(comment, existing, {
      bodyInEntry: true,
    });
    applyCodeAnchor(next, comment);
    commentEntries.set(id, next);
  }

  const suggestionEntries = suggestionEntriesFor(parsed, changes, parts);
  preserveOrphanEntries(
    parsed,
    commentEntries,
    suggestionEntries,
    preservedEntryIds,
  );
  const finalComments = inFileOrder(commentEntries, parsed.comments.keys());
  const finalSuggestions = inFileOrder(
    suggestionEntries,
    parsed.suggestions.keys(),
  );

  if (
    existingEndmatter &&
    areEndmatterMapsEqual(parsed.comments, finalComments) &&
    areEndmatterMapsEqual(parsed.suggestions, finalSuggestions)
  ) {
    return existingEndmatter;
  }

  const extra = new Map<string, unknown>(
    Object.entries(parsed.data ?? {}).filter(
      ([key]) => key !== "comments" && key !== "suggestions",
    ),
  );
  const written = stringifyRoughdraftEndmatter({
    comments: finalComments,
    suggestions: finalSuggestions,
    extra,
  });
  return written || null;
}

// ------------------------------------------------------------------ ids

export function createNextCommentId(
  existingComments: Iterable<Pick<CriticComment, "id">>,
): string {
  let maxId = 0;

  for (const comment of existingComments) {
    const match = comment.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `c${maxId + 1}`;
}

export function createNextChangeId(
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
): string {
  let maxId = 0;

  for (const change of existingChanges) {
    const match = change.changeId.match(/^s(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `s${maxId + 1}`;
}

function createCommentWithContext(
  partial?: Partial<CriticComment>,
  existingComments: Iterable<Pick<CriticComment, "id">> = [],
): CriticComment {
  const authorType = partial?.authorType ?? "user";

  return {
    ...partial,
    id: partial?.id ?? createNextCommentId(existingComments),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
  };
}

function createChangeWithContext(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">> = [],
): CriticChangeAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    changeId: partial?.changeId ?? createNextChangeId(existingChanges),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    ...(partial?.partId ? { partId: partial.partId } : {}),
  };
}

function suggestionGroupRoot(
  suggestion: RfmModelSuggestion,
  context: ReviewLoadContext,
): RfmModelSuggestion {
  let current = suggestion;
  const seen = new Set<string>([current.id]);
  while (current.continues) {
    const next = context.model.byId.get(current.continues);
    if (!isModelSuggestion(next) || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

function parseChangeMetadata(
  metadataText: string | undefined,
  context: ReviewLoadContext,
): Partial<CriticChangeAttrs> {
  const reference = metadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const item = context.model.byId.get(id);
    const suggestion = isModelSuggestion(item) ? item : null;
    // A later part of a suggestion over several blocks (`continues`) joins
    // its first part, so the editor shows and settles them as one.
    const root = suggestion ? suggestionGroupRoot(suggestion, context) : null;
    if (suggestion && root && root !== suggestion) {
      return {
        changeId: root.id,
        createdAt: root.at ?? suggestion.at ?? new Date().toISOString(),
        ...authorFields(root.by ?? suggestion.by),
        partId: id,
      };
    }
    return {
      changeId: id,
      createdAt: suggestion?.at ?? new Date().toISOString(),
      ...authorFields(suggestion?.by),
    };
  }

  const parsed = parseAttributeMetadata(metadataText);

  return {
    changeId: parsed.id,
    createdAt: parsed.createdAt,
    authorType: parsed.authorType,
    authorId: parsed.authorId,
  };
}

// ---------------------------------------------------------------- threads

function buildCommentThreadsFromOrderedComments(
  orderedComments: CriticComment[],
): CriticCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, CriticComment[]>();
  const rootComments: CriticComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (
      !parentCommentId ||
      parentCommentId === comment.id ||
      !validCommentIds.has(parentCommentId)
    ) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: CriticComment): CriticCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<CriticComment>,
): CriticCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<CriticCommentThread>,
): CriticComment[] {
  const orderedComments: CriticComment[] = [];

  const visit = (thread: CriticCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId || comment.parentCommentId === comment.id) {
      continue;
    }

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  const visited = new Set<string>([commentId]);
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId || visited.has(nextCommentId)) continue;
    visited.add(nextCommentId);

    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

/** A root and every reply under it, wherever the replies are stored. */
export function getThreadComments(
  rootId: string,
  comments: ReadonlyMap<string, CriticComment>,
): CriticComment[] {
  const root = comments.get(rootId);
  if (!root) return [];

  return [
    root,
    ...getCommentDescendantIds(rootId, comments)
      .map((id) => comments.get(id))
      .filter((comment): comment is CriticComment => Boolean(comment)),
  ];
}

/** Resolved threads fold into the "N resolved" row of their section. */
export function isResolvedComment(comment: CriticComment | undefined) {
  return comment?.status === "resolved";
}

// -------------------------------------------------------------- tokenizers

interface CommentTail {
  raw: string;
  /** Every comment id the markup named, replies included. */
  consumedIds: string[];
  /** Root ids for the mark, in file order. */
  commentIds: string[];
  /** Root ids written as a bare `{#id}` ref on this anchor. */
  refOnlyIds: string[];
  /** The markup split per root id, for the legacy writer (JSON, see `SourceTail`). */
  sourceTail: string | null;
  /** Whether anything at all was consumed. */
  matched: boolean;
}

/**
 * The comment markup one anchor carried in the file, kept on its mark so the
 * legacy writer can write it back byte for byte while its threads are
 * unchanged (D11: nothing converts on save).
 */
interface SourceTail {
  /** Which tail of the file this was (a split anchor shares it). */
  k: number;
  /** Reply markup before the first root (rare). */
  p: string;
  pIds: string[];
  /** One segment per root id: its train or ref plus the replies after it. */
  s: Array<{ id: string; raw: string; ids: string[] }>;
}

function parseSourceTail(value: unknown): SourceTail | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as SourceTail;
    return parsed && Array.isArray(parsed.s) ? parsed : null;
  } catch {
    return null;
  }
}

function commentIdFromTrain(
  commentText: string,
  legacyMetadataText: string | undefined,
  attributeMetadataText: string | undefined,
  referenceMetadataText: string | undefined,
  context: ReviewLoadContext,
  scope: CriticCommentScope,
): string {
  const reference = referenceMetadataText?.match(metadataReferencePattern);
  const metadata = reference
    ? { id: reference[1] }
    : attributeMetadataText
      ? parseAttributeMetadata(attributeMetadataText)
      : legacyMetadataText
        ? parseLegacyMetadata(legacyMetadataText)
        : {};
  const id = metadata.id;

  if (id && context.comments.has(id)) return id;

  // Not in the model: a train with no id (named here, as the browser always
  // did) or metadata rfm does not accept. Keep it readable either way.
  const comment = createCommentWithContext(
    { ...metadata, content: commentText, scope },
    context.comments.values(),
  );
  if (id) {
    comment.source = {
      content: commentText,
      rawContent: commentText,
      bodyFromEntry: false,
      createdAt: comment.createdAt,
      by: authorLabel(comment),
      status: null,
      resolved: null,
      attributes: attributeMetadataText
        ? Object.fromEntries(parseAttributeMap(attributeMetadataText))
        : null,
    };
  }
  context.comments.set(comment.id, comment);
  return comment.id;
}

// Comment trains and `{#id}` refs after a highlight, a suggestion or on
// their own, in any order.
function readCommentTail(
  src: string,
  offset: number,
  context: ReviewLoadContext,
  options: { scope: CriticCommentScope },
): CommentTail {
  let raw = "";
  let cursor = offset;
  const commentIds: string[] = [];
  const refOnlyIds: string[] = [];
  const consumedIds: string[] = [];
  const tail: SourceTail = { k: 0, p: "", pIds: [], s: [] };
  let keepsSource = true;
  let matched = false;

  const add = (id: string, refOnly: boolean, itemRaw: string) => {
    consumedIds.push(id);
    const comment = context.comments.get(id);
    if (isNestedReply(comment, context.comments, context.model)) {
      const segment = tail.s.at(-1);
      if (segment) {
        segment.raw += itemRaw;
        segment.ids.push(id);
      } else {
        tail.p += itemRaw;
        tail.pIds.push(id);
      }
      return;
    }
    if (commentIds.includes(id)) {
      // The same root twice on one anchor: nothing to keep apart, so the
      // save writes this anchor from the comment map.
      keepsSource = false;
    } else {
      commentIds.push(id);
      tail.s.push({ id, raw: itemRaw, ids: [id] });
    }
    if (refOnly && !refOnlyIds.includes(id)) refOnlyIds.push(id);
  };

  while (cursor < src.length) {
    const rest = src.slice(cursor);
    const train = rest.match(criticCommentBlockPattern);
    if (train) {
      const [
        whole,
        commentText = "",
        ,
        legacyMetadataText,
        attributeMetadataText,
        referenceMetadataText,
      ] = train;
      add(
        commentIdFromTrain(
          commentText,
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          context,
          options.scope,
        ),
        false,
        whole,
      );
      raw += whole;
      cursor += whole.length;
      matched = true;
      continue;
    }

    const ref = rest.match(bareRefPattern);
    if (ref) {
      // A ref to an id rfm does not read as a comment stays on the mark so
      // the save writes it back; the rail ignores it.
      add(ref[1] ?? "", true, ref[0]);
      raw += ref[0];
      cursor += ref[0].length;
      matched = true;
      continue;
    }

    break;
  }

  const isMatched = matched && !isLiteralTail(consumedIds, context);
  if (isMatched && keepsSource) {
    context.tailCount += 1;
    tail.k = context.tailCount;
  }

  return {
    raw,
    consumedIds,
    commentIds,
    refOnlyIds,
    // URI-encoded so no review markup appears in the editor's HTML.
    sourceTail:
      isMatched && keepsSource && (commentIds.length > 0 || tail.p)
        ? encodeURIComponent(JSON.stringify(tail))
        : null,
    matched: isMatched,
  };
}

function isLiteralTail(consumedIds: string[], context: ReviewLoadContext) {
  return (
    consumedIds.length > 0 &&
    consumedIds.every((id) => context.literalIds.has(id))
  );
}

function tokenizeCriticCommentAnchor(
  lexer: TokenizerThis["lexer"],
  src: string,
  context: ReviewLoadContext,
): CriticCommentToken | undefined {
  const anchorMatch = src.match(criticCommentAnchorPattern);
  if (!anchorMatch) return undefined;

  const [whole, anchor = ""] = anchorMatch;
  const tail = readCommentTail(src, whole.length, context, {
    scope: "inline",
  });
  if (!tail.matched) return undefined;

  return {
    type: "criticCommentAnchor",
    raw: whole + tail.raw,
    commentIds: tail.commentIds,
    refOnlyIds: tail.refOnlyIds,
    sourceTail: tail.sourceTail,
    tokens: lexer.inlineTokens(anchor),
  };
}

function tokenizeCriticStandaloneComment(
  src: string,
  context: ReviewLoadContext,
): CriticStandaloneCommentToken | undefined {
  if (src.startsWith("{#")) {
    const ref = src.match(bareRefPattern);
    const id = ref?.[1];
    if (!ref || !id || !isQualifiedBareRef(id, context)) return undefined;
    if (isModelSuggestion(context.model.byId.get(id))) return undefined;
  } else if (!src.startsWith("{>>")) {
    return undefined;
  }

  const tail = readCommentTail(src, 0, context, { scope: "standalone" });
  if (!tail.matched) return undefined;

  return {
    type: "criticStandaloneComment",
    raw: tail.raw,
    commentIds: tail.commentIds,
    refOnlyIds: tail.refOnlyIds,
    sourceTail: tail.sourceTail,
  };
}

function getTrailingAttributeMetadata(src: string, offset: number) {
  const reference = src.slice(offset).match(bareRefPattern);
  if (reference) {
    return {
      metadataText: reference[0],
      raw: reference[0],
    };
  }

  const match = src.slice(offset).match(attributeMetadataBlockPattern);

  if (!match) {
    return {
      metadataText: undefined,
      raw: "",
    };
  }

  return {
    metadataText: match[0],
    raw: match[0],
  };
}

function tokenizeCriticChange(
  lexer: TokenizerThis["lexer"],
  src: string,
  context: ReviewLoadContext,
): CriticChangeToken | undefined {
  const additionMatch = src.match(criticAdditionPattern);
  const deletionMatch = additionMatch ? null : src.match(criticDeletionPattern);
  const substitutionMatch =
    additionMatch || deletionMatch
      ? null
      : src.match(criticSubstitutionPattern);
  const match = additionMatch ?? deletionMatch ?? substitutionMatch;
  if (!match) return undefined;

  const kind: CriticChangeKind = additionMatch
    ? "addition"
    : deletionMatch
      ? "deletion"
      : "substitution-old";
  const metadata = getTrailingAttributeMetadata(src, match[0].length);
  const tail = readCommentTail(
    src,
    match[0].length + metadata.raw.length,
    context,
    { scope: "inline" },
  );
  const change = createChangeWithContext(
    kind,
    parseChangeMetadata(metadata.metadataText, context),
    context.changes.values(),
  );
  const raw = match[0] + metadata.raw + tail.raw;

  if (kind === "substitution-old") {
    return {
      type: "criticChange",
      raw,
      change,
      commentIds: tail.commentIds,
      refOnlyIds: tail.refOnlyIds,
      sourceTail: tail.sourceTail,
      oldTokens: lexer.inlineTokens(match[1] ?? ""),
      newTokens: lexer.inlineTokens(match[2] ?? ""),
    };
  }

  return {
    type: "criticChange",
    raw,
    change,
    commentIds: tail.commentIds,
    refOnlyIds: tail.refOnlyIds,
    sourceTail: tail.sourceTail,
    tokens: lexer.inlineTokens(match[1] ?? ""),
  };
}

function commentIdsAttributes(
  commentIds: string[],
  refOnlyIds: string[],
  context?: ReviewLoadContext,
  sourceTail?: string | null,
) {
  for (const id of commentIds) context?.placedIds.add(id);
  const refOnly = refOnlyIds.filter((id) => commentIds.includes(id));
  return `data-comment-ids="${escapeHtml(JSON.stringify(commentIds))}"${
    refOnly.length > 0
      ? ` data-comment-ref-only="${escapeHtml(JSON.stringify(refOnly))}"`
      : ""
  }${sourceTail ? ` data-comment-source="${escapeHtml(sourceTail)}"` : ""}`;
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
  refOnlyIds: string[] = [],
  context?: ReviewLoadContext,
  sourceTail?: string | null,
) {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(by)}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}"${
    change.partId
      ? ` data-critic-change-part="${escapeHtml(change.partId)}"`
      : ""
  }>${content}</span>`;

  if (commentIds.length === 0 && !sourceTail) {
    return changeSpan;
  }

  return `<span ${commentIdsAttributes(commentIds, refOnlyIds, context, sourceTail)}>${changeSpan}</span>`;
}

// Code is literal: nothing inside a fence is review markup. A comment on
// code is a ref on the opening fence line, with the highlighted lines in the
// comment's entry.
function renderCriticCodeBlock(token: Tokens.Code, context: ReviewLoadContext) {
  const info = (token.lang || "").trim();
  const language = info.match(/^[^\s{]\S*/)?.[0];
  const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  const content = token.escaped ? token.text : escapeHtml(token.text);
  const anchors: CodeCommentAnchor[] = [];

  for (const match of info.matchAll(fenceRefPattern)) {
    const id = match[1] ?? "";
    const comment = context.comments.get(id);
    if (!comment || isNestedReply(comment, context.comments, context.model)) {
      continue;
    }
    if (anchors.some((anchor) => anchor.id === id)) continue;
    anchors.push({ id, lines: comment.codeLines ?? null });
    context.placedIds.add(id);
  }

  const infoAttr =
    info && info !== language ? ` data-info="${escapeHtml(info)}"` : "";
  const anchorsAttr =
    anchors.length > 0
      ? ` data-code-anchors="${escapeHtml(JSON.stringify(anchors))}"`
      : "";

  return `<pre${infoAttr}${anchorsAttr}><code${classAttr}>${content}</code></pre>\n`;
}

// ------------------------------------------------------------- the writer

/** A later part of a suggestion over several blocks, as the save wrote it. */
interface ChangePart {
  root: string;
  change: CriticChangeAttrs;
}

interface ChangePartsState {
  /** Ids each suggestion was written under this save (first part first). */
  written: Map<string, string[]>;
  /** Part id -> the first part's id. */
  partOf: Map<string, ChangePart>;
  /** Part ids in the order they were written. */
  order: string[];
  /** Every id in use, so a new part gets a fresh one. */
  taken: Set<string>;
  /** The id each marker element got (turndown can visit an element twice). */
  byElement: WeakMap<Element, string>;
}

interface SerializeContext {
  comments: Map<string, CriticComment>;
  format: ReviewFormat;
  /** Legacy writer: the file has a review block (compact trains), else attributes. */
  useEndmatter: boolean;
  /** Roots whose replies were already written inline (attribute files). */
  emittedReplies: Set<string>;
  /** Legacy writer: roots whose train (their text) was written. */
  emittedBodies: Set<string>;
  /** Legacy writer: source segments written (`<tail>:<id>`), so a split anchor writes it once. */
  emittedSegments: Set<string>;
  /** Legacy writer: ids whose metadata was written inline (no review block entry needed). */
  inlineMetadataIds: Set<string>;
  parts: ChangePartsState;
}

function serializeMetadata(comment: CriticComment): string {
  const source = comment.source;
  const fields = new Map<string, string>();

  if (source?.attributes) {
    for (const [key, value] of Object.entries(source.attributes)) {
      fields.set(key, value);
    }
  }

  const by = authorLabel(comment);
  fields.set("id", comment.id);
  if (!sameAuthor(fields.get("by"), by)) fields.set("by", by);
  if (!(source && fields.has("at") && comment.createdAt === source.createdAt)) {
    fields.set("at", comment.createdAt || new Date().toISOString());
  }
  if (comment.parentCommentId) {
    fields.set("re", comment.parentCommentId);
  } else {
    fields.delete("re");
  }
  if (!source || (comment.status ?? null) !== source.status) {
    if (comment.status) fields.set("status", comment.status);
    else fields.delete("status");
  }
  if (!source || (comment.resolved ?? null) !== source.resolved) {
    if (comment.resolved) fields.set("resolved", comment.resolved);
    else fields.delete("resolved");
  }

  return `{${[...fields]
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function serializeChangeMetadata(
  change: CriticChangeAttrs,
  id = change.changeId,
): string {
  return serializeMetadata({
    id,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

// An inline body (older formats only): its bytes while unchanged, else the
// text with line breaks stored as `<br>` so the train stays on one line.
function inlineCommentText(comment: CriticComment): string {
  const source = comment.source;
  return source?.rawContent != null && comment.content === source.content
    ? source.rawContent
    : encodeBreaks(comment.content);
}

function serializeInlineReplies(rootId: string, context: SerializeContext) {
  if (context.format === "canonical") return "";
  if (context.useEndmatter || context.emittedReplies.has(rootId)) return "";
  context.emittedReplies.add(rootId);

  return getCommentDescendantIds(rootId, context.comments)
    .map((id) => context.comments.get(id))
    .filter(
      (comment): comment is CriticComment =>
        comment !== undefined && !comment.literal && !isUnsavedDraft(comment),
    )
    .map((comment) => {
      context.inlineMetadataIds.add(comment.id);
      return `{>>${inlineCommentText(comment)}<<}${serializeMetadata(comment)}`;
    })
    .join("");
}

/** The comment reads as it did when the file was loaded. */
function isCommentUnchanged(comment: CriticComment | undefined): boolean {
  const source = comment?.source;
  if (!comment || !source) return false;
  return (
    comment.content === source.content &&
    comment.createdAt === source.createdAt &&
    (comment.status ?? null) === source.status &&
    (comment.resolved ?? null) === source.resolved &&
    authorLabel(comment) === authorLabel(authorFields(source.by))
  );
}

// Whether a root's markup from the file can be written back as it was: the
// root and every reply in the segment are unchanged, and (in a file that
// keeps replies inline) the thread gained or lost no reply.
function isSegmentUnchanged(
  rootId: string,
  segmentIds: readonly string[],
  context: SerializeContext,
): boolean {
  if (!segmentIds.every((id) => isCommentUnchanged(context.comments.get(id)))) {
    return false;
  }
  if (context.useEndmatter) return true;
  return getCommentDescendantIds(rootId, context.comments).every((id) => {
    const comment = context.comments.get(id);
    return comment?.literal === true || isCommentUnchanged(comment);
  });
}

// Canonical shape: every anchor is `{#id}` refs, nothing else. The text,
// replies and status live in the review block.
function serializeCanonicalCommentRefs(
  commentIds: string[],
  refOnlyIds: string[],
  context: SerializeContext,
): string {
  const written: string[] = [];
  for (const commentId of commentIds) {
    if (written.includes(commentId)) continue;
    const comment = context.comments.get(commentId);
    if (!comment) {
      if (refOnlyIds.includes(commentId)) written.push(commentId);
      continue;
    }
    // Marks carry root ids only; replies live in the review block.
    if (isNestedReply(comment, context.comments)) continue;
    if (isUnsavedDraft(comment)) continue;
    written.push(commentId);
  }
  return written.map((id) => `{#${id}}`).join("");
}

// The train for a root of an older-format file, in the shape that comment
// already has (attribute metadata, or a compact train in a file with a
// review block), plus its inline replies in attribute files.
function serializeLegacyTrain(
  comment: CriticComment,
  refOnly: boolean,
  context: SerializeContext,
): string {
  // One body per comment: a later anchor of the same comment (a cross-block
  // selection, a split anchor) is a continuation ref.
  if (refOnly || context.emittedBodies.has(comment.id)) {
    return `{#${comment.id}}`;
  }
  context.emittedBodies.add(comment.id);

  let train: string;
  if (context.useEndmatter && comment.bodyInEndmatter) {
    train = `{#${comment.id}}`;
  } else if (!context.useEndmatter || comment.source?.attributes) {
    context.inlineMetadataIds.add(comment.id);
    train = `{>>${inlineCommentText(comment)}<<}${serializeMetadata(comment)}`;
  } else {
    train = `{>>${inlineCommentText(comment)}<<}{#${comment.id}}`;
  }
  return train + serializeInlineReplies(comment.id, context);
}

// Older formats (D11): an anchor whose threads are unchanged is written back
// exactly as the file had it; anything new or edited takes the file's shape.
function serializeLegacyCommentBlocks(
  commentIds: string[],
  refOnlyIds: string[],
  sourceTail: SourceTail | null,
  context: SerializeContext,
): string {
  let result = "";

  if (
    sourceTail?.p &&
    sourceTail.pIds.every((id) => isCommentUnchanged(context.comments.get(id)))
  ) {
    result += sourceTail.p;
    for (const id of sourceTail.pIds) {
      const reply = context.comments.get(id);
      if (reply?.source?.attributes) context.inlineMetadataIds.add(id);
      if (reply?.parentCommentId) {
        context.emittedReplies.add(reply.parentCommentId);
      }
    }
  }

  for (const commentId of commentIds) {
    const comment = context.comments.get(commentId);
    if (!comment) {
      if (refOnlyIds.includes(commentId)) result += `{#${commentId}}`;
      continue;
    }
    // Marks carry root ids only; a reply that still sits on one is written
    // with its thread (or in the review block).
    if (isNestedReply(comment, context.comments)) continue;
    if (isUnsavedDraft(comment)) continue;

    const segment = sourceTail?.s.find(
      (candidate) => candidate.id === commentId,
    );
    if (
      sourceTail &&
      segment &&
      isSegmentUnchanged(commentId, segment.ids, context)
    ) {
      const key = `${sourceTail.k}:${commentId}`;
      if (context.emittedSegments.has(key)) {
        // The same anchor split in two by an edit: one body, then refs.
        result += `{#${commentId}}`;
        continue;
      }
      context.emittedSegments.add(key);
      context.emittedBodies.add(commentId);
      for (const id of segment.ids) {
        if (context.comments.get(id)?.source?.attributes) {
          context.inlineMetadataIds.add(id);
        }
      }
      if (segment.ids.length > 1) context.emittedReplies.add(commentId);
      result += segment.raw;
      continue;
    }

    result += serializeLegacyTrain(
      comment,
      refOnlyIds.includes(commentId),
      context,
    );
  }

  return result;
}

function serializeCommentBlocks(
  commentIds: string[],
  refOnlyIds: string[],
  sourceTail: string | null,
  context: SerializeContext,
): string {
  if (context.format === "canonical") {
    return serializeCanonicalCommentRefs(commentIds, refOnlyIds, context);
  }
  return serializeLegacyCommentBlocks(
    commentIds,
    refOnlyIds,
    parseSourceTail(sourceTail),
    context,
  );
}

function getElementIdList(element: HTMLElement, attribute: string): string[] {
  const text = element.getAttribute(attribute);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function addCriticCommentRule(
  service: TurndownService,
  context: SerializeContext,
) {
  service.addRule("criticComment", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-comment-ids"),
    replacement(content, node) {
      const element = node as HTMLElement;
      const commentIds = getElementIdList(element, "data-comment-ids");
      const refOnlyIds = getElementIdList(element, "data-comment-ref-only");
      const sourceTail = element.getAttribute("data-comment-source");

      const criticChangeElement = element.querySelector(
        "span[data-critic-change-kind]",
      );
      if (criticChangeElement instanceof HTMLElement) {
        return serializeCriticChangeElement(
          service,
          criticChangeElement,
          service.turndown(criticChangeElement.innerHTML).trim(),
          context,
          commentIds,
          refOnlyIds,
          sourceTail,
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        refOnlyIds,
        sourceTail,
        context,
      );
      if (content === unanchoredCommentSentinel) return commentBlocks;
      if (!commentBlocks) return content;

      return `{==${content}==}${commentBlocks}`;
    },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A fence whose info string carries more than a language (fence-line refs,
// attributes) is written back with that info string, minus the refs of code
// comments that were deleted (or never typed into).
function addCodeBlockInfoRule(
  service: TurndownService,
  context: SerializeContext,
) {
  service.addRule("codeBlockInfo", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      (node as HTMLElement).hasAttribute("data-info") &&
      (node as HTMLElement).firstElementChild?.nodeName === "CODE",
    replacement(_content, node) {
      const element = node as HTMLElement;
      let info = element.getAttribute("data-info") ?? "";
      for (const anchor of parseCodeCommentAnchors(
        element.getAttribute("data-code-anchors"),
      )) {
        const comment = context.comments.get(anchor.id);
        if (comment && !isUnsavedDraft(comment)) continue;
        info = info.replace(
          new RegExp(`[ \\t]*\\{#${escapeRegExp(anchor.id)}\\}`),
          "",
        );
      }
      const code = element.firstElementChild?.textContent ?? "";
      const longestRun = Math.max(
        2,
        ...[...code.matchAll(/^`{3,}/gm)].map((match) => match[0].length),
      );
      const fence = "`".repeat(longestRun + 1);

      return `\n\n${fence}${info}\n${code.replace(/\n$/, "")}\n${fence}\n\n`;
    },
  });
}

function getElementChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (
    kind !== "addition" &&
    kind !== "deletion" &&
    kind !== "substitution-old" &&
    kind !== "substitution-new"
  ) {
    return null;
  }

  if (!changeId || !createdAt) return null;

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";
  const partId = element.getAttribute("data-critic-change-part");

  return {
    kind,
    changeId,
    createdAt,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
    ...(partId ? { partId } : {}),
  };
}

function isPairedSubstitutionElement(
  element: Element | null,
  kind: CriticChangeKind,
  changeId: string,
) {
  return (
    element instanceof HTMLElement &&
    element.getAttribute("data-critic-change-kind") === kind &&
    element.getAttribute("data-critic-change-id") === changeId
  );
}

function nextFreeId(prefix: string, taken: Set<string>): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of taken) {
    const match = id.match(pattern);
    if (match) max = Math.max(max, Number.parseInt(match[1] ?? "0", 10));
  }
  return `${prefix}${max + 1}`;
}

// The id a suggestion marker is written under. The first marker of a
// suggestion keeps its id; in the canonical shape each later marker (a
// suggestion over several blocks) is a part with its own id that
// `continues` the first. Older formats keep one id on every marker.
function changeMarkerId(
  element: Element,
  change: CriticChangeAttrs,
  context: SerializeContext,
): string {
  const parts = context.parts;
  const known = parts.byElement.get(element);
  if (known) return known;
  const id = allocateChangeMarkerId(change, context);
  parts.byElement.set(element, id);
  return id;
}

function allocateChangeMarkerId(
  change: CriticChangeAttrs,
  context: SerializeContext,
): string {
  const parts = context.parts;
  const written = parts.written.get(change.changeId);
  if (!written) {
    parts.written.set(change.changeId, [change.changeId]);
    parts.taken.add(change.changeId);
    return change.changeId;
  }
  if (context.format === "legacy" && !change.partId) return change.changeId;

  const id =
    change.partId &&
    !written.includes(change.partId) &&
    !parts.partOf.has(change.partId)
      ? change.partId
      : nextFreeId("s", parts.taken);
  parts.taken.add(id);
  written.push(id);
  parts.order.push(id);
  parts.partOf.set(id, { root: change.changeId, change });
  return id;
}

function changeMetadata(
  change: CriticChangeAttrs,
  id: string,
  kind: CriticChangeKind,
  context: SerializeContext,
) {
  if (context.format === "canonical" || context.useEndmatter) return `{#${id}}`;
  return serializeChangeMetadata({ ...change, kind }, id);
}

function getChangeCommentBlocks(
  element: HTMLElement,
  change: CriticChangeAttrs,
  context: SerializeContext,
  extraCommentIds: string[] = [],
  extraRefOnlyIds: string[] = [],
  sourceTail: string | null = null,
) {
  const blocks = serializeCommentBlocks(
    [
      ...new Set([
        ...getElementIdList(element, "data-comment-ids"),
        ...extraCommentIds,
      ]),
    ],
    [...getElementIdList(element, "data-comment-ref-only"), ...extraRefOnlyIds],
    sourceTail ?? element.getAttribute("data-comment-source"),
    context,
  );

  // Replies to the suggestion itself (attribute files keep them inline).
  return blocks + serializeInlineReplies(change.changeId, context);
}

function serializeCriticChangeElement(
  service: TurndownService,
  element: HTMLElement,
  content: string,
  context: SerializeContext,
  extraCommentIds: string[] = [],
  extraRefOnlyIds: string[] = [],
  sourceTail: string | null = null,
) {
  const change = getElementChangeAttrs(element);

  if (!change) return content;

  const isSecondHalf =
    change.kind === "substitution-new" &&
    isPairedSubstitutionElement(
      element.previousElementSibling,
      "substitution-old",
      change.changeId,
    );
  if (isSecondHalf) return "";

  const markerId = changeMarkerId(element, change, context);
  const commentBlocks = getChangeCommentBlocks(
    element,
    change,
    context,
    extraCommentIds,
    extraRefOnlyIds,
    sourceTail,
  );

  if (change.kind === "addition") {
    return `{++${content}++}${changeMetadata(change, markerId, "addition", context)}${commentBlocks}`;
  }

  if (change.kind === "deletion") {
    return `{--${content}--}${changeMetadata(change, markerId, "deletion", context)}${commentBlocks}`;
  }

  if (change.kind === "substitution-new") {
    return `{++${content}++}${changeMetadata(change, markerId, "addition", context)}${commentBlocks}`;
  }

  const nextElement = element.nextElementSibling;

  if (
    nextElement instanceof HTMLElement &&
    isPairedSubstitutionElement(
      nextElement,
      "substitution-new",
      change.changeId,
    )
  ) {
    const replacement = service.turndown(nextElement.innerHTML).trim();
    return `{~~${content}~>${replacement}~~}${changeMetadata(
      change,
      markerId,
      "substitution-old",
      context,
    )}${commentBlocks}`;
  }

  return `{--${content}--}${changeMetadata(change, markerId, "deletion", context)}${commentBlocks}`;
}

function addCriticChangeRule(
  service: TurndownService,
  context: SerializeContext,
) {
  service.addRule("criticChange", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-critic-change-kind"),
    replacement(content, node) {
      return serializeCriticChangeElement(
        service,
        node as HTMLElement,
        content,
        context,
      );
    },
  });
}

// ------------------------------------------------------------- the reader

function createCriticMarked(
  context: ReviewLoadContext,
  markdownOptions?: MarkdownOptions,
) {
  const renderer = createMarkedRenderer(markdownOptions);
  renderer.code = (token) => renderCriticCodeBlock(token, context);
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer,
  });

  parser.use({
    extensions: [
      {
        name: "criticCommentAnchor",
        level: "inline",
        start(src: string) {
          return src.indexOf("{==");
        },
        tokenizer(this: TokenizerThis, src: string) {
          return tokenizeCriticCommentAnchor(this.lexer, src, context);
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticCommentToken;
          const inner = this.parser.parseInline(criticToken.tokens);
          // A highlight that only carried replies keeps no mark: the
          // replies are in the comment map.
          // A highlight that only carried replies keeps no thread; in an
          // older-format file its markup still goes back as it was.
          if (criticToken.commentIds.length === 0 && !criticToken.sourceTail) {
            return inner;
          }
          return `<span ${commentIdsAttributes(
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
            criticToken.sourceTail,
          )}>${inner}</span>`;
        },
        childTokens: ["tokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticStandaloneComment",
        level: "inline",
        start(src: string) {
          const starts = ["{>>", "{#"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(src: string) {
          return tokenizeCriticStandaloneComment(src, context);
        },
        renderer(token: Tokens.Generic) {
          const criticToken = token as CriticStandaloneCommentToken;
          if (criticToken.commentIds.length === 0 && !criticToken.sourceTail) {
            return "";
          }
          return `<span ${commentIdsAttributes(
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
            criticToken.sourceTail,
          )} data-comment-anchorless="true">${unanchoredCommentSentinel}</span>`;
        },
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticChange",
        level: "inline",
        start(src: string) {
          const starts = ["{++", "{--", "{~~"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(this: TokenizerThis, src: string) {
          const token = tokenizeCriticChange(this.lexer, src, context);
          if (!token) return undefined;

          context.placedSuggestionIds.add(
            token.change.partId ?? token.change.changeId,
          );
          if (
            !token.change.partId ||
            !context.changes.has(token.change.changeId)
          ) {
            context.changes.set(token.change.changeId, token.change);
          }
          return token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticChangeToken;

          if (criticToken.change.kind === "substitution-old") {
            const oldContent = this.parser.parseInline(
              criticToken.oldTokens ?? [],
            );
            const newContent = this.parser.parseInline(
              criticToken.newTokens ?? [],
            );
            const substitutionHtml = `${renderCriticChangeSpan(
              criticToken.change,
              oldContent,
              "substitution-old",
            )}${renderCriticChangeSpan(
              criticToken.change,
              newContent,
              "substitution-new",
            )}`;

            if (
              criticToken.commentIds.length === 0 &&
              !criticToken.sourceTail
            ) {
              return substitutionHtml;
            }

            return `<span ${commentIdsAttributes(
              criticToken.commentIds,
              criticToken.refOnlyIds,
              context,
              criticToken.sourceTail,
            )}>${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
            criticToken.sourceTail,
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
    ],
  });

  return parser;
}

interface CriticMarkdownLoad {
  html: string;
  placedIds: Set<string>;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
  reviewStatus: RfmEndmatterStatus;
  /** Set when the review block could not be read: the banner text. */
  reviewError: string | null;
  /** Review block entries the editor does not show; a save keeps them. */
  preservedEntryIds: string[];
  /** The file keeps a blank line around its headings; a save does too. */
  looseHeadings: boolean;
  /** The file's lists were written by an earlier build; a save keeps that shape. */
  legacyListSpacing: boolean;
  /** Every id the file uses (anchors, entries, orphans): new ids avoid them. */
  reservedIds: string[];
}

// Inline roots rfm reads but the editor could not place, with every reply
// under them. Their markup is kept as literal text on a second pass.
function findUnplacedThreads(context: ReviewLoadContext): Set<string> {
  const unplaced = new Set<string>();

  for (const item of context.model.comments) {
    if (item.kind !== "comment" || item.anchors.length === 0) continue;
    if (context.placedIds.has(item.id)) continue;
    if (!context.comments.has(item.id)) continue;
    unplaced.add(item.id);
    for (const id of getCommentDescendantIds(item.id, context.comments)) {
      unplaced.add(id);
    }
  }

  return unplaced;
}

function parseBody(
  markdown: string,
  body: string,
  options: MarkdownOptions | undefined,
  literalIds: Set<string>,
) {
  const context = createReviewLoadContext(markdown);
  for (const id of literalIds) context.literalIds.add(id);
  const parser = createCriticMarked(context, options);
  const html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  return { context, html };
}

function loadCriticMarkdown(
  markdown: string,
  options?: MarkdownOptions,
): CriticMarkdownLoad {
  const split = yamlDocumentMetadataFromSplit(parseReviewModel(markdown).split);
  const { frontmatter, body, endmatter, status, yamlError } = split;
  let { context, html } = parseBody(markdown, body, options, new Set());
  const unplaced = findUnplacedThreads(context);
  if (unplaced.size > 0) {
    ({ context, html } = parseBody(markdown, body, options, unplaced));
    for (const id of unplaced) {
      const comment = context.comments.get(id);
      if (comment) comment.literal = true;
    }
  }

  return {
    html,
    placedIds: context.placedIds,
    comments: context.comments,
    changes: context.changes,
    frontmatter,
    endmatter,
    reviewStatus: status,
    reviewError:
      status === "invalid" && yamlError
        ? describeReviewBlockError(yamlError.message)
        : null,
    // Entries the editor cannot show (orphans, and suggestions on markers it
    // cannot place, such as empty ones) are kept as they are.
    preservedEntryIds: [
      ...context.model.orphans.map((orphan) => orphan.id),
      ...context.model.suggestions
        .map((suggestion) => suggestion.id)
        .filter((id) => !context.placedSuggestionIds.has(id)),
    ],
    looseHeadings: usesLooseHeadingSpacing(body),
    legacyListSpacing: usesLegacyListSpacing(body),
    reservedIds: [
      ...new Set([
        ...context.model.ids,
        ...context.model.split.entries.comments.keys(),
        ...context.model.split.entries.suggestions.keys(),
        ...context.model.orphans.map((orphan) => orphan.id),
        ...context.comments.keys(),
        ...context.changes.keys(),
      ]),
    ],
  };
}

/**
 * A thread shown in the global section: a document-level comment, a comment
 * whose anchor is gone, or a reply whose parent is missing (rfm gives all
 * three the document scope; replies to a suggestion keep the inline one).
 */
export function isGlobalThreadRoot(
  comment: CriticComment,
  comments: ReadonlyMap<string, CriticComment>,
): boolean {
  if (isNestedReply(comment, comments)) return false;
  return comment.scope === "document" || comment.lostAnchor === true;
}

// Whether the document has anything for the rail to show: a suggestion, a
// thread on an anchor the editor renders, or a global thread. Review markup
// the editor keeps literal (inside raw HTML blocks) does not count.
export function criticMarkdownHasReviewRail(
  markdown: string,
  options?: MarkdownOptions,
): boolean {
  const { comments, changes, placedIds } = loadCriticMarkdown(
    markdown,
    options,
  );
  if (changes.size > 0 || placedIds.size > 0) return true;

  for (const comment of comments.values()) {
    if (isGlobalThreadRoot(comment, comments)) return true;
  }
  return false;
}

/** The banner text when the file's review block cannot be read, else null. */
export function getReviewBlockError(markdown: string): string | null {
  const split = parseReviewModel(markdown).split;
  return split.status === "invalid" && split.yamlError
    ? describeReviewBlockError(split.yamlError.message)
    : null;
}

export function criticMarkdownToRenderedHtml(
  markdown: string,
  options?: MarkdownOptions,
): {
  html: string;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { html, comments, changes, frontmatter, endmatter } =
    loadCriticMarkdown(markdown, options);

  return { html, comments, changes, frontmatter, endmatter };
}

export function criticMarkdownToEditorState(
  markdown: string,
  options?: MarkdownOptions,
): {
  doc: JSONContent;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
  reviewStatus: RfmEndmatterStatus;
  reviewError: string | null;
  preservedEntryIds: string[];
  looseHeadings: boolean;
  legacyListSpacing: boolean;
  reviewFormat: ReviewFormat;
  reservedIds: string[];
} {
  const load = loadCriticMarkdown(markdown, options);
  const reviewFormat = getReviewFormat(markdown);
  const doc = generateJSON(load.html, extensions) as JSONContent &
    CriticDocumentMetadata;
  if (load.frontmatter) {
    doc.yamlFrontmatter = load.frontmatter;
  }
  if (load.endmatter) {
    doc.yamlEndmatter = load.endmatter;
  }
  if (load.preservedEntryIds.length > 0) {
    doc.yamlEndmatterPreservedIds = load.preservedEntryIds;
  }
  if (load.looseHeadings) {
    doc.looseHeadings = true;
  }
  if (load.legacyListSpacing) {
    doc.legacyListSpacing = true;
  }
  // Kept on the document only when it is not the default, like the rest.
  if (reviewFormat === "legacy") {
    doc.reviewFormat = reviewFormat;
  }

  return {
    doc,
    comments: load.comments,
    frontmatter: load.frontmatter,
    endmatter: load.endmatter,
    reviewStatus: load.reviewStatus,
    reviewError: load.reviewError,
    preservedEntryIds: load.preservedEntryIds,
    looseHeadings: load.looseHeadings,
    legacyListSpacing: load.legacyListSpacing,
    reviewFormat,
    reservedIds: load.reservedIds,
  };
}

// What a load keeps beside the editor document for the next save.
interface CriticDocumentMetadata {
  yamlFrontmatter?: string;
  yamlEndmatter?: string;
  yamlEndmatterPreservedIds?: string[];
  looseHeadings?: boolean;
  legacyListSpacing?: boolean;
  reviewFormat?: ReviewFormat;
}

function collectCriticChangesFromDoc(doc: JSONContent): {
  changes: Map<string, CriticChangeAttrs>;
  partIds: Set<string>;
} {
  const changes = new Map<string, CriticChangeAttrs>();
  const partIds = new Set<string>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (attrs?.partId) partIds.add(attrs.partId);
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
        // The first part names the suggestion (its author and time).
        if (attrs.partId && changes.has(attrs.changeId)) continue;
        changes.set(attrs.changeId, {
          kind: attrs.kind,
          changeId: attrs.changeId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType,
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return { changes, partIds };
}

/**
 * Write the editor state back to Markdown. A canonical file (or one with no
 * review items yet) gets the canonical shape: `{#id}` anchors in the prose,
 * fence-line refs for code, every body in the review block written by rfm's
 * canonical writer. An older-format file keeps its review markup exactly as
 * it was and new items take the shape the file already uses (D11).
 */
export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: {
    frontmatter?: string | null;
    endmatter?: string | null;
    preservedEntryIds?: readonly string[];
    looseHeadings?: boolean;
    legacyListSpacing?: boolean;
    reviewFormat?: ReviewFormat;
  },
): string {
  const html = generateHTML(doc, extensions);
  const metadata = doc as JSONContent & CriticDocumentMetadata;
  const service = createTurndownService({
    legacyListSpacing:
      options?.legacyListSpacing ?? metadata.legacyListSpacing ?? false,
  });
  const frontmatter = options?.frontmatter ?? metadata.yamlFrontmatter ?? null;
  const sourceEndmatter = options?.endmatter ?? metadata.yamlEndmatter ?? null;
  const preservedEntryIds =
    options?.preservedEntryIds ?? metadata.yamlEndmatterPreservedIds ?? [];
  const format: ReviewFormat =
    options?.reviewFormat ?? metadata.reviewFormat ?? "canonical";
  const { changes, partIds } = collectCriticChangesFromDoc(doc);
  const parsedEndmatter = parseReviewEndmatter(sourceEndmatter);
  const context: SerializeContext = {
    comments,
    format,
    useEndmatter: Boolean(sourceEndmatter),
    emittedReplies: new Set(),
    emittedBodies: new Set(),
    emittedSegments: new Set(),
    inlineMetadataIds: new Set(),
    parts: {
      written: new Map(),
      partOf: new Map(),
      order: [],
      byElement: new WeakMap(),
      taken: new Set([
        ...parsedEndmatter.comments.keys(),
        ...parsedEndmatter.suggestions.keys(),
        ...comments.keys(),
        ...changes.keys(),
        ...partIds,
      ]),
    },
  };
  addCriticCommentRule(service, context);
  addCriticChangeRule(service, context);
  addCodeBlockInfoRule(service, context);
  const body = service.turndown(html).trimEnd();
  const endmatter =
    format === "canonical"
      ? serializeCanonicalEndmatter(
          sourceEndmatter,
          comments,
          changes,
          context.parts,
          preservedEntryIds,
        )
      : serializeLegacyEndmatter(
          sourceEndmatter,
          comments,
          changes,
          context.parts,
          preservedEntryIds,
          context.inlineMetadataIds,
        );
  return appendYamlEndmatter(
    prependYamlFrontmatter(
      normalizeBlockSpacing(`${body}\n`, {
        looseHeadings: options?.looseHeadings ?? metadata.looseHeadings,
      }),
      frontmatter,
    ),
    endmatter,
  );
}

export function createCriticComment(
  partial?: Partial<CriticComment>,
  options?: {
    existingComments?: Iterable<Pick<CriticComment, "id">>;
  },
): CriticComment {
  return createCommentWithContext(partial, options?.existingComments);
}

export function createCriticChange(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  options?: {
    existingChanges?: Iterable<Pick<CriticChangeAttrs, "changeId">>;
  },
): CriticChangeAttrs {
  return createChangeWithContext(kind, partial, options?.existingChanges);
}
