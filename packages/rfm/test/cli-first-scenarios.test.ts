// The operation scenarios of the command-first prototype
// (.context/review/agent-interaction/cli-first/scenarios.mjs), rerun on the
// shipped engine. Each prototype operation maps onto one response:
// `reply` -> threads[id].reply, `edit --anchor` -> edits[{ anchor, new }],
// `edit --old --near` -> edits[{ old, new, near }], `accept`/`reject` ->
// decision, `resolve` -> resolve, `note` -> note. Scenario 24 (the guard
// hook's decision table) belongs to the CLI owner and is not here.
// By design of the 3b contract the output is the canonical shape: comment text
// lives in the review block, so the prototype's "train" moves are anchor moves.
import { describe, expect, it } from "vitest";
import {
  normalizeRoughdraftMetadata,
  type RfmThreadAction,
} from "../src/index";
import {
  apply,
  canonical,
  errorCodes,
  fixture,
  NO_PROBLEMS,
  readersAccept,
  response,
  startRound,
} from "./review-helpers";

const A8 = `# Launch checklist
Everything below happens in the final week.
## {==Pre-flight==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}
{==The creator confirms the caption and the pin schedule with ops:==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}

- {==Caption matches the approved copy deck==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}

- {==Tracking link is the campaign short link==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}

- {==Pin window is agreed with the brand==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}


{==Ops gives the final go in the deal thread.==}{>>Split these checks by owner.<<}{id="c1" by="user" at="2026-10-04T19:03:39.625Z"}
## Day of
Publish in the local morning window.
`;

const K1 = canonical(`# Control

Keep {==this claim==}{>>Needs a source.<<}{#c1} short.

---
comments:
  c1:
    by: user
    at: "2026-10-04T09:00:00.000Z"
  c2:
    body: "Done: added the source."
    by: AI
    at: "2026-10-04T09:05:00.000Z"
    re: c1
`);

/** One prototype operation list as one response. */
function ops(
  markdown: string,
  threads: Record<string, RfmThreadAction>,
  extra: Parameters<typeof response>[2] = {},
) {
  const round = startRound(markdown, "r-cli");
  return apply({
    current: markdown,
    response: response(round.roundId, threads, { partial: true, ...extra }),
    round,
  });
}

function applied(result: ReturnType<typeof apply>): string {
  expect(result.errors).toEqual([]);
  const markdown = result.markdown as string;
  expect(readersAccept(markdown)).toEqual(NO_PROBLEMS);
  return markdown;
}

const case1 = canonical(fixture("repro-case1-ui-saved"));
const case2 = canonical(fixture("repro-case2-ui-saved"));
const case3 = canonical(fixture("repro-case3-ui-saved"));
const case4 = canonical(fixture("repro-case4-ui-saved"));
const case5 = canonical(fixture("repro-case5-ui-saved"));
const case6 = canonical(fixture("repro-case6-ui-saved"));

