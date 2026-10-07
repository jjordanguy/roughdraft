// The round an agent reads: one entry per thread with the highlighted text,
// two blocks of context on each side, the section heading, every reply, and
// the clean text it edits. `applyReviewResponse` takes the agent's answer.
import { loadCanonical } from "./canonical.js";
import { cleanTextOfDoc, type RfmCleanTextMap } from "./clean.js";
import type { RfmNormalizationChange } from "./document.js";
import type {
  RfmModelComment,
  RfmModelSuggestion,
  RfmReviewModel,
  RfmSuggestionKind,
} from "./model.js";
import { sha256Hex } from "./sha256.js";
import type { RfmEndmatterStatus } from "./split.js";

export const DEFAULT_AGENT_LABELS = ["AI"];

export interface RfmRoundOptions {
  /** Defaults to `r-<UTC timestamp>-<first 4 hex of the content hash>`. */
  roundId?: string;
  /** ISO time the round starts; defaults to now. */
  createdAt?: string;
  /** Absolute path of the document, echoed in the round. */
  path?: string | null;
  /** The server's file version (`mtimeMs:size:sha256`), echoed in the round. */
  version?: string | null;
  /** `by` values that count as the agent (default `["AI"]`). */
  agentLabels?: string[];
  /** Build a round from an old-shape file, normalizing it on the way (default: refuse, per D11). */
  allowLegacy?: boolean;
}

export interface RfmRoundSegment {
  /** The highlighted text of one anchor (the quoted lines for code; empty for a standalone comment). */
  text: string;
  /** 1-based line in the clean text. */
  line: number;
}

export interface RfmRoundAnchor {
  segments: RfmRoundSegment[];
  /** The nearest heading line at or above the first segment, e.g. `## Timeline`. */
  section: string | null;
  /** Up to two blocks of the clean text before the first segment's block. */
  before: string;
  /** Up to two blocks of the clean text after the last segment's block. */
  after: string;
  /** Code comments: the highlighted lines inside the block. */
  lines?: [number, number];
}

export interface RfmRoundReply {
  id: string;
  author: string | null;
  at: string | null;
  body: string;
  /** The entry this reply answers, when it is not the thread's root. */
  re?: string;
}

export type RfmRoundThreadKind = "comment" | "document" | "suggestion" | "code";

export interface RfmRoundThread {
  id: string;
  kind: RfmRoundThreadKind;
  author: string | null;
  at: string | null;
  /** The thread is open and its latest entry is not by an agent. */
  needsAnswer: boolean;
  /** Comment text with line breaks as `\n`; empty for suggestions. */
  body: string;
  anchor: RfmRoundAnchor | null;
  replies: RfmRoundReply[];
  status: "open" | "resolved";
  resolved: string | null;
  /** Document comments that keep the text they were on (a lost anchor or a restored comment). */
  quote?: string;
  /** A comment whose highlight is gone from the text (shown with the document comments). */
  lostAnchor?: boolean;
  suggestion?: {
    type: RfmSuggestionKind;
    original: string;
    proposed: string;
    /** Every part of a suggestion over several blocks, in document order. */
    parts: string[];
  };
}

export interface RfmRound {
  roughdraftRound: 1;
  roundId: string;
  createdAt: string;
  document: { path: string | null; sha256: string; version: string | null };
  agentLabels: string[];
  endmatter: RfmEndmatterStatus;
  /** Normalizations made to read the file (only with `allowLegacy`). */
  normalized: RfmNormalizationChange[];
  counts: { threads: number; needsAnswer: number; resolved: number };
  threads: RfmRoundThread[];
  /** The clean text the agent edits (clean.md). */
  clean: string;
}

// ------------------------------------------------------------- context

interface Block {
  start: number;
  end: number;
}

/** Blocks of the clean text: paragraphs, headings, list items and whole fenced blocks. */
export function cleanBlocks(clean: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fence: string | null = null;
  let offset = 0;
  for (const line of clean.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (current) current.end = end;
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence[0] &&
        (fenceMatch[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
        current = null;
      }
      continue;
    }
    if (fenceMatch) {
      current = { start, end };
      blocks.push(current);
      fence = fenceMatch[1] ?? "```";
      continue;
    }
    if (line.trim() === "") {
      current = null;
      continue;
    }
    const standalone =
      /^ {0,3}#{1,6}(?:\s|$)/.test(line) ||
      /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line);
    if (!current || standalone) {
      current = { start, end };
      blocks.push(current);
      if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) current = null;
      continue;
    }
    current.end = end;
  }
  return blocks;
}

