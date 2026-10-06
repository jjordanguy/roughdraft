import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";

/**
 * Where the review block of a document stands.
 *
 * - `absent`: no review-shaped `---` block at the end of the file.
 * - `recognized`: a review block that parses and belongs to Roughdraft.
 * - `ignored`: a review-shaped block that parses, but the body has no
 *   Roughdraft metadata and the block has no document-level comment. It is an
 *   ordinary final section of the document and stays part of the body.
 * - `invalid`: a review-shaped block that does not parse, has the wrong shape,
 *   or is one of two review blocks. Readers must not edit such a file.
 */
export type RfmEndmatterStatus =
  | "absent"
  | "recognized"
  | "ignored"
  | "invalid";

/** One YAML entry under `comments:` or `suggestions:`, values as parsed. */
export type RfmEndmatterEntry = Record<string, unknown>;

export interface RfmEndmatterEntries {
  /** Entries under `comments:`, in file order. */
  comments: Map<string, RfmEndmatterEntry>;
  /** Entries under `suggestions:`, in file order. */
  suggestions: Map<string, RfmEndmatterEntry>;
  /** Every other top-level key of the review block, in file order. */
  extra: Map<string, unknown>;
}

export type RfmYamlErrorCode =
  | "invalid-endmatter-yaml"
  | "duplicate-endmatter-key"
  | "multiple-endmatter-blocks";

export interface RfmYamlError {
  code: RfmYamlErrorCode;
  /** Human message that starts with the file line, e.g. `line 12: duplicate key c2`. */
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface RoughdraftDocumentSplit {
  /** Frontmatter from byte 0 through its closing line and the blank lines after it. */
  frontmatter: string | null;
  /** Everything between the frontmatter and the review block. */
  body: string;
  /** The review block from its `---` line to the end of the file (recognized or invalid only). */
  endmatter: string | null;
  status: RfmEndmatterStatus;
  /** Parsed review block entries; empty unless the status is `recognized`. */
  entries: RfmEndmatterEntries;
  yamlError: RfmYamlError | null;
  /** Offset of `body` in the source; `frontmatter + body + endmatter` is the source. */
  bodyOffset: number;
  /** Offset of the review block's `---` line (recognized or invalid), else null. */
  endmatterOffset: number | null;
}

/** Internal split result with the locations the model needs for diagnostics. */
export interface SplitDetails extends RoughdraftDocumentSplit {
  /** Offset of a review-shaped block that was ignored, so the scan can stop there. */
  blockOffset: number | null;
  entryOffsets: {
    comments: Map<string, number>;
    suggestions: Map<string, number>;
  };
  /** Ids whose plain `body` scalar was cut short by a ` #` YAML comment. */
  truncatedBodies: Array<{ section: "comments" | "suggestions"; id: string }>;
  /** Entries under `comments:` or `suggestions:` that are not maps. */
  invalidEntries: Array<{
    section: "comments" | "suggestions";
    id: string;
    offset: number;
  }>;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

const RULE_LINE = /^---[ \t]*$/;
const REVIEW_KEY_LINE = /^(?:comments|suggestions):(?:[ \t]|$)/;

function emptyEntries(): RfmEndmatterEntries {
  return { comments: new Map(), suggestions: new Map(), extra: new Map() };
}

export function splitLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    const text = markdown.slice(start, end).replace(/\r$/, "");
    lines.push({ start, end, text });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

/** Offset where the body starts: after frontmatter and the blank lines that follow it. */
function frontmatterEnd(markdown: string): number {
  if (!/^---[ \t]*\r?\n/.test(markdown)) return 0;
  const lines = splitLines(markdown);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) break;
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
      let next = index + 1;
      while (
        next < lines.length &&
        lines[next]?.text.trim() === "" &&
        (lines[next]?.start ?? markdown.length) < markdown.length
      ) {
        next += 1;
      }
      return lines[next]?.start ?? markdown.length;
    }
  }
  return 0;
}

export interface FenceState {
  marker: "`" | "~";
  length: number;
}

/**
 * Fence detection kept identical to rfm 0.1.10 so both readers agree on what
 * is code: an opening line is up to three spaces then three or more backticks
 * or tildes; it closes on the same marker with at least the same length.
 */
export function matchFence(
  text: string,
  fence: FenceState | null,
): FenceState | null {
  const match = text.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const markerText = match[1] ?? "";
  const marker = markerText[0] as "`" | "~";
  if (!fence) return { marker, length: markerText.length };
  if (fence.marker !== marker || markerText.length < fence.length) return null;
  return fence;
}

function parseReviewYaml(yaml: string) {
  return parseDocument(yaml, { uniqueKeys: true });
}

function isReviewMapValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "object" && !Array.isArray(value))
  );
}

