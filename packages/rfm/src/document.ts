// The editable review document: the body as a list of pieces (plain text,
// highlights, refs, suggestion markers, fence-line refs) plus the review block
// entries. Every writer in batch 3b goes through it: normalization builds it
// from any legacy shape, apply edits it, and `serializeDoc` writes the one
// canonical shape.
import { isMap, parseDocument as parseYamlDocument } from "yaml";
import {
  createLineStarts,
  locationForOffset,
  parseReviewModel,
  type RfmMarkupRun,
  type RfmModelComment,
  type RfmReviewModel,
  type RfmSuggestionKind,
} from "./model.js";
import { type RfmEndmatterEntry, splitLines } from "./split.js";
import { stringifyRoughdraftEndmatter } from "./writer.js";

export type Entry = RfmEndmatterEntry;

export type Piece =
  | { t: "text"; s: string; src?: number }
  | { t: "hl"; s: string; ids: string[]; src?: number; fresh?: boolean }
  | { t: "ref"; ids: string[] }
  | {
      t: "sug";
      id: string;
      kind: RfmSuggestionKind;
      old: string;
      new: string;
      ids: string[];
      src?: number;
    }
  | { t: "fref"; id: string; lead: string };

export interface ReviewDoc {
  /** Frontmatter bytes, verbatim ("" when none). */
  frontmatter: string;
  pieces: Piece[];
  comments: Map<string, Entry>;
  suggestions: Map<string, Entry>;
  extra: Map<string, unknown>;
  /** The source had a review block (recognized or merged). */
  hadBlock: boolean;
}

/** One thing normalization changed, with the input line it concerns. */
export interface RfmNormalizationChange {
  code: string;
  id?: string;
  line?: number;
  message?: string;
}

/** One thing normalization will not decide on its own. */
export interface RfmNormalizationRefusal {
  code: string;
  message: string;
  line: number;
}

export interface BuildResult {
  doc: ReviewDoc | null;
  /** The model of the source (after merging review blocks). */
  model: RfmReviewModel;
  source: string;
  changes: RfmNormalizationChange[];
  refused: RfmNormalizationRefusal[];
}

/** Model errors normalization resolves by rewriting the file. */
const FIXABLE_ERRORS = new Set([
  "multiple-endmatter-blocks",
  "inline-comment-blank-line",
  "inline-reply-not-allowed",
]);

/** Changes that only rewrite the review block's formatting, not the shape of the file. */
export const FORMATTING_CHANGES = new Set([
  "yaml-rewritten",
  "document-scope",
  "blank-line-before-block",
]);

const BLOCK_PREFIX =
  /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+))*/;

// ------------------------------------------------------------------ helpers

