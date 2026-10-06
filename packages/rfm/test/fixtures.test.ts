// Conformance over docs/spec/fixtures: every fixture's split status,
// diagnostics and review items are pinned in the expected.json beside it.
// Regenerate after a deliberate change with:
//   RFM_UPDATE_FIXTURES=1 pnpm --filter @roughdraft/rfm test
// and review the diff of the .expected.json files.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractReviewIndexWithLegacyReader,
  extractRoughdraftReviewIndex,
  splitRoughdraftDocument,
  stringifyRoughdraftEndmatter,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "../src/index";
import {
  conformanceItems,
  type Fixture,
  isCanonical,
  loadFixtures,
} from "./fixture-helpers";

const update = process.env.RFM_UPDATE_FIXTURES === "1";
const fixtures = loadFixtures();
const canonical = fixtures.filter(isCanonical);
const cases = fixtures.map((fixture) => [fixture.name, fixture] as const);
const canonicalCases = canonical.map(
  (fixture) => [fixture.name, fixture] as const,
);

function actualFor(fixture: Fixture) {
  const split = splitRoughdraftDocument(fixture.markdown);
  const validation = validateRoughdraftMarkdown(fixture.markdown);
  const index = extractRoughdraftReviewIndex(fixture.markdown);
  return {
    status: split.status,
    ok: validation.ok,
    diagnostics: validation.diagnostics.map(
      (diagnostic) => `${diagnostic.severity} ${diagnostic.code}`,
    ),
    summary: {
      comments: validation.summary.comments,
      roots: validation.summary.roots,
      documentComments: validation.summary.documentComments,
      replies: validation.summary.replies,
      suggestions: validation.summary.suggestions,
    },
    items: conformanceItems(index),
  };
}

describe("docs/spec/fixtures", () => {
  it("covers the canonical format, the legacy forms, the format probe and the browser repro cases", () => {
    const prefixes = new Set(fixtures.map((f) => f.name.split("-")[0]));
    expect(prefixes).toEqual(
      new Set([
        "anchored",
        "canonical",
        "legacy",
        "probe",
        "repro",
        "suggestion",
      ]),
    );
    expect(fixtures.filter((f) => f.name.startsWith("probe-"))).toHaveLength(
      23,
    );
  });

  it.each(cases)("%s: matches expected.json", (_name, fixture) => {
    const actual = actualFor(fixture);
    if (update) {
      fs.writeFileSync(
        fixture.expectedPath,
        `${JSON.stringify(actual, null, 2)}\n`,
      );
      return;
    }
    const expected = JSON.parse(fs.readFileSync(fixture.expectedPath, "utf8"));
    // Status first so a split regression fails with a specific message.
    expect(actual.status).toBe(expected.status);
    expect(actual).toEqual(expected);
  });

  it("splits every fixture losslessly", () => {
    for (const fixture of fixtures) {
      const split = splitRoughdraftDocument(fixture.markdown);
      expect(
        `${split.frontmatter ?? ""}${split.body}${split.endmatter ?? ""}`,
        fixture.name,
      ).toBe(fixture.markdown);
    }
  });
});

describe("canonical fixtures", () => {
  it("exist for every new-format shape", () => {
    expect(canonical.length).toBeGreaterThanOrEqual(10);
  });

  it.each(
    canonicalCases,
  )("%s: is recognized and has no errors", (_name, fixture) => {
    const validation = validateRoughdraftMarkdown(fixture.markdown);
    expect(validation.summary.endmatter).toBe("recognized");
    expect(validation.errors).toEqual([]);
  });

  it.each(
    canonicalCases,
  )("%s: the canonical writer reproduces the review block byte for byte", (_name, fixture) => {
    const split = splitRoughdraftDocument(fixture.markdown);
    expect(stringifyRoughdraftEndmatter(split.entries)).toBe(split.endmatter);
  });

  it.each(
    canonicalCases,
  )("%s: 0.1.10 reads it with no errors and one item per logical comment", (_name, fixture) => {
    const legacy = validateWithLegacyReader(fixture.markdown);
    expect(legacy.errors).toEqual([]);

    const legacyItems = extractReviewIndexWithLegacyReader(
      fixture.markdown,
    ).items.map((item) => [item.id, item.parentId]);
    const forkItems = extractRoughdraftReviewIndex(fixture.markdown).items.map(
      (item) => [item.id, item.parentId],
    );
    const byId = (a: (string | null)[], b: (string | null)[]) =>
      String(a[0]).localeCompare(String(b[0]));
    expect(legacyItems.sort(byId)).toEqual(forkItems.sort(byId));
  });
});