function blockIndexAt(blocks: Block[], offset: number): number {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as Block;
    if (offset < block.start) return Math.max(0, index - 1);
    if (offset <= block.end) return index;
  }
  return blocks.length - 1;
}

function sectionAt(clean: string, offset: number): string | null {
  const lineEnd = clean.indexOf("\n", offset);
  const lines = clean
    .slice(0, lineEnd === -1 ? clean.length : lineEnd)
    .split("\n");
  let fence: string | null = null;
  let heading: string | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = fence ? null : (fenceMatch[1] ?? null);
      continue;
    }
    if (!fence && /^ {0,3}#{1,6}\s/.test(line)) heading = line.trim();
  }
  return heading;
}

export function contextAround(
  clean: string,
  start: number,
  end: number,
): { before: string; after: string; section: string | null } {
  const blocks = cleanBlocks(clean);
  if (blocks.length === 0) return { before: "", after: "", section: null };
  const first = blockIndexAt(blocks, start);
  const last = blockIndexAt(blocks, Math.max(start, end));
  const text = (block: Block) => clean.slice(block.start, block.end);
  return {
    before: blocks
      .slice(Math.max(0, first - 2), first)
      .map(text)
      .join("\n\n"),
    after: blocks
      .slice(last + 1, last + 3)
      .map(text)
      .join("\n\n"),
    section: sectionAt(clean, start),
  };
}

// ------------------------------------------------------------- threads

function timeOf(at: string | null): number {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

function descendants(model: RfmReviewModel, rootId: string): RfmModelComment[] {
  const out: RfmModelComment[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string) => {
    const item = model.byId.get(id);
    for (const replyId of item?.replies ?? []) {
      if (seen.has(replyId)) continue;
      seen.add(replyId);
      const reply = model.comments.find((comment) => comment.id === replyId);
      if (!reply) continue;
      out.push(reply);
      walk(replyId);
    }
  };
  walk(rootId);
  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => timeOf(a.item.at) - timeOf(b.item.at) || a.index - b.index)
    .map(({ item }) => item);
}

/** The thread is open and its latest entry is not by an agent. */
export function needsAnswer(
  root: { by: string | null; status: string | null },
  replies: Array<{ by: string | null }>,
  agentLabels: string[],
): boolean {
  if (root.status === "resolved") return false;
  const last = replies.at(-1) ?? root;
  return !agentLabels.includes(last.by ?? "");
}

function suggestionGroup(
  model: RfmReviewModel,
  root: RfmModelSuggestion,
): RfmModelSuggestion[] {
  const byId = new Map(model.suggestions.map((item) => [item.id, item]));
  const out: RfmModelSuggestion[] = [];
  const seen = new Set<string>();
  const walk = (item: RfmModelSuggestion) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
    for (const id of item.continuedBy) {
      const next = byId.get(id);
      if (next) walk(next);
    }
  };
  walk(root);
  return out.sort((a, b) => a.offset - b.offset);
}

/** The id of the suggestion a part belongs to (the first part of its group). */
export function suggestionRootId(model: RfmReviewModel, id: string): string {
  const byId = new Map(model.suggestions.map((item) => [item.id, item]));
  let current = byId.get(id);
  const seen = new Set<string>();
  while (
    current?.continues &&
    byId.has(current.continues) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = byId.get(current.continues);
  }
  return current?.id ?? id;
}

