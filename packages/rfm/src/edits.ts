// Text edits on a review document: the clean-text diff, locating an edit by
// content in the current clean text, and replacing a clean range while every
// highlight stays on its text or follows the edit.
import {
  cleanViewOf,
  normalizePieces,
  type Piece,
  type ReviewDoc,
} from "./document.js";

// ---------------------------------------------------------------- diff

export interface CleanHunk {
  /** Range in the old text. */
  start: number;
  end: number;
  /** Text replacing it. */
  text: string;
}

const WORD = /[\p{L}\p{N}_'’-]/u;
const isWord = (character: string | undefined) =>
  character !== undefined && WORD.test(character);

function splitKeepingNewlines(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

/** Narrow a hunk to the characters that changed, widened to whole words. */
function refine(oldText: string, newText: string): { p: number; q: number } {
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p += 1;
  let q = 0;
  while (
    q < max - p &&
    oldText[oldText.length - 1 - q] === newText[newText.length - 1 - q]
  ) {
    q += 1;
  }
  while (
    p > 0 &&
    isWord(oldText[p - 1]) &&
    (isWord(oldText[p]) || isWord(newText[p]))
  ) {
    p -= 1;
  }
  while (
    q > 0 &&
    isWord(oldText[oldText.length - q]) &&
    (isWord(oldText[oldText.length - q - 1]) ||
      isWord(newText[newText.length - q - 1]))
  ) {
    q -= 1;
  }
  return { p, q };
}

/** Line diff of two texts, each hunk narrowed to the words that changed. */
export function diffCleanText(oldText: string, newText: string): CleanHunk[] {
  if (oldText === newText) return [];
  const a = splitKeepingNewlines(oldText);
  const b = splitKeepingNewlines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  // Matching line pairs in the middle (LCS); a very large middle is one hunk.
  const pairs: Array<[number, number]> = [];
  if (am.length > 0 && bm.length > 0 && am.length * bm.length <= 4_000_000) {
    const width = bm.length + 1;
    const table = new Uint32Array((am.length + 1) * width);
    for (let i = am.length - 1; i >= 0; i -= 1) {
      for (let j = bm.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          am[i] === bm[j]
            ? (table[(i + 1) * width + j + 1] as number) + 1
            : Math.max(
                table[(i + 1) * width + j] as number,
                table[i * width + j + 1] as number,
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        pairs.push([i, j]);
        i += 1;
        j += 1;
      } else if (
        (table[(i + 1) * width + j] as number) >=
        (table[i * width + j + 1] as number)
      ) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  pairs.push([am.length, bm.length]);
  const offsets = [0];
  for (const line of a) offsets.push((offsets.at(-1) as number) + line.length);
  const hunks: CleanHunk[] = [];
  let i = 0;
  let j = 0;
  const push = (
    start: number,
    end: number,
    oldPart: string,
    newPart: string,
  ) => {
    const { p, q } = refine(oldPart, newPart);
    hunks.push({
      start: start + p,
      end: end - q,
      text: newPart.slice(p, newPart.length - q),
    });
  };
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      if (pi - i === pj - j) {
        // As many lines out as in: one hunk per line pair, so an edit on one
        // line never widens a highlight on the next.
        for (let k = 0; k < pi - i; k += 1) {
          const oldLine = am[i + k] as string;
          const newLine = bm[j + k] as string;
          if (oldLine === newLine) continue;
          const start = offsets[head + i + k] as number;
          push(start, start + oldLine.length, oldLine, newLine);
        }
      } else {
        const start = offsets[head + i] as number;
        const end = offsets[head + pi] as number;
        push(start, end, am.slice(i, pi).join(""), bm.slice(j, pj).join(""));
      }
    }
    i = pi + 1;
    j = pj + 1;
  }
  return hunks.filter((hunk) => hunk.end > hunk.start || hunk.text.length > 0);
}

// -------------------------------------------------------------- locate

export type MatchMode = "exact" | "whitespace";

export interface Located {
  start: number;
  end: number;
  mode: MatchMode;
}

export type LocateFailure =
  | { code: "edit-not-found"; message: string; hint?: string }
  | { code: "edit-ambiguous"; message: string; lines: number[] };

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every match of `needle`, exact first, then treating every whitespace run as equal. */
export function findMatches(
  text: string,
  needle: string,
): { matches: Array<[number, number]>; mode: MatchMode } {
  const exact: Array<[number, number]> = [];
  if (needle.length > 0) {
    for (
      let index = text.indexOf(needle);
      index !== -1;
      index = text.indexOf(needle, index + 1)
    ) {
      exact.push([index, index + needle.length]);
    }
  }
  if (exact.length > 0) return { matches: exact, mode: "exact" };
  const parts = needle.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (parts.length === 0) return { matches: [], mode: "exact" };
  const lead = /^\s/.test(needle) ? "\\s*" : "";
  const trail = /\s$/.test(needle) ? "\\s*" : "";
  const pattern = new RegExp(`${lead}${parts.join("\\s+")}${trail}`, "g");
  const loose: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    loose.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  return { matches: loose, mode: "whitespace" };
}

function commonSuffix(
  a: string,
  aEnd: number,
  b: string,
  bEnd: number,
  cap: number,
) {
  let n = 0;
  while (
    n < cap &&
    aEnd - n > 0 &&
    bEnd - n > 0 &&
    a[aEnd - n - 1] === b[bEnd - n - 1]
  )
    n += 1;
  return n;
}

function commonPrefix(
  a: string,
  aStart: number,
  b: string,
  bStart: number,
  cap: number,
) {
  let n = 0;
  while (
    n < cap &&
    aStart + n < a.length &&
    bStart + n < b.length &&
    a[aStart + n] === b[bStart + n]
  )
    n += 1;
  return n;
}

/**
 * Find a hunk of the old clean text in the current clean text by content:
 * the old text exact, then ignoring whitespace; several matches are told
 * apart by how much of the surrounding old text matches around each.
 */
export function locateHunk(
  oldClean: string,
  current: string,
  hunk: CleanHunk,
): Located | LocateFailure {
  if (oldClean === current)
    return { start: hunk.start, end: hunk.end, mode: "exact" };
  const old = oldClean.slice(hunk.start, hunk.end);
  const cap = 400;
  let candidates: Array<[number, number]> = [];
  let mode: MatchMode = "exact";
  if (old.length > 0) {
    const found = findMatches(current, old);
    candidates = found.matches;
    mode = found.mode;
  } else {
    // A pure insertion: positions where the text around it still meets.
    const left = oldClean.slice(Math.max(0, hunk.start - 24), hunk.start);
    const right = oldClean.slice(hunk.end, hunk.end + 24);
    const set = new Set<number>();
    if (left) {
      for (
        let index = current.indexOf(left);
        index !== -1;
        index = current.indexOf(left, index + 1)
      ) {
        set.add(index + left.length);
      }
    }
    if (right) {
      for (
        let index = current.indexOf(right);
        index !== -1;
        index = current.indexOf(right, index + 1)
      ) {
        set.add(index);
      }
    }
    if (!left && !right) set.add(0);
    candidates = [...set].map(
      (position) => [position, position] as [number, number],
    );
  }
  if (candidates.length === 0) {
    const near = oldClean.slice(Math.max(0, hunk.start - 80), hunk.end + 80);
    return {
      code: "edit-not-found",
      message: `the text this edit changes ("${clip(old || near)}") is no longer in the document`,
      hint: "It was changed after the round started. Start a new round to edit the current text.",
    };
  }
  // A hunk that starts or ends on a word boundary only matches there.
  if (old.length > 0) {
    const startsWord = isWord(old[0]) && !isWord(oldClean[hunk.start - 1]);
    const endsWord = isWord(old.at(-1)) && !isWord(oldClean[hunk.end]);
    const bounded = candidates.filter(
      ([start, end]) =>
        (!startsWord || !isWord(current[start - 1])) &&
        (!endsWord || !isWord(current[end])),
    );
    if (bounded.length === 0) {
      return {
        code: "edit-not-found",
        message: `the text this edit changes ("${clip(old)}") is no longer in the document`,
        hint: "It was changed after the round started. Start a new round to edit the current text.",
      };
    }
    candidates = bounded;
  }
  if (candidates.length === 1 && old.length > 0) {
    const [start, end] = candidates[0] as [number, number];
    return { start, end, mode };
  }
  const scored = candidates
    .map(([start, end]) => ({
      start,
      end,
      score:
        commonSuffix(oldClean, hunk.start, current, start, cap) +
        commonPrefix(oldClean, hunk.end, current, end, cap),
    }))
    .sort((x, y) => y.score - x.score);
  const best = scored[0] as { start: number; end: number; score: number };
  const second = scored[1];
  if (second && second.score === best.score) {
    return {
      code: "edit-ambiguous",
      message: `the text this edit changes ("${clip(old)}") occurs ${candidates.length} times and the text around it does not tell them apart`,
      lines: scored
        .filter((item) => item.score === best.score)
        .map((item) => lineOf(current, item.start)),
    };
  }
  // Several candidates and too little matching text around the best one to
  // be sure it is the same place.
  if (best.score < Math.min(12, Math.max(4, 24 - old.length))) {
    return {
      code: old.length === 0 ? "edit-not-found" : "edit-ambiguous",
      message:
        old.length === 0
          ? "the place this edit inserts text is no longer in the document"
          : `the text this edit changes ("${clip(old)}") occurs ${candidates.length} times and the text around it changed`,
      ...(old.length === 0
        ? {
            hint: "The text around it changed after the round started. Start a new round.",
          }
        : { lines: scored.map((item) => lineOf(current, item.start)) }),
    } as LocateFailure;
  }
  if (old.length === 0 && best.score === 0) {
    return {
      code: "edit-not-found",
      message: "the place this edit inserts text is no longer in the document",
      hint: "The text around it changed after the round started. Start a new round.",
    };
  }
  return { start: best.start, end: best.end, mode };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

// --------------------------------------------------------------- apply

export type AnchorResult =
  | "inside"
  | "kept"
  | "widened"
  | "standalone"
  | "segment-removed"
  | "moved";

export interface EditOutcome {
  anchors: Array<{ id: string; result: AnchorResult }>;
  /** Ids whose last highlight this edit removed; made standalone at the spot. */
  orphaned: string[];
}

export interface EditRefusal {
  code: "edit-touches-suggestion";
  suggestion: string;
}

/**
 * Replace the clean range [a, b) with `text`. Markup outside the range never
 * changes. An edit inside one highlight keeps it; a highlight whose text the
 * edit crosses stays on its text when that text survives exactly once in the
 * new text, otherwise it covers the new text; a comment with no text left
 * becomes a standalone ref at the spot. Pending suggestions refuse.
 */
export function applyEditAt(
  doc: ReviewDoc,
  a: number,
  b: number,
  text: string,
  collapse = true,
): EditOutcome | EditRefusal {
  const view = cleanViewOf(doc.pieces);
  const pieces = doc.pieces;
  const hits: number[] = [];
  pieces.forEach((piece, index) => {
    const [start, end] = view.spans[index] as [number, number];
    if (start === end) {
      if (a < start && start < b) hits.push(index);
      if (piece.t === "sug" && a === b && start === a) {
        // An insertion exactly at an addition's spot touches it.
        hits.push(index);
      }
      return;
    }
    if (start < b && end > a) hits.push(index);
    else if (a === b && start < a && a < end) hits.push(index);
  });
  for (const index of hits) {
    const piece = pieces[index] as Piece;
    if (piece.t === "sug")
      return { code: "edit-touches-suggestion", suggestion: piece.id };
  }

  const outcome: EditOutcome = { anchors: [], orphaned: [] };
  const textHits = hits.filter((index) => {
    const [start, end] = view.spans[index] as [number, number];
    return end > start;
  });

  if (textHits.length === 0) {
    // A pure insertion between pieces, or a replacement of nothing: insert
    // plain text after any zero-width refs at that spot (a standalone comment
    // stays after the text it follows).
    let insertAt = pieces.length;
    for (let index = 0; index < pieces.length; index += 1) {
      const [start, end] = view.spans[index] as [number, number];
      if (start >= a && !(start === end && start === a)) {
        insertAt = index;
        break;
      }
    }
    const moved = hits.map((index) => pieces[index] as Piece);
    const rest = pieces.filter((_, index) => !hits.includes(index));
    const position = rest.indexOf(pieces[insertAt] as Piece);
    const at = position === -1 ? rest.length : position;
    rest.splice(at, 0, { t: "text", s: text }, ...moved);
    doc.pieces = normalizePieces(rest, true);
    for (const piece of moved) {
      if (piece.t === "ref")
        for (const id of piece.ids)
          outcome.anchors.push({ id, result: "moved" });
      if (piece.t === "fref")
        outcome.anchors.push({ id: piece.id, result: "moved" });
    }
    return outcome;
  }

  const firstIndex = textHits[0] as number;
  const lastIndex = textHits.at(-1) as number;
  const first = pieces[firstIndex] as Extract<Piece, { t: "text" | "hl" }>;
  const last = pieces[lastIndex] as Extract<Piece, { t: "text" | "hl" }>;
  const firstStart = (view.spans[firstIndex] as [number, number])[0];
  const lastStart = (view.spans[lastIndex] as [number, number])[0];
  const prefix = first.s.slice(0, a - firstStart);
  const suffix = last.s.slice(b - lastStart);

  const covered = new Map<string, string[]>();
  let sameIds: string | null = null;
  let allSame = true;
  for (const index of textHits) {
    const piece = pieces[index] as Extract<Piece, { t: "text" | "hl" }>;
    const [start, end] = view.spans[index] as [number, number];
    const part = piece.s.slice(
      Math.max(a, start) - start,
      Math.min(b, end) - start,
    );
    const ids = piece.t === "hl" ? piece.ids : [];
    const key = [...ids].sort().join(",");
    if (sameIds === null) sameIds = key;
    else if (sameIds !== key) allSame = false;
    for (const id of ids) covered.set(id, [...(covered.get(id) ?? []), part]);
  }

  const marks: Array<Set<string>> = Array.from(
    { length: text.length },
    () => new Set(),
  );
  const blank = text.trim() === "";
  if (allSame && sameIds && !blank) {
    for (const set of marks) for (const id of sameIds.split(",")) set.add(id);
    for (const id of sameIds.split(",")) {
      outcome.anchors.push({ id, result: "inside" });
    }
  } else {
    for (const [id, parts] of covered) {
      if (blank) {
        outcome.anchors.push({ id, result: "segment-removed" });
        continue;
      }
      const spots: Array<[number, number]> = [];
      let ok = true;
      for (const part of parts) {
        const at = text.indexOf(part);
        if (!part.trim() || at === -1 || text.indexOf(part, at + 1) !== -1) {
          ok = false;
          break;
        }
        spots.push([at, at + part.length]);
      }
      if (ok) {
        for (const [x, y] of spots)
          for (let q = x; q < y; q += 1) marks[q]?.add(id);
        outcome.anchors.push({ id, result: "kept" });
      } else {
        for (const set of marks) set.add(id);
        outcome.anchors.push({ id, result: "widened" });
      }
    }
  }

  const out: Piece[] = [];
  if (prefix) {
    out.push(
      first.t === "hl"
        ? { t: "hl", s: prefix, ids: [...first.ids], fresh: true }
        : { t: "text", s: prefix },
    );
  }
  let runStart = 0;
  const key = (set: Set<string> | undefined) =>
    [...(set ?? [])].sort().join(",");
  for (let q = 1; q <= text.length; q += 1) {
    if (q < text.length && key(marks[q]) === key(marks[runStart])) continue;
    const chunk = text.slice(runStart, q);
    const ids = [...(marks[runStart] ?? [])];
    if (chunk)
      out.push(
        ids.length > 0
          ? { t: "hl", s: chunk, ids, fresh: true }
          : { t: "text", s: chunk },
      );
    runStart = q;
  }
  // Comments whose text in the range is gone and that keep nothing in the
  // prefix or suffix: a standalone ref at the spot (dropped later when the
  // comment still has another anchor).
  const keptIds = new Set<string>();
  for (const piece of out)
    if (piece.t === "hl") for (const id of piece.ids) keptIds.add(id);
  if (suffix && last.t === "hl") for (const id of last.ids) keptIds.add(id);
  const orphaned = [...covered.keys()].filter((id) => !keptIds.has(id));
  const zeroWidth = hits
    .filter((index) => !textHits.includes(index))
    .map((index) => pieces[index] as Piece);
  if (orphaned.length > 0) out.push({ t: "ref", ids: orphaned });
  outcome.orphaned = orphaned;
  for (const piece of zeroWidth) {
    out.push(piece);
    if (piece.t === "ref")
      for (const id of piece.ids) outcome.anchors.push({ id, result: "moved" });
    if (piece.t === "fref")
      outcome.anchors.push({ id: piece.id, result: "moved" });
  }
  if (suffix) {
    out.push(
      last.t === "hl"
        ? { t: "hl", s: suffix, ids: [...last.ids], fresh: true }
        : { t: "text", s: suffix },
    );
  }
  const startIndex = Math.min(...hits);
  const endIndex = Math.max(...hits);
  const next = [...pieces];
  next.splice(startIndex, endIndex - startIndex + 1, ...out);
  if (text.length === 0 && collapse)
    collapseBlankLines(next, startIndex + (prefix ? 1 : 0));
  doc.pieces = normalizePieces(next, true);
  return outcome;
}

/**
 * When an edit or a decision removes a whole block, the blank lines on both
 * sides meet: collapse three or more line breaks at that junction to one blank
 * line, and only there.
 */
export function collapseBlankLines(pieces: Piece[], index: number): void {
  let refsBetween = false;
  let before = index - 1;
  while (before >= 0) {
    const piece = pieces[before] as Piece;
    if (piece.t === "text" && piece.s === "") before -= 1;
    else if (piece.t === "ref") {
      refsBetween = true;
      before -= 1;
    } else break;
  }
  let after = index;
  while (after < pieces.length) {
    const piece = pieces[after] as Piece;
    if (piece.t === "text" && piece.s === "") after += 1;
    else if (piece.t === "ref") {
      refsBetween = true;
      after += 1;
    } else break;
  }
  const left = pieces[before];
  const right = pieces[after];
  if (left?.t !== "text" || right?.t !== "text") return;
  const tail = left.s.match(/\s*$/)?.[0] ?? "";
  const head = right.s.match(/^\s*/)?.[0] ?? "";
  if (!tail.includes("\n") || !head.includes("\n")) return;
  if (((tail + head).match(/\n/g) ?? []).length < 3) return;
  // A standalone ref left at the junction keeps its own line.
  const breaks = (tail.match(/\n/g) ?? []).length;
  const kept = !refsBetween
    ? ""
    : breaks >= 2
      ? "\n\n"
      : breaks === 1
        ? "\n"
        : "";
  left.s = left.s.slice(0, left.s.length - tail.length) + kept;
  right.s = `\n\n${right.s.slice(head.length)}`;
}
