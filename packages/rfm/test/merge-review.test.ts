// mergeReview: the tab's draft (ours) merged onto the file on disk (theirs).
// The list follows the sync review's "Merge tests (rfm unit)", plus the
// resolver round trip, the fixtures and the corpus.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  diffSequences,
  extractRoughdraftReviewIndex,
  mergeReview,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  validateRoughdraftMarkdown,
} from "../src/index";
import { loadFixtures } from "./fixture-helpers";

const NOW = "2026-10-06T10:00:00.000Z";

const BASE = `# Plan

Keep {==this claim==}{#c1} as written.

The pilot is small on purpose.

Closing line here.

---
comments:
  c1:
    body: "Needs a source."
    by: user
    at: "2026-10-05T09:00:00.000Z"
`;

function merge(base: string, ours: string, theirs: string) {
  return mergeReview(base, ours, theirs, { now: NOW });
}

function ids(markdown: string): string[] {
  return extractRoughdraftReviewIndex(markdown)
    .items.map((item) => item.id)
    .sort();
}

function expectValid(markdown: string) {
  const validation = validateRoughdraftMarkdown(markdown);
  expect(validation.errors).toEqual([]);
  const normalized = normalizeRoughdraftMetadata(markdown);
  expect(normalized.refused).toEqual([]);
  expect(normalized.markdown).toBe(markdown);
}

describe("mergeReview: shortcuts", () => {
  const edited = BASE.replace("small", "tiny");

  it("returns theirs when ours equals base", () => {
    expect(merge(BASE, BASE, edited)).toEqual({
      merged: edited,
      conflicts: [],
      suggestionsAdded: [],
      rekeyed: {},
    });
  });

  it("returns ours when theirs equals base", () => {
    expect(merge(BASE, edited, BASE).merged).toBe(edited);
  });

  it("returns ours when both made the same change", () => {
    expect(merge(BASE, edited, edited).merged).toBe(edited);
  });
});