/** One entry per thread, document comments first, then in document order. */
export function buildThreads(
  model: RfmReviewModel,
  clean: string,
  map: RfmCleanTextMap,
  agentLabels: string[],
): RfmRoundThread[] {
  const threads: Array<{ thread: RfmRoundThread; position: number }> = [];
  const anchorFor = (
    segments: Array<{ text: string; start: number; end: number }>,
    lines?: [number, number] | null,
  ): RfmRoundAnchor | null => {
    if (segments.length === 0) return null;
    const first = segments[0] as { start: number };
    const last = segments.at(-1) as { end: number };
    const context = contextAround(clean, first.start, last.end);
    const lineOf = (offset: number) =>
      clean.slice(0, offset).split("\n").length;
    return {
      segments: segments.map((segment) => ({
        text: segment.text,
        line: lineOf(segment.start),
      })),
      section: context.section,
      before: context.before,
      after: context.after,
      ...(lines ? { lines } : {}),
    };
  };
  const replyList = (rootId: string): RfmRoundReply[] =>
    descendants(model, rootId).map((reply) => ({
      id: reply.id,
      author: reply.by,
      at: reply.at,
      body: reply.body,
      ...(reply.parentId && reply.parentId !== rootId
        ? { re: reply.parentId }
        : {}),
    }));

  for (const comment of model.comments) {
    if (comment.kind !== "comment") continue;
    const replies = replyList(comment.id);
    const anchors = map.anchors.filter((anchor) => anchor.id === comment.id);
    const document = comment.scope === "document" || anchors.length === 0;
    const kind: RfmRoundThreadKind = document
      ? "document"
      : comment.scope === "code"
        ? "code"
        : "comment";
    const segments = anchors.map((anchor) => ({
      text:
        anchor.kind === "code"
          ? (comment.quote ?? "")
          : clean.slice(anchor.cleanStart, anchor.cleanEnd),
      start: anchor.cleanStart,
      end: anchor.cleanEnd,
    }));
    const thread: RfmRoundThread = {
      id: comment.id,
      kind,
      author: comment.by,
      at: comment.at,
      needsAnswer: needsAnswer(
        comment,
        descendants(model, comment.id),
        agentLabels,
      ),
      body: comment.body,
      anchor: document
        ? null
        : anchorFor(segments, comment.scope === "code" ? comment.lines : null),
      replies,
      status: comment.status === "resolved" ? "resolved" : "open",
      resolved: comment.resolved,
    };
    if (document && comment.quote) thread.quote = comment.quote;
    if (comment.lostAnchor) thread.lostAnchor = true;
    threads.push({
      thread,
      position: document ? -1 : (anchors[0]?.cleanStart ?? -1),
    });
  }

  for (const suggestion of model.suggestions) {
    if (suggestionRootId(model, suggestion.id) !== suggestion.id) continue;
    const group = suggestionGroup(model, suggestion);
    const parts = group
      .map((part) => map.suggestions.find((item) => item.id === part.id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const replies = replyList(suggestion.id);
    const thread: RfmRoundThread = {
      id: suggestion.id,
      kind: "suggestion",
      author: suggestion.by,
      at: suggestion.at,
      needsAnswer: needsAnswer(
        suggestion,
        descendants(model, suggestion.id),
        agentLabels,
      ),
      body: "",
      anchor: anchorFor(
        parts.map((part) => ({
          text: part.kind === "addition" ? "" : part.original,
          start: part.cleanStart,
          end: part.cleanEnd,
        })),
      ),
      replies,
      status: suggestion.status === "resolved" ? "resolved" : "open",
      resolved: suggestion.resolved,
      suggestion: {
        type: suggestion.suggestionKind,
        original: parts.map((part) => part.original).join("\n\n"),
        proposed: parts.map((part) => part.proposed).join("\n\n"),
        parts: group.map((part) => part.id),
      },
    };
    threads.push({ thread, position: parts[0]?.cleanStart ?? -1 });
  }

  return threads
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ thread }) => thread);
}

function defaultRoundId(createdAt: string, hash: string): string {
  const stamp = createdAt
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
  return `r-${stamp}-${hash.slice(0, 4)}`;
}

/**
 * Build the `round.json` content for a document: one entry per thread (a
 * comment over several blocks is one thread with several segments), the
 * clean text, the content hash and a round id. Throws a
 * `RoughdraftFormatError` on an old-shape file unless `allowLegacy`.
 */
export function buildReviewRound(
  markdown: string,
  options: RfmRoundOptions = {},
): RfmRound {
  const agentLabels = options.agentLabels ?? DEFAULT_AGENT_LABELS;
  const loaded = loadCanonical(markdown, { allowLegacy: options.allowLegacy });
  const { clean, map } = cleanTextOfDoc(loaded.doc, loaded.bodyOffset);
  const threads = buildThreads(loaded.model, clean, map, agentLabels);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const hash = sha256Hex(markdown);
  return {
    roughdraftRound: 1,
    roundId: options.roundId ?? defaultRoundId(createdAt, hash),
    createdAt,
    document: {
      path: options.path ?? null,
      sha256: hash,
      version: options.version ?? null,
    },
    agentLabels,
    endmatter: loaded.model.split.status,
    normalized: loaded.changes,
    counts: {
      threads: threads.length,
      needsAnswer: threads.filter((thread) => thread.needsAnswer).length,
      resolved: threads.filter((thread) => thread.status === "resolved").length,
    },
    threads,
    clean,
  };
}
