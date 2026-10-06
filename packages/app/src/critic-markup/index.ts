import {
  parseReviewModel,
  type RfmEndmatterStatus,
  type RfmModelComment,
  type RfmModelSuggestion,
  type RfmReviewModel,
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

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  refOnlyIds: string[];
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
  refOnlyIds: string[];
}

interface CriticChangeToken {
  type: "criticChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  refOnlyIds: string[];
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
    comment.scope === "document" ||
    comment.lostAnchor === true ||
    isReply ||
    comment.bodyInEndmatter === true ||
    (typeof existing?.body === "string" && existing.body === comment.content);

  if (keepsBodyInEntry) {
    // The entry's own text is kept byte for byte (`<br>`, quoting) while the
    // editor shows the same words.
    const entryBodyMatches =
      source?.bodyFromEntry === true ||
      (typeof existing?.body === "string" &&
        decodeBreaks(existing.body) === comment.content);
    if (!(unchanged(comment.content, source?.content) && entryBodyMatches)) {
      next.body = comment.content;
    }
  } else {
    delete next.body;
  }

  if (isReply) {
    next.re = comment.parentCommentId;
  } else if (typeof next.re === "string" && next.re !== "") {
    delete next.re;
  }

  applyResolution(next, comment);
  return next;
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

function serializeReviewEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  preservedEntryIds: readonly string[] = [],
): string | null {
  if (!existingEndmatter) return null;

  const parsed = parseReviewEndmatter(existingEndmatter);
  const commentEntries = new Map<string, Record<string, unknown>>();
  const suggestionEntries = new Map<string, Record<string, unknown>>();

  for (const comment of comments.values()) {
    const existing = parsed.comments.get(comment.id);
    if (comment.literal) {
      // Its markup is still literal text in the body; the entry stays as is.
      if (existing) commentEntries.set(comment.id, existing);
      continue;
    }
    commentEntries.set(comment.id, endmatterEntryForComment(comment, existing));
  }

  for (const change of changes.values()) {
    suggestionEntries.set(
      change.changeId,
      endmatterEntryForChange(change, parsed.suggestions.get(change.changeId)),
    );
  }

  // Entries the browser never showed (no anchor, no body, no `re`) stay as
  // they are; nothing in the editor can have deleted them.
  for (const id of preservedEntryIds) {
    const comment = parsed.comments.get(id);
    if (comment && !commentEntries.has(id)) commentEntries.set(id, comment);
    const suggestion = parsed.suggestions.get(id);
    if (suggestion && !suggestionEntries.has(id)) {
      suggestionEntries.set(id, suggestion);
    }
  }

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
  };
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
  /** Whether anything at all was consumed. */
  matched: boolean;
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
  let matched = false;

  const addRoot = (id: string, refOnly: boolean) => {
    consumedIds.push(id);
    const comment = context.comments.get(id);
    if (isNestedReply(comment, context.comments, context.model)) return;
    if (!commentIds.includes(id)) commentIds.push(id);
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
      addRoot(
        commentIdFromTrain(
          commentText,
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          context,
          options.scope,
        ),
        false,
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
      addRoot(ref[1] ?? "", true);
      raw += ref[0];
      cursor += ref[0].length;
      matched = true;
      continue;
    }

    break;
  }

  return {
    raw,
    consumedIds,
    commentIds,
    refOnlyIds,
    matched: matched && !isLiteralTail(consumedIds, context),
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
    tokens: lexer.inlineTokens(match[1] ?? ""),
  };
}

function commentIdsAttributes(
  commentIds: string[],
  refOnlyIds: string[],
  context?: ReviewLoadContext,
) {
  for (const id of commentIds) context?.placedIds.add(id);
  const refOnly = refOnlyIds.filter((id) => commentIds.includes(id));
  return `data-comment-ids="${escapeHtml(JSON.stringify(commentIds))}"${
    refOnly.length > 0
      ? ` data-comment-ref-only="${escapeHtml(JSON.stringify(refOnly))}"`
      : ""
  }`;
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
  refOnlyIds: string[] = [],
  context?: ReviewLoadContext,
) {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(by)}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}">${content}</span>`;

  if (commentIds.length === 0) {
    return changeSpan;
  }

  return `<span ${commentIdsAttributes(commentIds, refOnlyIds, context)}>${changeSpan}</span>`;
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