describe("mergeReview: body", () => {
  it("merges edits to different paragraphs", () => {
    const ours = BASE.replace("small on purpose", "small, three customers");
    const theirs = BASE.replace("Closing line here.", "Closing line, revised.");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.suggestionsAdded).toEqual([]);
    expect(result.merged).toBe(
      BASE.replace("small on purpose", "small, three customers").replace(
        "Closing line here.",
        "Closing line, revised.",
      ),
    );
    expectValid(result.merged);
  });

  it("merges edits to different words of one paragraph without a suggestion", () => {
    const ours = BASE.replace("The pilot", "Our pilot");
    const theirs = BASE.replace("on purpose", "by design");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.suggestionsAdded).toEqual([]);
    expect(result.merged).toContain("Our pilot is small by design.");
  });

  it("turns an overlapping plain-text edit into a suggestion by the user", () => {
    const ours = BASE.replace("small on purpose", "tiny on purpose");
    const theirs = BASE.replace("small on purpose", "limited on purpose");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.suggestionsAdded).toEqual(["s1"]);
    expect(result.merged).toContain(
      "The pilot is {~~limited~>tiny~~}{#s1} on purpose.",
    );
    const s1 = extractRoughdraftReviewIndex(result.merged).items.find(
      (item) => item.id === "s1",
    );
    expect(s1).toMatchObject({
      kind: "suggestion",
      suggestionKind: "substitution",
      author: "user",
      createdAt: NOW,
      originalText: "limited",
      replacementText: "tiny",
    });
    expectValid(result.merged);
  });

  it("keeps a deletion that overlaps the agent's edit as a deletion suggestion", () => {
    const ours = BASE.replace(" on purpose", "");
    const theirs = BASE.replace("on purpose", "by design");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain("The pilot is small{-- by design--}{#s1}.");
    expectValid(result.merged);
  });

  it("picks the next free suggestion id over both sides", () => {
    const base = `${BASE.replace(
      "Closing line here.",
      "Use {~~rough~>specific~~}{#s2} wording.",
    )}suggestions:\n  s2:\n    by: AI\n    at: "2026-10-05T09:02:00.000Z"\n`;
    const ours = base.replace("small on purpose", "tiny on purpose");
    const theirs = base.replace("small on purpose", "limited on purpose");
    const result = merge(base, ours, theirs);
    expect(result.suggestionsAdded).toEqual(["s3"]);
    expectValid(result.merged);
  });

  it("reports a conflict for an overlap inside review markup", () => {
    const ours = BASE.replace("this claim", "this bold claim");
    const theirs = BASE.replace("this claim", "that claim");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      id: "h1",
      kind: "body",
      reason: "markup-overlap",
      choices: ["ours", "theirs"],
      ours: "Keep {==this bold claim==}{#c1} as written.",
      theirs: "Keep {==that claim==}{#c1} as written.",
      lines: { ours: 3, theirs: 3 },
    });
    expect(result.suggestionsAdded).toEqual([]);
    // Unsettled, the hunk keeps ours.
    expect(result.merged).toBe(ours);
  });

  it("settles a conflict hunk when run again with a resolution", () => {
    const ours = BASE.replace("this claim", "this bold claim").replace(
      "Closing line here.",
      "Closing line, mine.",
    );
    const theirs = BASE.replace("this claim", "that claim");
    const first = merge(BASE, ours, theirs);
    expect(first.conflicts.map((hunk) => hunk.id)).toEqual(["h1"]);
    const settled = mergeReview(BASE, ours, theirs, {
      now: NOW,
      resolutions: { h1: "theirs" },
    });
    expect(settled.conflicts).toEqual([]);
    expect(settled.merged).toContain("Keep {==that claim==}{#c1} as written.");
    expect(settled.merged).toContain("Closing line, mine.");
    expect(
      mergeReview(BASE, ours, theirs, { resolutions: { document: "theirs" } })
        .merged,
    ).toBe(theirs);
  });

  it("reports a conflict for an overlap inside a code block", () => {
    const base = BASE.replace(
      "Closing line here.",
      "```sh\nnpm run build\n```",
    );
    const ours = base.replace("npm run build", "pnpm build");
    const theirs = base.replace("npm run build", "npm run build:all");
    const result = merge(base, ours, theirs);
    expect(result.conflicts.map((hunk) => hunk.reason)).toEqual([
      "code-overlap",
    ]);
  });

  it("does not add a suggestion to a file in an older review format", () => {
    const legacy = `# Draft\n\nKeep {==this==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"} here.\n\nThe pilot is small.\n`;
    const result = merge(
      legacy,
      legacy.replace("small", "tiny"),
      legacy.replace("small", "limited"),
    );
    expect(result.conflicts.map((hunk) => hunk.reason)).toEqual([
      "older-format",
    ]);
  });
});

