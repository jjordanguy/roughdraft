// Three-way merge of a whole review document: the tab's draft (`ours`) onto
// what is on disk now (`theirs`), both descended from `base`. Pure, so the
// browser, the server and the CLI can share it.
//
// 1. Shortcuts when a side is unchanged.
// 2. Review ids both sides added (each picked the next free `cN`) are
//    re-keyed on `ours`: refs and markers in the prose, entry keys, `re` and
//    `continues`.
// 3. Spacing the browser's writer normalizes (blank-line runs, blank lines
//    around headings, `*` and `+` bullets) is applied to base and theirs when
//    ours shows it, so a normalization is not an edit.
// 4. The review block merges by id (`mergeReviewEntries`); the frontmatter as
//    one unit; the body by line with diff3. Where both sides changed the same
//    lines, a token-level diff3 runs inside the hunk: edits to different
//    words both land. What still overlaps in plain prose becomes a suggestion
//    from `ours` against `theirs` (`by: user`); an overlap inside review
//    markup or code is a conflict hunk.
// 5. The result is read back: no new errors, every id from both inputs still
//    there, canonical when both inputs were, and every added suggestion reads
//    back as written. Any failure turns the merge into a document conflict.
import { type Diff3Region, diff3Merge } from "./diff3.js";
import { buildReviewDoc, FORMATTING_CHANGES } from "./document.js";
import { mergeReviewEntries, type RfmMergeConflict } from "./merge.js";
import { parseReviewModel, type RfmReviewModel } from "./model.js";
import { normalizeRoughdraftMetadata } from "./normalize.js";
import type { RfmEndmatterEntry } from "./split.js";
import { stringifyRoughdraftEndmatter } from "./writer.js";

/** How a conflict hunk is settled when the merge runs again with `resolutions`. */
export type RfmMergeChoice = "suggestion" | "ours" | "theirs";

export type RfmConflictReason =
  /** Both sides changed the same review markup, or prose right against it. */
  | "markup-overlap"
  /** Both sides changed the same lines inside a fenced code block. */
  | "code-overlap"
  /** Overlapping prose in a file in an older review format: no suggestion can be added to it. */
  | "older-format"
  /** Overlapping prose that cannot be written as a suggestion (a changed list marker, delimiter characters, a line ending). */
  | "not-suggestable"
  /** Both sides changed the frontmatter differently. */
  | "frontmatter"
  /** Both sides changed the same key of a review entry, or one removed an entry the other changed. */
  | "entry"
  /** A review block that cannot be read. */
  | "review-block-unreadable"
  /** The merged document does not read back cleanly. */
  | "result-invalid"
  /** A review id from one of the inputs is missing from the merge. */
  | "id-lost";

export interface RfmConflictHunk {
  /** `h1`, `h2`, ... in document order (frontmatter, body, entries); `document` for a whole-document conflict. Stable for the same three inputs. */
  id: string;
  kind: "frontmatter" | "body" | "entry" | "document";
  reason: RfmConflictReason;
  message: string;
  /** What `resolutions[id]` may say for this hunk. */
  choices: RfmMergeChoice[];
  /** Frontmatter and body hunks: the lines on each side, joined with line breaks. */
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** Body hunks: 1-based first line of the hunk in each document (after spacing normalization). */
  lines: { ours: number; theirs: number } | null;
  /** Entry hunks: the review-block key both sides changed. */
  entry: RfmMergeConflict | null;
}

/** The contract's name for a conflict hunk. */
export type ConflictHunk = RfmConflictHunk;

export interface RfmMergeReviewOptions {
  /** `at` of the suggestions the merge adds. Default: now. */
  now?: string;
  /** `by` of the suggestions the merge adds. Default `user`. */
  author?: string;
  /** Settle conflict hunks from an earlier run on the same three inputs, by hunk id. */
  resolutions?: Record<string, RfmMergeChoice>;
}

export interface RfmMergeReviewResult {
  /**
   * The merged document. With conflicts, unsettled hunks keep `ours` (entry
   * keys too), and a `document` conflict returns `ours` unchanged: callers
   * keep their draft and show the hunks.
   */
  merged: string;
  conflicts: RfmConflictHunk[];
  /** Ids of the suggestions the merge wrote (overlapping edits from `ours`). */
  suggestionsAdded: string[];
  /** Ids `ours` added that `theirs` also used, and what they became. */
  rekeyed: Record<string, string>;
}