interface SerializeContext {
  comments: Map<string, CriticComment>;
  useEndmatter: boolean;
  /** Roots whose replies were already written inline (attribute files). */
  emittedReplies: Set<string>;
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

function serializeChangeMetadata(change: CriticChangeAttrs): string {
  return serializeMetadata({
    id: change.changeId,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

function inlineCommentText(comment: CriticComment): string {
  const source = comment.source;
  return source?.rawContent != null && comment.content === source.content
    ? source.rawContent
    : comment.content;
}

function serializeInlineReplies(rootId: string, context: SerializeContext) {
  if (context.useEndmatter || context.emittedReplies.has(rootId)) return "";
  context.emittedReplies.add(rootId);

  return getCommentDescendantIds(rootId, context.comments)
    .map((id) => context.comments.get(id))
    .filter(
      (comment): comment is CriticComment =>
        comment !== undefined && !comment.literal,
    )
    .map(
      (comment) =>
        `{>>${inlineCommentText(comment)}<<}${serializeMetadata(comment)}`,
    )
    .join("");
}

function serializeCommentBlocks(
  commentIds: string[],
  refOnlyIds: string[],
  context: SerializeContext,
): string {
  let result = "";

  for (const commentId of commentIds) {
    const comment = context.comments.get(commentId);
    if (!comment) {
      if (refOnlyIds.includes(commentId)) result += `{#${commentId}}`;
      continue;
    }
    // Marks carry root ids only; a reply that still sits on one is written
    // with its thread below (or in the review block).
    if (isNestedReply(comment, context.comments)) continue;

    if (
      refOnlyIds.includes(commentId) ||
      (context.useEndmatter && comment.bodyInEndmatter)
    ) {
      result += `{#${comment.id}}`;
    } else if (context.useEndmatter) {
      result += `{>>${inlineCommentText(comment)}<<}{#${comment.id}}`;
    } else {
      result += `{>>${inlineCommentText(comment)}<<}${serializeMetadata(comment)}`;
    }
    result += serializeInlineReplies(comment.id, context);
  }

  return result;
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
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        refOnlyIds,
        context,
      );
      if (content === unanchoredCommentSentinel) return commentBlocks;
      if (!commentBlocks) return content;

      return `{==${content}==}${commentBlocks}`;
    },
  });
}

// A fence whose info string carries more than a language (fence-line refs,
// attributes) is written back with that info string untouched.
function addCodeBlockInfoRule(service: TurndownService) {
  service.addRule("codeBlockInfo", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      (node as HTMLElement).hasAttribute("data-info") &&
      (node as HTMLElement).firstElementChild?.nodeName === "CODE",
    replacement(_content, node) {
      const element = node as HTMLElement;
      const info = element.getAttribute("data-info") ?? "";
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

  return {
    kind,
    changeId,
    createdAt,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
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

function getChangeCommentBlocks(
  element: HTMLElement,
  change: CriticChangeAttrs,
  context: SerializeContext,
  extraCommentIds: string[] = [],
  extraRefOnlyIds: string[] = [],
) {
  const blocks = serializeCommentBlocks(
    [
      ...new Set([
        ...getElementIdList(element, "data-comment-ids"),
        ...extraCommentIds,
      ]),
    ],
    [...getElementIdList(element, "data-comment-ref-only"), ...extraRefOnlyIds],
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

  const commentBlocks = getChangeCommentBlocks(
    element,
    change,
    context,
    extraCommentIds,
    extraRefOnlyIds,
  );
  const metadata = context.useEndmatter
    ? `{#${change.changeId}}`
    : serializeChangeMetadata(change);

  if (change.kind === "addition") {
    return `{++${content}++}${metadata}${commentBlocks}`;
  }

  if (change.kind === "deletion") {
    return `{--${content}--}${metadata}${commentBlocks}`;
  }

  if (change.kind === "substitution-new") {
    return `{++${content}++}${
      context.useEndmatter
        ? `{#${change.changeId}}`
        : serializeChangeMetadata({
            ...change,
            kind: "addition",
          })
    }${commentBlocks}`;
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
    return `{~~${content}~>${replacement}~~}${metadata}${commentBlocks}`;
  }

  return `{--${content}--}${
    context.useEndmatter
      ? `{#${change.changeId}}`
      : serializeChangeMetadata({
          ...change,
          kind: "deletion",
        })
  }${commentBlocks}`;
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
          if (criticToken.commentIds.length === 0) return inner;
          return `<span ${commentIdsAttributes(
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
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
          if (criticToken.commentIds.length === 0) return "";
          return `<span ${commentIdsAttributes(
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
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

          context.changes.set(token.change.changeId, token.change);
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

            if (criticToken.commentIds.length === 0) {
              return substitutionHtml;
            }

            return `<span ${commentIdsAttributes(
              criticToken.commentIds,
              criticToken.refOnlyIds,
              context,
            )}>${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
            criticToken.refOnlyIds,
            context,
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
    preservedEntryIds: context.model.orphans.map((orphan) => orphan.id),
    looseHeadings: usesLooseHeadingSpacing(body),
    legacyListSpacing: usesLegacyListSpacing(body),
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
} {
  const load = loadCriticMarkdown(markdown, options);
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
  };
}

// What a load keeps beside the editor document for the next save.
interface CriticDocumentMetadata {
  yamlFrontmatter?: string;
  yamlEndmatter?: string;
  yamlEndmatterPreservedIds?: string[];
  looseHeadings?: boolean;
  legacyListSpacing?: boolean;
}

function collectCriticChangesFromDoc(
  doc: JSONContent,
): Map<string, CriticChangeAttrs> {
  const changes = new Map<string, CriticChangeAttrs>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
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
  return changes;
}

export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: {
    frontmatter?: string | null;
    endmatter?: string | null;
    preservedEntryIds?: readonly string[];
    looseHeadings?: boolean;
    legacyListSpacing?: boolean;
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
  const changes = collectCriticChangesFromDoc(doc);
  const context: SerializeContext = {
    comments,
    useEndmatter: Boolean(sourceEndmatter),
    emittedReplies: new Set(),
  };
  addCriticCommentRule(service, context);
  addCriticChangeRule(service, context);
  addCodeBlockInfoRule(service);
  const body = service.turndown(html).trimEnd();
  const endmatter = serializeReviewEndmatter(
    sourceEndmatter,
    comments,
    changes,
    preservedEntryIds,
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