describe("mergeReview: review block and ids", () => {
  it("unions entries added on both sides", () => {
    const ours = appendRoughdraftReply(BASE, {
      parentId: "c1",
      message: "Mine too.",
      author: "user",
      at: "2026-10-06T09:00:00.000Z",
    });
    const theirs = appendRoughdraftReply(BASE, {
      parentId: "c1",
      message: "Added the survey.",
      at: "2026-10-06T09:01:00.000Z",
    });
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(ids(result.merged)).toEqual(["a1", "c1", "c2"]);
    expectValid(result.merged);
  });

  it("re-keys an id both sides added, with its refs and replies", () => {
    // Ours: a new comment c2 on the pilot sentence and Jordan's reply to it.
    const ours = BASE.replace(
      "The pilot is small on purpose.",
      "The pilot is {==small on purpose==}{#c2}.",
    ).replace(
      'at: "2026-10-05T09:00:00.000Z"\n',
      'at: "2026-10-05T09:00:00.000Z"\n  c2:\n    body: "How small?"\n    by: user\n    at: "2026-10-06T09:00:00.000Z"\n  c3:\n    body: "Three customers?"\n    by: user\n    at: "2026-10-06T09:00:30.000Z"\n    re: c2\n',
    );
    // Theirs (another tab): its own c2 on the closing line.
    const theirs = BASE.replace(
      "Closing line here.",
      "{==Closing line==}{#c2} here.",
    ).replace(
      'at: "2026-10-05T09:00:00.000Z"\n',
      'at: "2026-10-05T09:00:00.000Z"\n  c2:\n    body: "Drop this line."\n    by: user\n    at: "2026-10-06T09:01:00.000Z"\n',
    );
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.rekeyed).toEqual({ c2: "c4" });
    expect(result.merged).toContain("{==small on purpose==}{#c4}");
    expect(result.merged).toContain("{==Closing line==}{#c2}");
    const items = extractRoughdraftReviewIndex(result.merged).items;
    expect(items.find((item) => item.id === "c4")?.text).toBe("How small?");
    expect(items.find((item) => item.id === "c2")?.text).toBe(
      "Drop this line.",
    );
    expect(items.find((item) => item.id === "c3")?.parentId).toBe("c4");
    expectValid(result.merged);
  });

  it("re-keys a suggestion both sides added, and the continuation that names it", () => {
    const sug = (text: string, id: string, extra = "") =>
      `${text}suggestions:\n  ${id}:\n    by: user\n    at: "2026-10-06T09:00:00.000Z"\n${extra}`;
    const ours = sug(
      BASE.replace("small", "{--small--}{#s1}").replace(
        "Closing line",
        "{--Closing line--}{#s2}",
      ),
      "s1",
      '  s2:\n    by: user\n    at: "2026-10-06T09:00:00.000Z"\n    continues: s1\n',
    );
    const theirs = sug(
      BASE.replace("purpose", "{++good ++}{#s1}purpose"),
      "s1",
    );
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.rekeyed).toEqual({ s1: "s3" });
    expect(result.merged).toContain("{--small--}{#s3}");
    expect(result.merged).toContain("    continues: s3");
    expectValid(result.merged);
  });

  it("reports a conflict when the same entry key changed on both sides", () => {
    const resolve = (summary: string) =>
      BASE.replace(
        'at: "2026-10-05T09:00:00.000Z"\n',
        `at: "2026-10-05T09:00:00.000Z"\n    status: resolved\n    resolved: "${summary}"\n`,
      );
    const ours = resolve("Fixed in the intro.");
    const theirs = resolve("Cited the survey.");
    const result = merge(BASE, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: "entry",
      reason: "entry",
      entry: {
        section: "comments",
        id: "c1",
        key: "resolved",
        ours: "Fixed in the intro.",
        theirs: "Cited the survey.",
      },
    });
    const settled = mergeReview(BASE, ours, theirs, {
      resolutions: { [result.conflicts[0]?.id ?? ""]: "theirs" },
    });
    expect(settled.conflicts).toEqual([]);
    expect(settled.merged).toBe(theirs);
  });
});

describe("mergeReview: normalization", () => {
  // The browser's writer tightens headings in a file whose headings are not
  // all loose, and writes `-` bullets. A draft saved that way differs from
  // disk on lines Jordan never touched; the agent meanwhile turned the
  // bullets into a numbered list.
  const base = `# Launch

Intro paragraph.
## Steps

* first step
* second step

Closing paragraph.
`;
  const ours = `# Launch
Intro paragraph, with a note.
## Steps
- first step
- second step

Closing paragraph.
`;
  const theirs = `# Launch

Intro paragraph.
## Steps

1. first step
2. second step, owned by ops

Closing paragraph.
`;

  it("normalization-only differences do not conflict", () => {
    const result = merge(base, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.suggestionsAdded).toEqual([]);
    expect(result.merged).toBe(`# Launch
Intro paragraph, with a note.
## Steps
1. first step
2. second step, owned by ops

Closing paragraph.
`);
  });

  it("leaves a loose-heading file loose when the draft kept it loose", () => {
    const loose = "# A\n\nOne.\n\n# B\n\nTwo.\n";
    const result = merge(
      loose,
      loose.replace("One.", "One, edited."),
      loose.replace("Two.", "Two, edited."),
    );
    expect(result.merged).toBe("# A\n\nOne, edited.\n\n# B\n\nTwo, edited.\n");
  });
});

// ------------------------------------------------------------ fixtures and corpus

const canonicalInputs = loadFixtures()
  .map((fixture) => ({
    name: fixture.name,
    result: normalizeRoughdraftMetadata(fixture.markdown),
  }))
  .filter(({ result }) => result.refused.length === 0)
  .map(({ name, result }) => ({ name, markdown: result.markdown }));

const corpusDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "corpus",
);
const corpusInputs = fs.existsSync(corpusDir)
  ? fs
      .readdirSync(corpusDir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => ({
        name: file,
        result: normalizeRoughdraftMetadata(
          fs.readFileSync(path.join(corpusDir, file), "utf8"),
        ),
      }))
      .filter(({ result }) => result.refused.length === 0)
      .map(({ name, result }) => ({ name, markdown: result.markdown }))
  : [];

/** Body line indexes that hold prose only: no markup, not code, not the review block. */
function proseLines(markdown: string): number[] {
  const model = parseReviewModel(markdown);
  const lines = markdown.split("\n");
  const bodyStart =
    markdown.slice(0, model.split.bodyOffset).split("\n").length - 1;
  const bodyEnd =
    model.split.endmatterOffset === null
      ? lines.length
      : markdown.slice(0, model.split.endmatterOffset).split("\n").length - 1;
  const out: number[] = [];
  let fence = false;
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const line = lines[index] ?? "";
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/[{}|<>`]/.test(line) || /^\s*[-*+]?\s*$/.test(line)) continue;
    if (/^ {0,3}(#|>|\d+[.)]|[-*+] )/.test(line)) continue;
    if (!/[A-Za-z]{4,}/.test(line)) continue;
    out.push(index);
  }
  return out;
}

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

const WORDS = ["launch", "pilot", "three", "owner", "budget", "quietly"];

function editLine(line: string, next: () => number): string {
  const words = [...line.matchAll(/[A-Za-z]{4,}/g)];
  const word = words[Math.floor(next() * words.length)];
  if (!word) return `${line} more`;
  const start = word.index ?? 0;
  const replacement = WORDS[Math.floor(next() * WORDS.length)] ?? "pilot";
  return (
    line.slice(0, start) +
    (replacement === word[0] ? `${replacement}s` : replacement) +
    line.slice(start + word[0].length)
  );
}

function everyIdSurvives(name: string, markdown: string) {
  // Theirs: an agent reply to the first open root and a global comment from
  // another tab. Ours: Jordan's own global comment (same next cN) and an
  // edit to the first prose line.
  const root = extractRoughdraftReviewIndex(markdown).items.find(
    (item) => item.kind === "comment" && item.status !== "resolved",
  );
  let theirs = appendRoughdraftDocumentComment(markdown, {
    message: "From the other tab.",
    author: "user",
    at: "2026-10-06T09:00:00.000Z",
  });
  if (root) {
    theirs = appendRoughdraftReply(theirs, {
      parentId: root.id,
      message: "Answered.",
      at: "2026-10-06T09:01:00.000Z",
    });
  }
  let ours = appendRoughdraftDocumentComment(markdown, {
    message: "Mine.",
    author: "user",
    at: "2026-10-06T09:02:00.000Z",
  });
  const prose = proseLines(ours);
  if (prose.length > 0) {
    const lines = ours.split("\n");
    const index = prose[0] as number;
    lines[index] = editLine(lines[index] ?? "", random(7));
    ours = lines.join("\n");
  }
  const result = merge(markdown, ours, theirs);
  expect(result.conflicts, name).toEqual([]);
  const merged = new Set(ids(result.merged));
  for (const id of ids(theirs))
    expect(merged.has(id), `${name} ${id}`).toBe(true);
  for (const id of ids(ours)) {
    const mapped = result.rekeyed[id] ?? id;
    expect(merged.has(mapped), `${name} ${id}`).toBe(true);
  }
  expect(Object.keys(result.rekeyed).length, name).toBe(1);
  expect(validateRoughdraftMarkdown(result.merged).errors, name).toEqual(
    validateRoughdraftMarkdown(theirs).errors,
  );
}

describe("mergeReview: every review id from both inputs survives", () => {
  it.each(
    canonicalInputs.map((input) => [input.name, input] as const),
  )("fixture %s", (name, input) => everyIdSurvives(name, input.markdown));

  it
    .skipIf(corpusInputs.length === 0)
    .each(corpusInputs.map((input) => [input.name, input] as const))(
    "corpus %s",
    (name, input) => everyIdSurvives(name, input.markdown),
  );
});

// RFM_MERGE_TRIALS raises the count for a longer local run.
const TRIALS = Number(process.env.RFM_MERGE_TRIALS ?? 20);
const LONG_RUN_MS = Math.max(5_000, TRIALS * 100);

describe("property: random non-overlapping edits on both sides merge exactly", () => {
  it.each(
    [...canonicalInputs, ...corpusInputs]
      .filter((input) => proseLines(input.markdown).length >= 3)
      .map((input, index) => [input.name, input, index] as const),
  )(
    "%s",
    (name, input, index) => {
      const next = random(500 + index);
      const prose = proseLines(input.markdown);
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const lines = input.markdown.split("\n");
        // Disjoint, non-adjacent line sets for the two sides.
        const shuffled = [...prose].sort(() => next() - 0.5);
        const mine: number[] = [];
        const other: number[] = [];
        for (const line of shuffled) {
          const near = (set: number[]) =>
            set.some((taken) => Math.abs(taken - line) <= 1);
          if (mine.length <= other.length && !near(other) && !near(mine))
            mine.push(line);
          else if (!near(mine) && !near(other)) other.push(line);
          if (mine.length >= 2 && other.length >= 2) break;
        }
        const ours = [...lines];
        const theirs = [...lines];
        const expected = [...lines];
        for (const line of mine) {
          ours[line] = editLine(lines[line] ?? "", next);
          expected[line] = ours[line] as string;
        }
        for (const line of other) {
          theirs[line] = editLine(lines[line] ?? "", next);
          expected[line] = theirs[line] as string;
        }
        const result = merge(
          input.markdown,
          ours.join("\n"),
          theirs.join("\n"),
        );
        expect(result.conflicts, `${name} trial ${trial}`).toEqual([]);
        expect(result.merged, `${name} trial ${trial}`).toBe(
          expected.join("\n"),
        );
      }
    },
    LONG_RUN_MS,
  );

  it.each(
    canonicalInputs
      .filter((input) => proseLines(input.markdown).length >= 1)
      .map((input, index) => [input.name, input, index] as const),
  )(
    "same-line edits in %s land or become suggestions, never lose ids",
    (name, input, index) => {
      const next = random(900 + index);
      const prose = proseLines(input.markdown);
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const lines = input.markdown.split("\n");
        const line = prose[Math.floor(next() * prose.length)] as number;
        const ours = [...lines];
        const theirs = [...lines];
        ours[line] = editLine(lines[line] ?? "", next);
        theirs[line] = editLine(lines[line] ?? "", next);
        const result = merge(
          input.markdown,
          ours.join("\n"),
          theirs.join("\n"),
        );
        expect(result.conflicts, `${name} trial ${trial}`).toEqual([]);
        const merged = new Set(ids(result.merged));
        for (const id of ids(input.markdown))
          expect(merged.has(id), `${name} ${id}`).toBe(true);
        for (const id of result.suggestionsAdded)
          expect(merged.has(id), `${name} ${id}`).toBe(true);
        expect(validateRoughdraftMarkdown(result.merged).errors).toEqual(
          validateRoughdraftMarkdown(input.markdown).errors,
        );
      }
    },
    LONG_RUN_MS,
  );
});

describe("diffSequences", () => {
  function lcs(a: string[], b: string[]): number {
    const table = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        const row = table[i] as number[];
        row[j] =
          a[i] === b[j]
            ? ((table[i + 1] as number[])[j + 1] ?? 0) + 1
            : Math.max((table[i + 1] as number[])[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    return (table[0] as number[])[0] ?? 0;
  }

  it("rebuilds b from a with a minimal edit script (random sequences)", () => {
    const next = random(42);
    for (let trial = 0; trial < 400; trial += 1) {
      const pick = () =>
        Array.from({ length: Math.floor(next() * 12) }, () =>
          "abcd".charAt(Math.floor(next() * 4)),
        );
      const a = pick();
      const b = pick();
      const hunks = diffSequences(a, b);
      const rebuilt: string[] = [];
      let cursor = 0;
      let removed = 0;
      for (const hunk of hunks) {
        rebuilt.push(...a.slice(cursor, hunk.aStart));
        rebuilt.push(...b.slice(hunk.bStart, hunk.bEnd));
        removed += hunk.aEnd - hunk.aStart;
        cursor = hunk.aEnd;
      }
      rebuilt.push(...a.slice(cursor));
      expect(rebuilt).toEqual(b);
      expect(a.length - removed).toBe(lcs(a, b));
    }
  });
});
