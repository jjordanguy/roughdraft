import { describe, expect, it } from "vitest";
import { applyReviewResponse, buildReviewRound } from "../src/index";
import {
  APPLY_AT,
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

const doc = (body: string, comments: string, suggestions = "") =>
  `${body}\n\n---\ncomments:\n${comments}${suggestions ? `suggestions:\n${suggestions}` : ""}`;
const entry = (id: string, body: string, by = "user", minute = 0, extra = "") =>
  `  ${id}:\n    body: "${body}"\n    by: ${by}\n    at: "2026-10-04T09:${String(minute).padStart(2, "0")}:00.000Z"\n${extra}`;

const c6 = canonical(fixture("repro-case6-ui-saved"));
const answerBoth = {
  c1: { reply: "Three customers." },
  c2: { reply: "Named Dana Ruiz." },
};

function run(
  markdown: string,
  threads: Parameters<typeof response>[1],
  options: {
    current?: string;
    baseline?: string | null;
    clean?: (clean: string) => string;
    extra?: Parameters<typeof response>[2];
  } = {},
) {
  const round = startRound(markdown, "r-apply");
  return apply({
    base: markdown,
    current: options.current ?? markdown,
    baseline: options.baseline ?? undefined,
    cleanEdited: options.clean ? options.clean(round.clean) : undefined,
    response: response(round.roundId, threads, options.extra),
    round,
  });
}

function ok(result: ReturnType<typeof apply>): string {
  expect(result.errors).toEqual([]);
  expect(readersAccept(result.markdown as string)).toEqual(NO_PROBLEMS);
  return result.markdown as string;
}

describe("applyReviewResponse: refusals (nothing written)", () => {
  it.each([
    [
      "unknown key at the top",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: answerBoth,
        extra: 1,
      },
      "unknown-key",
    ],
    [
      "unknown key in a thread",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: { reply: "x", replay: "y" } },
      },
      "unknown-key",
    ],
    [
      "unknown key in an edit",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: answerBoth,
        edits: [{ old: "Zeta", new: "Z", olds: "x" }],
      },
      "unknown-key",
    ],
    [
      "a wrong schema version",
      { roughdraftResponse: 2, roundId: "r-apply", threads: answerBoth },
      "bad-response",
    ],
    [
      "skip with a reply",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: { reply: "x", skip: "later" } },
      },
      "skip-with-actions",
    ],
    [
      "an empty action",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: {} },
      },
      "no-action",
    ],
    [
      "an empty reply",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: { reply: "  \n " } },
      },
      "empty-reply",
    ],
    [
      "a reply with a close delimiter",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: { reply: "see <<} here" } },
      },
      "markup-in-reply",
    ],
    [
      "a bad decision",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: { ...answerBoth, c1: { decision: "maybe" } },
      },
      "bad-decision",
    ],
    [
      "an edit with two forms",
      {
        roughdraftResponse: 1,
        roundId: "r-apply",
        threads: answerBoth,
        edits: [{ old: "Zeta", anchor: "c1", new: "Z" }],
      },
      "bad-edit",
    ],
  ])("refuses %s", (_label, body, code) => {
    const round = startRound(c6, "r-apply");
    const result = apply({ current: c6, response: body, round });
    expect(errorCodes(result)).toContain(code);
    expect(result.markdown).toBeNull();
    expect(result.report).toMatchObject({ ok: false, status: "refused" });
  });

  it("refuses a response for another round", () => {
    const round = startRound(c6, "r-apply");
    expect(
      errorCodes(
        apply({
          current: c6,
          response: response("r-other", answerBoth),
          round,
        }),
      ),
    ).toEqual(["round-mismatch"]);
  });

  it("refuses unanswered-thread, naming the thread", () => {
    const result = run(c6, { c1: { reply: "Three customers." } });
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "unanswered-thread", thread: "c2" }),
    ]);
  });

  it("accepts skip and followUp as answers", () => {
    ok(
      run(c6, {
        c1: { reply: "Three customers." },
        c2: { skip: "Waiting on the approver list." },
      }),
    );
  });

  it("refuses unknown-thread, thread-not-in-round and thread-removed", () => {
    expect(errorCodes(run(c6, { ...answerBoth, c9: { reply: "x" } }))).toEqual([
      "unknown-thread",
    ]);
    const added = c6
      .replace("Tail line", "{==Tail==}{#c3} line")
      .concat(entry("c3", "New one", "user", 30));
    expect(
      errorCodes(
        run(
          c6,
          { ...answerBoth, c3: { reply: "x" } },
          { current: added, baseline: added },
        ),
      ),
    ).toEqual(["thread-not-in-round"]);
    const removed = c6
      .replace("{==who signs off==}{#c2}", "who signs off")
      .replace(/ {2}c2:\n(?: {4}.*\n)+/, "");
    expect(
      errorCodes(run(c6, answerBoth, { current: removed, baseline: removed })),
    ).toEqual(["thread-removed"]);
  });

  it("refuses thread-changed when Jordan replied in the thread since the round", () => {
    const replied = c6.concat(
      entry("c3", "Also the timing.", "user", 40, "    re: c1\n"),
    );
    const result = run(c6, answerBoth, { current: replied, baseline: replied });
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "thread-changed", thread: "c1" }),
    ]);
  });

  it("refuses edit-not-found and edit-ambiguous with lines", () => {
    expect(
      errorCodes(
        run(c6, answerBoth, {
          extra: { edits: [{ old: "Omega paragraph", new: "x" }] },
        }),
      ),
    ).toEqual(["edit-not-found"]);
    const ambiguous = run(c6, answerBoth, {
      extra: { edits: [{ old: "explains", new: "shows" }] },
    });
    expect(ambiguous.errors).toEqual([
      expect.objectContaining({ code: "edit-ambiguous", lines: [2, 4] }),
    ]);
  });

  it("settles an ambiguous edit with near", () => {
    const markdown = ok(
      run(c6, answerBoth, {
        extra: { edits: [{ old: "explains", new: "shows", near: "c2" }] },
      }),
    );
    expect(markdown).toContain("Zeta paragraph explains");
    expect(markdown).toContain("Eta paragraph shows");
  });

  it("refuses edits-overlap", () => {
    const result = run(c6, answerBoth, {
      extra: {
        edits: [
          { old: "Zeta paragraph explains", new: "A" },
          { old: "paragraph explains why", new: "B" },
        ],
      },
    });
    expect(errorCodes(result)).toEqual(["edits-overlap"]);
  });

  it("refuses edits and an edited clean.md together", () => {
    const result = run(c6, answerBoth, {
      clean: (clean) => clean.replace("Tail", "End"),
      extra: { edits: [{ old: "Zeta", new: "Z" }] },
    });
    expect(errorCodes(result)).toEqual(["bad-edit"]);
  });

  it("refuses review markup typed into clean.md outside code", () => {
    const result = run(c6, answerBoth, {
      clean: (clean) => clean.replace("Tail line", "Tail {==line==}"),
    });
    expect(errorCodes(result)).toEqual(["markup-in-edit"]);
  });

  it("refuses decision-on-comment and resolve-on-suggestion", () => {
    expect(
      errorCodes(run(c6, { ...answerBoth, c1: { decision: "accept" } })),
    ).toEqual(["decision-on-comment"]);
    const c5 = canonical(fixture("repro-case5-ui-saved"));
    expect(errorCodes(run(c5, { s1: { resolve: true } }))).toEqual([
      "resolve-on-suggestion",
    ]);
  });

  it("refuses already-replied-this-round unless followUp", () => {
    const first = ok(run(c6, answerBoth));
    const round = startRound(c6, "r-apply");
    const again = apply({
      base: c6,
      current: first,
      response: response(round.roundId, {
        c1: { reply: "One more thing." },
        c2: { skip: "done" },
      }),
      round,
    });
    expect(errorCodes(again)).toEqual(["already-replied-this-round"]);
    const followUp = apply({
      base: c6,
      current: first,
      response: response(round.roundId, {
        c1: { reply: "One more thing.", followUp: true },
        c2: { skip: "done" },
      }),
      round,
    });
    expect(followUp.errors).toEqual([]);
    expect(followUp.report.replies).toEqual([{ thread: "c1", id: "a3" }]);
  });

  it("refuses an old-shape file with a message naming roughdraft doctor --fix (D11)", () => {
    const old = fixture("repro-case6-ui-saved");
    const result = applyReviewResponse({
      base: old,
      current: old,
      response: response("r-x", answerBoth),
      now: APPLY_AT,
    });
    expect(errorCodes(result)).toEqual(["legacy-format", "legacy-format"]);
    expect(result.errors[0]?.message).toMatch(/roughdraft doctor --fix/);
    const allowed = applyReviewResponse({
      base: old,
      current: old,
      response: response("r-x", answerBoth),
      now: APPLY_AT,
      allowLegacy: true,
    });
    expect(allowed.errors).toEqual([]);
    expect(allowed.report.normalized.length).toBeGreaterThan(0);
  });

  it("refuses a note on a file whose final comments: section is text", () => {
    const ignored =
      '# Doc\n\nPlain text.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n';
    expect(
      errorCodes(run(ignored, {}, { extra: { note: "Round 1." } })),
    ).toEqual(["document-invalid"]);
  });
});