function lineAt(source: string, offset: number): number {
  return locationForOffset(createLineStarts(source), offset).line;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function idNumber(id: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
  return match ? Number(match[1]) : null;
}

/** Every id the document uses: refs, markers, fence refs and every key of both maps. */
export function allIds(doc: ReviewDoc): Set<string> {
  const ids = new Set<string>([
    ...doc.comments.keys(),
    ...doc.suggestions.keys(),
  ]);
  for (const piece of doc.pieces) {
    if (piece.t === "hl" || piece.t === "ref")
      for (const id of piece.ids) ids.add(id);
    if (piece.t === "sug") {
      ids.add(piece.id);
      for (const id of piece.ids) ids.add(id);
    }
    if (piece.t === "fref") ids.add(piece.id);
  }
  return ids;
}

/** A fresh id with the given prefix (`c`, `a` or `s`), one more than the largest in use. */
export function nextId(
  doc: ReviewDoc,
  prefix: "c" | "a" | "s",
  taken?: Set<string>,
): string {
  let max = 0;
  for (const id of [...allIds(doc), ...(taken ?? [])]) {
    const number = idNumber(id, prefix);
    if (number !== null) max = Math.max(max, number);
  }
  return `${prefix}${max + 1}`;
}

function refsText(ids: string[]): string {
  return ids.map((id) => `{#${id}}`).join("");
}

export function markerText(piece: Extract<Piece, { t: "sug" }>): string {
  if (piece.kind === "addition") return `{++${piece.new}++}`;
  if (piece.kind === "deletion") return `{--${piece.old}--}`;
  return `{~~${piece.old}~>${piece.new}~~}`;
}

export function pieceSource(piece: Piece): string {
  switch (piece.t) {
    case "text":
      return piece.s;
    case "hl":
      return `{==${piece.s}==}${refsText(piece.ids)}`;
    case "ref":
      return refsText(piece.ids);
    case "sug":
      return `${markerText(piece)}{#${piece.id}}${refsText(piece.ids)}`;
    case "fref":
      return `${piece.lead}{#${piece.id}}`;
  }
}

/** The piece as it reads in the clean text: suggestions show the current text. */
export function pieceClean(piece: Piece): string {
  switch (piece.t) {
    case "text":
    case "hl":
      return piece.s;
    case "sug":
      return piece.kind === "addition" ? "" : piece.old;
    default:
      return "";
  }
}

export function cleanViewOf(pieces: Piece[]): {
  text: string;
  spans: Array<[number, number]>;
} {
  let text = "";
  const spans: Array<[number, number]> = [];
  for (const piece of pieces) {
    const start = text.length;
    text += pieceClean(piece);
    spans.push([start, text.length]);
  }
  return { text, spans };
}

/** Body bytes, with the blank line the canonical shape puts before the block. */
function bodyWithBlankLine(body: string): string {
  return `${body.replace(/(?:\r?\n[ \t]*)*$/, "")}\n\n`;
}

/** The canonical bytes of a review document. */
export function serializeDoc(doc: ReviewDoc): string {
  let body = "";
  for (const piece of doc.pieces) body += pieceSource(piece);
  // Blank lines right after frontmatter belong to it when the file is read
  // back, so the body starts at its first non-blank line.
  if (doc.frontmatter) body = body.replace(/^(?:[ \t]*\r?\n)+/, "");
  const block = stringifyRoughdraftEndmatter({
    comments: doc.comments,
    suggestions: doc.suggestions,
    extra: doc.extra,
  });
  if (!block) {
    // The last review item went away: drop the blank lines left before it.
    const text = doc.hadBlock ? body.replace(/(?:\r?\n[ \t]*)+$/, "\n") : body;
    return doc.frontmatter + text;
  }
  return doc.frontmatter + bodyWithBlankLine(body) + block;
}

/** Split a highlight or marker text that spans lines into one piece per line. */
function splitLinesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Highlights never hold a line break or a block prefix; empty highlights
 * vanish; adjacent text merges. With `merge`, a highlight an edit touched
 * (`fresh`) merges with a neighbour carrying the same ids. Untouched
 * neighbours are never merged, so a canonical file keeps its exact anchors.
 */
export function normalizePieces(input: Piece[], merge: boolean): Piece[] {
  // Highlights an edit touched join their same-id neighbours first, so the
  // spaces between the parts stay inside the one highlight.
  const pieces: Piece[] = [];
  for (const piece of input) {
    const previous = pieces.at(-1);
    if (
      merge &&
      piece.t === "hl" &&
      previous?.t === "hl" &&
      (piece.fresh || previous.fresh) &&
      piece.ids.length > 0 &&
      [...previous.ids].sort().join() === [...piece.ids].sort().join()
    ) {
      pieces[pieces.length - 1] = {
        t: "hl",
        s: previous.s + piece.s,
        ids: [...previous.ids],
        fresh: true,
      };
      continue;
    }
    pieces.push(piece);
  }
  const out: Piece[] = [];
  const touched = new WeakSet<Piece>();
  let atLineStart = true;
  const push = (piece: Piece, fresh = false) => {
    const previous = out.at(-1);
    if (piece.t === "text" && previous?.t === "text") {
      previous.s += piece.s;
      return;
    }
    if (
      merge &&
      piece.t === "hl" &&
      previous?.t === "hl" &&
      (fresh || touched.has(previous)) &&
      piece.ids.length > 0 &&
      [...previous.ids].sort().join() === [...piece.ids].sort().join()
    ) {
      previous.s += piece.s;
      touched.add(previous);
      return;
    }
    out.push(piece);
    if (fresh) touched.add(piece);
  };
  for (const piece of pieces) {
    if (piece.t !== "hl") {
      if (piece.t === "text") {
        if (piece.s === "") continue;
        push({ ...piece });
        atLineStart = piece.s.endsWith("\n");
      } else {
        push(piece);
        if (piece.t === "sug") atLineStart = false;
      }
      continue;
    }
    const fresh = piece.fresh === true;
    const { fresh: _fresh, ...plain } = piece;
    if (piece.ids.length === 0 || (!piece.s.includes("\n") && !fresh)) {
      if (plain.s !== "" || piece.ids.length > 0) push({ ...plain }, fresh);
      atLineStart = false;
      continue;
    }
    const base = piece.src;
    const at = (offset: number) =>
      base === undefined ? undefined : base + offset;
    let position = 0;
    piece.s.split("\n").forEach((rawLine, index) => {
      if (index > 0) {
        push({ t: "text", s: "\n", src: at(position - 1) });
        atLineStart = true;
      }
      const lineStart = position;
      position += rawLine.length + 1;
      const line = rawLine.replace(/\r$/, "");
      const cr = rawLine.length - line.length;
      let rest = line;
      let restStart = lineStart;
      if (atLineStart && (index > 0 || fresh)) {
        const prefix = line.match(BLOCK_PREFIX)?.[0] ?? "";
        if (prefix) {
          push({ t: "text", s: prefix, src: at(lineStart) });
          rest = line.slice(prefix.length);
          restStart += prefix.length;
        }
      }
      if (rest) {
        if (!rest.trim()) {
          push({ t: "text", s: rest, src: at(restStart) });
        } else {
          // Leading and trailing spaces stay outside the highlight.
          const lead = rest.match(/^[ \t]*/)?.[0] ?? "";
          const trail = rest.match(/[ \t]*$/)?.[0] ?? "";
          if (lead) push({ t: "text", s: lead, src: at(restStart) });
          push(
            {
              t: "hl",
              s: rest.slice(lead.length, rest.length - trail.length),
              ids: [...piece.ids],
              src: at(restStart + lead.length),
            },
            fresh,
          );
          if (trail) {
            push({
              t: "text",
              s: trail,
              src: at(restStart + rest.length - trail.length),
            });
          }
        }
        atLineStart = false;
      }
      if (cr) push({ t: "text", s: "\r", src: at(lineStart + line.length) });
    });
  }
  return out;
}

// ---------------------------------------------------------- review blocks

interface MergedBlocks {
  markdown: string;
  refusal: RfmNormalizationRefusal | null;
  blocks: number;
  line: number;
}

/** Merge two or more review blocks at the end of a file into one. */
function mergeReviewBlocks(
  markdown: string,
  firstOffset: number,
): MergedBlocks {
  const line = lineAt(markdown, firstOffset);
  const body = markdown.slice(0, firstOffset);
  const lines = splitLines(markdown).filter(
    (item) => item.start >= firstOffset,
  );
  const starts = lines.filter((item) => /^---[ \t]*$/.test(item.text));
  const comments = new Map<string, Entry>();
  const suggestions = new Map<string, Entry>();
  const extra = new Map<string, unknown>();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (!start) continue;
    const yamlStart = Math.min(start.end + 1, markdown.length);
    const yamlEnd = starts[index + 1]?.start ?? markdown.length;
    const yaml = markdown.slice(yamlStart, yamlEnd);
    const document = parseYamlDocument(yaml, { uniqueKeys: true });
    const blockLine = lineAt(markdown, start.start);
    const error = document.errors[0];
    if (error) {
      return {
        markdown,
        refusal: {
          code: "invalid-endmatter-yaml",
          message: `the review block at line ${blockLine} does not parse: ${error.message.split("\n")[0]}`,
          line: blockLine,
        },
        blocks: starts.length,
        line,
      };
    }
    const data = document.toJS() as unknown;
    if (data === null || data === undefined) continue;
    if (
      typeof data !== "object" ||
      Array.isArray(data) ||
      !isMap(document.contents)
    ) {
      return {
        markdown,
        refusal: {
          code: "invalid-endmatter-yaml",
          message: `the block at line ${blockLine} is not a YAML mapping`,
          line: blockLine,
        },
        blocks: starts.length,
        line,
      };
    }
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (key === "comments" || key === "suggestions") {
        if (value === null) continue;
        if (typeof value !== "object" || Array.isArray(value)) {
          return {
            markdown,
            refusal: {
              code: "invalid-endmatter-yaml",
              message: `\`${key}\` in the block at line ${blockLine} is not a map keyed by id`,
              line: blockLine,
            },
            blocks: starts.length,
            line,
          };
        }
        const target = key === "comments" ? comments : suggestions;
        for (const [id, entry] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const existing = target.get(id);
          if (existing && !deepEqual(existing, entry)) {
            return {
              markdown,
              refusal: {
                code: "conflicting-blocks",
                message: `\`${id}\` is in two review blocks with different content (the second at line ${blockLine}); keep one by hand`,
                line: blockLine,
              },
              blocks: starts.length,
              line,
            };
          }
          target.set(id, (entry ?? {}) as Entry);
        }
        continue;
      }
      if (extra.has(key) && !deepEqual(extra.get(key), value)) {
        return {
          markdown,
          refusal: {
            code: "conflicting-blocks",
            message: `\`${key}\` is in two review blocks with different values (the second at line ${blockLine})`,
            line: blockLine,
          },
          blocks: starts.length,
          line,
        };
      }
      extra.set(key, value);
    }
  }
  return {
    markdown:
      bodyWithBlankLine(body) +
      stringifyRoughdraftEndmatter({ comments, suggestions, extra }),
    refusal: null,
    blocks: starts.length,
    line,
  };
}