type EntryMaps = {
  comments: Map<string, RfmEndmatterEntry>;
  suggestions: Map<string, RfmEndmatterEntry>;
  extra: Map<string, unknown>;
};

interface Side {
  text: string;
  model: RfmReviewModel;
  frontmatter: string;
  /** Body lines with the trailing blank lines cut. */
  lines: string[];
  /** The trailing blank lines that were cut. */
  tail: string;
  endmatter: string;
  entries: EntryMaps;
  hasBlock: boolean;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function entriesSame(a: EntryMaps, b: EntryMaps): boolean {
  return (
    same([...a.comments], [...b.comments]) &&
    same([...a.suggestions], [...b.suggestions]) &&
    same([...a.extra], [...b.extra])
  );
}

// ------------------------------------------------------------- ids

/** Every review id a document uses: entries, markers, refs, fence refs. */
function idSet(model: RfmReviewModel): Set<string> {
  const ids = new Set<string>(model.ids);
  for (const id of model.split.entries.comments.keys()) ids.add(id);
  for (const id of model.split.entries.suggestions.keys()) ids.add(id);
  for (const run of model.markup) {
    if (run.id) ids.add(run.id);
    for (const item of run.tail) if (item.id) ids.add(item.id);
  }
  return ids;
}

function freshId(id: string, taken: Set<string>): string {
  const match = /^(.*?)(\d+)$/.exec(id);
  const prefix = match ? (match[1] ?? "") : `${id}-`;
  let max = 0;
  for (const other of taken) {
    if (!other.startsWith(prefix)) continue;
    const rest = other.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

/** What makes an item the same item on both sides: its entry and its anchor text. */
function itemSignature(model: RfmReviewModel, id: string): string | null {
  const item = model.byId.get(id);
  if (!item) return null;
  const entry =
    model.split.entries.comments.get(id) ??
    model.split.entries.suggestions.get(id) ??
    null;
  if ("suggestionKind" in item) {
    return JSON.stringify([
      entry,
      item.suggestionKind,
      item.originalText ?? null,
      item.replacementText ?? null,
    ]);
  }
  return JSON.stringify([
    entry,
    item.body,
    item.parentId,
    item.anchors.map((anchor) => anchor.text),
  ]);
}

/** Rename ids inside the review markup of a body (refs, marker metadata, attribute blocks). */
function renameInBody(
  model: RfmReviewModel,
  renames: Map<string, string>,
): string {
  const body = model.split.body;
  const base = model.split.bodyOffset;
  const spans: Array<[number, number]> = [];
  for (const run of model.markup) {
    if (
      run.type === "suggestion" &&
      run.markerEnd !== null &&
      run.metadataEnd !== null
    ) {
      spans.push([run.markerEnd, run.metadataEnd]);
    }
    if (run.type === "fence-ref") spans.push([run.offset, run.endOffset]);
    for (const item of run.tail) spans.push([item.offset, item.endOffset]);
  }
  spans.sort((a, b) => b[0] - a[0]);
  let out = body;
  for (const [start, end] of spans) {
    const from = start - base;
    const to = end - base;
    if (from < 0 || to > body.length) continue;
    const piece = out
      .slice(from, to)
      .replace(/\{#([^}\s]+)\}/g, (whole, id: string) =>
        renames.has(id) ? `{#${renames.get(id)}}` : whole,
      )
      .replace(
        /\b(id|re|continues)="([^"]*)"/g,
        (whole, key: string, id: string) =>
          renames.has(id) ? `${key}="${renames.get(id)}"` : whole,
      );
    out = out.slice(0, from) + piece + out.slice(to);
  }
  return out;
}

function renameEntries(
  entries: EntryMaps,
  renames: Map<string, string>,
): EntryMaps {
  const section = (map: Map<string, RfmEndmatterEntry>) => {
    const out = new Map<string, RfmEndmatterEntry>();
    for (const [id, entry] of map) {
      const copy: RfmEndmatterEntry = { ...entry };
      for (const key of ["re", "continues"]) {
        const value = copy[key];
        if (typeof value === "string" && renames.has(value)) {
          copy[key] = renames.get(value);
        }
      }
      out.set(renames.get(id) ?? id, copy);
    }
    return out;
  };
  return {
    comments: section(entries.comments),
    suggestions: section(entries.suggestions),
    extra: new Map(entries.extra),
  };
}

// ------------------------------------------------------------- sides

function cutTail(body: string): { core: string; tail: string } {
  const match = /(?:\r?\n[ \t]*)*$/.exec(body);
  const tail = match ? match[0] : "";
  return { core: body.slice(0, body.length - tail.length), tail };
}

function sideOf(text: string, model: RfmReviewModel, body: string): Side {
  const { core, tail } = cutTail(body);
  return {
    text,
    model,
    frontmatter: model.split.frontmatter ?? "",
    lines: core === "" ? [] : core.split("\n"),
    tail,
    endmatter: model.split.endmatter ?? "",
    entries: {
      comments: new Map(model.split.entries.comments),
      suggestions: new Map(model.split.entries.suggestions),
      extra: new Map(model.split.entries.extra),
    },
    hasBlock: model.split.status === "recognized",
  };
}

/** True when the canonical writer would leave the review data's shape alone. */
function isCanonicalShape(markdown: string): boolean {
  const built = buildReviewDoc(markdown);
  return (
    built.doc !== null &&
    built.refused.length === 0 &&
    built.changes.every((change) => FORMATTING_CHANGES.has(change.code))
  );
}

// ------------------------------------------------------------- code lines

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Per line: a fence line or a line inside a fenced block. */
function codeFlags(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = FENCE_OPEN.exec(line);
    if (fence === null) {
      if (
        match &&
        !(match[1]?.startsWith("`") && /`/.test(line.slice(match[0].length)))
      ) {
        fence = match[1] ?? null;
        flags.push(true);
        continue;
      }
      flags.push(false);
      continue;
    }
    flags.push(true);
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
    const marker = close?.[1];
    if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  }
  return flags;
}

// ------------------------------------------------------------- spacing rules

const HEADING = /^#{1,6} /;
const THEMATIC = /^[ \t]*([*+-])(?:[ \t]*\1){2,}[ \t]*$/;
const STAR_BULLET = /^([ \t]*)[*+]([ \t]+)(?=\S)/;

type Rule = (lines: string[]) => string[];

/** Runs of empty lines outside code become one. */
const collapseBlankRuns: Rule = (lines) => {
  const code = codeFlags(lines);
  return lines.filter(
    (line, index) =>
      !(
        line === "" &&
        !code[index] &&
        index > 0 &&
        lines[index - 1] === "" &&
        !code[index - 1]
      ),
  );
};

/** No empty line right before or after an ATX heading outside code. */
const tightHeadings: Rule = (lines) => {
  const code = codeFlags(lines);
  const drop = new Set<number>();
  lines.forEach((line, index) => {
    if (code[index] || !HEADING.test(line)) return;
    if (index > 1 && lines[index - 1] === "" && !code[index - 1])
      drop.add(index - 1);
    if (index + 1 < lines.length && lines[index + 1] === "" && !code[index + 1])
      drop.add(index + 1);
  });
  return lines.filter((_, index) => !drop.has(index));
};

/** `*` and `+` bullets outside code become `-`. */
const dashBullets: Rule = (lines) => {
  const code = codeFlags(lines);
  return lines.map((line, index) =>
    code[index] || THEMATIC.test(line)
      ? line
      : line.replace(STAR_BULLET, "$1-$2"),
  );
};

const SPACING_RULES: Rule[] = [collapseBlankRuns, tightHeadings, dashBullets];

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * Apply each spacing rule the browser's writer applies to base and theirs,
 * but only when ours already follows it and base does not (that is, the
 * browser normalized ours). Returns the rules applied.
 */
function normalizeSpacing(base: Side, ours: Side, theirs: Side): number {
  let applied = 0;
  for (const rule of SPACING_RULES) {
    if (!sameLines(rule(ours.lines), ours.lines)) continue;
    const next = rule(base.lines);
    if (sameLines(next, base.lines)) continue;
    base.lines = next;
    theirs.lines = rule(theirs.lines);
    applied += 1;
  }
  return applied;
}

// ------------------------------------------------------------- tokens

interface Token {
  text: string;
  markup: boolean;
}

const TOKEN =
  /\{==[\s\S]*?==\}|\{\+\+[\s\S]*?\+\+\}|\{--[\s\S]*?--\}|\{~~[\s\S]*?~~\}|\{>>[\s\S]*?<<\}|\{#[^}\s]*\}|\{@[\s\S]*?@\}|\{[^{}\n]*\bid="[^"\n]*"[^{}\n]*\}|\r?\n|[ \t]+|[\p{L}\p{N}_]+|[\s\S]/gu;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const value = match[0];
    tokens.push({
      text: value,
      markup: value.length > 2 && value.startsWith("{") && value.endsWith("}"),
    });
  }
  return tokens;
}

// ------------------------------------------------------------- suggestions

const BLOCK_PREFIX =
  /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+))*/;
const DELIMITERS =
  /\{(?:==|\+\+|--|~~|>>|#|@)|==\}|\+\+\}|--\}|~~\}|<<\}|~>|\r/;

type Part =
  | { plain: string }
  | {
      kind: "addition" | "deletion" | "substitution";
      old: string;
      new: string;
    };

function markerFor(old: string, neu: string): Part[] | null {
  if (old === neu) return [{ plain: neu }];
  // Common whitespace at either end stays outside the marker.
  let lead = 0;
  while (
    lead < old.length &&
    lead < neu.length &&
    old[lead] === neu[lead] &&
    /[ \t]/.test(old[lead] ?? "")
  )
    lead += 1;
  let trail = 0;
  while (
    trail < old.length - lead &&
    trail < neu.length - lead &&
    old[old.length - 1 - trail] === neu[neu.length - 1 - trail] &&
    /[ \t]/.test(old[old.length - 1 - trail] ?? "")
  )
    trail += 1;
  const o = old.slice(lead, old.length - trail);
  const n = neu.slice(lead, neu.length - trail);
  const parts: Part[] = [];
  if (lead) parts.push({ plain: old.slice(0, lead) });
  if (!o.trim() && !n.trim()) {
    parts.push({ plain: n });
  } else if (!o.trim()) {
    if (o) parts.push({ plain: o });
    if (n.endsWith("+")) return null;
    parts.push({ kind: "addition", old: "", new: n });
  } else if (!n.trim()) {
    if (o.endsWith("-")) return null;
    parts.push({ kind: "deletion", old: o, new: "" });
    if (n) parts.push({ plain: n });
  } else {
    if (o.endsWith("~") || n.endsWith("~")) return null;
    parts.push({ kind: "substitution", old: o, new: n });
  }
  if (trail) parts.push({ plain: old.slice(old.length - trail) });
  return parts;
}

/**
 * The parts that write `neu` (ours) as a suggestion against `old` (theirs).
 * One marker per line (the canonical shape); a block prefix stays outside
 * the marker and must be the same on both sides. Null when it cannot be
 * written as a suggestion.
 */
function suggestionParts(
  old: string,
  neu: string,
  atLineStart: boolean,
): Part[] | null {
  if (DELIMITERS.test(old) || DELIMITERS.test(neu)) return null;
  const oldLines = old.split("\n");
  const newLines = neu.split("\n");
  const parts: Part[] = [];
  const prefixed = (line: string, index: number) => {
    if (index === 0 && !atLineStart) return { prefix: "", rest: line };
    const prefix = line.match(BLOCK_PREFIX)?.[0] ?? "";
    return { prefix, rest: line.slice(prefix.length) };
  };
  if (oldLines.length === newLines.length) {
    for (let index = 0; index < oldLines.length; index += 1) {
      if (index > 0) parts.push({ plain: "\n" });
      const o = prefixed(oldLines[index] ?? "", index);
      const n = prefixed(newLines[index] ?? "", index);
      if (o.prefix !== n.prefix) return null;
      if (o.prefix) parts.push({ plain: o.prefix });
      const line = markerFor(o.rest, n.rest);
      if (!line) return null;
      parts.push(...line);
    }
    return parts;
  }
  // Different line counts: theirs' lines as deletions, then ours' lines as
  // additions. Line breaks stay plain text.
  oldLines.forEach((line, index) => {
    if (index > 0) parts.push({ plain: "\n" });
    const o = prefixed(line, index);
    if (o.prefix) parts.push({ plain: o.prefix });
    if (o.rest.trim()) parts.push({ kind: "deletion", old: o.rest, new: "" });
    else parts.push({ plain: o.rest });
  });
  newLines.forEach((line, index) => {
    if (index > 0) parts.push({ plain: "\n" });
    const n = index === 0 ? { prefix: "", rest: line } : prefixed(line, index);
    if (n.prefix) parts.push({ plain: n.prefix });
    if (n.rest.trim()) parts.push({ kind: "addition", old: "", new: n.rest });
    else parts.push({ plain: n.rest });
  });
  for (const part of parts) {
    if ("kind" in part && part.kind === "deletion" && part.old.endsWith("-"))
      return null;
    if ("kind" in part && part.kind === "addition" && part.new.endsWith("+"))
      return null;
  }
  return parts;
}

function markerSource(part: Exclude<Part, { plain: string }>): string {
  if (part.kind === "addition") return `{++${part.new}++}`;
  if (part.kind === "deletion") return `{--${part.old}--}`;
  return `{~~${part.old}~>${part.new}~~}`;
}

// ------------------------------------------------------------- the merge

interface PendingSuggestion {
  id: string;
  kind: "addition" | "deletion" | "substitution";
  old: string;
  new: string;
  continues: string | null;
}

class SuggestionWriter {
  readonly added: PendingSuggestion[] = [];
  constructor(private readonly taken: Set<string>) {}

  write(parts: Part[]): string {
    let text = "";
    let first: string | null = null;
    for (const part of parts) {
      if ("plain" in part) {
        text += part.plain;
        continue;
      }
      const id = freshId("s1", this.taken);
      this.taken.add(id);
      this.added.push({
        id,
        kind: part.kind,
        old: part.old,
        new: part.new,
        continues: first,
      });
      first ??= id;
      text += `${markerSource(part)}{#${id}}`;
    }
    return text;
  }
}

interface HunkOutcome {
  lines: string[];
  conflict: Omit<RfmConflictHunk, "id"> | null;
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/** Settle one region where both sides changed the same lines. */
function settleRegion(
  region: Extract<Diff3Region, { stable: false }>,
  context: {
    canSuggest: boolean;
    code: { base: boolean[]; ours: boolean[]; theirs: boolean[] };
    writer: SuggestionWriter;
    choice: RfmMergeChoice | undefined;
    linesBefore: number;
  },
): HunkOutcome {
  const { choice } = context;
  const lines = {
    ours: context.linesBefore + region.oursStart + 1,
    theirs: context.linesBefore + region.theirsStart + 1,
  };
  const texts = {
    base: joinLines(region.base),
    ours: joinLines(region.ours),
    theirs: joinLines(region.theirs),
  };
  if (choice === "ours") return { lines: region.ours, conflict: null };
  if (choice === "theirs") return { lines: region.theirs, conflict: null };

  const conflict = (
    reason: RfmConflictReason,
    message: string,
  ): HunkOutcome => ({
    lines: region.ours,
    conflict: {
      kind: "body",
      reason,
      message,
      choices: ["ours", "theirs"],
      ...texts,
      lines,
      entry: null,
    },
  });

  const anyCode =
    context.code.base.slice(region.baseStart, region.baseEnd).some(Boolean) ||
    context.code.ours.slice(region.oursStart, region.oursEnd).some(Boolean) ||
    context.code.theirs
      .slice(region.theirsStart, region.theirsEnd)
      .some(Boolean);
  if (anyCode) {
    return conflict(
      "code-overlap",
      `Both versions changed the same lines of a code block (line ${lines.theirs} on disk).`,
    );
  }

  // Inside the hunk, merge by token: edits to different words both land.
  const tokens = {
    base: tokenize(texts.base),
    ours: tokenize(texts.ours),
    theirs: tokenize(texts.theirs),
  };
  const inner = diff3Merge(
    tokens.base.map((token) => token.text),
    tokens.ours.map((token) => token.text),
    tokens.theirs.map((token) => token.text),
  );
  const markupAt = (list: Token[], index: number) =>
    list[index]?.markup === true;

  let text = "";
  const pieces: Array<string | Part[]> = [];
  let blocked: { reason: RfmConflictReason; message: string } | null = null;
  for (const part of inner) {
    if (part.stable) {
      const value = part.lines.join("");
      pieces.push(value);
      text += value;
      continue;
    }
    const touchesMarkup =
      tokens.base.slice(part.baseStart, part.baseEnd).some((t) => t.markup) ||
      tokens.ours.slice(part.oursStart, part.oursEnd).some((t) => t.markup) ||
      tokens.theirs
        .slice(part.theirsStart, part.theirsEnd)
        .some((t) => t.markup) ||
      markupAt(tokens.ours, part.oursStart - 1) ||
      markupAt(tokens.ours, part.oursEnd) ||
      markupAt(tokens.theirs, part.theirsStart - 1) ||
      markupAt(tokens.theirs, part.theirsEnd);
    const old = part.theirs.join("");
    const neu = part.ours.join("");
    if (touchesMarkup) {
      blocked ??= {
        reason: "markup-overlap",
        message: `Both versions changed the same review markup (line ${lines.theirs} on disk); it cannot hold a suggestion.`,
      };
    } else if (!context.canSuggest) {
      blocked ??= {
        reason: "older-format",
        message: `Both versions changed the same text (line ${lines.theirs} on disk), and this file uses an older review format, so the overlap cannot be kept as a suggestion.`,
      };
    }
    const atLineStart = text === "" || text.endsWith("\n");
    const parts = blocked ? null : suggestionParts(old, neu, atLineStart);
    if (!blocked && !parts) {
      blocked = {
        reason: "not-suggestable",
        message: `Both versions changed the same text (line ${lines.theirs} on disk) in a way a suggestion cannot hold.`,
      };
    }
    pieces.push(parts ?? []);
    text += neu;
  }
  if (blocked) return conflict(blocked.reason, blocked.message);

  let merged = "";
  for (const piece of pieces) {
    merged += typeof piece === "string" ? piece : context.writer.write(piece);
  }
  return { lines: merged.split("\n"), conflict: null };
}

function documentConflict(
  ours: string,
  reason: RfmConflictReason,
  message: string,
): RfmMergeReviewResult {
  return {
    merged: ours,
    conflicts: [
      {
        id: "document",
        kind: "document",
        reason,
        message,
        choices: ["ours", "theirs"],
        base: null,
        ours: null,
        theirs: null,
        lines: null,
        entry: null,
      },
    ],
    suggestionsAdded: [],
    rekeyed: {},
  };
}

function errorCounts(model: RfmReviewModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of model.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return counts;
}

/**
 * Merge the tab's draft (`ours`) onto the file on disk (`theirs`), both made
 * from `base`. See the top of this file for the steps. Pure: `options.now`
 * pins the `at` of added suggestions.
 */
export function mergeReview(
  base: string,
  ours: string,
  theirs: string,
  options: RfmMergeReviewOptions = {},
): RfmMergeReviewResult {
  const quiet = { conflicts: [], suggestionsAdded: [], rekeyed: {} };
  if (ours === base || ours === theirs) {
    return { merged: ours === base ? theirs : ours, ...quiet };
  }
  if (theirs === base) return { merged: ours, ...quiet };
  const resolutions = options.resolutions ?? {};
  if (resolutions.document === "ours") return { merged: ours, ...quiet };
  if (resolutions.document === "theirs") return { merged: theirs, ...quiet };

  const models = {
    base: parseReviewModel(base),
    ours: parseReviewModel(ours),
    theirs: parseReviewModel(theirs),
  };
  for (const [name, model] of Object.entries(models)) {
    if (model.split.status === "invalid") {
      return documentConflict(
        ours,
        "review-block-unreadable",
        `The review block of the ${name === "theirs" ? "file on disk" : name === "ours" ? "draft" : "last saved version"} cannot be read, so the two versions cannot be merged.`,
      );
    }
  }

  // Ids both sides added: re-key ours.
  const ids = {
    base: idSet(models.base),
    ours: idSet(models.ours),
    theirs: idSet(models.theirs),
  };
  const taken = new Set([...ids.base, ...ids.ours, ...ids.theirs]);
  const renames = new Map<string, string>();
  for (const id of ids.ours) {
    if (ids.base.has(id) || !ids.theirs.has(id)) continue;
    // The same item on both sides (same entry, same text) keeps its id.
    const mine = itemSignature(models.ours, id);
    if (mine !== null && mine === itemSignature(models.theirs, id)) continue;
    const fresh = freshId(id, taken);
    taken.add(fresh);
    renames.set(id, fresh);
  }

  const sides = {
    base: sideOf(base, models.base, models.base.split.body),
    ours: sideOf(
      ours,
      models.ours,
      renames.size > 0
        ? renameInBody(models.ours, renames)
        : models.ours.split.body,
    ),
    theirs: sideOf(theirs, models.theirs, models.theirs.split.body),
  };
  if (renames.size > 0) {
    sides.ours.entries = renameEntries(sides.ours.entries, renames);
  }
  normalizeSpacing(sides.base, sides.ours, sides.theirs);

  const canSuggest = isCanonicalShape(ours) && isCanonicalShape(theirs);
  const writer = new SuggestionWriter(taken);
  const conflicts: RfmConflictHunk[] = [];
  let hunkCount = 0;
  const nextHunkId = () => {
    hunkCount += 1;
    return `h${hunkCount}`;
  };

  // Frontmatter: one unit.
  let frontmatter = sides.ours.frontmatter;
  const fm = {
    base: sides.base.frontmatter,
    ours: sides.ours.frontmatter,
    theirs: sides.theirs.frontmatter,
  };
  if (fm.ours === fm.base) frontmatter = fm.theirs;
  else if (fm.theirs !== fm.base && fm.theirs !== fm.ours) {
    const id = nextHunkId();
    const choice = resolutions[id];
    if (choice === "theirs") frontmatter = fm.theirs;
    else if (choice !== "ours") {
      conflicts.push({
        id,
        kind: "frontmatter",
        reason: "frontmatter",
        message: "Both versions changed the frontmatter.",
        choices: ["ours", "theirs"],
        ...fm,
        lines: null,
        entry: null,
      });
    }
  }

  // Body: line diff3, then token diff3 inside overlapping hunks.
  const code = {
    base: codeFlags(sides.base.lines),
    ours: codeFlags(sides.ours.lines),
    theirs: codeFlags(sides.theirs.lines),
  };
  const linesBefore = frontmatter.split("\n").length - 1;
  const bodyLines: string[] = [];
  for (const region of diff3Merge(
    sides.base.lines,
    sides.ours.lines,
    sides.theirs.lines,
  )) {
    if (region.stable) {
      bodyLines.push(...region.lines);
      continue;
    }
    const id = nextHunkId();
    const choice = resolutions[id];
    const outcome = settleRegion(region, {
      canSuggest,
      code,
      writer,
      choice,
      linesBefore,
    });
    bodyLines.push(...outcome.lines);
    if (outcome.conflict) conflicts.push({ id, ...outcome.conflict });
  }

  // Review block: union by id, key by key.
  const entryMerge = mergeReviewEntries(
    sides.base.entries,
    sides.ours.entries,
    sides.theirs.entries,
  );
  const entries = entryMerge.entries;
  for (const conflict of entryMerge.conflicts) {
    const id = nextHunkId();
    const choice = resolutions[id];
    const section = entries[conflict.section] as Map<string, unknown>;
    if (choice === "theirs") {
      if (conflict.key === null) {
        if (conflict.theirs === undefined) section.delete(conflict.id);
        else section.set(conflict.id, conflict.theirs);
      } else {
        const entry = {
          ...((section.get(conflict.id) as RfmEndmatterEntry) ?? {}),
        };
        if (conflict.theirs === undefined) delete entry[conflict.key];
        else entry[conflict.key] = conflict.theirs;
        section.set(conflict.id, entry);
      }
      continue;
    }
    if (choice === "ours") continue;
    conflicts.push({
      id,
      kind: "entry",
      reason: "entry",
      message:
        conflict.key === null
          ? `${conflict.id} was removed in one version and changed in the other.`
          : `Both versions changed \`${conflict.key}\` of ${conflict.id}.`,
      choices: ["ours", "theirs"],
      base: null,
      ours: null,
      theirs: null,
      lines: null,
      entry: conflict,
    });
  }
  for (const suggestion of writer.added) {
    const entry: RfmEndmatterEntry = {
      by: options.author ?? "user",
      at: options.now ?? new Date().toISOString(),
    };
    if (suggestion.continues) entry.continues = suggestion.continues;
    entries.suggestions.set(suggestion.id, entry);
  }

  // Assemble.
  let endmatter: string;
  if (renames.size === 0 && writer.added.length === 0) {
    if (entriesSame(entries, sides.theirs.entries))
      endmatter = sides.theirs.endmatter;
    else if (entriesSame(entries, sides.ours.entries))
      endmatter = sides.ours.endmatter;
    else endmatter = stringifyRoughdraftEndmatter(entries);
  } else {
    endmatter = stringifyRoughdraftEndmatter(entries);
  }
  const tails = {
    base: sides.base.tail,
    ours: sides.ours.tail,
    theirs: sides.theirs.tail,
  };
  let tail = tails.ours === tails.base ? tails.theirs : tails.ours;
  if (endmatter) {
    if (canSuggest || !/\n[ \t]*\n/.test(tail)) tail = "\n\n";
  } else if (sides.ours.hasBlock || sides.theirs.hasBlock) {
    tail = bodyLines.length > 0 ? "\n" : "";
  }
  let merged = frontmatter + bodyLines.join("\n") + tail + endmatter;

  // Read the result back.
  const model = parseReviewModel(merged);
  const before = [errorCounts(models.ours), errorCounts(models.theirs)];
  for (const [codeName, count] of errorCounts(model)) {
    const allowed = Math.max(
      ...before.map((counts) => counts.get(codeName) ?? 0),
    );
    if (count > allowed) {
      return documentConflict(
        ours,
        "result-invalid",
        `The merged document has a new problem (${codeName}); keep one version.`,
      );
    }
  }
  const mergedIds = idSet(model);
  const oursIds = new Set([...ids.ours].map((id) => renames.get(id) ?? id));
  const required = [...new Set([...oursIds, ...ids.theirs])].filter(
    (id) => !ids.base.has(id) || (oursIds.has(id) && ids.theirs.has(id)),
  );
  const lost = required.filter((id) => !mergedIds.has(id));
  if (lost.length > 0) {
    return documentConflict(
      ours,
      "id-lost",
      `Merging would drop ${lost.join(", ")}; keep one version.`,
    );
  }
  for (const suggestion of writer.added) {
    const found = model.suggestions.find((item) => item.id === suggestion.id);
    const readsBack =
      found !== undefined &&
      found.suggestionKind === suggestion.kind &&
      found.parts.length === 1 &&
      (suggestion.kind === "addition" ||
        found.originalText === suggestion.old) &&
      (suggestion.kind === "deletion" ||
        found.replacementText === suggestion.new) &&
      found.continues === suggestion.continues;
    if (!readsBack) {
      return documentConflict(
        ours,
        "result-invalid",
        `The suggestion ${suggestion.id} the merge wrote does not read back; keep one version.`,
      );
    }
  }
  if (canSuggest) {
    const normalized = normalizeRoughdraftMetadata(merged);
    if (
      normalized.refused.length > 0 ||
      normalized.changes.some((change) => !FORMATTING_CHANGES.has(change.code))
    ) {
      return documentConflict(
        ours,
        "result-invalid",
        "The merged document is not in the canonical review shape; keep one version.",
      );
    }
    merged = normalized.markdown;
  }

  return {
    merged,
    conflicts,
    suggestionsAdded: writer.added.map((suggestion) => suggestion.id),
    rekeyed: Object.fromEntries(renames),
  };
}
