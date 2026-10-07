// The 26 scenarios of the round-transaction prototype
// (.context/review/agent-interaction/round-proto/run-cases.mjs), rerun on the
// shipped engine. The inputs are the app-written browser-repro snapshots,
// converted first (D11: an agent round needs a file in the current format),
// and three of Jordan's real documents from the git-ignored corpus.
// Differences from the prototype, by design of the 3b contract: replies are
// `aN` entries in the review block; a comment whose text an edit deletes
// becomes a standalone comment instead of refusing (scenario 17); new threads
// in scenario 13 are written in the current format, as the 3b browser writes
// them; `--skip-failed` (19) is the CLI's retry without the failing unit.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewCleanText } from "../src/index";
import {
  apply,
  canonical,
  errorCodes,
  fixture,
  jordanItems,
  NO_PROBLEMS,
  readersAccept,
  response,
  startRound,
} from "./review-helpers";

const c1 = canonical(fixture("repro-case1-ui-saved"));
const c2 = canonical(fixture("repro-case2-ui-saved"));
const c3 = canonical(fixture("repro-case3-ui-saved"));
const c4 = canonical(fixture("repro-case4-ui-saved"));
const c5 = canonical(fixture("repro-case5-ui-saved"));
const c6 = canonical(fixture("repro-case6-ui-saved"));

/** Run the agent's side: edit the round's clean text, then apply. */
function roundTrip(
  markdown: string,
  threads: Parameters<typeof response>[1],
  options: {
    edit?: (clean: string) => string;
    current?: string;
    baseline?: string;
    extra?: Parameters<typeof response>[2];
    agentLabels?: string[];
  } = {},
) {
  const round = startRound(markdown, "r-proto", options.agentLabels);
  const result = apply({
    base: markdown,
    current: options.current ?? markdown,
    cleanEdited: options.edit ? options.edit(round.clean) : null,
    response: response(round.roundId, threads, options.extra),
    baseline: options.baseline,
    round,
  });
  return { round, result };
}

function applied(result: ReturnType<typeof apply>): string {
  expect(result.errors).toEqual([]);
  expect(result.report.status).toBe("applied");
  const markdown = result.markdown as string;
  expect(readersAccept(markdown)).toEqual(NO_PROBLEMS);
  return markdown;
}

