// The clean text: the body of a document with every review marker removed,
// the copy an agent edits during a round. Pending suggestions show the current
// text (a deletion keeps its text, an addition shows nothing, a substitution
// shows the old text), so the clean text is the document as it reads before
// anyone decides a suggestion.
import {
  buildReviewDoc,
  type Entry,
  type Piece,
  pieceClean,
  type ReviewDoc,
} from "./document.js";
import type { RfmSuggestionKind } from "./model.js";

export interface RfmCleanTextRun {
  /** Where the run starts in the clean text. */
  cleanStart: number;
  /** Where the same bytes start in the original document; null for text normalization rewrote. */
  sourceStart: number | null;
  length: number;
}

export interface RfmCleanTextAnchor {
  id: string;
  kind: "highlight" | "standalone" | "code" | "suggestion";
  cleanStart: number;
  cleanEnd: number;
  /** Start of the anchored text in the original document, when it is copied verbatim. */
  sourceStart: number | null;
  sourceEnd: number | null;
  /** 1-based line of `cleanStart` in the clean text. */
  line: number;
}

export interface RfmCleanTextSuggestion {
  id: string;
  kind: RfmSuggestionKind;
  cleanStart: number;
  cleanEnd: number;
  original: string;
  proposed: string;
  continues: string | null;
  line: number;
  /** What the clean text shows at this spot and what the suggestion proposes. */
  note: string;
}

export interface RfmCleanTextMap {
  /** Offset of the body (after frontmatter) in the original document. */
  bodyOffset: number;
  runs: RfmCleanTextRun[];
  anchors: RfmCleanTextAnchor[];
  suggestions: RfmCleanTextSuggestion[];
}

export interface RfmCleanText {
  clean: string;
  map: RfmCleanTextMap;
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function clip(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 3)}...` : flat;
}

export function suggestionNote(
  kind: RfmSuggestionKind,
  original: string,
  proposed: string,
): string {
  if (kind === "addition") {
    return `proposes adding "${clip(proposed)}" here; the clean text does not include it`;
  }
  if (kind === "deletion") {
    return `proposes deleting "${clip(original)}"; the clean text still has it`;
  }
  return `proposes replacing "${clip(original)}" with "${clip(proposed)}"; the clean text shows the current text`;
}

/** Clean ranges of the quoted lines of a code comment, from its fence ref piece onward. */
function codeRange(
  clean: string,
  fenceLineEnd: number,
  entry: Entry | undefined,
): [number, number] {
  const codeStart = clean.indexOf("\n", fenceLineEnd);
  if (codeStart === -1) return [fenceLineEnd, fenceLineEnd];
  const lines = Array.isArray(entry?.lines) ? (entry?.lines as number[]) : null;
  let start = codeStart + 1;
  if (!lines || typeof lines[0] !== "number" || typeof lines[1] !== "number") {
    return [start, start];
  }
  for (let line = 1; line < lines[0]; line += 1) {
    const next = clean.indexOf("\n", start);
    if (next === -1) return [start, start];
    start = next + 1;
  }
  let end = start;
  for (let line = lines[0]; line <= lines[1]; line += 1) {
    const next = clean.indexOf("\n", end);
    end = next === -1 ? clean.length : next + (line < lines[1] ? 1 : 0);
    if (next === -1) break;
  }
  return [start, end];
}

/** Clean text and its map for a built review document. */
export function cleanTextOfDoc(
  doc: ReviewDoc,
  bodyOffset: number,
): RfmCleanText {
  let clean = "";
  const runs: RfmCleanTextRun[] = [];
  const anchors: RfmCleanTextAnchor[] = [];
  const suggestions: RfmCleanTextSuggestion[] = [];
  const pending: Array<{ id: string; fenceLineEnd: number }> = [];

  const add = (piece: Piece) => {
    const start = clean.length;
    const text = pieceClean(piece);
    clean += text;
    const src = "src" in piece ? (piece.src ?? null) : null;
    if (text.length > 0 && (piece.t === "text" || piece.t === "hl")) {
      runs.push({ cleanStart: start, sourceStart: src, length: text.length });
    }
    if (piece.t === "hl") {
      for (const id of piece.ids) {
        anchors.push({
          id,
          kind: "highlight",
          cleanStart: start,
          cleanEnd: clean.length,
          sourceStart: src,
          sourceEnd: src === null ? null : src + text.length,
          line: 0,
        });
      }
    }
    if (piece.t === "ref") {
      for (const id of piece.ids) {
        anchors.push({
          id,
          kind: "standalone",
          cleanStart: start,
          cleanEnd: start,
          sourceStart: null,
          sourceEnd: null,
          line: 0,
        });
      }
    }
    if (piece.t === "fref") pending.push({ id: piece.id, fenceLineEnd: start });
    if (piece.t === "sug") {
      const entry = doc.suggestions.get(piece.id);
      const original = piece.kind === "addition" ? "" : piece.old;
      const proposed = piece.kind === "deletion" ? "" : piece.new;
      suggestions.push({
        id: piece.id,
        kind: piece.kind,
        cleanStart: start,
        cleanEnd: clean.length,
        original,
        proposed,
        continues:
          typeof entry?.continues === "string" && entry.continues
            ? entry.continues
            : null,
        line: 0,
        note: suggestionNote(piece.kind, original, proposed),
      });
      if (text.length > 0) {
        runs.push({ cleanStart: start, sourceStart: src, length: text.length });
      }
      for (const id of piece.ids) {
        anchors.push({
          id,
          kind: "suggestion",
          cleanStart: start,
          cleanEnd: clean.length,
          sourceStart: src,
          sourceEnd: src === null ? null : src + text.length,
          line: 0,
        });
      }
    }
  };
  for (const piece of doc.pieces) add(piece);

  for (const item of pending) {
    const [start, end] = codeRange(
      clean,
      item.fenceLineEnd,
      doc.comments.get(item.id),
    );
    anchors.push({
      id: item.id,
      kind: "code",
      cleanStart: start,
      cleanEnd: end,
      sourceStart: null,
      sourceEnd: null,
      line: 0,
    });
  }
  anchors.sort((a, b) => a.cleanStart - b.cleanStart);
  for (const anchor of anchors)
    anchor.line = lineAtOffset(clean, anchor.cleanStart);
  for (const suggestion of suggestions) {
    suggestion.line = lineAtOffset(clean, suggestion.cleanStart);
  }
  return { clean, map: { bodyOffset, runs, anchors, suggestions } };
}

/**
 * The document with every review marker removed, plus a map from clean-text
 * offsets back to the original. Frontmatter and the review block are not part
 * of the clean text. Throws when the review block cannot be read.
 */
export function reviewCleanText(markdown: string): RfmCleanText {
  const built = buildReviewDoc(markdown);
  if (!built.doc) {
    const first = built.refused[0];
    throw new Error(
      `The review block cannot be read${first ? `: line ${first.line}: ${first.message}` : "."}`,
    );
  }
  return cleanTextOfDoc(built.doc, built.model.split.bodyOffset);
}

/** The original offset of a clean-text offset, when that text was copied verbatim. */
export function cleanOffsetToSource(
  map: RfmCleanTextMap,
  offset: number,
): number | null {
  for (const run of map.runs) {
    if (offset >= run.cleanStart && offset <= run.cleanStart + run.length) {
      return run.sourceStart === null
        ? null
        : run.sourceStart + (offset - run.cleanStart);
    }
  }
  return null;
}