// ------------------------------------------------------------ the builder

function entryFromAttributes(attributes: Record<string, string>): Entry {
  const entry: Entry = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "id") continue;
    entry[key] = value;
  }
  return entry;
}

function sortByAt(entries: Map<string, Entry>): Map<string, Entry> {
  const list = [...entries];
  const key = (entry: Entry) => {
    const time =
      typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  const indexed = list.map((item, index) => ({ item, index }));
  indexed.sort((a, b) => key(a.item[1]) - key(b.item[1]) || a.index - b.index);
  return new Map(indexed.map(({ item }) => item));
}

const CODE_MARKUP = /(?:<<\}|\+\+\}|--\}|~~\})(?:\{[^}\n]*\bid="|\{@)/;

/**
 * Build the editable document from any shape Roughdraft reads, converting
 * legacy forms to the canonical one. `doc` is null only when the review
 * block cannot be read at all; when `refused` is non-empty the document is
 * still built for readers (the clean text), but it must not be written.
 */
export function buildReviewDoc(markdown: string): BuildResult {
  const changes: RfmNormalizationChange[] = [];
  const refused: RfmNormalizationRefusal[] = [];
  let source = markdown;
  let model = parseReviewModel(source);

  if (
    model.split.status === "invalid" &&
    model.split.yamlError?.code === "multiple-endmatter-blocks" &&
    model.split.endmatterOffset !== null
  ) {
    const merged = mergeReviewBlocks(source, model.split.endmatterOffset);
    if (merged.refusal) {
      return { doc: null, model, source, changes, refused: [merged.refusal] };
    }
    changes.push({
      code: "merged-blocks",
      line: merged.line,
      message: `${merged.blocks} review blocks merged into one`,
    });
    source = merged.markdown;
    model = parseReviewModel(source);
  }

  const split = model.split;
  if (split.status === "invalid") {
    const error = split.yamlError;
    refused.push({
      code: error?.code ?? "invalid-endmatter-yaml",
      message: `the review block could not be read: ${error?.message ?? "unknown error"}`,
      line: error?.line ?? 1,
    });
    return { doc: null, model, source, changes, refused };
  }

  for (const diagnostic of model.diagnostics) {
    if (
      diagnostic.severity !== "error" ||
      FIXABLE_ERRORS.has(diagnostic.code)
    ) {
      continue;
    }
    refused.push({
      code: diagnostic.code,
      message: diagnostic.message,
      line: diagnostic.line,
    });
  }

  const commentById = new Map<string, RfmModelComment>(
    model.comments.map((comment) => [comment.id, comment]),
  );
  const lineOf = (offset: number) => lineAt(source, offset);

  // Entries start as the review block, in its order.
  const comments = new Map<string, Entry>();
  const suggestions = new Map<string, Entry>();
  for (const [id, entry] of split.entries.comments)
    comments.set(id, { ...entry });
  for (const [id, entry] of split.entries.suggestions)
    suggestions.set(id, { ...entry });
  const extra = new Map(split.entries.extra);
  const newComments = new Set<string>();
  const newSuggestions = new Set<string>();
  const noted = new Set<string>();
  const note = (change: RfmNormalizationChange, once = true) => {
    const key = `${change.code}:${change.id ?? ""}`;
    if (once && noted.has(key)) return;
    noted.add(key);
    changes.push(change);
  };

  /** Comment text or metadata held inline: move it into the entry. */
  const takeTrainMetadata = (
    id: string,
    content: string | null,
    metadata: string | null,
    attributes: Record<string, string> | null,
    offset: number,
  ) => {
    let entry = comments.get(id);
    if (!entry) {
      entry = {};
      comments.set(id, entry);
      newComments.add(id);
    }
    if (attributes && (metadata === "attribute" || metadata === "legacy")) {
      Object.assign(entry, entryFromAttributes(attributes));
      note({
        code: metadata === "legacy" ? "legacy-metadata" : "attribute-metadata",
        id,
        line: lineOf(offset),
      });
      if ("status" in attributes || "resolved" in attributes) {
        note({ code: "status-attribute", id, line: lineOf(offset) });
      }
    }
    if (content !== null && entry.body === undefined) entry.body = content;
  };

  const seenRoots = new Set<string>();
  const seenMarkers = new Map<string, string>(); // marker id -> group root id
  const pieces: Piece[] = [];
  let cursor = split.bodyOffset;
  const scanEnd = split.endmatterOffset ?? source.length;

  // Trains inside fences that the 0.1.10 browser wrote (attribute metadata, or
  // a ref to a real entry): converted to fence-line refs when the file has
  // review data outside code; a file whose only review markup is inside code
  // could be documentation, so normalization refuses to guess.
  interface Pseudo {
    offset: number;
    endOffset: number;
    kind: "code" | "new-frefs";
    text?: string;
    ids?: string[];
  }
  const pseudo: Pseudo[] = [];
  const hasOutsideData =
    model.comments.length > 0 ||
    model.suggestions.length > 0 ||
    split.entries.comments.size > 0 ||
    split.entries.suggestions.size > 0;
  for (const fence of model.fences) {
    const code = source.slice(fence.codeStart, fence.codeEnd);
    const liveRefIds = [...code.matchAll(/\{#([A-Za-z][A-Za-z0-9_-]*)\}/g)]
      .map((match) => match[1] ?? "")
      .filter(
        (id) =>
          split.entries.comments.has(id) || split.entries.suggestions.has(id),
      );
    if (!CODE_MARKUP.test(code) && liveRefIds.length === 0) continue;
    if (!hasOutsideData) {
      refused.push({
        code: "markup-in-code",
        message:
          "review markup with an id inside a code block, in a file with no other review data: it could be an example or a comment an old browser wrote inside the code; convert it by hand or leave the file as it is",
        line: lineOf(fence.codeStart),
      });
      continue;
    }
    const inner = parseReviewModel(code);
    let newCode = "";
    let codeCursor = 0;
    const anchored: Array<{ id: string; start: number; end: number }> = [];
    for (const run of inner.markup) {
      if (run.type === "suggestion") {
        if (run.metadata === "attribute" || run.metadata === "legacy") {
          refused.push({
            code: "markup-in-code",
            message:
              "a suggestion with metadata inside a code block; settle it by hand",
            line: lineOf(fence.codeStart + run.offset),
          });
        }
        continue;
      }
      if (run.type === "fence-ref") continue;
      const live = run.tail.filter(
        (item) =>
          item.id !== null &&
          (item.metadata === "attribute" ||
            item.metadata === "legacy" ||
            (item.metadata === "reference" &&
              split.entries.comments.has(item.id)) ||
            (item.type === "ref" && split.entries.comments.has(item.id))),
      );
      if (live.length === 0) continue;
      newCode += code.slice(codeCursor, run.offset);
      const start = newCode.length;
      if (
        run.type === "highlight" &&
        run.textStart !== null &&
        run.textEnd !== null
      ) {
        newCode += code.slice(run.textStart, run.textEnd);
      }
      const end = newCode.length;
      // Anything in the tail that is not live stays as text.
      for (const item of run.tail) {
        if (live.includes(item)) continue;
        newCode += code.slice(item.offset, item.endOffset);
      }
      codeCursor = run.endOffset;
      for (const item of live) {
        const id = item.id as string;
        const isReply =
          (item.attributes &&
            typeof item.attributes.re === "string" &&
            item.attributes.re) ||
          typeof split.entries.comments.get(id)?.re === "string";
        takeTrainMetadata(
          id,
          item.content,
          item.metadata,
          item.attributes,
          fence.codeStart + item.offset,
        );
        if (!isReply) anchored.push({ id, start, end });
        note({
          code: "code-anchor",
          id,
          line: lineOf(fence.codeStart + item.offset),
        });
      }
    }
    newCode += code.slice(codeCursor);
    const codeLines = newCode.split("\n");
    const lineIn = (offset: number) =>
      newCode.slice(0, offset).split("\n").length;
    const ids: string[] = [];
    for (const item of anchored) {
      const first = lineIn(item.start);
      const last = lineIn(Math.max(item.start, item.end - 1));
      const entry = comments.get(item.id) as Entry;
      entry.lines = [first, last];
      entry.quote = codeLines.slice(first - 1, last).join("\n");
      if (!ids.includes(item.id)) ids.push(item.id);
    }
    pseudo.push({
      offset: fence.codeStart,
      endOffset: fence.codeEnd,
      kind: "code",
      text: newCode,
    });
    if (ids.length > 0) {
      pseudo.push({
        offset: fence.openLineEnd,
        endOffset: fence.openLineEnd,
        kind: "new-frefs",
        ids,
      });
    }
  }

  type Step =
    | { run: RfmMarkupRun; pseudo: null }
    | { run: null; pseudo: Pseudo };
  const steps: Step[] = [
    ...model.markup.map((run) => ({ run, pseudo: null }) as Step),
    ...pseudo.map((item) => ({ run: null, pseudo: item }) as Step),
  ].sort((a, b) => {
    const ao = a.run ? a.run.offset : (a.pseudo as Pseudo).offset;
    const bo = b.run ? b.run.offset : (b.pseudo as Pseudo).offset;
    return ao - bo;
  });

  const pushText = (from: number, to: number) => {
    if (to > from)
      pieces.push({ t: "text", s: source.slice(from, to), src: from });
  };

  const rootIdsOfTail = (run: RfmMarkupRun): string[] => {
    const ids: string[] = [];
    for (const item of run.tail) {
      if (!item.id) continue;
      const comment = commentById.get(item.id);
      if (!comment) continue;
      if (comment.kind === "reply") {
        if (item.type === "train") {
          takeTrainMetadata(
            item.id,
            item.content,
            item.metadata,
            item.attributes,
            item.offset,
          );
        }
        note({ code: "inline-reply", id: item.id, line: lineOf(item.offset) });
        continue;
      }
      if (item.type === "train") {
        if (seenRoots.has(item.id)) {
          note(
            {
              code: "replicas-to-continuations",
              id: item.id,
              line: lineOf(item.offset),
            },
            false,
          );
        } else if (item.metadata !== null) {
          takeTrainMetadata(
            item.id,
            item.content,
            item.metadata,
            item.attributes,
            item.offset,
          );
          note({
            code: "legacy-inline-body",
            id: item.id,
            line: lineOf(item.offset),
          });
        }
      }
      seenRoots.add(item.id);
      if (!ids.includes(item.id)) ids.push(item.id);
    }
    return ids;
  };

  for (const step of steps) {
    if (step.pseudo) {
      const item = step.pseudo;
      if (item.offset < cursor) continue;
      pushText(cursor, item.offset);
      if (item.kind === "code") {
        pieces.push({ t: "text", s: item.text ?? "" });
        cursor = item.endOffset;
      } else {
        for (const id of item.ids ?? [])
          pieces.push({ t: "fref", id, lead: " " });
        cursor = item.offset;
      }
      continue;
    }
    const run = step.run;
    if (run.offset < cursor || run.offset >= scanEnd) continue;
    if (run.type === "fence-ref") {
      let leadStart = run.offset;
      while (leadStart > cursor && /[ \t]/.test(source[leadStart - 1] ?? ""))
        leadStart -= 1;
      pushText(cursor, leadStart);
      pieces.push({
        t: "fref",
        id: run.id ?? "",
        lead: source.slice(leadStart, run.offset),
      });
      cursor = run.endOffset;
      continue;
    }
    pushText(cursor, run.offset);
    cursor = run.endOffset;
    if (run.type === "highlight") {
      const ids = rootIdsOfTail(run);
      const text = source.slice(
        run.textStart ?? run.offset,
        run.textEnd ?? run.offset,
      );
      if (text.includes("\n") && ids.length > 0) {
        note({
          code: "multi-line-highlight",
          id: ids[0],
          line: lineOf(run.offset),
        });
      }
      pieces.push({ t: "hl", s: text, ids, src: run.textStart ?? undefined });
      continue;
    }
    if (run.type === "standalone") {
      const ids = rootIdsOfTail(run);
      if (ids.length > 0) pieces.push({ t: "ref", ids });
      continue;
    }
    // Suggestion marker.
    const kind = run.suggestionKind as RfmSuggestionKind;
    const markerId = run.id ?? "";
    const commentIds = rootIdsOfTail(run);
    let id = markerId;
    let groupRoot: string;
    if (seenMarkers.has(markerId)) {
      groupRoot = seenMarkers.get(markerId) as string;
      id = nextIdOver("s", comments, suggestions, pieces);
      const first = suggestions.get(markerId) ?? {};
      const entry: Entry = {};
      if (first.by !== undefined) entry.by = first.by;
      if (first.at !== undefined) entry.at = first.at;
      entry.continues = groupRoot;
      suggestions.set(id, entry);
      newSuggestions.add(id);
      note(
        {
          code: "replicated-suggestion",
          id: markerId,
          line: lineOf(run.offset),
          message: `part written as ${id}`,
        },
        false,
      );
    } else {
      let entry = suggestions.get(markerId);
      if (!entry) {
        entry = {};
        suggestions.set(markerId, entry);
        newSuggestions.add(markerId);
      }
      if (
        run.attributes &&
        (run.metadata === "attribute" || run.metadata === "legacy")
      ) {
        Object.assign(entry, entryFromAttributes(run.attributes));
        note({
          code: "attribute-metadata",
          id: markerId,
          line: lineOf(run.offset),
        });
        if ("status" in run.attributes || "resolved" in run.attributes) {
          note({
            code: "status-attribute",
            id: markerId,
            line: lineOf(run.offset),
          });
        }
      }
      groupRoot =
        typeof entry.continues === "string" && entry.continues
          ? entry.continues
          : markerId;
      seenMarkers.set(markerId, groupRoot);
    }
    const original = run.original ?? "";
    const replacement = run.replacement ?? "";
    const multiLine = original.includes("\n") || replacement.includes("\n");
    if (!multiLine) {
      pieces.push({
        t: "sug",
        id,
        kind,
        old: kind === "addition" ? "" : original,
        new: kind === "deletion" ? "" : replacement,
        ids: commentIds,
        src: run.offset + 3,
      });
      continue;
    }
    // A suggestion over several lines: one marker per line, linked by `continues`.
    const oldLines = kind === "addition" ? [] : splitLinesOf(original);
    const newLines = kind === "deletion" ? [] : splitLinesOf(replacement);
    if (kind === "substitution" && oldLines.length !== newLines.length) {
      refused.push({
        code: "multi-line-substitution",
        message: `suggestion \`${markerId}\` replaces ${oldLines.length} line(s) with ${newLines.length}; split it by hand`,
        line: lineOf(run.offset),
      });
      continue;
    }
    note({
      code: "multi-line-suggestion",
      id: markerId,
      line: lineOf(run.offset),
    });
    const count = Math.max(oldLines.length, newLines.length);
    let partId = id;
    let firstPart = true;
    let atLineStart = false;
    for (let index = 0; index < count; index += 1) {
      if (index > 0) {
        pieces.push({ t: "text", s: "\n" });
        atLineStart = true;
      }
      let oldLine = oldLines[index] ?? "";
      let newLine = newLines[index] ?? "";
      const sample = kind === "addition" ? newLine : oldLine;
      const prefix = atLineStart ? (sample.match(BLOCK_PREFIX)?.[0] ?? "") : "";
      if (prefix) {
        pieces.push({ t: "text", s: prefix });
        if (kind !== "addition") oldLine = oldLine.slice(prefix.length);
        if (kind !== "deletion" && newLine.startsWith(prefix))
          newLine = newLine.slice(prefix.length);
      }
      if (kind === "substitution" && !oldLine.trim() !== !newLine.trim()) {
        refused.push({
          code: "multi-line-substitution",
          message: `suggestion \`${markerId}\` pairs a blank line with text; split it by hand`,
          line: lineOf(run.offset),
        });
        break;
      }
      if (!(kind === "addition" ? newLine : oldLine).trim()) {
        pieces.push({ t: "text", s: kind === "addition" ? newLine : oldLine });
        continue;
      }
      if (!firstPart) {
        partId = nextIdOver("s", comments, suggestions, pieces);
        const first = suggestions.get(id) ?? {};
        const entry: Entry = {};
        if (first.by !== undefined) entry.by = first.by;
        if (first.at !== undefined) entry.at = first.at;
        entry.continues = groupRoot;
        suggestions.set(partId, entry);
        newSuggestions.add(partId);
      }
      pieces.push({
        t: "sug",
        id: partId,
        kind,
        old: kind === "addition" ? "" : oldLine,
        new: kind === "deletion" ? "" : newLine,
        ids: firstPart ? commentIds : [],
      });
      firstPart = false;
    }
  }
  pushText(cursor, scanEnd);
  if (split.endmatterOffset === null && scanEnd < source.length)
    pushText(scanEnd, source.length);

  // With refusals the document is still built (readers such as the clean text
  // use it); callers must not write it.

  // Bodies held only in the YAML stay; inline bodies of roots seen above were
  // moved. Document-level comments of a legacy file get `scope: document` so
  // they keep their meaning in the current format.
  for (const comment of model.comments) {
    if (
      comment.kind === "comment" &&
      comment.scope === "document" &&
      !comment.lostAnchor &&
      comment.bodySource === "endmatter"
    ) {
      const entry = comments.get(comment.id);
      if (
        entry &&
        typeof entry.body === "string" &&
        entry.scope === undefined &&
        entry.quote === undefined &&
        entry.lines === undefined
      ) {
        entry.scope = "document";
        note({
          code: "document-scope",
          id: comment.id,
          line: lineOf(comment.offset),
        });
      }
    }
  }

  const doc: ReviewDoc = {
    frontmatter: split.frontmatter ?? "",
    pieces: normalizePieces(pieces, false),
    comments: newComments.size > 0 ? sortByAt(comments) : comments,
    suggestions: newSuggestions.size > 0 ? sortByAt(suggestions) : suggestions,
    extra,
    hadBlock: split.status === "recognized",
  };

  if (split.status === "recognized" && split.endmatter !== null) {
    const blockLine = lineOf(split.endmatterOffset ?? 0);
    const block = stringifyRoughdraftEndmatter({
      comments: doc.comments,
      suggestions: doc.suggestions,
      extra: doc.extra,
    });
    if (block !== split.endmatter) {
      note({
        code: "yaml-rewritten",
        line: blockLine,
        message: "the review block is rewritten in the canonical YAML shape",
      });
    }
    const bodyEnd = source.slice(
      split.bodyOffset,
      split.endmatterOffset ?? source.length,
    );
    if (bodyWithBlankLine(bodyEnd) !== bodyEnd) {
      note({ code: "blank-line-before-block", line: blockLine });
    }
  }
  return { doc, model, source, changes, refused };
}

/** The next free `sN` while the document is still being built. */
function nextIdOver(
  prefix: "s" | "c" | "a",
  comments: Map<string, Entry>,
  suggestions: Map<string, Entry>,
  pieces: Piece[],
): string {
  let max = 0;
  const bump = (id: string) => {
    const number = idNumber(id, prefix);
    if (number !== null) max = Math.max(max, number);
  };
  for (const id of comments.keys()) bump(id);
  for (const id of suggestions.keys()) bump(id);
  for (const piece of pieces) {
    if (piece.t === "sug") bump(piece.id);
    if (piece.t === "hl" || piece.t === "ref" || piece.t === "sug")
      for (const id of piece.ids) bump(id);
  }
  return `${prefix}${max + 1}`;
}