describe("applyReviewResponse: anchors follow the text", () => {
  const two = doc(
    "# Two\n\nWe launch in {==May==}{#c1} with {==two people==}{#c2} on ops. Keep {==this claim==}{#c3} short.{#c4}",
    entry("c1", "June?") +
      entry("c2", "Name them.", "user", 1) +
      entry("c3", "Source?", "user", 2) +
      entry("c4", "Standalone note.", "user", 3),
  );
  const all = {
    c1: { skip: "-" },
    c2: { skip: "-" },
    c3: { skip: "-" },
    c4: { skip: "-" },
  };

  it("inside: an edit within a highlight keeps it on the new words", () => {
    const result = run(two, all, {
      extra: { edits: [{ old: "two people", new: "Ana and Raj" }] },
    });
    expect(ok(result)).toContain("{==Ana and Raj==}{#c2}");
    expect(result.report.anchors).toEqual([{ id: "c2", result: "inside" }]);
  });

  it("kept: a rewrite around a highlight keeps it on its words when they survive once", () => {
    const result = run(two, all, {
      extra: {
        edits: [
          {
            old: "Keep this claim short.",
            new: "Keep this claim short and cite the Q3 report.",
          },
        ],
      },
    });
    expect(ok(result)).toContain(
      "Keep {==this claim==}{#c3} short and cite the Q3 report.",
    );
    expect(result.report.anchors).toContainEqual({ id: "c3", result: "kept" });
  });

  it("widened: a rewrite that drops a highlight's words covers the new text, one segment per line", () => {
    const result = run(two, all, {
      extra: {
        edits: [
          {
            old: "We launch in May with two people on ops.",
            new: "We launch in June.\nAna and Raj run ops.",
          },
        ],
      },
    });
    const markdown = ok(result);
    expect(markdown).toContain(
      "{==We launch in June.==}{#c1}{#c2}\n{==Ana and Raj run ops.==}{#c1}{#c2}",
    );
    expect(result.report.anchors).toEqual([
      { id: "c1", result: "widened" },
      { id: "c2", result: "widened" },
    ]);
  });

  it("a rewritten section keeps each highlight on its own paragraph, whole, with paragraphs added", () => {
    // From a real round: four decisions, each highlighted by Jordan, rewritten
    // with an update paragraph before them and a new question after D3. The
    // highlights used to slide two paragraphs down and open inside the bold.
    const decisions = doc(
      [
        "## 4. Decisions",
        "",
        "{==**D1. Look after a pick.** Context: the cards collapse to a name. Options: (a) keep that, (b) chips.==}{#c1}",
        "",
        "{==**D2. Converting old values.** Context: old packs do not say which base. Options: (a) convert, (b) leave.==}{#c2}",
        "",
        "{==**D3. The order page dropdown.** Context: the order page has its own dropdown. Options: (a) keep, (b) remove.==}{#c3}",
        "",
        "{==**D4. Wording of the shop line.** Context: documents need one line. Proposal: method, base, effects.==}{#c4}",
        "",
        "## 5. Assumptions to confirm",
      ].join("\n"),
      entry("c1", "agree") +
        entry("c2", "b", "user", 1) +
        entry("c3", "remove it and put the choice in the summary", "user", 2) +
        entry("c4", "agree", "user", 3),
    );
    const result = run(
      decisions,
      {
        c1: { skip: "-" },
        c2: { skip: "-" },
        c3: { skip: "-" },
        c4: { skip: "-" },
      },
      {
        clean: () =>
          [
            "## 4. Decisions (Updated round 2)",
            "",
            "**Round 2 update:** D1 and D4 locked (your c1, c4). D2 decided as (b) (your c2). D3 replaced by your ruling (your c3).",
            "",
            "**D1. Look after a pick. Locked:** row 1 collapses to its name with an X; rows 2 and 3 stay as chips.",
            "",
            "**D2. Old values. Decided (b):** old packs keep their old names and only new picks use the new rows.",
            "",
            "**D3. The order page. Decided, your ruling:** the separate section goes; the method is chosen inside the summary.",
            "",
            "**O1. Does Add options also offer the ink base swap?** Recommendation: offer both.",
            "",
            "**D4. Wording of the shop line. Locked:** method first, then base, then effects joined with +.",
            "",
            "## 5. Assumptions (Updated round 2)",
            "",
          ].join("\n"),
      },
    );
    const markdown = ok(result);
    expect(markdown).toContain(
      "{==**D1. Look after a pick. Locked:** row 1 collapses to its name with an X; rows 2 and 3 stay as chips.==}{#c1}",
    );
    expect(markdown).toContain(
      "{==**D2. Old values. Decided (b):** old packs keep their old names and only new picks use the new rows.==}{#c2}",
    );
    expect(markdown).toContain(
      "{==**D3. The order page. Decided, your ruling:** the separate section goes; the method is chosen inside the summary.==}{#c3}",
    );
    expect(markdown).toContain(
      "{==**D4. Wording of the shop line. Locked:** method first, then base, then effects joined with +.==}{#c4}",
    );
    expect(markdown).toContain(
      "\n**O1. Does Add options also offer the ink base swap?** Recommendation: offer both.\n",
    );
    expect(markdown).toContain("\n**Round 2 update:** D1 and D4 locked");
    expect(markdown).not.toContain("**{==");
    expect(markdown).toContain("## 5. Assumptions (Updated round 2)\n");
    // Each hunk is the whole paragraph and the highlight covered the whole
    // old paragraph, so the highlight simply stays on the new text.
    expect(result.report.anchors).toEqual([
      { id: "c1", result: "inside" },
      { id: "c2", result: "inside" },
      { id: "c3", result: "inside" },
      { id: "c4", result: "inside" },
    ]);
  });

  it("standalone: deleting all of a comment's text keeps it as a standalone comment there", () => {
    const result = run(two, all, {
      extra: { edits: [{ old: " with two people on ops", new: "" }] },
    });
    expect(ok(result)).toContain("We launch in {==May==}{#c1}{#c2}. Keep");
    expect(result.report.anchors).toEqual([{ id: "c2", result: "standalone" }]);
  });

  it("moved: a standalone comment inside an edited range moves to the end of the new text", () => {
    const result = run(two, all, {
      extra: { edits: [{ from: "short.", to: "short.", new: "brief." }] },
    });
    expect(ok(result)).toContain("Keep {==this claim==}{#c3} brief.{#c4}");
    const across = run(two, all, {
      clean: (clean) => clean.replace("short.", "short, as agreed."),
    });
    expect(ok(across)).toContain("short, as agreed.{#c4}");
  });

  it("a code comment follows its lines when the code above it changes", () => {
    const code = fixture("canonical-code-block");
    const round = startRound(code, "r-code");
    const threads = Object.fromEntries(
      round.threads
        .filter((thread) => thread.needsAnswer)
        .map((thread) => [thread.id, { skip: "-" }]),
    );
    const result = apply({
      current: code,
      cleanEdited: round.clean.replace(
        'import { start } from "./server";\n',
        'import { start } from "./server";\nimport { env } from "./env";\n',
      ),
      response: response(round.roundId, threads),
      round,
    });
    const markdown = ok(result);
    expect(markdown).toContain(
      '    lines: [4, 5]\n    quote: "const port = 3000;\\nstart({ port });"',
    );
    expect(result.report.anchors).toContainEqual({ id: "c1", result: "moved" });
  });

  it("a comment on a deleted code block becomes a standalone comment", () => {
    const code = fixture("canonical-code-block");
    const round = startRound(code, "r-code");
    const threads = Object.fromEntries(
      round.threads
        .filter((thread) => thread.needsAnswer)
        .map((thread) => [thread.id, { skip: "-" }]),
    );
    const result = apply({
      current: code,
      cleanEdited: round.clean.replace(/```ts\n[\s\S]*?```\n\n/, ""),
      response: response(round.roundId, threads),
      round,
    });
    const markdown = ok(result);
    expect(markdown).not.toContain("```");
    expect(markdown).toMatch(/\{#c1\}\{#c3\}|\{#c3\}\{#c1\}|\{#c1\} \{#c3\}/);
  });
});

describe("applyReviewResponse: decisions", () => {
  const body =
    "Use {~~Postgres~>SQLite~~}{#s1} here. Add {++a cache++}{#s2} later. Drop {--the old note--}{#s3} now.";
  const suggestions = [
    '  s1:\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n',
    '  s2:\n    by: user\n    at: "2026-10-04T09:01:00.000Z"\n',
    '  s3:\n    by: user\n    at: "2026-10-04T09:02:00.000Z"\n',
  ].join("");
  const plain = doc(
    `# Sub\n\n${body}`,
    entry("c1", "Fine either way.", "user", 5, "    re: s3\n"),
    suggestions,
  );
  const answers = { s1: { skip: "-" }, s2: { skip: "-" }, s3: { skip: "-" } };

  it("accept applies each kind; reject restores each kind; the markers and entries go", () => {
    const accepted = ok(
      run(plain, {
        s1: { decision: "accept" },
        s2: { decision: "accept" },
        s3: { decision: "accept", dropReplies: true },
      }),
    );
    expect(
      accepted.startsWith(
        "# Sub\n\nUse SQLite here. Add a cache later. Drop  now.\n\n---\n",
      ),
    ).toBe(true);
    expect(accepted).not.toContain("suggestions:");
    const rejected = ok(
      run(plain, {
        s1: { decision: "reject" },
        s2: { decision: "reject" },
        s3: { decision: "reject", dropReplies: true },
      }),
    );
    expect(
      rejected.startsWith(
        "# Sub\n\nUse Postgres here. Add  later. Drop the old note now.\n\n---\n",
      ),
    ).toBe(true);
  });

  it("deciding a suggestion with replies needs dropReplies, and echoes what it removed", () => {
    expect(
      errorCodes(run(plain, { ...answers, s3: { decision: "accept" } })),
    ).toEqual(["thread-has-replies"]);
    const result = run(plain, {
      ...answers,
      s3: { decision: "accept", dropReplies: true, reply: "Done." },
    });
    const markdown = ok(result);
    expect(result.report.droppedReplies).toEqual([
      { thread: "s3", id: "c1", author: "user", body: "Fine either way." },
    ]);
    expect(markdown).not.toContain("Fine either way.");
    expect(markdown).toContain(
      'Accepted your suggestion deleting \\"the old note\\": Done.',
    );
  });

  it("a decision without replies needs no dropReplies, and the agent's reply goes into the round note", () => {
    const result = run(
      plain,
      { ...answers, s1: { decision: "reject", reply: "We stay on Postgres." } },
      { extra: { note: "Round 2." } },
    );
    const markdown = ok(result);
    expect(result.report.rejected).toEqual(["s1"]);
    expect(markdown).toContain(
      'body: "Round 2. Rejected your suggestion \\"Postgres\\" to \\"SQLite\\": We stay on Postgres."',
    );
    expect(markdown).not.toContain("re: s1");
  });

  it("a comment anchored on a suggestion marker stays on the decided text", () => {
    const anchored = doc(
      "# Doc\n\nUse {~~Postgres~>SQLite~~}{#s1}{#c1} here.",
      entry("c1", "Why?"),
      suggestions.split("  s2")[0] ?? "",
    );
    const result = run(anchored, {
      s1: { decision: "accept" },
      c1: { skip: "-" },
    });
    expect(ok(result)).toContain("Use {==SQLite==}{#c1} here.");
  });
});

describe("applyReviewResponse: restoring Jordan's items changed outside Roughdraft", () => {
  it("puts back a comment body an agent edited directly (no baseline: the round's base)", () => {
    const damaged = c6.replace(
      "Say how small: number of customers.",
      "Say how small.",
    );
    const result = run(c6, answerBoth, { current: damaged });
    const markdown = ok(result);
    expect(result.report.restored).toEqual([
      { id: "c1", what: "entry", keys: ["body"] },
    ]);
    expect(result.report.rebase.outsideChanges).toBe(true);
    expect(jordanItems(markdown)).toEqual(jordanItems(c6));
  });

  it("treats a change the browser saved (in the baseline) as Jordan's and keeps it", () => {
    const browser = c6.replace(
      "Name the person, not the team.",
      "Name the person and their title.",
    );
    const result = run(
      c6,
      {
        c1: { reply: "Three customers." },
        c2: { skip: "Will answer next round." },
      },
      { current: browser, baseline: browser },
    );
    const markdown = ok(result);
    expect(result.report.restored).toEqual([]);
    expect(markdown).toContain("Name the person and their title.");
  });

  it("re-wraps a highlight removed outside Roughdraft when its text is still there", () => {
    const damaged = c6.replace("{==who signs off==}{#c2}", "who signs off");
    const result = run(c6, answerBoth, { current: damaged });
    expect(ok(result)).toContain("{==who signs off==}{#c2}");
    expect(result.report.restored).toEqual([{ id: "c2", what: "anchor" }]);
  });

  it("keeps a comment whose highlighted text is gone as a global comment with the quote", () => {
    const damaged = c6.replace("{==who signs off==}{#c2}", "who approves");
    const result = run(
      c6,
      { c1: { reply: "Three customers." } },
      { current: damaged, extra: { partial: true } },
    );
    const markdown = ok(result);
    expect(result.report.restored).toEqual([{ id: "c2", what: "quote" }]);
    expect(markdown).toContain(
      '    scope: document\n    quote: "who signs off"',
    );
  });

  it("puts back a suggestion marker removed outside Roughdraft", () => {
    const c5 = canonical(fixture("repro-case5-ui-saved"));
    const damaged = c5.replace(
      "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}",
      "Delta paragraph repeats the budget numbers from the appendix.",
    );
    const result = run(
      c5,
      { s1: { reply: "Leaving it to you." } },
      { current: damaged },
    );
    expect(ok(result)).toContain(
      "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}",
    );
    expect(result.report.restored).toEqual([{ id: "s1", what: "marker" }]);
  });

  it("puts back a status changed outside, then the agent's resolve lands on top", () => {
    const damaged = c6.replace(
      '    at: "2026-10-04T19:01:00.289Z"\n',
      '    at: "2026-10-04T19:01:00.289Z"\n    status: resolved\n',
    );
    const result = run(
      c6,
      {
        c1: { reply: "x" },
        c2: { reply: "Named.", resolve: "Named the approver." },
      },
      { current: damaged },
    );
    const markdown = ok(result);
    expect(result.report.restored).toEqual([
      { id: "c2", what: "entry", keys: ["status"] },
    ]);
    expect(markdown).toContain(
      '    status: resolved\n    resolved: "Named the approver."',
    );
  });

  it("refuses entry-conflict when Jordan changed a key in the browser that the response changes too", () => {
    const browser = c6.replace(
      '    at: "2026-10-04T19:01:00.289Z"\n',
      '    at: "2026-10-04T19:01:00.289Z"\n    status: resolved\n    resolved: "Fine as is."\n',
    );
    const result = run(
      c6,
      {
        c1: { reply: "x" },
        c2: { reply: "Named.", resolve: "Named the approver." },
      },
      { current: browser, baseline: browser },
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "entry-conflict", thread: "c2" }),
    ]);
  });
});