describe("round-proto scenarios", () => {
  it("01 case 1: a two-paragraph comment is one thread; the edit inside it keeps the highlight", () => {
    const { round, result } = roundTrip(
      c1,
      {
        c1: {
          reply:
            "Reconciled both paragraphs with the timeline doc; the launch now moves to June.",
        },
      },
      {
        edit: (clean) =>
          clean.replace("the launch moves to May", "the launch moves to June"),
      },
    );
    expect(round.threads.map((thread) => thread.id)).toEqual(["c1"]);
    expect(round.threads[0]?.anchor?.segments).toHaveLength(2);
    const markdown = applied(result);
    expect(markdown).toContain(
      "{==Alpha paragraph says the launch moves to June and nothing else changes.==}{#c1}",
    );
    expect(markdown).toContain(
      "{==Beta paragraph lists the owners for each step of the rollout.==}{#c1}",
    );
    expect(result.report.replies).toEqual([{ thread: "c1", id: "a1" }]);
    expect(result.report.edits[0]?.anchors).toEqual([
      { id: "c1", result: "inside" },
    ]);
  });

  it("02 case 2: two edits inside a heading-paragraph-list comment and one outside it", () => {
    const { result } = roundTrip(
      c2,
      { c1: { reply: "Done: split the checks by owner." } },
      {
        edit: (clean) =>
          clean
            .replace("Pre-flight", "Pre-flight, split by owner")
            .replace(
              "The creator confirms the caption with ops before scheduling.",
              "The creator checks the caption and the link. Ops checks the pin window and gives the go.",
            )
            .replace(
              "Intro sentence above the section.",
              "Intro sentence above the checks.",
            ),
      },
    );
    const markdown = applied(result);
    // Words added right after a highlight stay outside it: the highlight keeps its text.
    expect(markdown).toContain("## {==Pre-flight==}{#c1}, split by owner");
    expect(markdown).toContain(
      "{==The creator checks the caption and the link. Ops checks the pin window and gives the go.==}{#c1}",
    );
    expect(markdown).toContain("Intro sentence above the checks.");
    expect(result.report.edits).toHaveLength(3);
  });

  it("03 case 3: an edit crossing the highlight's end widens it to the new sentence", () => {
    const { result } = roundTrip(
      c3,
      { c1: { reply: "Smoothed the handoff between the two sentences." } },
      {
        edit: (clean) =>
          clean.replace(
            "an opening clause and a closing clause that runs on.",
            "an opening clause and a closing clause that now leads into the next paragraph.",
          ),
      },
    );
    const markdown = applied(result);
    expect(markdown).toContain(
      "{==Second paragraph starts with a lead phrase==}{#c1}",
    );
    expect(markdown).toMatch(
      /\{==[^=]*closing clause that now leads into the next paragraph\.==\}\{#c1\}/,
    );
  });

  it("04 case 4: a comment typed with a blank line is answered; the line breaks stay in the body", () => {
    const { round, result } = roundTrip(c4, {
      c1: {
        reply: "Scope: three customers. Timing: two weeks starting June 2.",
      },
    });
    expect(round.threads[0]?.body).toBe(
      "First point about scope.\n\nSecond point about timing.",
    );
    const markdown = applied(result);
    expect(markdown).toContain(
      'body: "First point about scope.<br><br>Second point about timing."',
    );
  });

  it("05 case 5: accepting a cross-block deletion removes both parts and leaves a round note", () => {
    const { result } = roundTrip(c5, {
      s1: {
        decision: "accept",
        reply: "both paragraphs repeated the appendix.",
      },
    });
    const markdown = applied(result);
    const body = markdown.slice(0, markdown.indexOf("\n---\n"));
    expect(body).toBe(
      "# Case 5: suggested deletion across two paragraphs\nKeep this opening paragraph as it is.\n\nTail line for the save trigger.\n",
    );
    expect(result.report.accepted).toEqual(["s1"]);
    expect(result.report.note).toBe("a1");
    expect(markdown).toContain("Accepted your suggestion deleting");
  });

  it("06 case 5: rejecting keeps both paragraphs and removes the markers", () => {
    const { result } = roundTrip(c5, {
      s1: {
        decision: "reject",
        reply: "the budget numbers are needed here for the board.",
      },
    });
    const markdown = applied(result);
    expect(markdown).toContain(
      "Delta paragraph repeats the budget numbers from the appendix.\n\nEpsilon paragraph",
    );
    expect(markdown).not.toContain("{--");
    expect(result.report.rejected).toEqual(["s1"]);
  });

  it("07 case 5: a reply alone leaves the suggestion pending", () => {
    const { result } = roundTrip(c5, {
      s1: {
        reply: "Question: should the appendix keep both tables if these go?",
      },
    });
    const markdown = applied(result);
    expect(markdown).toContain(
      "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}",
    );
    expect(markdown).toContain("    re: s1");
  });

  it("08 case 6: two comments, one resolved, and a round note", () => {
    const { result } = roundTrip(
      c6,
      {
        c1: { reply: "Three customers." },
        c2: { reply: "Named Dana Ruiz.", resolve: "Named the approver." },
      },
      {
        edit: (clean) =>
          clean.replace(
            "why the pilot is small",
            "why the pilot is small (three customers)",
          ),
        extra: { note: "Round 1: both comments handled." },
      },
    );
    const markdown = applied(result);
    expect(result.report.resolved).toEqual(["c2"]);
    expect(markdown).toContain(
      '    status: resolved\n    resolved: "Named the approver."',
    );
    expect(markdown).toContain(
      '    body: "Round 1: both comments handled."\n    by: AI\n    at: "2026-10-04T21:05:00.000Z"\n    scope: document',
    );
  });

  it("09 refuses an ambiguous edit", () => {
    const { result } = roundTrip(
      c6,
      { c1: { reply: "ok" }, c2: { reply: "ok" } },
      { extra: { edits: [{ old: "paragraph", new: "section" }] } },
    );
    expect(errorCodes(result)).toEqual(["edit-ambiguous"]);
    expect(result.errors[0]?.lines).toEqual([2, 4]);
    expect(result.markdown).toBeNull();
  });

  it("10 refuses a response that leaves a waiting thread unanswered", () => {
    const { result } = roundTrip(c6, { c1: { reply: "Three customers." } });
    expect(errorCodes(result)).toEqual(["unanswered-thread"]);
    expect(result.errors[0]?.thread).toBe("c2");
  });

  it("11 a partial round answers one thread and lists the other as remaining", () => {
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Three customers." } },
      { extra: { partial: true } },
    );
    applied(result);
    expect(result.report.remaining).toEqual(["c2"]);
  });

  it("12 refuses markup in a reply and in an edit", () => {
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Changed it to {++three++}." }, c2: { reply: "ok" } },
      {
        extra: {
          edits: [{ old: "who signs off", new: "{==who signs off==}" }],
        },
      },
    );
    expect(errorCodes(result).sort()).toEqual([
      "markup-in-edit",
      "markup-in-reply",
    ]);
  });

  it("13 rebases over text and a new comment Jordan added after the round", () => {
    const typed = c6
      .replace(
        "Tail line for the save trigger.",
        "Tail line for the save trigger. He added a sentence.\n\nA new paragraph with {==a new comment==}{#c3} inside.",
      )
      .replace(
        '    at: "2026-10-04T19:01:00.289Z"\n',
        '    at: "2026-10-04T19:01:00.289Z"\n  c3:\n    body: "Is this needed?"\n    by: user\n    at: "2026-10-04T21:02:00.000Z"\n',
      );
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "Named Dana Ruiz." } },
      { current: typed, baseline: typed },
    );
    const markdown = applied(result);
    expect(result.report.rebase).toMatchObject({
      baseChanged: true,
      newThreads: ["c3"],
      outsideChanges: false,
    });
    expect(result.report.replies.map((reply) => reply.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(markdown).toContain("{==a new comment==}{#c3}");
  });

  it("14 refuses when Jordan edited a thread's comment after the round (browser save)", () => {
    const edited = c6.replace(
      "Say how small: number of customers.",
      "Say how small: number of customers and weeks.",
    );
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "Named Dana Ruiz." } },
      { current: edited, baseline: edited },
    );
    expect(errorCodes(result)).toEqual(["thread-changed"]);
    expect(result.errors[0]?.thread).toBe("c1");
  });

  it("15 refuses an edit of prose Jordan changed after the round", () => {
    const changed = c6.replace(
      "Zeta paragraph explains",
      "Zeta paragraph now explains",
    );
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "ok" } },
      {
        current: changed,
        baseline: changed,
        extra: {
          edits: [
            {
              old: "Zeta paragraph explains",
              new: "The Zeta paragraph explains",
            },
          ],
        },
      },
    );
    expect(errorCodes(result)).toEqual(["edit-not-found"]);
  });

  it("15b Jordan edits the highlighted text; the reply still applies", () => {
    const changed = c6.replace(
      "why the pilot is small",
      "why the pilot stays small",
    );
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "Named Dana Ruiz." } },
      { current: changed, baseline: changed },
    );
    const markdown = applied(result);
    expect(markdown).toContain("{==why the pilot stays small==}{#c1}");
  });

  it("15c refuses a clean.md edit of words Jordan changed; an insertion next to them still lands", () => {
    const changed = c6.replace(
      "why the pilot is small",
      "why the pilot stays small",
    );
    const conflict = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "ok" } },
      {
        current: changed,
        baseline: changed,
        edit: (clean) =>
          clean.replace("why the pilot is small", "why the pilot was small"),
      },
    );
    expect(errorCodes(conflict.result)).toEqual(["edit-not-found"]);
    const beside = roundTrip(
      c6,
      { c1: { reply: "Three customers." }, c2: { reply: "ok" } },
      {
        current: changed,
        baseline: changed,
        edit: (clean) =>
          clean.replace(
            "why the pilot is small",
            "why the pilot is small (three customers)",
          ),
      },
    );
    expect(applied(beside.result)).toContain(
      "{==why the pilot stays small==}{#c1} (three customers).",
    );
  });

  it("16 refuses an edit over a pending suggestion", () => {
    const withSuggestion = c6
      .replace(
        "Tail line for the save trigger.",
        "Tail line {++for the save++}{#s1} trigger.",
      )
      .concat(
        'suggestions:\n  s1:\n    by: user\n    at: "2026-10-04T21:01:00.000Z"\n',
      );
    const { result } = roundTrip(
      withSuggestion,
      {
        c1: { reply: "ok" },
        c2: { reply: "ok" },
        s1: { reply: "Leaving this for you." },
      },
      { extra: { edits: [{ old: "Tail line trigger.", new: "Last line." }] } },
    );
    expect(errorCodes(result)).toEqual(["edit-touches-suggestion"]);
  });

  it("17 deleting all of a comment's text leaves it as a standalone comment at that spot", () => {
    const { result } = roundTrip(
      c6,
      { c1: { reply: "Removed the sentence." }, c2: { reply: "ok" } },
      {
        edit: (clean) =>
          clean.replace("Zeta paragraph explains why the pilot is small.", ""),
      },
    );
    const markdown = applied(result);
    expect(result.report.edits[0]?.anchors).toEqual([
      { id: "c1", result: "standalone" },
    ]);
    expect(markdown).toContain(
      "# Case 6: two separate comments\n{#c1}\n\nEta paragraph",
    );
  });

  it("18 the same deletion with resolve: standalone and resolved", () => {
    const { result } = roundTrip(
      c6,
      {
        c1: {
          reply: "Removed the sentence; the pilot size is in the plan table.",
          resolve: true,
        },
        c2: { reply: "ok" },
      },
      {
        extra: {
          edits: [
            { old: "Zeta paragraph explains why the pilot is small.", new: "" },
          ],
        },
      },
    );
    const markdown = applied(result);
    expect(result.report.resolved).toEqual(["c1"]);
    expect(markdown).toContain("{#c1}");
    expect(markdown).toContain("    status: resolved");
  });

  it("19 a failing edit refuses the whole round; the CLI's --skip-failed retries without that unit", () => {
    const threads = {
      c1: { reply: "Three customers." },
      c2: { reply: "Renamed." },
    };
    const first = roundTrip(c6, threads, {
      extra: { edits: [{ old: "who approves", new: "who signs" }] },
    });
    expect(errorCodes(first.result)).toEqual(["edit-not-found"]);
    expect(first.result.errors[0]?.thread).toBe("edits[0]");
    const retry = roundTrip(c6, threads);
    applied(retry.result);
  });

  it("20 a range edit rewriting a section widens the highlight over the new text", () => {
    const { result } = roundTrip(
      c2,
      { c1: { reply: "Rewrote the section as one owner table." } },
      {
        extra: {
          edits: [
            {
              from: "The creator confirms",
              to: "agreed with the brand",
              new: "Owner checks: creator (caption, link); ops (pin window, final go).",
            },
          ],
        },
      },
    );
    const markdown = applied(result);
    expect(result.report.edits[0]?.anchors).toEqual([
      { id: "c1", result: "widened" },
    ]);
    expect(markdown).toContain(
      "{==Owner checks: creator (caption, link); ops (pin window, final go).==}{#c1}",
    );
    expect(markdown).toContain("## {==Pre-flight==}{#c1}");
  });

  it("24 an edit copied before a browser save that rewrote whitespace still lands", () => {
    const spaced =
      '# Plan\n\n## Scope\n\nThe pilot runs with {==three customers==}{#c1} for two weeks.\n\nTail.\n\n---\ncomments:\n  c1:\n    body: "Which three?"\n    by: user\n    at: "2026-10-04T20:00:00.000Z"\n';
    const resaved = spaced.replace(
      "## Scope\n\nThe pilot",
      "## Scope\nThe pilot",
    );
    const viaEdits = roundTrip(
      spaced,
      { c1: { reply: "Named them in the scope section." } },
      {
        current: resaved,
        baseline: resaved,
        extra: {
          edits: [
            {
              old: "## Scope\n\nThe pilot runs with",
              new: "## Scope\n\nThe pilot runs with Acme, Birch and Cobalt, the",
            },
          ],
        },
      },
    );
    applied(viaEdits.result);
    expect(viaEdits.result.report.edits[0]?.match).toBe("whitespace");
    const viaClean = roundTrip(
      spaced,
      { c1: { reply: "Named them in the scope section." } },
      {
        current: resaved,
        baseline: resaved,
        edit: (clean) =>
          clean.replace(
            "runs with three",
            "runs with Acme, Birch and Cobalt, the three",
          ),
      },
    );
    const markdown = applied(viaClean.result);
    expect(markdown).toContain(
      "## Scope\nThe pilot runs with Acme, Birch and Cobalt, the {==three customers==}{#c1} for two weeks.",
    );
  });
});

