import { describe, expect, it } from "vitest";
import {
  buildReviewRound,
  cleanOffsetToSource,
  RoughdraftFormatError,
  reviewCleanText,
  sha256Hex,
} from "../src/index";
import { canonical, fixture, ROUND_AT, startRound } from "./review-helpers";

describe("reviewCleanText", () => {
  it("removes highlights and refs and maps each anchor back to the original", () => {
    const markdown = fixture("canonical-continuation");
    const { clean, map } = reviewCleanText(markdown);
    expect(clean).toBe(
      "# Rollout\n\n## Pre-flight\n\nThe creator confirms the caption with ops before scheduling.\n\n- Caption matches the approved copy deck\n- Tracking link is the campaign short link\n\nTail line.\n\n",
    );
    expect(
      map.anchors.map((anchor) => [anchor.id, anchor.kind, anchor.line]),
    ).toEqual([
      ["c1", "highlight", 3],
      ["c1", "highlight", 5],
      ["c1", "highlight", 7],
    ]);
    for (const anchor of map.anchors) {
      const source = markdown.slice(
        anchor.sourceStart ?? 0,
        anchor.sourceEnd ?? 0,
      );
      expect(source).toBe(clean.slice(anchor.cleanStart, anchor.cleanEnd));
    }
    const offset = clean.indexOf("Tail line");
    expect(
      markdown
        .slice(cleanOffsetToSource(map, offset) ?? 0)
        .startsWith("Tail line"),
    ).toBe(true);
  });

  it("shows pending suggestions as the current text: deletions kept, additions dropped, substitutions old", () => {
    const { clean, map } = reviewCleanText(fixture("canonical-suggestions"));
    expect(clean).toBe(
      "# Budget\n\nAdd  to the intro.\n\nDelta paragraph repeats the budget numbers from the appendix.\n\nEpsilon paragraph repeats the timeline from the appendix.\n\nUse rough wording.\n\n",
    );
    expect(
      map.suggestions.map((item) => [
        item.id,
        item.kind,
        item.continues,
        item.line,
      ]),
    ).toEqual([
      ["s1", "addition", null, 3],
      ["s2", "deletion", null, 5],
      ["s3", "deletion", "s2", 7],
      ["s4", "substitution", null, 9],
    ]);
    expect(map.suggestions[0]?.note).toBe(
      'proposes adding "one concrete example" here; the clean text does not include it',
    );
    expect(map.suggestions[3]?.note).toContain(
      'replacing "rough" with "specific"',
    );
  });

  it("drops the fence-line refs and maps a code comment to its quoted lines", () => {
    const { clean, map } = reviewCleanText(fixture("canonical-code-block"));
    expect(clean).toContain("```ts\nimport { start }");
    const code = map.anchors.filter((anchor) => anchor.kind === "code");
    expect(
      code.map((anchor) => [
        anchor.id,
        clean.slice(anchor.cleanStart, anchor.cleanEnd),
      ]),
    ).toEqual([
      ["c3", 'import { start } from "./server";'],
      ["c1", "const port = 3000;\nstart({ port });"],
    ]);
  });

  it("leaves frontmatter and the review block out", () => {
    const { clean, map } = reviewCleanText(fixture("canonical-frontmatter"));
    expect(clean).not.toContain("title:");
    expect(clean).not.toContain("comments:");
    expect(map.bodyOffset).toBeGreaterThan(0);
  });

  it("reads an old-shape file the same way", () => {
    expect(reviewCleanText(fixture("repro-case6-ui-saved")).clean).toBe(
      reviewCleanText(canonical(fixture("repro-case6-ui-saved"))).clean.replace(
        /\n\n$/,
        "\n",
      ),
    );
  });
});

