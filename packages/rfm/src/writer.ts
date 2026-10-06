import { stringify as stringifyYaml } from "yaml";
import type { RfmEndmatterEntry } from "./split.js";

type EntriesSection =
  | Map<string, RfmEndmatterEntry>
  | Record<string, RfmEndmatterEntry>;

export interface RfmEndmatterEntriesInput {
  comments?: EntriesSection;
  suggestions?: EntriesSection;
  /** Other top-level keys of the review block, written after `suggestions`. */
  extra?: Map<string, unknown> | Record<string, unknown>;
}

/** Entry keys in the order the canonical writer emits them; unknown keys follow in their own order. */
export const ENTRY_KEY_ORDER = [
  "body",
  "by",
  "at",
  "re",
  "status",
  "resolved",
  "scope",
  "lines",
  "quote",
  "continues",
] as const;

const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const YAML_KEYWORDS = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "null",
]);
const LINE_BREAK = /\r\n|\r|\n/g;

/** A value YAML 1.1 and 1.2 readers both take as the same string when written plain. */
function isPlainSafe(value: string): boolean {
  return PLAIN_SAFE.test(value) && !YAML_KEYWORDS.has(value.toLowerCase());
}

/** One-line YAML double-quoted scalar (JSON escapes plus the characters YAML needs escaped). */
function doubleQuoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function plainOrQuoted(value: string): string {
  return isPlainSafe(value) ? value : doubleQuoted(value);
}

function flowValue(value: unknown): string {
  if (typeof value === "string") return plainOrQuoted(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : doubleQuoted(String(value));
  }
  if (typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(flowValue).join(", ")}]`;
  if (value instanceof Date) return doubleQuoted(value.toISOString());
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${plainOrQuoted(key)}: ${flowValue(item)}`,
    );
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }
  return doubleQuoted(String(value));
}

function scalarFor(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (key === "body" || key === "resolved") {
      // Line breaks are stored as <br> so each field stays on one line.
      return doubleQuoted(value.replace(LINE_BREAK, "<br>"));
    }
    if (key === "at" || key === "quote") return doubleQuoted(value);
    return plainOrQuoted(value);
  }
  return flowValue(value);
}

function entriesOf(
  section: EntriesSection | undefined,
): Array<[string, RfmEndmatterEntry]> {
  if (!section) return [];
  return section instanceof Map ? [...section] : Object.entries(section);
}

function extraOf(
  extra: RfmEndmatterEntriesInput["extra"],
): Array<[string, unknown]> {
  if (!extra) return [];
  return extra instanceof Map ? [...extra] : Object.entries(extra);
}

function stringifyEntry(id: string, entry: RfmEndmatterEntry): string {
  const known = ENTRY_KEY_ORDER.filter(
    (key) => key in entry && entry[key] !== undefined,
  );
  const unknown = Object.keys(entry).filter(
    (key) =>
      !(ENTRY_KEY_ORDER as readonly string[]).includes(key) &&
      entry[key] !== undefined,
  );
  const keys = [...known, ...unknown];
  if (keys.length === 0) return `  ${plainOrQuoted(id)}: {}\n`;
  return [
    `  ${plainOrQuoted(id)}:`,
    ...keys.map(
      (key) => `    ${plainOrQuoted(key)}: ${scalarFor(key, entry[key])}`,
    ),
  ]
    .join("\n")
    .concat("\n");
}

/**
 * The canonical review block writer. Output starts with the `---` line and
 * ends with a newline; an empty input gives an empty string.
 *
 * - No line folding: every value stays on one line.
 * - `body`, `resolved`, `at` and `quote` are always double-quoted; line
 *   breaks in `body` and `resolved` are written as `<br>`.
 * - `by`, `re`, `status`, `scope`, `continues`, ids and unknown string values
 *   are plain when they are a simple word that no YAML 1.1 or 1.2 reader
 *   takes as a boolean or null, double-quoted otherwise.
 * - Keys in the order body, by, at, re, status, resolved, scope, lines,
 *   quote, continues, then unknown keys in their existing order. Entries stay
 *   in the order given (creation order).
 * - Sections in the order comments, suggestions, then other top-level keys.
 */
export function stringifyRoughdraftEndmatter(
  entries: RfmEndmatterEntriesInput,
): string {
  const comments = entriesOf(entries.comments);
  const suggestions = entriesOf(entries.suggestions);
  const extra = extraOf(entries.extra);
  if (comments.length === 0 && suggestions.length === 0 && extra.length === 0) {
    return "";
  }
  let output = "---\n";
  if (comments.length > 0) {
    output += "comments:\n";
    for (const [id, entry] of comments) output += stringifyEntry(id, entry);
  }
  if (suggestions.length > 0) {
    output += "suggestions:\n";
    for (const [id, entry] of suggestions) output += stringifyEntry(id, entry);
  }
  for (const [key, value] of extra) {
    output += stringifyYaml({ [key]: value }, { lineWidth: 0 });
  }
  return output;
}