// Scenarios 21 to 23 run on copies of Jordan's real documents (private,
// git-ignored); they skip when the corpus folder is absent.
const corpusDir = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "corpus",
);
const corpus = (name: string) => {
  const file = path.join(corpusDir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};
const ingestion = corpus("docs--ingestion-pipeline-v3-redesign.md");
const airtable = corpus("weekly-command-center--airtable-migration-preview.md");
const plan = corpus(
  "Planning--Resnick_Advisory_-_Internal_Implementation_Plan_(v3).md",
);

describe.skipIf(!ingestion || !airtable || !plan)(
  "round-proto scenarios on real documents",
  () => {
    it("21 ingestion doc: the replies glued above the block move to it; a reply to the global comment lands there", () => {
      const converted = canonical(ingestion as string);
      expect(converted).not.toMatch(/\{>>/);
      const { result } = roundTrip(
        converted,
        { c9: { reply: "Reviewed: nothing blocks increment 1." } },
        { extra: { partial: true } },
      );
      const markdown = applied(result);
      expect(jordanItems(markdown)).toEqual(jordanItems(converted));
      expect(markdown).toContain("    re: c9");
    });

    it("22 airtable preview: Mike's unread reply becomes readable; a note-only round", () => {
      const converted = canonical(airtable as string);
      const { round, result } = roundTrip(
        converted,
        {},
        {
          extra: {
            partial: true,
            note: "Checked: Mike's earlier reply is now readable.",
          },
          agentLabels: ["AI", "Mike"],
        },
      );
      expect(
        round.threads.flatMap((thread) =>
          thread.replies.map((reply) => reply.author),
        ),
      ).toContain("Mike");
      applied(result);
      expect(result.report.note).toBe("a1");
    });

    it("23 implementation plan: two review blocks merge and Jordan's c11 becomes an answerable thread", () => {
      const converted = canonical(plan as string);
      const { round, result } = roundTrip(
        converted,
        {
          c11: {
            reply: "Thanks; the overall note is now visible to both tools.",
          },
        },
        { extra: { partial: true } },
      );
      expect(round.threads.find((thread) => thread.id === "c11")).toMatchObject(
        { kind: "document", needsAnswer: true },
      );
      const markdown = applied(result);
      expect(reviewCleanText(markdown).clean).toBe(
        reviewCleanText(converted).clean,
      );
    });
  },
);
