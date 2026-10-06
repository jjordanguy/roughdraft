import fs from "node:fs";
import path from "node:path";
import {
  applyReviewResponse,
  buildReviewRound,
  extractRoughdraftReviewIndex,
  lintRoughdraftMarkdown,
  normalizeRoughdraftMetadata,
  type RfmApplyInput,
  type RfmApplyResult,
  type RfmReviewResponse,
  type RfmRound,
  type RfmThreadAction,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "../src/index";
import { fixturesDir } from "./fixture-helpers";

export const ROUND_AT = "2026-10-04T21:00:00.000Z";
export const APPLY_AT = "2026-10-04T21:05:00.000Z";

/** A spec fixture as written on disk. */
export function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, `${name}.md`), "utf8");
}

/** A document in the canonical shape: what `roughdraft doctor --fix` leaves. */
export function canonical(markdown: string): string {
  const result = normalizeRoughdraftMetadata(markdown);
  if (result.refused.length > 0) {
    throw new Error(
      `fixture refuses to normalize: ${JSON.stringify(result.refused)}`,
    );
  }
  return result.markdown;
}

export function startRound(
  markdown: string,
  roundId = "r-test",
  agentLabels?: string[],
): RfmRound {
  return buildReviewRound(markdown, {
    roundId,
    createdAt: ROUND_AT,
    agentLabels,
  });
}

export function response(
  roundId: string,
  threads: Record<string, RfmThreadAction>,
  extra: Partial<RfmReviewResponse> = {},
): RfmReviewResponse {
  return { roughdraftResponse: 1, roundId, threads, ...extra };
}

/** Apply with a fixed clock; `base` defaults to `current`. */
export function apply(
  input: Omit<RfmApplyInput, "base" | "now"> & { base?: string },
): RfmApplyResult {
  return applyReviewResponse({
    ...input,
    base: input.base ?? input.current,
    now: APPLY_AT,
  });
}

export function errorCodes(result: RfmApplyResult): string[] {
  return result.errors.map((error) => error.code);
}

/** Jordan's items (by a non-agent author) as `id kind parent by at status: body`. */
export function jordanItems(markdown: string, agentLabels = ["AI"]): string[] {
  return extractRoughdraftReviewIndex(markdown)
    .items.filter((item) => !agentLabels.includes(item.author ?? ""))
    .map(
      (item) =>
        `${item.id} ${item.kind} ${item.parentId ?? "-"} ${item.author} ${item.createdAt} ${item.status ?? "open"}: ${item.text}`,
    )
    .sort();
}

/** Both readers and the lint accept the document. */
export function readersAccept(markdown: string): {
  fork: string[];
  legacy: string[];
  lint: string[];
} {
  return {
    fork: validateRoughdraftMarkdown(markdown).errors.map(
      (error) => `${error.code}@${error.line}`,
    ),
    legacy: validateWithLegacyReader(markdown).errors.map(
      (error) => `${error.code}@${error.line}`,
    ),
    lint: lintRoughdraftMarkdown(markdown).fails,
  };
}

export const NO_PROBLEMS = { fork: [], legacy: [], lint: [] };
