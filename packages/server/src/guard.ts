/**
 * `roughdraft guard --claude-hook`: an opt-in Claude Code PreToolUse hook
 * that keeps the agent's editing tools off review markup.
 *
 * Decision table, for Edit, MultiEdit and Write on a `.md` file:
 *
 * - the file has an open round: deny, naming the round's clean.md;
 * - Write over an existing file that holds review data: deny;
 * - an edit whose old or new text holds review markup outside code, whose
 *   matched text overlaps a highlight, ref or suggestion marker, or that
 *   reaches into the review block at the end: deny;
 * - everything else: allow.
 *
 * "Allow" prints nothing and exits 0, which lets Claude Code run its normal
 * permission flow (a `permissionDecision: "allow"` would skip the user's
 * permission prompts). Any internal error allows too: the guard fails open.
 *
 * The file also owns the open-rounds index (`<stateDir>/rounds/index.json`)
 * that `roughdraft round` writes and `apply` clears, so the hook can answer
 * without a running server.
 */

import fs from "node:fs";
import path from "node:path";
import { parseReviewModel } from "@roughdraft/rfm";
import { documentKey } from "./registry.js";

/** How long an open round keeps the reviewed file off limits to Edit and Write. */
export const GUARD_ROUND_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const ROUNDS_DIR = "rounds";
const ROUND_INDEX_FILE = "index.json";

/** Any review markup token: highlight, comment, suggestion delimiters, refs, attribute blocks. */
const REVIEW_MARKUP =
  /\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|\{#[A-Za-z][A-Za-z0-9_-]*\}|\{id="|\{@/;

// ------------------------------------------------------------ rounds index

export interface OpenRoundEntry {
  documentPath: string;
  roundId: string;
  dir: string;
  cleanPath: string;
  responsePath: string;
  openedAt: string;
}

type RoundIndex = Record<string, OpenRoundEntry>;

export function roundsDir(stateDir: string): string {
  return path.join(stateDir, ROUNDS_DIR);
}

function roundIndexPath(stateDir: string): string {
  return path.join(roundsDir(stateDir), ROUND_INDEX_FILE);
}

export function readRoundIndex(stateDir: string): RoundIndex {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(roundIndexPath(stateDir), "utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RoundIndex;
    }
  } catch {}
  return {};
}

function writeRoundIndex(stateDir: string, index: RoundIndex): void {
  const target = roundIndexPath(stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(temp, target);
}

/** Records the open round for a document (a newer round replaces an older one). */
export function recordOpenRound(stateDir: string, entry: OpenRoundEntry): void {
  const index = readRoundIndex(stateDir);
  index[documentKey(entry.documentPath)] = entry;
  writeRoundIndex(stateDir, index);
}

/** Clears the document's open round when it is `roundId` (or any, when omitted). */
export function clearOpenRound(
  stateDir: string,
  documentPath: string,
  roundId?: string,
): void {
  const index = readRoundIndex(stateDir);
  const key = documentKey(documentPath);
  const entry = index[key];
  if (!entry || (roundId && entry.roundId !== roundId)) return;
  delete index[key];
  writeRoundIndex(stateDir, index);
}

export function findOpenRound(
  stateDir: string,
  documentPath: string,
  now: number = Date.now(),
): OpenRoundEntry | null {
  const entry = readRoundIndex(stateDir)[documentKey(documentPath)];
  if (!entry || typeof entry.roundId !== "string") return null;
  const openedAt = Date.parse(entry.openedAt);
  if (Number.isFinite(openedAt) && now - openedAt > GUARD_ROUND_MAX_AGE_MS) {
    return null;
  }
  return entry;
}

// ------------------------------------------------------------ decisions

export type GuardDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "deny"; reason: string };

export interface GuardOptions {
  stateDir: string;
  readFile?: (filePath: string) => string;
  now?: () => number;
}

interface EditPair {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** Drops inline code spans, so a markup example in backticks is not markup. */
function withoutInlineCode(text: string): string {
  return text.replace(/(`+)[^`\n]*?\1/g, "");
}

function holdsMarkup(text: string): boolean {
  return REVIEW_MARKUP.test(withoutInlineCode(text));
}

function occurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const found: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return found;
}

const MARKUP_REASON =
  "This edit touches Roughdraft review markup. Never type review markup: run `roughdraft round <file>` and edit the clean.md it names, then `roughdraft apply`; or answer one thread with `roughdraft reply`, `resolve`, `accept`, `reject` or `note`.";

const BLOCK_REASON =
  "This edit reaches into the review block at the end of a Roughdraft document. Use `roughdraft reply`, `resolve`, `note`, or `round` and `apply` instead.";

const WRITE_REASON =
  "This is a Roughdraft review document; rewriting it with Write would damage the review. Run `roughdraft round <file>`, edit the clean.md it names, then run `roughdraft apply`.";

