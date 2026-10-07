// Apply an agent's round response to a document in one checked write: rebase
// the clean-text edits onto the current file by content, keep every highlight
// on its text (or move it with an edit), restore Jordan's items changed
// outside Roughdraft, add replies, resolutions, decisions and the round note,
// then gate the result. A non-empty `errors` means nothing may be written.
import {
  type CanonicalDocument,
  loadCanonical,
  RoughdraftFormatError,
} from "./canonical.js";
import { cleanTextOfDoc } from "./clean.js";
import {
  allIds,
  buildReviewDoc,
  cleanViewOf,
  type Entry,
  normalizePieces,
  type Piece,
  type ReviewDoc,
  type RfmNormalizationChange,
  serializeDoc,
} from "./document.js";
import {
  type AnchorResult,
  applyEditAt,
  type CleanHunk,
  collapseBlankLines,
  diffCleanText,
  findMatches,
  type Located,
  locateHunk,
  type MatchMode,
} from "./edits.js";
import { validateWithLegacyReader } from "./legacy.js";
import { lintRoughdraftMarkdown } from "./lint.js";
import { mergeReviewEntries } from "./merge.js";
import { parseReviewModel } from "./model.js";
import {
  buildReviewRound,
  buildThreads,
  cleanBlocks,
  DEFAULT_AGENT_LABELS,
  type RfmRound,
  type RfmRoundThread,
} from "./round.js";

// ------------------------------------------------------------ the schema

export interface RfmEditSpec {
  /** Exact text from the clean text to replace. */
  old?: string;
  /** Replace everything from the start of `from` through the end of `to`. */
  from?: string;
  to?: string;
  /** Replace exactly what comment `anchor` highlights (first segment to last). */
  anchor?: string;
  new: string;
  /** Replace every occurrence of `old`. */
  all?: boolean;
  /** A thread id whose block settles which of several matches is meant. */
  near?: string;
}

export interface RfmThreadAction {
  reply?: string;
  /** `true`, or a one-line summary stored as `resolved`. */
  resolve?: boolean | string;
  decision?: "accept" | "reject";
  /** Required to accept or reject a suggestion that has replies (they are removed with it). */
  dropReplies?: boolean;
  /** A reason; nothing is written for the thread. */
  skip?: string;
  /** Allow a second agent reply to a thread already answered in this round. */
  followUp?: boolean;
}

export interface RfmReviewResponse {
  roughdraftResponse: 1;
  roundId: string;
  partial?: boolean;
  threads?: Record<string, RfmThreadAction>;
  /** Edits for clients that cannot edit clean.md; not together with an edited clean.md. */
  edits?: RfmEditSpec[];
  /** A one-line round note, stored as an agent document comment. */
  note?: string;
}

export interface RfmApplyInput {
  /** The file as the round read it (base.md). */
  base: string;
  /** The file as it is now. */
  current: string;
  /** clean.md as the agent left it; omit or pass null when it was not edited. */
  cleanEdited?: string | null;
  /** The parsed response.json. */
  response: unknown;
  /** The file as the browser last saved it (the server baseline); falls back to `base`. */
  baseline?: string | null;
  /** The round object; rebuilt from `base` when omitted. */
  round?: RfmRound | null;
  /** `by` values that count as the agent (default the round's, else `["AI"]`). */
  agentLabels?: string[];
  /** `by` of the entries apply writes (default the first agent label). */
  author?: string;
  /** Time stamped on new entries (default now). */
  now?: string;
  /** Apply to an old-shape file, normalizing it on the way (default: refuse, per D11). */
  allowLegacy?: boolean;
}

export interface RfmApplyError {
  code: string;
  /** The thread or unit (`edits[2]`, `clean.md`, `note`, `response`) the error is about. */
  thread?: string;
  message: string;
  hint?: string;
  /** Clean-text lines, for `edit-ambiguous`. */
  lines?: number[];
}

export interface RfmApplyAnchorReport {
  id: string;
  result: AnchorResult;
}

export interface RfmApplyEditReport {
  /** `clean.md` hunk number or `edits[n]`. */
  unit: string;
  /** 1-based line in the current clean text. */
  line: number;
  match: MatchMode;
  anchors: RfmApplyAnchorReport[];
}

export interface RfmRestoredItem {
  id: string;
  /** `entry` (body or metadata put back), `anchor` (highlight re-wrapped), `quote` (text gone; kept as a quote), `marker` (suggestion marker put back). */
  what: "entry" | "anchor" | "quote" | "marker";
  keys?: string[];
}

export interface RfmApplyReport {
  ok: boolean;
  status: "applied" | "already-applied" | "refused";
  roundId: string | null;
  rebase: {
    /** The file changed between the round and now. */
    baseChanged: boolean;
    /** A server baseline was given and used to tell browser saves from outside changes. */
    baselineUsed: boolean;
    /** Something of Jordan's changed outside Roughdraft and was restored. */
    outsideChanges: boolean;
    /** Threads that exist now but were not in the round. */
    newThreads: string[];
  };
  restored: RfmRestoredItem[];
  normalized: RfmNormalizationChange[];
  replies: Array<{ thread: string; id: string }>;
  resolved: string[];
  accepted: string[];
  rejected: string[];
  droppedReplies: Array<{
    thread: string;
    id: string;
    author: string | null;
    body: string;
  }>;
  skipped: Array<{ id: string; reason: string }>;
  edits: RfmApplyEditReport[];
  /** Every anchor an edit touched, with what happened to it. */
  anchors: RfmApplyAnchorReport[];
  /** Id of the round note, when one was written. */
  note: string | null;
  /** Threads that needed an answer and were left out (`partial`). */
  remaining: string[];
  warnings: Array<{ code: string; thread?: string; message: string }>;
  doctor: {
    ok: boolean;
    comments: number;
    roots: number;
    documentComments: number;
    replies: number;
    suggestions: number;
  } | null;
  errors: RfmApplyError[];
}

export interface RfmApplyResult {
  /** The document to write; null when refused. */
  markdown: string | null;
  report: RfmApplyReport;
  errors: RfmApplyError[];
}

const THREAD_KEYS = new Set([
  "reply",
  "resolve",
  "decision",
  "dropReplies",
  "skip",
  "followUp",
]);
const RESPONSE_KEYS = new Set([
  "roughdraftResponse",
  "roundId",
  "partial",
  "threads",
  "edits",
  "note",
]);
const EDIT_KEYS = new Set([
  "old",
  "new",
  "from",
  "to",
  "anchor",
  "all",
  "near",
]);
const MARKUP =
  /\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|\{==|==\}|\{#[A-Za-z][A-Za-z0-9_-]*\}/;
const DELIMITER = /<<\}|\+\+\}|--\}|~~\}|==\}/;
const MAX_TEXT = 4000;