describe("buildReviewRound", () => {
  const c6 = canonical(fixture("repro-case6-ui-saved"));

  it("produces the round.json shape: threads, clean text, hash, version, round id", () => {
    const round = buildReviewRound(c6, {
      createdAt: ROUND_AT,
      path: "/abs/doc.md",
      version: "1:2:abc",
    });
    expect(round).toMatchObject({
      roughdraftRound: 1,
      createdAt: ROUND_AT,
      document: {
        path: "/abs/doc.md",
        sha256: sha256Hex(c6),
        version: "1:2:abc",
      },
      agentLabels: ["AI"],
      endmatter: "recognized",
      counts: { threads: 2, needsAnswer: 2, resolved: 0 },
    });
    expect(round.roundId).toBe(
      `r-20261004T210000-${sha256Hex(c6).slice(0, 4)}`,
    );
    expect(round.clean).toBe(reviewCleanText(c6).clean);
    expect(round.threads[0]).toEqual({
      id: "c1",
      kind: "comment",
      author: "user",
      at: "2026-10-04T19:00:58.493Z",
      needsAnswer: true,
      body: "Say how small: number of customers.",
      anchor: {
        segments: [{ text: "why the pilot is small", line: 2 }],
        section: "# Case 6: two separate comments",
        before: "# Case 6: two separate comments",
        after:
          "Eta paragraph explains who signs off on the pilot.\n\nTail line for the save trigger.",
      },
      replies: [],
      status: "open",
      resolved: null,
    });
  });

  it("gives two blocks of context on each side and the section heading", () => {
    const markdown = canonical(
      [
        "# Doc",
        "",
        "## Timeline",
        "",
        "One.",
        "",
        "Two.",
        "",
        "Three has {==the date==}{>>Which date?<<}{#c1}.",
        "",
        "Four.",
        "",
        "Five.",
        "",
        "Six.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        '    at: "2026-10-04T09:00:00.000Z"',
        "",
      ].join("\n"),
    );
    const anchor = startRound(markdown).threads[0]?.anchor;
    expect(anchor).toMatchObject({
      section: "## Timeline",
      before: "One.\n\nTwo.",
      after: "Four.\n\nFive.",
    });
  });

  it("lists a comment over several blocks as one thread with one segment per block", () => {
    const round = startRound(canonical(fixture("repro-case2-ui-saved")));
    expect(round.threads).toHaveLength(1);
    expect(round.threads[0]?.anchor?.segments).toEqual([
      { text: "Pre-flight", line: 3 },
      {
        text: "The creator confirms the caption with ops before scheduling.",
        line: 4,
      },
      { text: "Caption matches the approved copy deck", line: 6 },
      { text: "Tracking link is the campaign short link", line: 8 },
      { text: "Pin window is agreed with the brand", line: 10 },
    ]);
  });

  it("anchors a code comment on its quoted lines", () => {
    const round = startRound(fixture("canonical-code-block"));
    const c1 = round.threads.find((thread) => thread.id === "c1");
    expect(c1).toMatchObject({
      kind: "code",
      anchor: {
        segments: [{ text: "const port = 3000;\nstart({ port });", line: 8 }],
        lines: [3, 4],
      },
      replies: [{ id: "a1", author: "AI", body: "Changed both." }],
      needsAnswer: false,
    });
  });

  it("lists global comments first, as entries of the same shape, and keeps a lost anchor's flag", () => {
    const docs = startRound(fixture("canonical-document-comments"));
    expect(docs.threads.map((thread) => [thread.id, thread.kind])).toEqual([
      ["c2", "document"],
      ["a2", "document"],
      ["c1", "comment"],
    ]);
    expect(docs.threads[0]).toMatchObject({
      anchor: null,
      body: "Overall this reads well.\n\nTwo things before Friday:\n- shorten the intro\n- add the budget table",
    });
    const lost = startRound(fixture("canonical-lost-anchor")).threads.find(
      (thread) => thread.lostAnchor,
    );
    expect(lost).toMatchObject({ kind: "document", lostAnchor: true });
  });

  it("decides needsAnswer from the latest entry of an open thread", () => {
    const base = (entries: string) =>
      `Keep {==this==}{#c1} and {++that++}{#s1}.\n\n---\ncomments:\n  c1:\n    body: "Root"\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n${entries}suggestions:\n  s1:\n    by: AI\n    at: "2026-10-04T09:00:00.000Z"\n`;
    const reply = (id: string, by: string, minute: number, re = "c1") =>
      `  ${id}:\n    body: "x"\n    by: ${by}\n    at: "2026-10-04T09:${String(minute).padStart(2, "0")}:00.000Z"\n    re: ${re}\n`;
    const answer = (entries: string) =>
      Object.fromEntries(
        startRound(base(entries)).threads.map((thread) => [
          thread.id,
          thread.needsAnswer,
        ]),
      );
    // A root by Jordan with no reply waits; an agent root does not.
    expect(answer("")).toEqual({ c1: true, s1: false });
    // The agent answered last.
    expect(answer(reply("a1", "AI", 5))).toEqual({ c1: false, s1: false });
    // Jordan replied after the agent.
    expect(answer(reply("a1", "AI", 5) + reply("c2", "user", 6, "a1"))).toEqual(
      { c1: true, s1: false },
    );
    // Jordan answered the agent's suggestion.
    expect(answer(reply("c2", "user", 7, "s1"))).toEqual({
      c1: true,
      s1: true,
    });
    // Resolved threads wait for nothing.
    expect(answer("").c1).toBe(true);
    const resolved = base("")
      .replace(
        '    at: "2026-10-04T09:00:00.000Z"\nsuggestions',
        '    at: "2026-10-04T09:00:00.000Z"\nsuggestions',
      )
      .replace("    by: user\n", "    by: user\n")
      .replace(
        'body: "Root"\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n',
        'body: "Root"\n    by: user\n    at: "2026-10-04T09:00:00.000Z"\n    status: resolved\n',
      );
    expect(
      startRound(resolved).threads.find((thread) => thread.id === "c1")
        ?.needsAnswer,
    ).toBe(false);
    // Other agent labels count as the agent.
    expect(
      startRound(base(reply("c2", "Mike", 5)), "r", [
        "AI",
        "Mike",
      ]).threads.find((thread) => thread.id === "c1")?.needsAnswer,
    ).toBe(false);
  });

  it("lists every reply in time order with re only when it answers a reply", () => {
    const round = startRound(fixture("canonical-prose-anchor"));
    for (const thread of round.threads) {
      const times = thread.replies.map((reply) => Date.parse(reply.at ?? ""));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const reply of thread.replies)
        if (reply.re) expect(reply.re).not.toBe(thread.id);
    }
  });

  it("refuses an old-shape file (D11) unless allowLegacy, which reports the normalization", () => {
    const old = fixture("repro-case6-ui-saved");
    expect(() => buildReviewRound(old)).toThrow(RoughdraftFormatError);
    expect(() => buildReviewRound(old)).toThrow(/roughdraft doctor --fix/);
    const round = buildReviewRound(old, {
      allowLegacy: true,
      createdAt: ROUND_AT,
    });
    expect(round.normalized.map((change) => change.code)).toContain(
      "legacy-inline-body",
    );
    expect(round.threads).toHaveLength(2);
  });
});