/**
 * The guard's decision for one PreToolUse payload. Throws only on a bug; the
 * caller turns any throw into "allow".
 */
export function guardDecision(
  input: unknown,
  options: GuardOptions,
): GuardDecision {
  const payload = asRecord(input);
  const tool = stringField(payload, "tool_name");
  if (tool !== "Edit" && tool !== "MultiEdit" && tool !== "Write") {
    return { decision: "allow" };
  }
  const toolInput = asRecord(payload.tool_input);
  const rawPath = stringField(toolInput, "file_path");
  if (!rawPath || !/\.md$/i.test(rawPath)) return { decision: "allow" };
  const cwd = stringField(payload, "cwd") || process.cwd();
  const filePath = path.resolve(cwd, rawPath);

  const round = findOpenRound(
    options.stateDir,
    filePath,
    (options.now ?? Date.now)(),
  );
  if (round) {
    return {
      decision: "deny",
      reason: `A Roughdraft review round (${round.roundId}) is open on this file. Do not edit it directly: make the prose changes in ${round.cleanPath}, write the replies in ${round.responsePath}, then run \`roughdraft apply "${round.responsePath}"\`.`,
    };
  }

  const readFile =
    options.readFile ?? ((target: string) => fs.readFileSync(target, "utf8"));
  let markdown: string;
  try {
    markdown = readFile(filePath);
  } catch {
    // A new file, or one we cannot read: nothing to protect.
    return { decision: "allow" };
  }
  const model = parseReviewModel(markdown);
  const hasReview =
    model.markup.length > 0 ||
    model.summary.comments > 0 ||
    model.summary.suggestions > 0 ||
    model.split.endmatterOffset !== null;
  if (!hasReview) return { decision: "allow" };

  if (tool === "Write") return { decision: "deny", reason: WRITE_REASON };

  const edits: EditPair[] =
    tool === "MultiEdit"
      ? (Array.isArray(toolInput.edits) ? toolInput.edits : []).map((edit) => {
          const record = asRecord(edit);
          return {
            oldString: stringField(record, "old_string"),
            newString: stringField(record, "new_string"),
            replaceAll: record.replace_all === true,
          };
        })
      : [
          {
            oldString: stringField(toolInput, "old_string"),
            newString: stringField(toolInput, "new_string"),
            replaceAll: toolInput.replace_all === true,
          },
        ];

  const codeRanges = model.fences.map(
    (fence) => [fence.codeStart, fence.codeEnd] as const,
  );
  const markupRanges = model.markup.map(
    (run) => [run.offset, run.endOffset] as const,
  );
  const blockStart = model.split.endmatterOffset;
  const inCode = (start: number, end: number) =>
    codeRanges.some(([a, b]) => start >= a && end <= b);

  for (const edit of edits) {
    const starts = occurrences(markdown, edit.oldString);
    if (starts.length === 0) {
      // Edit itself will fail on text it cannot find; still refuse new markup.
      if (holdsMarkup(edit.newString)) {
        return { decision: "deny", reason: MARKUP_REASON };
      }
      continue;
    }
    const matched = edit.replaceAll ? starts : starts.slice(0, 1);
    for (const start of matched) {
      const end = start + edit.oldString.length;
      if (inCode(start, end)) continue;
      if (blockStart !== null && end > blockStart) {
        return { decision: "deny", reason: BLOCK_REASON };
      }
      if (
        holdsMarkup(edit.oldString) ||
        holdsMarkup(edit.newString) ||
        markupRanges.some(([a, b]) => start < b && end > a)
      ) {
        // An edit strictly inside a highlight's text is fine.
        const insideText = model.markup.some(
          (run) =>
            run.type === "highlight" &&
            run.textStart !== null &&
            run.textEnd !== null &&
            start >= run.textStart &&
            end <= run.textEnd,
        );
        if (
          insideText &&
          !holdsMarkup(edit.oldString) &&
          !holdsMarkup(edit.newString)
        ) {
          continue;
        }
        return { decision: "deny", reason: MARKUP_REASON };
      }
    }
  }
  return { decision: "allow" };
}

/** What the hook prints: nothing for allow, the PreToolUse JSON for deny. */
export function hookOutput(decision: GuardDecision): string {
  if (decision.decision !== "deny") return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  })}\n`;
}

/** Runs the hook over the raw stdin text. Never throws; always exit 0. */
export function runGuardHook(
  stdinText: string,
  options: GuardOptions,
): { stdout: string; decision: GuardDecision; exitCode: 0 } {
  let decision: GuardDecision = { decision: "allow" };
  try {
    decision = guardDecision(JSON.parse(stdinText) as unknown, options);
  } catch (error) {
    decision = {
      decision: "allow",
      reason: `guard error, failing open: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { stdout: hookOutput(decision), decision, exitCode: 0 };
}
