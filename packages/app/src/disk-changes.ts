// What an outside write changed, for the two notices (D5):
// - the quiet "Updated from disk: <what changed>" line;
// - the loud "An outside write removed text you saved" notice, with the
//   text this tab saved in the last five minutes that a write took away,
//   and its restore as a suggestion.
// Plain functions over Markdown strings; the sync controller calls them.

import {
  changesShape,
  diffSequences,
  normalizeRoughdraftMetadata,
  type RfmEndmatterEntry,
  splitRoughdraftDocument,
  stringifyRoughdraftEndmatter,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";

export const SAVED_TEXT_WINDOW_MS = 5 * 60 * 1000;

// --- "Updated from disk: ..." ----------------------------------------------

export interface DiskChangeSummary {
  // "2 replies added, text changed in Rollout"; "the file changed" when
  // nothing more specific can be said.
  summary: string;
  // The thread "show me" selects: the first reply's parent, else the first
  // resolved or added comment.
  commentId: string | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function stripReviewMarkup(text: string): string {
  return text
    .replace(/\{#[A-Za-z0-9_-]+\}/g, "")
    .replace(/\{(==|\+\+|--|~~)/g, "")
    .replace(/(==|\+\+|--|~~)\}/g, "")
    .replace(/~>/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function headingText(line: string): string | null {
  const match = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (!match) return null;
  const text = stripReviewMarkup(match[1] ?? "");
  return text || null;
}

function sectionOfLine(lines: string[], index: number): string | null {
  let inFence = false;
  let section: string | null = null;
  for (let line = 0; line <= Math.min(index, lines.length - 1); line += 1) {
    const text = lines[line] ?? "";
    if (/^ {0,3}(```|~~~)/.test(text)) inFence = !inFence;
    if (inFence) continue;
    const heading = headingText(text);
    if (heading) section = heading;
  }
  return section;
}

function entryString(entry: RfmEndmatterEntry | undefined, key: string) {
  const value = entry?.[key];
  return typeof value === "string" ? value : null;
}

export function describeDiskChange(
  before: string,
  after: string,
): DiskChangeSummary {
  const parts: string[] = [];
  let commentId: string | null = null;
  const previous = splitRoughdraftDocument(before);
  const next = splitRoughdraftDocument(after);

  let replies = 0;
  let comments = 0;
  let resolved = 0;
  let firstReplyParent: string | null = null;
  let firstResolved: string | null = null;
  let firstComment: string | null = null;
  for (const [id, entry] of next.entries.comments) {
    const old = previous.entries.comments.get(id);
    if (!old) {
      const parent = entryString(entry, "re");
      if (parent) {
        replies += 1;
        firstReplyParent ??= parent;
      } else {
        comments += 1;
        firstComment ??= id;
      }
      continue;
    }
    if (
      entryString(entry, "status") === "resolved" &&
      entryString(old, "status") !== "resolved"
    ) {
      resolved += 1;
      firstResolved ??= id;
    }
  }
  let suggestions = 0;
  for (const id of next.entries.suggestions.keys()) {
    if (!previous.entries.suggestions.has(id)) suggestions += 1;
  }
  if (replies > 0) parts.push(plural(replies, "reply added", "replies added"));
  if (comments > 0) {
    parts.push(plural(comments, "comment added", "comments added"));
  }
  if (resolved > 0) {
    parts.push(plural(resolved, "comment resolved", "comments resolved"));
  }
  if (suggestions > 0) {
    parts.push(plural(suggestions, "suggestion added", "suggestions added"));
  }

  const beforeLines = previous.body.split("\n");
  const afterLines = next.body.split("\n");
  const sections: string[] = [];
  let unsectioned = false;
  for (const hunk of diffSequences(beforeLines, afterLines)) {
    const changed = [
      ...beforeLines.slice(hunk.aStart, hunk.aEnd),
      ...afterLines.slice(hunk.bStart, hunk.bEnd),
    ];
    // Moving a review ref or a suggestion around is covered above.
    if (changed.every((line) => stripReviewMarkup(line) === "")) continue;
    // A removal has no lines on disk: the section is the one above the gap.
    const line = hunk.bEnd > hunk.bStart ? hunk.bStart : hunk.bStart - 1;
    const section = sectionOfLine(
      afterLines,
      Math.max(0, Math.min(line, afterLines.length - 1)),
    );
    if (!section) unsectioned = true;
    else if (!sections.includes(section)) sections.push(section);
  }
  if (sections.length === 1 && !unsectioned) {
    parts.push(`text changed in ${sections[0]}`);
  } else if (sections.length > 1) {
    parts.push(
      `text changed in ${sections[0]} and ${plural(
        sections.length - 1,
        "more section",
        "more sections",
      )}`,
    );
  } else if (sections.length === 1 || unsectioned) {
    parts.push("text changed");
  }

  if (
    parts.length === 0 &&
    (previous.frontmatter ?? "") !== (next.frontmatter ?? "")
  ) {
    parts.push("frontmatter changed");
  }

  commentId = firstReplyParent ?? firstResolved ?? firstComment;
  return {
    summary: parts.length > 0 ? parts.join(", ") : "the file changed",
    commentId,
  };
}

// --- Text this tab saved ---------------------------------------------------

// One body line this tab wrote, with the part of it the tab typed.
export interface SavedRun {
  line: string;
  start: number;
  end: number;
  savedAt: number;
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let index = 0;
  while (
    index < limit &&
    a.charCodeAt(a.length - 1 - index) === b.charCodeAt(b.length - 1 - index)
  ) {
    index += 1;
  }
  return index;
}

function bodyLines(markdown: string): string[] {
  return splitRoughdraftDocument(markdown).body.split("\n");
}

// After a save of `saved` on top of `previous`: the body lines the save
// wrote, each with the span this tab typed (merged with what earlier saves
// typed on the same line). Runs older than five minutes drop out.
export function recordSavedText(
  runs: SavedRun[],
  previous: string,
  saved: string,
  now: number,
): SavedRun[] {
  const recent = runs.filter((run) => now - run.savedAt < SAVED_TEXT_WINDOW_MS);
  const a = bodyLines(previous);
  const b = bodyLines(saved);
  const next = [...recent];
  for (const hunk of diffSequences(a, b)) {
    for (let index = hunk.bStart; index < hunk.bEnd; index += 1) {
      const line = b[index] ?? "";
      if (line.trim() === "") continue;
      const oldIndex = hunk.aStart + (index - hunk.bStart);
      const oldLine = oldIndex < hunk.aEnd ? (a[oldIndex] ?? null) : null;
      let start = 0;
      let end = line.length;
      if (oldLine !== null) {
        const prefix = commonPrefix(oldLine, line);
        const suffix = commonSuffix(oldLine, line, prefix);
        start = prefix;
        end = line.length - suffix;
        const earlier = next.findIndex((run) => run.line === oldLine);
        if (earlier >= 0) {
          const run = next[earlier] as SavedRun;
          const delta = line.length - oldLine.length;
          const oldChangeEnd = oldLine.length - suffix;
          const mappedStart =
            run.start <= prefix
              ? run.start
              : Math.max(prefix, run.start + delta);
          const mappedEnd =
            run.end <= prefix
              ? run.end
              : run.end >= oldChangeEnd
                ? run.end + delta
                : end;
          start = Math.min(start, mappedStart);
          end = Math.max(end, mappedEnd);
          next.splice(earlier, 1);
        }
      }
      if (end <= start) continue;
      next.push({ line, start, end, savedAt: now });
    }
  }
  return next;
}

export interface RemovedText {
  // The removed text, as it was on the saved line.
  text: string;
  // The saved line and where the text sat in it, to put it back.
  line: string;
  before: string;
  after: string;
  // The non-empty lines around the saved line, for a whole-line restore.
  previousLine: string | null;
  nextLine: string | null;
  whole: boolean;
}

function meaningful(text: string): boolean {
  const compact = stripReviewMarkup(text).replace(/\s+/g, "");
  return compact.length >= 6 && /[\p{L}\p{N}]/u.test(compact);
}

// Text this tab saved recently that an outside write took away: the saved
// line was in the base and still in the draft, and the merged draft no
// longer has the typed part.
export function findRemovedText(
  runs: SavedRun[],
  oldBase: string,
  oldDraft: string,
  nextDraft: string,
  now: number,
): RemovedText[] {
  const baseLines = bodyLines(oldBase);
  const draftLines = new Set(bodyLines(oldDraft));
  const nextLines = bodyLines(nextDraft);
  const nextSet = new Set(nextLines);
  const removed: RemovedText[] = [];
  for (const run of runs) {
    if (now - run.savedAt >= SAVED_TEXT_WINDOW_MS) continue;
    const baseIndex = baseLines.indexOf(run.line);
    if (baseIndex < 0 || !draftLines.has(run.line)) continue;
    if (nextSet.has(run.line)) continue;

    // The line that took its place, if any: the one sharing the most text.
    let bestPrefix = 0;
    let bestSuffix = 0;
    for (const candidate of nextLines) {
      const prefix = commonPrefix(run.line, candidate);
      const suffix = commonSuffix(run.line, candidate, prefix);
      if (prefix + suffix > bestPrefix + bestSuffix) {
        bestPrefix = prefix;
        bestSuffix = suffix;
      }
    }
    let goneStart = bestPrefix;
    let goneEnd = run.line.length - bestSuffix;
    if (bestPrefix + bestSuffix < 4) {
      goneStart = 0;
      goneEnd = run.line.length;
    }
    const start = Math.max(goneStart, run.start);
    const end = Math.min(goneEnd, run.end);
    if (end <= start) continue;
    const text = run.line.slice(start, end);
    if (!meaningful(text)) continue;
    // The text still sits somewhere else (the agent moved it).
    if (nextDraft.includes(text.trim())) continue;
    let previousLine: string | null = null;
    for (let index = baseIndex - 1; index >= 0; index -= 1) {
      const candidate = baseLines[index] ?? "";
      if (candidate.trim() !== "") {
        previousLine = candidate;
        break;
      }
    }
    let nextLine: string | null = null;
    for (let index = baseIndex + 1; index < baseLines.length; index += 1) {
      const candidate = baseLines[index] ?? "";
      if (candidate.trim() !== "") {
        nextLine = candidate;
        break;
      }
    }
    removed.push({
      text,
      line: run.line,
      before: run.line.slice(0, start),
      after: run.line.slice(end),
      previousLine,
      nextLine,
      whole: start === 0 && end === run.line.length,
    });
  }
  return removed;
}

// --- Restore as a suggestion -----------------------------------------------

const BLOCK_PREFIX =
  /^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*))/;
const DELIMITERS = /\{(==|\+\+|--|~~|>>|#)|(==|\+\+|--|~~|<<)\}|~>/;

function isCanonical(markdown: string): boolean {
  const normalized = normalizeRoughdraftMetadata(markdown);
  return normalized.refused.length === 0 && !changesShape(normalized.changes);
}

function nextSuggestionId(markdown: string): string {
  let max = 0;
  const pattern = /\{#s(\d+)\}|^\s+s(\d+):|continues:\s*"?s(\d+)/gm;
  for (const match of markdown.matchAll(pattern)) {
    const value = Number(match[1] ?? match[2] ?? match[3]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return `s${max + 1}`;
}

interface Placement {
  lineIndex: number;
  // Insert inside the line at this offset, or as a new paragraph after it
  // (before it when `before` is set).
  offset: number | null;
  before?: boolean;
}

function insertParagraph(
  lines: string[],
  placement: Placement,
  paragraph: string,
): string[] {
  const next = [...lines];
  if (placement.before) {
    next.splice(placement.lineIndex, 0, paragraph, "");
  } else {
    next.splice(placement.lineIndex + 1, 0, "", paragraph);
  }
  return next;
}

function findPlacement(lines: string[], removed: RemovedText): Placement {
  const before = removed.before.slice(-24);
  const after = removed.after.slice(0, 24);
  if (!removed.whole) {
    const candidates: Placement[] = [];
    lines.forEach((line, lineIndex) => {
      if (before && after) {
        const at = line.indexOf(before + after);
        if (at >= 0) candidates.push({ lineIndex, offset: at + before.length });
      }
    });
    if (candidates.length === 0) {
      lines.forEach((line, lineIndex) => {
        if (before) {
          const at = line.indexOf(before);
          if (at >= 0) {
            candidates.push({ lineIndex, offset: at + before.length });
          }
        } else if (after) {
          const at = line.indexOf(after);
          if (at >= 0) candidates.push({ lineIndex, offset: at });
        }
      });
    }
    const first = candidates[0];
    if (first) return first;
  }
  if (removed.previousLine !== null) {
    const index = lines.lastIndexOf(removed.previousLine);
    if (index >= 0) return { lineIndex: index, offset: null };
  }
  if (removed.nextLine !== null) {
    const index = lines.indexOf(removed.nextLine);
    if (index >= 0) return { lineIndex: index, offset: null, before: true };
  }
  let last = lines.length - 1;
  while (last > 0 && (lines[last] ?? "").trim() === "") last -= 1;
  return { lineIndex: last, offset: null };
}

// Puts removed text back into `markdown` as Jordan's insertion suggestion
// (`{++text++}{#sN}` plus an `sN` entry by user), so the agent sees it as a
// proposal instead of a silent revert. An older-format file gets the text
// back as plain text (D11: nothing converts on save).
export function restoreRemovedText(
  markdown: string,
  removed: RemovedText,
  now: string,
): string {
  const split = splitRoughdraftDocument(markdown);
  const lines = split.body.split("\n");
  const placement = findPlacement(lines, removed);
  const suggestible =
    (split.status === "recognized" || split.status === "absent") &&
    !DELIMITERS.test(removed.text) &&
    removed.text.trim() !== "" &&
    isCanonical(markdown);
  const id = nextSuggestionId(markdown);
  const mark = (text: string) => {
    if (!suggestible) return text;
    // Spaces at the edges stay outside the marker.
    const lead = /^\s*/.exec(text)?.[0] ?? "";
    const trail = /\s*$/.exec(text)?.[0] ?? "";
    const core = text.slice(lead.length, text.length - trail.length);
    return `${lead}{++${core}++}{#${id}}${trail}`;
  };

  const plainBody = placeText(lines, placement, removed, (text) => text);
  if (!suggestible) {
    return (split.frontmatter ?? "") + plainBody + (split.endmatter ?? "");
  }

  let body = placeText(lines, placement, removed, mark);
  const suggestions = new Map(split.entries.suggestions);
  suggestions.set(id, { by: "user", at: now });
  const endmatter = stringifyRoughdraftEndmatter({
    comments: split.entries.comments,
    suggestions,
    extra: split.entries.extra,
  });
  if (split.status === "absent") {
    body = body.endsWith("\n\n")
      ? body
      : body.endsWith("\n")
        ? `${body}\n`
        : `${body}\n\n`;
  }
  const result = (split.frontmatter ?? "") + body + endmatter;

  const before = validateRoughdraftMarkdown(markdown);
  const after = validateRoughdraftMarkdown(result);
  if (
    after.errors.length > before.errors.length ||
    after.summary.suggestions !== before.summary.suggestions + 1
  ) {
    // Something about this spot cannot hold a suggestion: put the text back
    // plain rather than not at all.
    return (split.frontmatter ?? "") + plainBody + (split.endmatter ?? "");
  }
  return result;
}

function placeText(
  lines: string[],
  placement: Placement,
  removed: RemovedText,
  mark: (text: string) => string,
): string {
  if (placement.offset !== null) {
    const next = [...lines];
    const line = next[placement.lineIndex] ?? "";
    next[placement.lineIndex] =
      line.slice(0, placement.offset) +
      mark(removed.text) +
      line.slice(placement.offset);
    return next.join("\n");
  }
  // A whole line: list markers, heading hashes and quote markers stay
  // outside the suggestion.
  const prefix = BLOCK_PREFIX.exec(removed.text)?.[1] ?? "";
  const paragraph = prefix + mark(removed.text.slice(prefix.length));
  return insertParagraph(lines, placement, paragraph).join("\n");
}