function emptyReport(roundId: string | null): RfmApplyReport {
  return {
    ok: false,
    status: "refused",
    roundId,
    rebase: {
      baseChanged: false,
      baselineUsed: false,
      outsideChanges: false,
      newThreads: [],
    },
    restored: [],
    normalized: [],
    replies: [],
    resolved: [],
    accepted: [],
    rejected: [],
    droppedReplies: [],
    skipped: [],
    edits: [],
    anchors: [],
    note: null,
    remaining: [],
    warnings: [],
    doctor: null,
    errors: [],
  };
}

function refuse(
  report: RfmApplyReport,
  errors: RfmApplyError[],
): RfmApplyResult {
  return {
    markdown: null,
    report: { ...report, ok: false, status: "refused", errors },
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------- response shape

function checkText(
  value: unknown,
  thread: string,
  what: string,
  errors: RfmApplyError[],
): void {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({
      code: "empty-reply",
      thread,
      message: `${thread}: ${what} is empty`,
    });
    return;
  }
  const delimiter = value.match(DELIMITER);
  if (delimiter || /\{>>|\{\+\+|\{--|\{~~|\{==/.test(value)) {
    errors.push({
      code: "markup-in-reply",
      thread,
      message: `${thread}: ${what} contains CriticMarkup ("${delimiter?.[0] ?? "{"}"); write plain text`,
    });
  }
  if (value.length > MAX_TEXT) {
    errors.push({
      code: "reply-too-long",
      thread,
      message: `${thread}: ${what} is longer than ${MAX_TEXT} characters`,
    });
  }
}

function validateShape(
  response: unknown,
  errors: RfmApplyError[],
): response is RfmReviewResponse {
  if (!isRecord(response)) {
    errors.push({
      code: "bad-response",
      thread: "response",
      message: "the response must be a JSON object",
    });
    return false;
  }
  for (const key of Object.keys(response)) {
    if (!RESPONSE_KEYS.has(key)) {
      errors.push({
        code: "unknown-key",
        thread: "response",
        message: `unknown key "${key}" in the response`,
      });
    }
  }
  if (response.roughdraftResponse !== 1) {
    errors.push({
      code: "bad-response",
      thread: "response",
      message: "roughdraftResponse must be 1",
    });
  }
  if (typeof response.roundId !== "string" || !response.roundId) {
    errors.push({
      code: "bad-response",
      thread: "response",
      message: "roundId is required",
    });
  }
  if (response.partial !== undefined && typeof response.partial !== "boolean") {
    errors.push({
      code: "bad-response",
      thread: "response",
      message: "partial must be true or false",
    });
  }
  if (response.threads !== undefined && !isRecord(response.threads)) {
    errors.push({
      code: "bad-response",
      thread: "response",
      message: "threads must be an object keyed by thread id",
    });
  }
  for (const [id, action] of Object.entries(
    isRecord(response.threads) ? response.threads : {},
  )) {
    if (!isRecord(action)) {
      errors.push({
        code: "bad-response",
        thread: id,
        message: `${id}: the action must be an object`,
      });
      continue;
    }
    for (const key of Object.keys(action)) {
      if (!THREAD_KEYS.has(key)) {
        errors.push({
          code: "unknown-key",
          thread: id,
          message: `${id}: unknown key "${key}"`,
        });
      }
    }
    if (
      action.decision !== undefined &&
      action.decision !== "accept" &&
      action.decision !== "reject"
    ) {
      errors.push({
        code: "bad-decision",
        thread: id,
        message: `${id}: decision must be "accept" or "reject"`,
      });
    }
    if (
      action.resolve !== undefined &&
      typeof action.resolve !== "boolean" &&
      typeof action.resolve !== "string"
    ) {
      errors.push({
        code: "bad-response",
        thread: id,
        message: `${id}: resolve must be true or a summary`,
      });
    }
    if (typeof action.resolve === "string")
      checkText(action.resolve, id, "the resolve summary", errors);
    if (action.skip !== undefined && typeof action.skip !== "string") {
      errors.push({
        code: "bad-response",
        thread: id,
        message: `${id}: skip must be a reason`,
      });
    }
    for (const flag of ["followUp", "dropReplies"]) {
      if (action[flag] !== undefined && typeof action[flag] !== "boolean") {
        errors.push({
          code: "bad-response",
          thread: id,
          message: `${id}: ${flag} must be true or false`,
        });
      }
    }
    if (action.reply !== undefined)
      checkText(action.reply, id, "the reply", errors);
    const acts = ["reply", "resolve", "decision"].filter(
      (key) => action[key] !== undefined && action[key] !== false,
    );
    if (action.skip !== undefined && acts.length > 0) {
      errors.push({
        code: "skip-with-actions",
        thread: id,
        message: `${id}: skip cannot be combined with ${acts.join(", ")}`,
      });
    }
    if (
      action.skip === undefined &&
      acts.length === 0 &&
      action.followUp !== true
    ) {
      errors.push({
        code: "no-action",
        thread: id,
        message: `${id}: give a reply, resolve, decision or skip`,
      });
    }
  }
  if (response.edits !== undefined && !Array.isArray(response.edits)) {
    errors.push({
      code: "bad-edit",
      thread: "edits",
      message: "edits must be a list",
    });
  }
  (Array.isArray(response.edits) ? response.edits : []).forEach(
    (edit: unknown, index: number) => {
      const unit = `edits[${index}]`;
      if (!isRecord(edit)) {
        errors.push({
          code: "bad-edit",
          thread: unit,
          message: `${unit} must be an object`,
        });
        return;
      }
      for (const key of Object.keys(edit)) {
        if (!EDIT_KEYS.has(key))
          errors.push({
            code: "unknown-key",
            thread: unit,
            message: `${unit}: unknown key "${key}"`,
          });
      }
      const forms = [
        typeof edit.old === "string",
        typeof edit.from === "string" || typeof edit.to === "string",
        typeof edit.anchor === "string",
      ].filter(Boolean).length;
      if (forms !== 1) {
        errors.push({
          code: "bad-edit",
          thread: unit,
          message: `${unit}: give exactly one of "old", "from" and "to", or "anchor"`,
        });
      }
      if ((typeof edit.from === "string") !== (typeof edit.to === "string")) {
        errors.push({
          code: "bad-edit",
          thread: unit,
          message: `${unit}: "from" and "to" go together`,
        });
      }
      if (typeof edit.new !== "string")
        errors.push({
          code: "bad-edit",
          thread: unit,
          message: `${unit}: "new" must be a string`,
        });
      if (edit.old === "")
        errors.push({
          code: "bad-edit",
          thread: unit,
          message: `${unit}: "old" is empty`,
        });
      for (const key of ["old", "new", "from", "to"]) {
        const value = edit[key];
        if (typeof value === "string" && MARKUP.test(value)) {
          errors.push({
            code: "markup-in-edit",
            thread: unit,
            message: `${unit}.${key} contains review markup; edits are plain text from the clean copy`,
          });
        }
      }
    },
  );
  if (response.note !== undefined)
    checkText(response.note, "note", "the note", errors);
  return errors.length === 0;
}

// --------------------------------------------------------------- helpers

function cloneDoc(doc: ReviewDoc): ReviewDoc {
  return {
    frontmatter: doc.frontmatter,
    pieces: doc.pieces.map((piece) => {
      if (piece.t === "hl" || piece.t === "ref")
        return { ...piece, ids: [...piece.ids] };
      if (piece.t === "sug") return { ...piece, ids: [...piece.ids] };
      return { ...piece };
    }),
    comments: new Map(
      [...doc.comments].map(([id, entry]) => [id, { ...entry }]),
    ),
    suggestions: new Map(
      [...doc.suggestions].map(([id, entry]) => [id, { ...entry }]),
    ),
    extra: new Map(doc.extra),
    hadBlock: doc.hadBlock,
  };
}

function cloneEntries(map: Map<string, Entry>): Map<string, Entry> {
  return new Map([...map].map(([id, entry]) => [id, { ...entry }]));
}

function threadsOf(
  loaded: CanonicalDocument,
  agentLabels: string[],
): Map<string, RfmRoundThread> {
  const { clean, map } = cleanTextOfDoc(loaded.doc, loaded.bodyOffset);
  return new Map(
    buildThreads(loaded.model, clean, map, agentLabels).map((thread) => [
      thread.id,
      thread,
    ]),
  );
}

/** What of a thread belongs to Jordan: his root text, the suggestion, his replies. */
function jordanPart(thread: RfmRoundThread, agentLabels: string[]): string {
  const isAgent = (by: string | null) => agentLabels.includes(by ?? "");
  return JSON.stringify({
    body: isAgent(thread.author) ? null : thread.body,
    suggestion: thread.suggestion
      ? [
          thread.suggestion.type,
          thread.suggestion.original,
          thread.suggestion.proposed,
        ]
      : null,
    replies: thread.replies
      .filter((reply) => !isAgent(reply.author))
      .map((reply) => [reply.id, reply.body]),
  });
}

function lineOfClean(clean: string, offset: number): number {
  return clean.slice(0, offset).split("\n").length;
}

/** Ranges of fenced code in the clean text (markup typed there is literal). */
function codeRanges(clean: string): Array<[number, number]> {
  return cleanBlocks(clean)
    .filter((block) =>
      /^[ \t]{0,3}(`{3,}|~{3,})/.test(clean.slice(block.start, block.end)),
    )
    .map((block) => [block.start, block.end]);
}

function insideCode(
  ranges: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  return ranges.some(([a, b]) => start >= a && end <= b);
}

function suggestionGroupIds(doc: ReviewDoc, rootId: string): string[] {
  const ids = [rootId];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, entry] of doc.suggestions) {
      if (
        !ids.includes(id) &&
        typeof entry.continues === "string" &&
        ids.includes(entry.continues)
      ) {
        ids.push(id);
        grew = true;
      }
    }
  }
  return ids;
}

function descendantIds(doc: ReviewDoc, rootId: string): string[] {
  const out: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const [id, entry] of doc.comments) {
      if (
        typeof entry.re === "string" &&
        frontier.includes(entry.re) &&
        !out.includes(id)
      ) {
        out.push(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return out;
}

function anchorIdsOf(doc: ReviewDoc): Set<string> {
  const ids = new Set<string>();
  for (const piece of doc.pieces) {
    if (piece.t === "hl" || piece.t === "ref" || piece.t === "sug")
      for (const id of piece.ids) ids.add(id);
    if (piece.t === "fref") ids.add(piece.id);
  }
  return ids;
}

function clip(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 3)}...` : flat;
}

// --------------------------------------------------------------- restore

/**
 * Put back Jordan's items that changed outside Roughdraft: entries whose body
 * or metadata differ from the reference, highlights that vanished (re-wrapped
 * when their text is still there once, else kept as a quote), and suggestion
 * markers (re-wrapped on their text).
 */
function restoreOutsideChanges(
  work: ReviewDoc,
  reference: ReviewDoc,
  agentLabels: string[],
  errors: RfmApplyError[],
): RfmRestoredItem[] {
  const restored: RfmRestoredItem[] = [];
  const isJordan = (entry: Entry) =>
    !agentLabels.includes(typeof entry.by === "string" ? entry.by : "");
  const refClean = cleanTextOfDoc(reference, 0);
  const refAnchorIds = anchorIdsOf(reference);

  for (const section of ["comments", "suggestions"] as const) {
    const refMap = reference[section];
    const workMap = work[section];
    for (const [id, refEntry] of refMap) {
      if (!isJordan(refEntry)) continue;
      const now = workMap.get(id);
      if (now && JSON.stringify(now) === JSON.stringify(refEntry)) continue;
      const keys = now
        ? [...new Set([...Object.keys(refEntry), ...Object.keys(now)])].filter(
            (key) => JSON.stringify(refEntry[key]) !== JSON.stringify(now[key]),
          )
        : ["(missing)"];
      workMap.set(id, { ...refEntry });
      restored.push({ id, what: "entry", keys });
    }
  }

  // Anchors of Jordan's comments that vanished.
  const workAnchors = anchorIdsOf(work);
  for (const id of refAnchorIds) {
    const entry = reference.comments.get(id);
    if (
      !entry ||
      !isJordan(entry) ||
      workAnchors.has(id) ||
      reference.suggestions.has(id)
    )
      continue;
    const texts = refClean.map.anchors.filter(
      (anchor) => anchor.id === id && anchor.kind === "highlight",
    );
    let rewrapped = false;
    if (texts.length > 0) {
      const view = cleanViewOf(work.pieces);
      const targets: Array<[number, number]> = [];
      for (const anchor of texts) {
        const text = refClean.clean.slice(anchor.cleanStart, anchor.cleanEnd);
        const { matches, mode } = findMatches(view.text, text);
        if (mode !== "exact" || matches.length !== 1) {
          targets.length = 0;
          break;
        }
        targets.push(matches[0] as [number, number]);
      }
      if (targets.length === texts.length && targets.length > 0) {
        rewrapped = targets.every(([start, end]) =>
          wrapRange(work, start, end, id),
        );
      }
    }
    if (rewrapped) {
      restored.push({ id, what: "anchor" });
    } else {
      const quote = texts
        .map((anchor) =>
          refClean.clean.slice(anchor.cleanStart, anchor.cleanEnd),
        )
        .join("\n");
      const current = work.comments.get(id) ?? { ...entry };
      if (quote) current.quote = quote;
      current.scope = "document";
      work.comments.set(id, current);
      restored.push({ id, what: "quote" });
    }
  }

  // Suggestion markers of Jordan's that vanished.
  const workMarkers = new Set(
    work.pieces
      .filter((piece) => piece.t === "sug")
      .map((piece) => (piece as { id: string }).id),
  );
  for (const piece of reference.pieces) {
    if (piece.t !== "sug" || workMarkers.has(piece.id)) continue;
    const entry = reference.suggestions.get(piece.id);
    if (!entry || !isJordan(entry)) continue;
    const view = cleanViewOf(work.pieces);
    const { matches, mode } =
      piece.kind === "addition"
        ? { matches: [], mode: "exact" }
        : findMatches(view.text, piece.old);
    if (
      mode === "exact" &&
      matches.length === 1 &&
      replaceRangeWithMarker(work, matches[0] as [number, number], piece)
    ) {
      restored.push({ id: piece.id, what: "marker" });
    } else {
      work.suggestions.delete(piece.id);
      errors.push({
        code: "restore-failed",
        thread: piece.id,
        message: `Jordan's suggestion ${piece.id} was removed from the text outside Roughdraft and cannot be put back on its own`,
        hint: "Restore the file from the browser or a backup, then start a new round.",
      });
    }
  }
  return restored;
}

/** Wrap a clean range that lies inside one plain text piece in a highlight. */
function wrapRange(
  doc: ReviewDoc,
  start: number,
  end: number,
  id: string,
): boolean {
  const view = cleanViewOf(doc.pieces);
  for (let index = 0; index < doc.pieces.length; index += 1) {
    const piece = doc.pieces[index] as Piece;
    const [s, e] = view.spans[index] as [number, number];
    if (piece.t !== "text" || start < s || end > e) continue;
    const before = piece.s.slice(0, start - s);
    const inside = piece.s.slice(start - s, end - s);
    const after = piece.s.slice(end - s);
    doc.pieces.splice(
      index,
      1,
      { t: "text", s: before },
      { t: "hl", s: inside, ids: [id] },
      { t: "text", s: after },
    );
    doc.pieces = normalizePieces(doc.pieces, false);
    return true;
  }
  return false;
}

function replaceRangeWithMarker(
  doc: ReviewDoc,
  [start, end]: [number, number],
  marker: Extract<Piece, { t: "sug" }>,
): boolean {
  const view = cleanViewOf(doc.pieces);
  for (let index = 0; index < doc.pieces.length; index += 1) {
    const piece = doc.pieces[index] as Piece;
    const [s, e] = view.spans[index] as [number, number];
    if (piece.t !== "text" || start < s || end > e) continue;
    doc.pieces.splice(
      index,
      1,
      { t: "text", s: piece.s.slice(0, start - s) },
      { ...marker, ids: [...marker.ids] },
      { t: "text", s: piece.s.slice(end - s) },
    );
    doc.pieces = normalizePieces(doc.pieces, false);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- apply

interface PlannedEdit {
  unit: string;
  start: number;
  end: number;
  text: string;
  mode: MatchMode;
}

/**
 * Apply an agent's response to a document. See `RfmApplyInput`. Returns the
 * document to write, the report, and the errors; a non-empty `errors` means
 * nothing may be written (`markdown` is null).
 *
 * Order: check the response; load the round's base, the current file and the
 * reference (the server baseline, else the base); put back Jordan's items
 * changed outside Roughdraft; check every answered thread against the round
 * (rebase); locate the edits in the current clean text by content and apply
 * them; decide suggestions; add replies, resolutions and the round note;
 * merge the agent's entry changes (made on the round's view) with the
 * current entries; serialize; run the gates.
 */
export function applyReviewResponse(input: RfmApplyInput): RfmApplyResult {
  const errors: RfmApplyError[] = [];
  const responseRoundId =
    isRecord(input.response) && typeof input.response.roundId === "string"
      ? input.response.roundId
      : null;
  let report = emptyReport(responseRoundId);
  if (!validateShape(input.response, errors)) return refuse(report, errors);
  const response = input.response;

  // ---- load the base, the current file and the reference.
  const load = (markdown: string, label: string): CanonicalDocument | null => {
    try {
      return loadCanonical(markdown, { allowLegacy: input.allowLegacy });
    } catch (error) {
      if (error instanceof RoughdraftFormatError) {
        errors.push({
          code: error.code,
          thread: "response",
          message: `${label}: ${error.message}`,
          hint:
            error.code === "legacy-format"
              ? "Run roughdraft doctor --fix on the file, then start a new round."
              : undefined,
        });
        return null;
      }
      throw error;
    }
  };
  const base = load(input.base, "the round's base");
  const current = load(input.current, "the document");
  if (!base || !current) return refuse(report, errors);

  let round = input.round ?? null;
  if (round && round.roundId !== response.roundId) {
    errors.push({
      code: "round-mismatch",
      thread: "response",
      message: `the response is for round ${response.roundId}, not ${round.roundId}`,
    });
    return refuse(report, errors);
  }
  const agentLabels =
    input.agentLabels ?? round?.agentLabels ?? DEFAULT_AGENT_LABELS;
  const author = input.author ?? agentLabels[0] ?? "AI";
  const now = input.now ?? new Date().toISOString();
  round ??= buildReviewRound(input.base, {
    roundId: response.roundId,
    agentLabels,
    allowLegacy: input.allowLegacy,
    createdAt: now,
  });

  let reference = base;
  let baselineUsed = false;
  if (typeof input.baseline === "string") {
    try {
      reference = loadCanonical(input.baseline, { allowLegacy: true });
      baselineUsed = true;
    } catch {
      // An unreadable baseline is ignored; the round's base stands in.
    }
  }

  // ---- put back Jordan's items changed outside Roughdraft. Everything after
  // this works on the restored document.
  const damaged = cloneDoc(current.doc);
  const restored = restoreOutsideChanges(
    damaged,
    reference.doc,
    agentLabels,
    errors,
  );
  if (errors.length > 0) return refuse(report, errors);
  const restoredDoc =
    restored.length > 0
      ? loadCanonical(serializeDoc(damaged), { allowLegacy: true })
      : current;
  const work = cloneDoc(restoredDoc.doc);
  const jordanBefore = cloneDoc(work);

  const baseThreads = threadsOf(base, agentLabels);
  const refThreads = threadsOf(reference, agentLabels);
  const curThreads = threadsOf(restoredDoc, agentLabels);
  const roundThreads = new Map(
    round.threads.map((thread) => [thread.id, thread]),
  );
  const actions = Object.entries(response.threads ?? {});
  const isAgent = (by: string | null) => agentLabels.includes(by ?? "");
  const writes = (action: RfmThreadAction) =>
    action.skip === undefined &&
    (action.reply !== undefined ||
      Boolean(action.resolve) ||
      action.decision !== undefined);

  report = {
    ...report,
    roundId: round.roundId,
    normalized: current.changes,
    restored,
    rebase: {
      baseChanged: input.current !== input.base,
      baselineUsed,
      outsideChanges: restored.length > 0,
      newThreads: [...curThreads.keys()].filter((id) => !baseThreads.has(id)),
    },
  };

  // ---- already applied: every reply and the note are in the file, every
  // decided suggestion is gone, every resolve is set.
  if (actions.some(([, action]) => writes(action)) || response.note) {
    const done = actions.every(([id, action]) => {
      const was = baseThreads.get(id);
      const nowThread = curThreads.get(id);
      if (!writes(action)) return true;
      if (action.decision) return !curThreads.has(id) && Boolean(was);
      if (!nowThread || !was) return false;
      const fresh = nowThread.replies.filter(
        (reply) =>
          isAgent(reply.author) &&
          !was.replies.some((old) => old.id === reply.id),
      );
      if (
        action.reply !== undefined &&
        !fresh.some((reply) => reply.body === action.reply)
      )
        return false;
      if (action.resolve && nowThread.status !== "resolved") return false;
      return true;
    });
    const noteDone =
      !response.note ||
      [...curThreads.values()].some(
        (thread) =>
          thread.kind === "document" &&
          isAgent(thread.author) &&
          !baseThreads.has(thread.id) &&
          thread.body.startsWith(response.note?.trim() ?? ""),
      );
    if (done && noteDone && restored.length === 0) {
      return {
        markdown: input.current,
        report: { ...report, ok: true, status: "already-applied" },
        errors: [],
      };
    }
  }

  // ---- per-thread rebase and shape checks.
  for (const [id, action] of actions) {
    const was = baseThreads.get(id);
    const ref = refThreads.get(id);
    const nowThread = curThreads.get(id);
    if (!roundThreads.has(id) || !was) {
      errors.push(
        nowThread
          ? {
              code: "thread-not-in-round",
              thread: id,
              message: `${id} was added after the round started`,
              hint: "Start a new round to answer it.",
            }
          : {
              code: "unknown-thread",
              thread: id,
              message: `${id} is not a thread of round ${round.roundId}`,
              hint: `Threads in the round: ${[...roundThreads.keys()].join(", ")}`,
            },
      );
      continue;
    }
    if (!nowThread) {
      if (writes(action)) {
        errors.push({
          code: "thread-removed",
          thread: id,
          message: `${id} was removed from the document after the round started`,
          hint: "Start a new round.",
        });
      }
      continue;
    }
    if (!writes(action)) continue;
    const jordanReplies = (thread: RfmRoundThread) =>
      thread.replies
        .filter((reply) => !isAgent(reply.author))
        .map((reply) => reply.id);
    const newJordanReplies = jordanReplies(nowThread).filter(
      (replyId) => !jordanReplies(was).includes(replyId),
    );
    if (
      (ref && jordanPart(ref, agentLabels) !== jordanPart(was, agentLabels)) ||
      newJordanReplies.length > 0
    ) {
      errors.push({
        code: "thread-changed",
        thread: id,
        message:
          newJordanReplies.length > 0
            ? `${id} has a new reply from Jordan since the round started`
            : `Jordan edited ${id} since the round started`,
        hint: "Start a new round so the answer reads his latest words.",
      });
    }
    const freshAgent = nowThread.replies.filter(
      (reply) =>
        isAgent(reply.author) &&
        !was.replies.some((old) => old.id === reply.id),
    );
    if (
      action.reply !== undefined &&
      freshAgent.length > 0 &&
      !action.followUp
    ) {
      errors.push({
        code: "already-replied-this-round",
        thread: id,
        message: `${id} already has an agent reply written in this round`,
        hint: "Set followUp: true to add another.",
      });
    }
    if (nowThread.kind === "suggestion") {
      if (action.resolve)
        errors.push({
          code: "resolve-on-suggestion",
          thread: id,
          message: `${id} is a suggestion; use decision accept or reject`,
        });
      if (
        action.decision &&
        nowThread.replies.length > 0 &&
        !action.dropReplies
      ) {
        errors.push({
          code: "thread-has-replies",
          thread: id,
          message: `${id} has ${nowThread.replies.length} repl${nowThread.replies.length === 1 ? "y" : "ies"}; deciding it removes them`,
          hint: "Set dropReplies: true to decide it anyway (the replies are listed in droppedReplies).",
        });
      }
    } else if (action.decision) {
      errors.push({
        code: "decision-on-comment",
        thread: id,
        message: `${id} is a comment; decision applies to suggestions only`,
      });
    }
  }
  if (
    current.model.split.status === "ignored" &&
    (actions.some(([, action]) => action.reply !== undefined) || response.note)
  ) {
    errors.push({
      code: "document-invalid",
      thread: "response",
      message:
        "the file ends with a comments: or suggestions: section that is part of the text, so a review block cannot be added after it",
      hint: "Rename or move that section, then start a new round.",
    });
  }

  // ---- coverage.
  if (!response.partial) {
    for (const thread of round.threads) {
      if (!thread.needsAnswer || !curThreads.has(thread.id)) continue;
      const action = response.threads?.[thread.id];
      const answered =
        action &&
        (action.reply !== undefined ||
          action.skip !== undefined ||
          action.followUp ||
          action.decision ||
          action.resolve);
      if (!answered) {
        errors.push({
          code: "unanswered-thread",
          thread: thread.id,
          message: `${thread.id} needs an answer: a reply, a decision, resolve, or skip with a reason`,
          hint: "Or set partial: true to answer it in a later round.",
        });
      }
    }
  }
  if (errors.length > 0) return refuse(report, errors);

  // ---- edits: an edited clean.md, or edit specs.
  const baseClean = cleanTextOfDoc(base.doc, base.bodyOffset).clean;
  const hunks: CleanHunk[] =
    typeof input.cleanEdited === "string"
      ? diffCleanText(baseClean, input.cleanEdited)
      : [];
  const specs = response.edits ?? [];
  if (hunks.length > 0 && specs.length > 0) {
    errors.push({
      code: "bad-edit",
      thread: "edits",
      message: "send edits or an edited clean.md, not both",
    });
    return refuse(report, errors);
  }
  const currentClean = cleanViewOf(work.pieces).text;
  const code = codeRanges(currentClean);
  const planned: PlannedEdit[] = [];
  hunks.forEach((hunk, index) => {
    const unit = `clean.md#${index + 1}`;
    const located = locateHunk(baseClean, currentClean, hunk);
    if ("code" in located) {
      errors.push({
        code: located.code,
        thread: unit,
        message: `${unit}: ${located.message}`,
        ...("hint" in located && located.hint ? { hint: located.hint } : {}),
        ...("lines" in located ? { lines: located.lines } : {}),
      });
      return;
    }
    const oldText = baseClean.slice(hunk.start, hunk.end);
    if (
      MARKUP.test(hunk.text) &&
      !MARKUP.test(oldText) &&
      !insideCode(code, located.start, located.end)
    ) {
      errors.push({
        code: "markup-in-edit",
        thread: unit,
        message: `${unit}: the edited clean.md adds review markup at line ${lineOfClean(currentClean, located.start)}; write plain text (markup is only literal inside code)`,
      });
      return;
    }
    planned.push({
      unit,
      start: located.start,
      end: located.end,
      text: hunk.text,
      mode: located.mode,
    });
  });
  const anchorsNow = cleanTextOfDoc(work, 0).map.anchors;
  specs.forEach((spec, index) => {
    const unit = `edits[${index}]`;
    const ranges = locateSpec(currentClean, spec, anchorsNow, unit, errors);
    for (const range of ranges)
      planned.push({ unit, ...range, text: spec.new });
  });
  planned.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < planned.length; index += 1) {
    const previous = planned[index - 1] as PlannedEdit;
    const next = planned[index] as PlannedEdit;
    if (
      next.start < previous.end ||
      (next.start === previous.start && next.end === previous.end)
    ) {
      errors.push({
        code: "edits-overlap",
        thread: next.unit,
        message: `${next.unit} overlaps ${previous.unit}`,
      });
    }
  }
  if (errors.length > 0) return refuse(report, errors);

  // ---- apply edits from last to first.
  const editReports: RfmApplyEditReport[] = [];
  const orphaned = new Set<string>();
  for (const edit of [...planned].reverse()) {
    const outcome = applyEditAt(
      work,
      edit.start,
      edit.end,
      edit.text,
      !edit.unit.startsWith("clean.md"),
    );
    if ("code" in outcome) {
      errors.push({
        code: "edit-touches-suggestion",
        thread: edit.unit,
        message: `${edit.unit}: the edit at line ${lineOfClean(currentClean, edit.start)} overlaps pending suggestion ${outcome.suggestion}`,
        hint: `Leave that text as it is; decide ${outcome.suggestion} with decision accept or reject only if Jordan asked.`,
      });
      continue;
    }
    for (const id of outcome.orphaned) orphaned.add(id);
    editReports.unshift({
      unit: edit.unit,
      line: lineOfClean(currentClean, edit.start),
      match: edit.mode,
      anchors: outcome.anchors,
    });
  }
  if (errors.length > 0) return refuse(report, errors);
  // A comment whose text an edit removed keeps a standalone ref there only
  // when no highlight of it is left anywhere.
  const anchoredAfter = new Set<string>();
  for (const piece of work.pieces) {
    if (piece.t === "hl" || piece.t === "sug")
      for (const id of piece.ids) anchoredAfter.add(id);
    if (piece.t === "fref") anchoredAfter.add(piece.id);
  }
  for (const piece of work.pieces) {
    if (piece.t !== "ref") continue;
    piece.ids = piece.ids.filter(
      (id) => !(orphaned.has(id) && anchoredAfter.has(id)),
    );
  }
  work.pieces = normalizePieces(
    work.pieces.filter((piece) => piece.t !== "ref" || piece.ids.length > 0),
    true,
  );
  for (const editReport of editReports) {
    for (const anchor of editReport.anchors) {
      if (anchor.result === "segment-removed" && !anchoredAfter.has(anchor.id))
        anchor.result = "standalone";
    }
  }
  // Anchor data follows the text: it changes on the current side.
  for (const id of fixFenceRefs(work, editReports)) {
    const entry = work.comments.get(id);
    if (entry) delete entry.lines;
  }
  report.edits = editReports;
  report.anchors = editReports.flatMap((item) => item.anchors);
  if (planned.length > 0) {
    report.anchors.push(...followCodeAnchors(work, work.comments));
    // An edit that changes the document's structure (an opened or removed
    // code fence, a new review-shaped section) can hide review markup from
    // every reader; read the edited document back before going on.
    const readBack = buildReviewDoc(serializeDoc(work));
    const lost = [...anchorIdsOf(work)].filter(
      (id) => !readBack.doc || !anchorIdsOf(readBack.doc).has(id),
    );
    if (lost.length > 0 || !readBack.doc || readBack.changes.length > 0) {
      errors.push({
        code: "edit-breaks-markup",
        thread: "edits",
        message: `after the edits, ${lost.length > 0 ? `the anchor of ${lost.join(", ")} is no longer read as review markup` : "review markup lands where it is not read as written (inside code, or past a new section break)"}; a code fence or a section break changed`,
        hint: "Keep code fences paired and leave the end of the file as it is.",
      });
      return refuse(report, errors);
    }
  }

  // ---- the agent's entry changes, made on the round's view of the entries.
  const agent = {
    comments: cloneEntries(base.doc.comments),
    suggestions: cloneEntries(base.doc.suggestions),
  };

  // ---- decisions.
  const noteLines: string[] = [];
  for (const [id, action] of actions) {
    if (!action.decision) continue;
    const group = suggestionGroupIds(work, id);
    const thread = curThreads.get(id);
    const positions: number[] = [];
    work.pieces.forEach((piece, position) => {
      if (piece.t === "sug" && group.includes(piece.id))
        positions.push(position);
    });
    for (const position of positions.reverse()) {
      const piece = work.pieces[position] as Extract<Piece, { t: "sug" }>;
      const text = action.decision === "accept" ? piece.new : piece.old;
      const replacement: Piece[] = [];
      if (text) {
        replacement.push(
          piece.ids.length > 0
            ? { t: "hl", s: text, ids: [...piece.ids], fresh: true }
            : { t: "text", s: text },
        );
      } else if (piece.ids.length > 0) {
        replacement.push({ t: "ref", ids: [...piece.ids] });
      }
      work.pieces.splice(
        position,
        1,
        ...(replacement.length > 0
          ? replacement
          : [{ t: "text", s: "" } as Piece]),
      );
      if (!text) collapseBlankLines(work.pieces, position + replacement.length);
    }
    work.pieces = normalizePieces(work.pieces, true);
    for (const partId of group) agent.suggestions.delete(partId);
    for (const replyId of descendantIds(work, id)) {
      const entry = work.comments.get(replyId);
      if (!entry) continue;
      report.droppedReplies.push({
        thread: id,
        id: replyId,
        author: typeof entry.by === "string" ? entry.by : null,
        body: typeof entry.body === "string" ? entry.body : "",
      });
      agent.comments.delete(replyId);
    }
    (action.decision === "accept" ? report.accepted : report.rejected).push(id);
    const summary = thread?.suggestion;
    const what = summary
      ? summary.type === "deletion"
        ? `deleting "${clip(summary.original)}"`
        : summary.type === "addition"
          ? `adding "${clip(summary.proposed)}"`
          : `"${clip(summary.original)}" to "${clip(summary.proposed)}"`
      : id;
    noteLines.push(
      `${action.decision === "accept" ? "Accepted" : "Rejected"} your suggestion ${what}${action.reply ? `: ${action.reply.trim()}` : "."}`,
    );
  }

  // ---- replies, resolutions, skips, the note.
  const taken = new Set<string>([
    ...allIds(work),
    ...agent.comments.keys(),
    ...agent.suggestions.keys(),
  ]);
  const allocate = () => {
    let max = 0;
    for (const id of taken) {
      const match = /^a(\d+)$/.exec(id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    const id = `a${max + 1}`;
    taken.add(id);
    return id;
  };
  for (const [id, action] of actions) {
    if (action.skip !== undefined) {
      report.skipped.push({ id, reason: action.skip });
      continue;
    }
    if (action.decision) continue;
    if (action.reply !== undefined) {
      const replyId = allocate();
      agent.comments.set(replyId, {
        body: action.reply,
        by: author,
        at: now,
        re: id,
      });
      report.replies.push({ thread: id, id: replyId });
    }
    if (action.resolve) {
      const entry = agent.comments.get(id);
      if (entry) {
        entry.status = "resolved";
        if (typeof action.resolve === "string") entry.resolved = action.resolve;
        report.resolved.push(id);
      }
    }
  }
  const noteText = [response.note?.trim(), ...noteLines]
    .filter(Boolean)
    .join(" ");
  if (noteText) {
    const noteId = allocate();
    agent.comments.set(noteId, {
      body: noteText,
      by: author,
      at: now,
      scope: "document",
    });
    report.note = noteId;
  }

  // The current entries (Jordan's browser saves, the restores, anchor data
  // that followed the edits) and the agent's changes meet key by key over the
  // round's base; a key both changed differently is a conflict.
  const merged = mergeReviewEntries(
    { comments: base.doc.comments, suggestions: base.doc.suggestions },
    { comments: work.comments, suggestions: work.suggestions },
    agent,
  );
  if (merged.conflicts.length > 0) {
    errors.push(
      ...merged.conflicts.map((conflict) => ({
        code: "entry-conflict",
        thread: conflict.id,
        message: `${conflict.id}${conflict.key ? `.${conflict.key}` : ""} changed since the round started and the response changes it too`,
        hint: "Start a new round.",
      })),
    );
    return refuse(report, errors);
  }
  work.comments = merged.entries.comments;
  work.suggestions = merged.entries.suggestions;

  const markdown = serializeDoc(work);
  const expectedClean = cleanViewOf(work.pieces).text;

  // ---- gates.
  const gateErrors = runGates({
    markdown,
    expectedClean,
    before: jordanBefore,
    agentLabels,
    resolved: new Set(report.resolved),
    decided: new Set(
      [...report.accepted, ...report.rejected].flatMap((id) =>
        suggestionGroupIds(jordanBefore, id),
      ),
    ),
    dropped: new Set(report.droppedReplies.map((item) => item.id)),
    currentCanonical: current.canonical,
  });
  if (gateErrors.length > 0) return refuse(report, gateErrors);

  const summary = parseReviewModel(markdown).summary;
  report.remaining = round.threads
    .filter(
      (thread) =>
        thread.needsAnswer &&
        curThreads.has(thread.id) &&
        !(thread.id in (response.threads ?? {})),
    )
    .map((thread) => thread.id);
  report.doctor = {
    ok: true,
    comments: summary.comments,
    roots: summary.roots,
    documentComments: summary.documentComments,
    replies: summary.replies,
    suggestions: summary.suggestions,
  };
  return {
    markdown,
    report: { ...report, ok: true, status: "applied", errors: [] },
    errors: [],
  };
}

/**
 * A comment on code follows edits inside its block: when its quoted lines
 * moved, `lines` follows them; when they changed, it covers the same line
 * numbers (kept inside the block) and `quote` takes their new text.
 */
function followCodeAnchors(
  doc: ReviewDoc,
  entries: Map<string, Entry>,
): RfmApplyAnchorReport[] {
  const reports: RfmApplyAnchorReport[] = [];
  const view = cleanViewOf(doc.pieces);
  doc.pieces.forEach((piece, index) => {
    if (piece.t !== "fref") return;
    const entry = entries.get(piece.id);
    const range = Array.isArray(entry?.lines)
      ? (entry?.lines as number[])
      : null;
    if (!entry || !range || typeof entry.quote !== "string") return;
    const at = (view.spans[index] as [number, number])[0];
    const lineStart = view.text.lastIndexOf("\n", at - 1) + 1;
    const marker = view.text
      .slice(lineStart, at)
      .match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
    const codeStart = view.text.indexOf("\n", at) + 1;
    if (!marker || codeStart === 0) return;
    const lines: string[] = [];
    for (const line of view.text.slice(codeStart).split("\n")) {
      const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (close && close[0] === marker[0] && close.length >= marker.length)
        break;
      lines.push(line);
    }
    const [first, last] = range as [number, number];
    if (lines.slice(first - 1, last).join("\n") === entry.quote) return;
    const quoted = entry.quote.split("\n");
    const spots: number[] = [];
    for (let start = 0; start + quoted.length <= lines.length; start += 1) {
      if (lines.slice(start, start + quoted.length).join("\n") === entry.quote)
        spots.push(start);
    }
    if (spots.length === 1) {
      const start = spots[0] as number;
      entry.lines = [start + 1, start + quoted.length];
      reports.push({ id: piece.id, result: "moved" });
      return;
    }
    const end = Math.max(1, Math.min(last, lines.length));
    const begin = Math.min(first, end);
    entry.lines = [begin, end];
    entry.quote = lines.slice(begin - 1, end).join("\n");
    reports.push({ id: piece.id, result: "widened" });
  });
  return reports;
}

/** A fence ref an edit moved off its fence line becomes a standalone ref. */
function fixFenceRefs(
  doc: ReviewDoc,
  editReports: RfmApplyEditReport[],
): string[] {
  const moved: string[] = [];
  const view = cleanViewOf(doc.pieces);
  doc.pieces.forEach((piece, index) => {
    if (piece.t !== "fref") return;
    const at = (view.spans[index] as [number, number])[0];
    const lineStart = view.text.lastIndexOf("\n", at - 1) + 1;
    const line = view.text.slice(lineStart, at);
    const after = view.text[at];
    if (
      /^[ \t]{0,3}(`{3,}|~{3,})/.test(line) &&
      (after === "\n" || after === undefined)
    )
      return;
    doc.pieces[index] = { t: "ref", ids: [piece.id] };
    for (const editReport of editReports) {
      for (const anchor of editReport.anchors)
        if (anchor.id === piece.id) anchor.result = "standalone";
    }
    moved.push(piece.id);
  });
  return moved;
}

function locateSpec(
  clean: string,
  spec: RfmEditSpec,
  anchors: Array<{
    id: string;
    cleanStart: number;
    cleanEnd: number;
    kind: string;
  }>,
  unit: string,
  errors: RfmApplyError[],
): Array<{ start: number; end: number; mode: MatchMode }> {
  const near = spec.near
    ? anchors.filter((anchor) => anchor.id === spec.near)
    : [];
  const blocks = cleanBlocks(clean);
  const nearRange: [number, number] | null =
    near.length > 0
      ? [
          blocks.find((block) => block.end >= (near[0]?.cleanStart ?? 0))
            ?.start ?? 0,
          [...blocks]
            .reverse()
            .find((block) => block.start <= (near.at(-1)?.cleanEnd ?? 0))
            ?.end ?? clean.length,
        ]
      : null;
  const pick = (needle: string, what: string, after = -1): Located | null => {
    let { matches, mode } = findMatches(clean, needle);
    if (after >= 0) matches = matches.filter(([start]) => start >= after);
    if (matches.length === 0) {
      errors.push({
        code: "edit-not-found",
        thread: unit,
        message: `${unit}: the ${what} text "${clip(needle)}" is not in the clean text`,
        hint: "Copy it exactly from the current clean.md (start a new round if the document changed).",
      });
      return null;
    }
    if (matches.length === 1 || after >= 0) {
      const [start, end] = matches[0] as [number, number];
      return { start, end, mode };
    }
    if (nearRange) {
      const inside = matches.filter(
        ([start, end]) => start < nearRange[1] && end > nearRange[0],
      );
      if (inside.length === 1) {
        const [start, end] = inside[0] as [number, number];
        return { start, end, mode };
      }
    }
    errors.push({
      code: "edit-ambiguous",
      thread: unit,
      message: `${unit}: the ${what} text "${clip(needle)}" occurs ${matches.length} times; quote more of the sentence or name the thread with "near"`,
      lines: matches.map(([start]) => lineOfClean(clean, start)),
    });
    return null;
  };
  if (typeof spec.anchor === "string") {
    const own = anchors.filter(
      (anchor) => anchor.id === spec.anchor && anchor.kind === "highlight",
    );
    if (own.length === 0) {
      errors.push({
        code: "edit-not-found",
        thread: unit,
        message: `${unit}: ${spec.anchor} has no highlighted text to replace`,
      });
      return [];
    }
    return [
      {
        start: own[0]?.cleanStart ?? 0,
        end: own.at(-1)?.cleanEnd ?? 0,
        mode: "exact",
      },
    ];
  }
  if (typeof spec.old === "string") {
    if (spec.all) {
      const { matches, mode } = findMatches(clean, spec.old);
      if (matches.length === 0) {
        errors.push({
          code: "edit-not-found",
          thread: unit,
          message: `${unit}: "${clip(spec.old)}" is not in the clean text`,
        });
      }
      return matches.map(([start, end]) => ({ start, end, mode }));
    }
    const located = pick(spec.old, "old");
    return located ? [located] : [];
  }
  const from = pick(spec.from ?? "", "from");
  if (!from) return [];
  const to = pick(spec.to ?? "", "to", from.start);
  if (!to) return [];
  return [
    {
      start: from.start,
      end: to.end,
      mode:
        from.mode === "exact" && to.mode === "exact" ? "exact" : "whitespace",
    },
  ];
}

// ------------------------------------------------------------------ gates

interface GateInput {
  markdown: string;
  expectedClean: string;
  before: ReviewDoc;
  agentLabels: string[];
  resolved: Set<string>;
  decided: Set<string>;
  dropped: Set<string>;
  currentCanonical: string;
}

const ITEM_KEYS = [
  "body",
  "by",
  "at",
  "re",
  "scope",
  "lines",
  "quote",
  "continues",
] as const;

function runGates(gate: GateInput): RfmApplyError[] {
  const errors: RfmApplyError[] = [];
  const fail = (code: string, message: string) =>
    errors.push({
      code,
      thread: "response",
      message: `${message} (a Roughdraft bug; nothing was written)`,
    });

  // 1. The fork's rfm reads it with no errors, and it is canonical.
  const model = parseReviewModel(gate.markdown);
  const forkErrors = model.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (forkErrors.length > 0) {
    fail(
      "gate-fork-validation",
      `rfm reports ${forkErrors.map((error) => `${error.code} at line ${error.line}`).join(", ")}`,
    );
  }
  const rebuilt = buildReviewDoc(gate.markdown);
  if (
    !rebuilt.doc ||
    rebuilt.changes.length > 0 ||
    serializeDoc(rebuilt.doc) !== gate.markdown
  ) {
    fail(
      "gate-not-canonical",
      `the result is not in the canonical shape (${rebuilt.changes.map((change) => change.code).join(", ")})`,
    );
  }

  // 2. The frozen 0.1.10 reader finds no error the document did not have.
  const legacyBefore = new Set(
    validateWithLegacyReader(gate.currentCanonical).errors.map(
      (error) => error.code,
    ),
  );
  const legacyNew = validateWithLegacyReader(gate.markdown).errors.filter(
    (error) => !legacyBefore.has(error.code),
  );
  if (legacyNew.length > 0) {
    fail(
      "gate-legacy-reader",
      `rfm 0.1.10 reports ${legacyNew.map((error) => `${error.code} at line ${error.line}`).join(", ")}`,
    );
  }

  // 3. The rd-lint rules find no hazard the document did not have.
  const lintBefore = new Set(
    lintRoughdraftMarkdown(gate.currentCanonical).fails,
  );
  const lintNew = lintRoughdraftMarkdown(gate.markdown).fails.filter(
    (message) => !lintBefore.has(message),
  );
  if (lintNew.length > 0) fail("gate-lint", `rd-lint: ${lintNew.join("; ")}`);

  // 4. The clean text reads back as expected.
  const back = rebuilt.doc ? cleanTextOfDoc(rebuilt.doc, 0).clean : null;
  // Trailing blank lines before the review block are the writer's, not prose.
  const trimmed = (text: string | null) =>
    (text ?? "").replace(/^\s+|\s+$/g, "");
  if (back === null || trimmed(back) !== trimmed(gate.expectedClean)) {
    fail(
      "gate-clean-text",
      "re-reading the result does not give the expected prose",
    );
  }

  // 5. None of Jordan's items lost or changed its body.
  const isJordan = (entry: Entry) =>
    !gate.agentLabels.includes(typeof entry.by === "string" ? entry.by : "");
  const after = rebuilt.doc;
  const anchored = after ? anchorIdsOf(after) : new Set<string>();
  const anchoredBefore = anchorIdsOf(gate.before);
  for (const section of ["comments", "suggestions"] as const) {
    for (const [id, entry] of gate.before[section]) {
      if (!isJordan(entry) || gate.decided.has(id) || gate.dropped.has(id))
        continue;
      const now = after?.[section].get(id);
      if (!now) {
        fail("gate-item-lost", `${id} is missing from the result`);
        continue;
      }
      for (const key of ITEM_KEYS) {
        if (key === "lines" || key === "quote") continue; // anchor data follows edits
        if (
          key === "scope" &&
          entry.scope === undefined &&
          now.scope === undefined
        )
          continue;
        if (JSON.stringify(entry[key]) !== JSON.stringify(now[key])) {
          fail("gate-item-changed", `${id}.${key} changed in the result`);
        }
      }
      if (!gate.resolved.has(id)) {
        for (const key of ["status", "resolved"]) {
          if (JSON.stringify(entry[key]) !== JSON.stringify(now[key]))
            fail("gate-item-changed", `${id}.${key} changed in the result`);
        }
      }
      if (anchoredBefore.has(id) && !anchored.has(id))
        fail("gate-anchor-lost", `${id} lost its place in the text`);
    }
  }
  return errors;
}