describe("cli-first scenarios", () => {
  it("01 case 1: one reply to a two-paragraph comment goes to the review block once", () => {
    const markdown = applied(
      ops(case1, {
        c1: { reply: "Done: both paragraphs now match the timeline doc." },
      }),
    );
    expect(markdown.match(/re: c1/g)).toHaveLength(1);
    const round = startRound(markdown);
    expect(round.threads).toHaveLength(1);
    expect(round.threads[0]).toMatchObject({
      needsAnswer: false,
      replies: [{ id: "a1", author: "AI" }],
    });
  });

  it("02 case 2: rewriting the whole anchored section keeps the comment over the new section", () => {
    const result = ops(
      case2,
      { c1: { reply: "Done: split the checks into Creator and Ops lists." } },
      {
        edits: [
          {
            anchor: "c1",
            new: "Pre-flight, by owner\n\n### Creator\n\n- Caption matches the approved copy deck\n- Tracking link is the campaign short link\n\n### Ops\n\n- Pin window is agreed with the brand\n- Final go is posted in the deal thread",
          },
        ],
      },
    );
    const markdown = applied(result);
    expect(markdown).toContain(
      "## {==Pre-flight, by owner==}{#c1}\n\n### {==Creator==}{#c1}\n\n- {==Caption matches the approved copy deck==}{#c1}",
    );
    expect(markdown).toContain(
      "- {==Final go is posted in the deal thread==}{#c1}",
    );
    expect(startRound(markdown).threads).toHaveLength(1);
  });

  it("03 case 3: an edit of the second segment only keeps the first segment as it was", () => {
    const markdown = applied(
      ops(
        case3,
        {
          c1: {
            reply: "Done: added a bridge so the second paragraph follows on.",
          },
        },
        {
          edits: [
            {
              old: "Second paragraph starts with a lead phrase",
              new: "Second paragraph now opens with a bridge sentence that follows from the first",
            },
          ],
        },
      ),
    );
    expect(markdown).toContain("{==a closing clause that runs on.==}{#c1}");
    expect(markdown).toContain(
      "{==Second paragraph now opens with a bridge sentence that follows from the first==}{#c1}",
    );
  });

  it("04 case 4: a reply under a comment typed with a blank line", () => {
    const markdown = applied(
      ops(case4, { c1: { reply: "Done: narrowed scope to three customers." } }),
    );
    expect(markdown).toContain("<br><br>");
  });

  it("05 case 5: accept settles both parts of a cross-block deletion", () => {
    const result = ops(case5, { s1: { decision: "accept" } });
    const markdown = applied(result);
    expect(markdown).not.toContain("{--");
    expect(result.report.accepted).toEqual(["s1"]);
  });

  it("06 case 6: two anchor edits and two replies in one write", () => {
    const markdown = applied(
      ops(
        case6,
        {
          c1: { reply: "Done: three customers." },
          c2: { reply: "Done: named Dana." },
        },
        {
          edits: [
            {
              anchor: "c1",
              new: "why the pilot is limited to three customers",
            },
            {
              old: "who signs off",
              new: "who signs off (Dana Ruiz, VP Ops)",
              near: "c2",
            },
          ],
        },
      ),
    );
    expect(markdown).toContain(
      "{==why the pilot is limited to three customers==}{#c1}",
    );
    expect(markdown).toContain("{==who signs off (Dana Ruiz, VP Ops)==}{#c2}");
  });

  it("07 A8: six replicas normalize to one primary anchor plus five continuations", () => {
    const result = normalizeRoughdraftMetadata(A8);
    expect(result.refused).toEqual([]);
    expect(result.markdown.match(/\{#c1\}/g)).toHaveLength(6);
    expect(result.markdown).not.toContain("{>>");
    expect(
      result.changes.filter(
        (change) => change.code === "replicas-to-continuations",
      ),
    ).toHaveLength(5);
    expect(readersAccept(result.markdown)).toEqual(NO_PROBLEMS);
  });

  it("08 K1: an edit inside a highlight keeps it", () => {
    const result = ops(
      K1,
      {},
      { edits: [{ old: "this claim", new: "the revenue claim" }] },
    );
    expect(applied(result)).toContain(
      "Keep {==the revenue claim==}{#c1} short.",
    );
    expect(result.report.anchors).toEqual([{ id: "c1", result: "inside" }]);
  });

  it("09 K1: an edit of the whole sentence keeps the highlight on its words", () => {
    const result = ops(
      K1,
      {},
      {
        edits: [
          {
            old: "Keep this claim short.",
            new: "Keep this claim short and cite the Q3 report.",
          },
        ],
      },
    );
    expect(applied(result)).toContain(
      "Keep {==this claim==}{#c1} short and cite the Q3 report.",
    );
    expect(result.report.anchors).toEqual([{ id: "c1", result: "kept" }]);
  });

  it("10 two highlights in one sentence rewritten by one edit both cover the new sentence", () => {
    const two = `# Two in one\n\nWe launch in {==May==}{#c1} with {==two people==}{#c2} on ops.\n\n---\ncomments:\n  c1:\n    body: "June?"\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n  c2:\n    body: "Name them."\n    by: user\n    at: "2026-10-04T09:01:00.000Z"\n`;
    const result = ops(
      two,
      {},
      {
        edits: [
          {
            old: "We launch in May with two people on ops.",
            new: "We launch in June with Ana and Raj on ops.",
          },
        ],
      },
    );
    expect(applied(result)).toContain(
      "{==We launch in June with Ana and Raj on ops.==}{#c1}{#c2}",
    );
    expect(result.report.anchors.map((anchor) => anchor.result)).toEqual([
      "widened",
      "widened",
    ]);
  });

  it("11 deleting an anchored sentence leaves a standalone comment there", () => {
    const cut = `# Cut\n\nKeep this. {==Drop this sentence entirely.==}{#c1} Keep that.\n\nNext paragraph.\n\n---\ncomments:\n  c1:\n    body: "Cut this."\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n`;
    const result = ops(
      cut,
      { c1: { reply: "Done: cut it." } },
      { edits: [{ anchor: "c1", new: "" }] },
    );
    expect(applied(result)).toContain("Keep this. {#c1} Keep that.");
    expect(result.report.anchors).toEqual([{ id: "c1", result: "standalone" }]);
  });

  it("12 deleting an anchored paragraph leaves a standalone comment between the neighbours", () => {
    const cut = `# Cut\n\nKeep this paragraph.\n\n{==Drop this whole paragraph.==}{#c1}\n\nNext paragraph.\n\n---\ncomments:\n  c1:\n    body: "Cut the paragraph."\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n`;
    const result = ops(
      cut,
      {},
      { edits: [{ old: "Drop this whole paragraph.", new: "" }] },
    );
    const markdown = applied(result);
    expect(markdown.slice(0, markdown.indexOf("---"))).toBe(
      "# Cut\n\nKeep this paragraph.\n\n{#c1}\n\nNext paragraph.\n\n",
    );
  });

  const withSuggestion = `# Guards\n\nShip it {--next week--}{#s1} soon. Ship it next month.\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n`;

  it("13 refuses an edit touching a suggestion", () => {
    expect(
      errorCodes(
        ops(
          withSuggestion,
          {},
          { edits: [{ old: "Ship it next week soon", new: "Ship it" }] },
        ),
      ),
    ).toEqual(["edit-touches-suggestion"]);
  });

  it("14 refuses new text with review markup", () => {
    expect(
      errorCodes(
        ops(
          K1,
          {},
          { edits: [{ old: "short", new: "short{>>agent note<<}" }] },
        ),
      ),
    ).toEqual(["markup-in-edit"]);
  });

  it("15 refuses an ambiguous old text", () => {
    const result = ops(
      withSuggestion,
      {},
      { edits: [{ old: "Ship it", new: "Release it" }] },
    );
    expect(errorCodes(result)).toEqual(["edit-ambiguous"]);
    expect(result.errors[0]?.lines).toEqual([3, 3]);
  });

  it("16 refuses an unknown thread id", () => {
    const result = ops(K1, { c9: { reply: "Hi." } });
    expect(errorCodes(result)).toEqual(["unknown-thread"]);
    expect(result.errors[0]?.hint).toContain("c1");
  });

  const substitution = `# Sub\n\nUse {~~Postgres~>SQLite~~}{#s1} here.\n\n---\ncomments:\n  c1:\n    body: "Or DuckDB?"\n    by: user\n    at: "2026-10-04T09:02:00.000Z"\n    re: s1\nsuggestions:\n  s1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n`;

  it("17 refuses to reject a suggestion with replies without dropReplies", () => {
    expect(
      errorCodes(ops(substitution, { s1: { decision: "reject" } })),
    ).toEqual(["thread-has-replies"]);
  });

  it("18 rejects it with dropReplies and echoes the removed reply", () => {
    const result = ops(substitution, {
      s1: { decision: "reject", dropReplies: true },
    });
    const markdown = applied(result);
    expect(markdown.startsWith("# Sub\n\nUse Postgres here.\n\n---\n")).toBe(
      true,
    );
    expect(markdown).not.toContain("DuckDB");
    expect(result.report.droppedReplies).toEqual([
      { thread: "s1", id: "c1", author: "user", body: "Or DuckDB?" },
    ]);
  });

  it("19 R01: an attribute root plus a reply in the block converts, then takes a reply", () => {
    const r01 = canonical(fixture("probe-R01-inline-root-endmatter-reply"));
    const markdown = applied(
      ops(r01, { c1: { reply: "Confirmed the citation is in." } }),
    );
    expect(
      startRound(markdown).threads[0]?.replies.map((reply) => reply.id),
    ).toEqual(["c2", "a1"]);
  });

  it("20 two review blocks merge; Jordan's comment in the first one takes a reply", () => {
    const twoBlocks = `# Plan\n\nKeep {==this==}{>>Root<<}{#c1} short.\n\n---\ncomments:\n  c11:\n    body: "Overall: tighten section 2."\n    by: user\n    at: "2026-10-03T12:05:00.000Z"\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n  rc1:\n    body: >-\n      Done, trimmed.\n    by: AI\n    at: "2026-10-03T12:10:00.000Z"\n    re: c1\n`;
    const markdown = applied(
      ops(canonical(twoBlocks), {
        c11: { reply: "Done: section 2 is half the length." },
      }),
    );
    expect(markdown.match(/^---$/gm)).toHaveLength(1);
    expect(markdown).toContain("    re: c11");
  });

  it("21 W1: replies glued above the block move into it; a new reply follows", () => {
    const w1 = `# Doc\n\nPlease revisit this sentence.{>>Needs a source.<<}{#c1}\n\n5. Last list item\n{>>Trimmed the intro.<<}{id="c3" by="AI" at="2026-10-03T13:00:00.000Z" re="c2"}\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-03T12:00:00.000Z"\n  c2:\n    body: "Overall: the intro is long."\n    by: user\n    at: "2026-10-03T12:30:00.000Z"\n`;
    const markdown = applied(
      ops(canonical(w1), { c1: { reply: "Done: cited the Q3 report." } }),
    );
    expect(markdown).toContain("5. Last list item\n\n---\n");
    expect(markdown).toContain(
      '  c3:\n    body: "Trimmed the intro."\n    by: AI\n    at: "2026-10-03T13:00:00.000Z"\n    re: c2',
    );
  });

  it("22 episode 12: bare anchors with bodies in the block are the current format; a reply lands", () => {
    const ep12 = `# Doc\n\nThe {==tech pack==}{#c5} goes to the factory {==on Monday==}{#c6}.\n\n---\ncomments:\n  c5:\n    body: "Which version?"\n    by: user\n    at: "2026-08-12T10:00:00.000Z"\n  c6:\n    body: "Too early."\n    by: user\n    at: "2026-08-12T10:01:00.000Z"\n`;
    expect(normalizeRoughdraftMetadata(ep12).changes).toEqual([]);
    const result = ops(ep12, { c5: { reply: "v3, attached in the thread." } });
    expect(applied(result)).toContain(
      "The {==tech pack==}{#c5} goes to the factory {==on Monday==}{#c6}.",
    );
  });

  it("23 inline status attributes survive the conversion", () => {
    const status = `# Doc\n\nKeep this.{>>Root<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z" status="resolved" resolved="Done."}\n`;
    const markdown = canonical(status);
    expect(markdown).toContain('    status: resolved\n    resolved: "Done."');
    expect(startRound(markdown).threads[0]).toMatchObject({
      status: "resolved",
      needsAnswer: false,
    });
  });

  it("25 normalizing any output again changes nothing", () => {
    for (const markdown of [
      case1,
      case2,
      case3,
      case4,
      case5,
      case6,
      K1,
      canonical(A8),
    ]) {
      const again = normalizeRoughdraftMetadata(markdown);
      expect(again.changes).toEqual([]);
      expect(again.markdown).toBe(markdown);
    }
  });

  it("26 case 1: deleting the first block of a two-block comment keeps the comment on the second", () => {
    const result = ops(
      case1,
      { c1: { reply: "Done: removed the Alpha paragraph." } },
      {
        edits: [
          {
            old: "Alpha paragraph says the launch moves to May and nothing else changes.",
            new: "",
          },
        ],
      },
    );
    const markdown = applied(result);
    expect(markdown.match(/\{#c1\}/g)).toHaveLength(1);
    expect(markdown).toContain(
      "{==Beta paragraph lists the owners for each step of the rollout.==}{#c1}",
    );
    expect(result.report.anchors).toEqual([
      { id: "c1", result: "segment-removed" },
    ]);
  });

  it("27 case 3: an edit from plain text into the continuation keeps both segments", () => {
    const result = ops(
      case3,
      {},
      {
        edits: [
          {
            old: "a closing clause that runs on.\n\nSecond paragraph starts with a lead phrase and ends",
            new: "a closing clause that now leads into the next point.\n\nThe second paragraph picks that up and ends",
          },
        ],
      },
    );
    const markdown = applied(result);
    expect(markdown).toContain(
      "{==a closing clause that now leads into the next point.==}{#c1}\n\n{==The second paragraph picks that up and ends==}{#c1}",
    );
  });

  it("28 case 5: the round shows a cross-block suggestion as one thread with two parts", () => {
    const round = startRound(case5);
    expect(round.threads).toHaveLength(1);
    expect(round.threads[0]).toMatchObject({
      id: "s1",
      kind: "suggestion",
      needsAnswer: true,
      suggestion: { type: "deletion", parts: ["s1", "s2"] },
    });
    expect(
      round.threads[0]?.anchor?.segments.map((segment) => segment.line),
    ).toEqual([4, 6]);
  });
});
