// The one-thread writers the MCP tools and the CLI quick commands call. Each
// is a transaction on the canonical document: it reads the file into the
// review document, adds or changes one entry, and writes the canonical shape.
// Agent-authored entries get `aN` ids. An old-shape file is refused with a
// message naming `roughdraft doctor --fix` (D11); the one exception is a
// document comment written by a person (the Done route's comment box), which
// keeps the 0.1.10 behavior on an old file so his comment is never lost.
import {
  LEGACY_FORMAT_MESSAGE,
  loadCanonical,
  RoughdraftFormatError,
} from "./canonical.js";
import {
  type Entry,
  nextId,
  type ReviewDoc,
  serializeDoc,
} from "./document.js";
import { legacyAppendRoughdraftDocumentComment } from "./legacy.js";
import { DEFAULT_AGENT_LABELS } from "./round.js";

export interface AppendRoughdraftReplyOptions {
  parentId: string;
  message: string;
  /** Default `AI`. */
  author?: string;
  at?: string;
  /** Default: the next `aN` for an agent author, the next `cN` otherwise. */
  id?: string;
  /** `by` values that count as the agent (default `["AI"]`). */
  agentLabels?: string[];
}

export interface AppendRoughdraftDocumentCommentOptions {
  message: string;
  /** Default `AI`. */
  author?: string;
  at?: string;
  id?: string;
  agentLabels?: string[];
}

export interface MarkRoughdraftResolvedOptions {
  targetId: string;
  summary?: string;
}

const CLOSE_DELIMITER = /<<}|\+\+}|--}|~~}|==}/;

function assertSafeText(message: string, what: string): void {
  const match = message.match(CLOSE_DELIMITER);
  if (match) {
    throw new Error(
      `${what} text contains CriticMarkup close delimiter "${match[0]}". Rewrite the ${what.toLowerCase()} without raw CriticMarkup delimiters.`,
    );
  }
  if (message.trim() === "") {
    throw new Error(`${what} text is empty.`);
  }
}

function assertWritableBlock(ignored: boolean): void {
  if (ignored) {
    throw new RoughdraftFormatError(
      "needs-a-person",
      "This file ends with a `comments:` or `suggestions:` block that is part of the text, not Roughdraft's review block; adding a review entry would make a second block. Rename or move that section first.",
    );
  }
}

function newId(
  doc: ReviewDoc,
  requested: string | undefined,
  agent: boolean,
): string {
  if (requested) {
    if (doc.comments.has(requested) || doc.suggestions.has(requested)) {
      throw new Error(`Review id already in use: ${requested}`);
    }
    return requested;
  }
  return nextId(doc, agent ? "a" : "c");
}

/** Add a reply to any comment, reply, document comment or suggestion. */
export function appendRoughdraftReply(
  markdown: string,
  options: AppendRoughdraftReplyOptions,
): string {
  assertSafeText(options.message, "Reply");
  const loaded = loadCanonical(markdown);
  const { doc } = loaded;
  if (
    !doc.comments.has(options.parentId) &&
    !doc.suggestions.has(options.parentId)
  ) {
    throw new Error(`Review item not found: ${options.parentId}`);
  }
  assertWritableBlock(loaded.model.split.status === "ignored");
  const author = options.author ?? "AI";
  const agent = (options.agentLabels ?? DEFAULT_AGENT_LABELS).includes(author);
  const id = newId(doc, options.id, agent);
  const entry: Entry = {
    body: options.message,
    by: author,
    at: options.at ?? new Date().toISOString(),
    re: options.parentId,
  };
  doc.comments.set(id, entry);
  return serializeDoc(doc);
}

/** Add a document-level (global) comment with `scope: document`. */
export function appendRoughdraftDocumentComment(
  markdown: string,
  options: AppendRoughdraftDocumentCommentOptions,
): string {
  assertSafeText(options.message, "Comment");
  const author = options.author ?? "AI";
  const agent = (options.agentLabels ?? DEFAULT_AGENT_LABELS).includes(author);
  let loaded: ReturnType<typeof loadCanonical>;
  try {
    loaded = loadCanonical(markdown);
  } catch (error) {
    if (
      !agent &&
      error instanceof RoughdraftFormatError &&
      error.code === "legacy-format"
    ) {
      // A person's global comment on an old-shape file: written the way 0.1.10
      // writes it, next to the old forms, without converting anything.
      return legacyAppendRoughdraftDocumentComment(markdown, options);
    }
    throw error;
  }
  const { doc } = loaded;
  assertWritableBlock(loaded.model.split.status === "ignored");
  const id = newId(doc, options.id, agent);
  doc.comments.set(id, {
    body: options.message,
    by: author,
    at: options.at ?? new Date().toISOString(),
    scope: "document",
  });
  return serializeDoc(doc);
}

/** Mark a comment, document comment or suggestion resolved, with an optional summary. */
export function markRoughdraftResolved(
  markdown: string,
  options: MarkRoughdraftResolvedOptions,
): string {
  if (options.summary !== undefined) assertSafeText(options.summary, "Summary");
  const { doc } = loadCanonical(markdown);
  const entry =
    doc.comments.get(options.targetId) ?? doc.suggestions.get(options.targetId);
  if (!entry) throw new Error(`Review item not found: ${options.targetId}`);
  entry.status = "resolved";
  if (options.summary !== undefined) entry.resolved = options.summary;
  return serializeDoc(doc);
}

export { LEGACY_FORMAT_MESSAGE };