/** The block parses as a mapping whose `comments` or `suggestions` key is a map or empty. */
function parsesAsReviewMap(yaml: string): boolean {
  const document = parseReviewYaml(yaml);
  if (document.errors.length > 0) return false;
  const data = document.toJS() as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    ("comments" in record && isReviewMapValue(record.comments)) ||
    ("suggestions" in record && isReviewMapValue(record.suggestions))
  );
}

function firstContentLine(
  lines: Line[],
  from: number,
  until: number,
): Line | null {
  for (let index = from; index < until; index += 1) {
    const line = lines[index];
    if (line && line.text.trim() !== "") return line;
  }
  return null;
}

function hasReviewMetadataSignal(text: string): boolean {
  return (
    /\{#[A-Za-z]/.test(text) ||
    /(?:<<\}|\+\+\}|--\}|~~\}|==\})\{[^}\n]*\bid="/.test(text) ||
    /<<\}\{@/.test(text)
  );
}

function hasDocumentLevelComment(comments: Map<string, RfmEndmatterEntry>) {
  for (const entry of comments.values()) {
    const re = entry.re;
    if (typeof entry.body === "string" && !(typeof re === "string" && re)) {
      return true;
    }
  }
  return false;
}

function locationOf(markdown: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function yamlErrorFrom(
  markdown: string,
  yaml: string,
  yamlOffset: number,
  error: { code: string; message: string; pos: [number, number] },
): RfmYamlError {
  const offset = yamlOffset + Math.max(0, Math.min(error.pos[0], yaml.length));
  const { line, column } = locationOf(markdown, offset);
  if (error.code === "DUPLICATE_KEY") {
    const key = yaml
      .slice(error.pos[0])
      .match(/^["']?([^"':\n]+)/)?.[1]
      ?.trim();
    return {
      code: "duplicate-endmatter-key",
      message: `line ${line}: duplicate key ${key ?? "(unknown)"}`,
      offset,
      line,
      column,
    };
  }
  const reason = (error.message.split("\n")[0] ?? "")
    .replace(/ at line \d+, column \d+:?$/, "")
    .trim();
  return {
    code: "invalid-endmatter-yaml",
    message: `line ${line}, column ${column}: ${reason}`,
    offset,
    line,
    column,
  };
}

function shapeError(
  markdown: string,
  offset: number,
  reason: string,
): RfmYamlError {
  const { line, column } = locationOf(markdown, offset);
  return {
    code: "invalid-endmatter-yaml",
    message: `line ${line}: ${reason}`,
    offset,
    line,
    column,
  };
}

function keyOffset(node: unknown): number {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : 0;
}

/**
 * Split a document into frontmatter, body and the final review block.
 *
 * A final `---` block is review-shaped when its first non-blank line starts at
 * column 0 with `comments:` or `suggestions:` (a line check, so it works when
 * the YAML does not parse), or when the block parses as a mapping that has a
 * `comments` or `suggestions` map. `---` lines inside fenced code and the
 * frontmatter are never candidates.
 */
export function splitDocumentDetails(markdown: string): SplitDetails {
  const bodyOffset = frontmatterEnd(markdown);
  const frontmatter = bodyOffset > 0 ? markdown.slice(0, bodyOffset) : null;
  const lines = splitLines(markdown);
  const ruleLines: number[] = [];
  let fence: FenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.start < bodyOffset) continue;
    const fenceMatch = matchFence(line.text, fence);
    if (fenceMatch) {
      fence = fence ? null : fenceMatch;
      continue;
    }
    if (fence) continue;
    if (line.start === 0) continue;
    if (RULE_LINE.test(line.text)) ruleLines.push(index);
  }

  const base: SplitDetails = {
    frontmatter,
    body: markdown.slice(bodyOffset),
    endmatter: null,
    status: "absent",
    entries: emptyEntries(),
    yamlError: null,
    bodyOffset,
    endmatterOffset: null,
    blockOffset: null,
    entryOffsets: { comments: new Map(), suggestions: new Map() },
    truncatedBodies: [],
    invalidEntries: [],
  };

  const lastRuleIndex = ruleLines.at(-1);
  if (lastRuleIndex === undefined) return base;
  const ruleLine = lines[lastRuleIndex];
  if (!ruleLine) return base;

  const yamlStart = lines[lastRuleIndex + 1]?.start ?? markdown.length;
  const yaml = markdown.slice(yamlStart);
  const firstLine = firstContentLine(lines, lastRuleIndex + 1, lines.length);
  const lineShaped = Boolean(firstLine && REVIEW_KEY_LINE.test(firstLine.text));
  if (!lineShaped && !parsesAsReviewMap(yaml)) return base;

  const blockOffset = ruleLine.start;
  const invalid = (error: RfmYamlError): SplitDetails => ({
    ...base,
    body: markdown.slice(bodyOffset, blockOffset),
    endmatter: markdown.slice(blockOffset),
    status: "invalid",
    yamlError: error,
    endmatterOffset: blockOffset,
    blockOffset,
  });

  // A second review block earlier in the file (an agent appended a new block
  // instead of editing the existing one).
  for (const earlierIndex of ruleLines.slice(0, -1)) {
    const earlier = lines[earlierIndex];
    if (!earlier) continue;
    const earlierFirst = firstContentLine(
      lines,
      earlierIndex + 1,
      lastRuleIndex,
    );
    if (!earlierFirst || !REVIEW_KEY_LINE.test(earlierFirst.text)) continue;
    const earlierYaml = markdown.slice(
      lines[earlierIndex + 1]?.start ?? earlier.end,
      blockOffset,
    );
    if (!parsesAsReviewMap(earlierYaml)) continue;
    const { line, column } = locationOf(markdown, earlier.start);
    return {
      ...invalid({
        code: "multiple-endmatter-blocks",
        message: `line ${line}: the file has two review blocks (lines ${line} and ${locationOf(markdown, blockOffset).line}); merge them into the last one`,
        offset: earlier.start,
        line,
        column,
      }),
      body: markdown.slice(bodyOffset, earlier.start),
      endmatter: markdown.slice(earlier.start),
      endmatterOffset: earlier.start,
      blockOffset: earlier.start,
    };
  }

  const document = parseReviewYaml(yaml);
  const firstError = document.errors[0];
  if (firstError) {
    return invalid(
      yamlErrorFrom(markdown, yaml, yamlStart, {
        code: firstError.code,
        message: firstError.message,
        pos: firstError.pos,
      }),
    );
  }

  const contents = document.contents;
  if (!isMap(contents)) {
    return invalid(
      shapeError(markdown, yamlStart, "the review block is not a YAML mapping"),
    );
  }

  const entries = emptyEntries();
  const entryOffsets = {
    comments: new Map<string, number>(),
    suggestions: new Map<string, number>(),
  };
  const truncatedBodies: SplitDetails["truncatedBodies"] = [];
  const invalidEntries: SplitDetails["invalidEntries"] = [];

  const data = document.toJS() as Record<string, unknown>;
  for (const pair of (contents as YAMLMap).items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = pair.value;
    if (key !== "comments" && key !== "suggestions") {
      entries.extra.set(key, data[key] ?? null);
      continue;
    }
    if (value === null || (isScalar(value) && value.value === null)) continue;
    if (!isMap(value)) {
      return invalid(
        shapeError(
          markdown,
          yamlStart + keyOffset(pair.key),
          `\`${key}\` must be a map keyed by id`,
        ),
      );
    }
    const target = key === "comments" ? entries.comments : entries.suggestions;
    const offsets =
      key === "comments" ? entryOffsets.comments : entryOffsets.suggestions;
    for (const entryPair of value.items) {
      const id = isScalar(entryPair.key)
        ? String(entryPair.key.value)
        : String(entryPair.key);
      const offset = yamlStart + keyOffset(entryPair.key);
      const entryValue = entryPair.value;
      if (!isMap(entryValue)) {
        invalidEntries.push({ section: key, id, offset });
        continue;
      }
      const sectionData = data[key] as Record<string, RfmEndmatterEntry>;
      target.set(id, sectionData[id] ?? {});
      offsets.set(id, offset);
      for (const field of entryValue.items) {
        if (!isScalar(field.key) || field.key.value !== "body") continue;
        const scalar = field.value;
        if (!isScalar(scalar) || scalar.type !== "PLAIN" || !scalar.range) {
          continue;
        }
        const valueEnd = scalar.range[1];
        const lineEnd = yaml.indexOf("\n", valueEnd);
        const rest = yaml.slice(valueEnd, lineEnd === -1 ? undefined : lineEnd);
        if (/^[ \t]+#/.test(rest)) truncatedBodies.push({ section: key, id });
      }
    }
  }

  const body = markdown.slice(bodyOffset, blockOffset);
  const recognized =
    hasReviewMetadataSignal(body) || hasDocumentLevelComment(entries.comments);

  if (!recognized) {
    return { ...base, status: "ignored", blockOffset };
  }

  return {
    ...base,
    body,
    endmatter: markdown.slice(blockOffset),
    status: "recognized",
    entries,
    endmatterOffset: blockOffset,
    blockOffset,
    entryOffsets,
    truncatedBodies,
    invalidEntries,
  };
}

/**
 * Split a Markdown document into frontmatter, body and the final review block,
 * and parse the block. `frontmatter + body + endmatter` always equals the
 * input (with `endmatter` null for `absent` and `ignored`).
 */
export function splitRoughdraftDocument(
  markdown: string,
): RoughdraftDocumentSplit {
  const details = splitDocumentDetails(markdown);
  return {
    frontmatter: details.frontmatter,
    body: details.body,
    endmatter: details.endmatter,
    status: details.status,
    entries: details.entries,
    yamlError: details.yamlError,
    bodyOffset: details.bodyOffset,
    endmatterOffset: details.endmatterOffset,
  };
}