describe("applyReviewResponse: ids, notes and retries", () => {
  it("allocates aN over every id in the file, never a cN Jordan's tab could take", () => {
    const withAgent = c6.concat(
      entry("a4", "Earlier note.", "AI", 50, "    scope: document\n"),
    );
    const result = run(withAgent, answerBoth, { extra: { note: "Round 2." } });
    ok(result);
    expect(result.report.replies.map((reply) => reply.id)).toEqual([
      "a5",
      "a6",
    ]);
    expect(result.report.note).toBe("a7");
  });

  it("returns already-applied for the same response on the file it produced", () => {
    const round = startRound(c6, "r-apply");
    const body = response(round.roundId, answerBoth, { note: "Round 1." });
    const first = apply({ base: c6, current: c6, response: body, round });
    const again = apply({
      base: c6,
      current: first.markdown as string,
      response: body,
      round,
    });
    expect(again.errors).toEqual([]);
    expect(again.report.status).toBe("already-applied");
    expect(again.markdown).toBe(first.markdown);
  });

  it("reports the doctor breakdown of the result", () => {
    const result = run(c6, answerBoth, { extra: { note: "Round 1." } });
    expect(result.report.doctor).toEqual({
      ok: true,
      comments: 5,
      roots: 2,
      documentComments: 1,
      replies: 2,
      suggestions: 0,
    });
  });

  it("rebuilds the round from base when none is given", () => {
    const roundId = buildReviewRound(c6).roundId;
    const result = applyReviewResponse({
      base: c6,
      current: c6,
      response: response(roundId, answerBoth),
      now: APPLY_AT,
    });
    expect(result.errors).toEqual([]);
  });
});
