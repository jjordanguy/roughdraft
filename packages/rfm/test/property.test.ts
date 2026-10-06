// Property: random edits to a round's clean text, applied through
// applyReviewResponse, either land exactly as asked or are refused with a
// named reason; nothing of Jordan's is lost or changed, and the result passes
// the fork, the frozen 0.1.10 reader and the rd-lint rules. Seeded, so every
// run is the same.
import { describe, expect, it } from "vitest";
import {
  applyReviewResponse,
  buildReviewRound,
  lintRoughdraftMarkdown,
  normalizeRoughdraftMetadata,
  reviewCleanText,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "../src/index";
import { loadFixtures } from "./fixture-helpers";
import { APPLY_AT, jordanItems } from "./review-helpers";

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "launch",
  "Ana",
  "the pilot",
  "three",
  "customers",
  "owner",
  "June",
  "budget",
  "is",
  "small",
  "and",
  "ops",
  "(see table)",
  ".",
];
const BLOCKS = [
  "\n\nA new paragraph about the pilot.\n\n",
  "\n- a new list item\n",
  "\n\n## A new heading\n\n",
  " and a clause,",
  "\nsecond line",
];

function randomEdit(clean: string, next: () => number): string {
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)] as T;
  const position = Math.floor(next() * (clean.length + 1));
  const kind = Math.floor(next() * 4);
  if (kind === 0) {
    // Replace a word.
    const words = [...clean.matchAll(/[A-Za-z]{3,}/g)];
    if (words.length === 0) return clean;
    const word = pick(words);
    const start = word.index ?? 0;
    return (
      clean.slice(0, start) + pick(WORDS) + clean.slice(start + word[0].length)
    );
  }
  if (kind === 1)
    return (
      clean.slice(0, position) +
      pick([...WORDS.map((word) => ` ${word}`), ...BLOCKS]) +
      clean.slice(position)
    );
  if (kind === 2) {
    const length = 1 + Math.floor(next() * 40);
    return clean.slice(0, position) + clean.slice(position + length);
  }
  // Rewrite a whole line.
  const lines = clean.split("\n");
  const index = Math.floor(next() * lines.length);
  if (/^\s*(```|~~~)/.test(lines[index] ?? "")) return clean;
  lines[index] = `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`;
  return lines.join("\n");
}

// RFM_PROPERTY_TRIALS raises the count for a longer local run.
const TRIALS = Number(process.env.RFM_PROPERTY_TRIALS ?? 12);
let appliedTotal = 0;
let trialsTotal = 0;

const ALLOWED_REFUSALS = new Set([
  "edit-touches-suggestion",
  "edit-breaks-markup",
]);

const inputs = loadFixtures()
  .map((fixture) => ({
    name: fixture.name,
    result: normalizeRoughdraftMetadata(fixture.markdown),
  }))
  .filter(({ result }) => result.refused.length === 0)
  .map(({ name, result }) => ({ name, markdown: result.markdown }));

describe("property: random clean-text edits keep Jordan's items and both readers happy", () => {
  it.each(
    inputs.map((input, index) => [input.name, input, index] as const),
  )("%s", (_name, input, index) => {
    const next = random(1000 + index);
    const round = buildReviewRound(input.markdown, {
      roundId: "r-prop",
      createdAt: "2026-10-04T21:00:00.000Z",
    });
    const legacyBefore = new Set(
      validateWithLegacyReader(input.markdown).errors.map(
        (error) => error.code,
      ),
    );
    const lintBefore = new Set(lintRoughdraftMarkdown(input.markdown).fails);
    let applied = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      let edited = round.clean;
      const count = 1 + Math.floor(next() * 3);
      for (let edit = 0; edit < count; edit += 1)
        edited = randomEdit(edited, next);
      if (
        /^\s*(```|~~~|---)/m.test(edited) &&
        edited.split(/^\s*(?:```|~~~)/m).length !==
          round.clean.split(/^\s*(?:```|~~~)/m).length
      ) {
        continue;
      }
      const result = applyReviewResponse({
        base: input.markdown,
        current: input.markdown,
        cleanEdited: edited,
        response: {
          roughdraftResponse: 1,
          roundId: round.roundId,
          partial: true,
          threads: {},
          note: "Round note.",
        },
        round,
        now: APPLY_AT,
      });
      trialsTotal += 1;
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          expect(
            ALLOWED_REFUSALS.has(error.code),
            `${error.code}: ${error.message}\n--- edited:\n${edited}`,
          ).toBe(true);
        }
        expect(result.markdown).toBeNull();
        continue;
      }
      applied += 1;
      appliedTotal += 1;
      const output = result.markdown as string;
      expect(reviewCleanText(output).clean.trim()).toBe(edited.trim());
      expect(jordanItems(output)).toEqual(jordanItems(input.markdown));
      expect(validateRoughdraftMarkdown(output).errors).toEqual([]);
      expect(
        validateWithLegacyReader(output).errors.filter(
          (error) => !legacyBefore.has(error.code),
        ),
      ).toEqual([]);
      expect(
        lintRoughdraftMarkdown(output).fails.filter(
          (fail) => !lintBefore.has(fail),
        ),
      ).toEqual([]);
      const again = normalizeRoughdraftMetadata(output);
      expect(again.changes).toEqual([]);
    }
    void applied;
  });

  it("lands most edits (the rest touch a pending suggestion or a fence)", () => {
    expect(trialsTotal).toBeGreaterThan(500);
    expect(appliedTotal / trialsTotal).toBeGreaterThan(0.6);
  });
});
