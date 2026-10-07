import { describe, expect, it } from "vitest";
import {
  parseReviewModel,
  type RfmModelComment,
  type RfmModelSuggestion,
} from "./index";

const lines = (...parts: string[]) => parts.join("\n");

function comment(markdown: string, id: string): RfmModelComment {
  const found = parseReviewModel(markdown).comments.find(
    (item) => item.id === id,
  );
  if (!found) throw new Error(`comment ${id} not in model`);
  return found;
}

function suggestion(markdown: string, id: string): RfmModelSuggestion {
  const found = parseReviewModel(markdown).suggestions.find(
    (item) => item.id === id,
  );
  if (!found) throw new Error(`suggestion ${id} not in model`);
  return found;
}

const AT = '"2026-10-05T09:00:00.000Z"';

describe("parseReviewModel: the canonical format", () => {
  it("reads a prose anchor whose text lives in the review block", () => {
    const markdown = lines(
      "# Plan",
      "",
      "Keep {==this claim==}{#c1} as written.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Needs a source."',
      "    by: user",
      `    at: ${AT}`,
      "",
    );
    const model = parseReviewModel(markdown);
    expect(model.diagnostics).toEqual([]);
    expect(model.comments).toHaveLength(1);
    expect(model.comments[0]).toMatchObject({
      id: "c1",
      kind: "comment",
      scope: "inline",
      body: "Needs a source.",
      by: "user",
      at: "2026-10-05T09:00:00.000Z",
      bodySource: "endmatter",
      metadataSource: "endmatter",
      lostAnchor: false,
      primaryAnchor: {
        kind: "highlight",
        text: "this claim",
        line: 3,
        offset: markdown.indexOf("{==this"),
        endOffset: markdown.indexOf("{#c1}"),
      },
    });
  });

  it("merges continuation anchors under one id, the first in document order being primary", () => {
    const model = parseReviewModel(
      lines(
        "## {==Pre-flight==}{#c1}",
        "",
        "{==The creator confirms the caption.==}{#c1}",
        "",
        "- {==Caption matches the deck==}{#c1}",
        "- Tracking link is the short link",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Split these by owner."',
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
    );
    expect(model.diagnostics).toEqual([]);
    expect(model.comments).toHaveLength(1);
    const [c1] = model.comments;
    expect(
      c1?.anchors.map((anchor) => [anchor.text, anchor.blockIndex]),
    ).toEqual([
      ["Pre-flight", 0],
      ["The creator confirms the caption.", 1],
      ["Caption matches the deck", 2],
    ]);
    expect(c1?.primaryAnchor?.text).toBe("Pre-flight");
    expect(model.summary).toMatchObject({ roots: 1, comments: 1 });
  });

  it("reads a code block anchor from the fence line with its lines and quote", () => {
    const markdown = lines(
      "```ts {#c1}",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "```",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Merge these."',
      "    by: user",
      `    at: ${AT}`,
      "    lines: [2, 3]",
      '    quote: "const b = 2;\\nconst c = 3;"',
      "",
    );
    const c1 = comment(markdown, "c1");
    expect(c1).toMatchObject({
      scope: "code",
      lines: [2, 3],
      quote: "const b = 2;\nconst c = 3;",
      primaryAnchor: {
        kind: "code",
        text: "const b = 2;\nconst c = 3;",
        line: 1,
        offset: markdown.indexOf("{#c1}"),
      },
    });
    expect(parseReviewModel(markdown).diagnostics).toEqual([]);
  });

  it("derives the quote of a code anchor from its lines when the entry has none", () => {
    const c1 = comment(
      lines(
        "~~~python {#c1} {#c2}",
        "x = 1",
        "y = 2",
        "~~~",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Name it."',
        "    by: user",
        `    at: ${AT}`,
        "    lines: [2, 2]",
        "  c2:",
        '    body: "Whole block."',
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
      "c1",
    );
    expect(c1.quote).toBe("y = 2");
    expect(c1.anchors[0]?.text).toBe("y = 2");
  });

  it("treats inline code inside a highlight as a normal prose anchor", () => {
    const c1 = comment(
      lines(
        "Start it with {==`pnpm dev`==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Use the wrapper."',
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
      "c1",
    );
    expect(c1).toMatchObject({ scope: "inline" });
    expect(c1.primaryAnchor?.text).toBe("`pnpm dev`");
  });

  it("reads a bare ref as a standalone comment at that spot", () => {
    const markdown = lines(
      "The pilot runs for two weeks.{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "How many customers?"',
      "    by: user",
      `    at: ${AT}`,
      "",
    );
    expect(comment(markdown, "c1")).toMatchObject({
      scope: "standalone",
      primaryAnchor: {
        kind: "standalone",
        text: "",
        offset: markdown.indexOf("{#c1}"),
      },
    });
  });

  it("leaves Pandoc-style ids that are not review ids alone", () => {
    const model = parseReviewModel("# Intro {#intro}\n\nText.\n");
    expect(model.comments).toEqual([]);
    expect(model.diagnostics).toEqual([]);
  });

  it("reads document-level comments, explicit by scope or implicit in legacy files", () => {
    const markdown = lines(
      "Keep this.{>>Root<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      `    at: ${AT}`,
      "  c2:",
      '    body: "Overall fine."',
      "    by: user",
      `    at: ${AT}`,
      "  c3:",
      '    body: "Round done."',
      "    by: AI",
      `    at: ${AT}`,
      "    scope: document",
      "",
    );
    const model = parseReviewModel(markdown);
    expect(
      model.comments.map((item) => [item.id, item.scope, item.lostAnchor]),
    ).toEqual([
      ["c1", "standalone", false],
      ["c2", "document", false],
      ["c3", "document", false],
    ]);
    expect(model.summary).toMatchObject({
      roots: 1,
      documentComments: 2,
      replies: 0,
      comments: 3,
    });
  });

  it("marks an anchorless, unscoped entry as a lost anchor in a current-format file", () => {
    const model = parseReviewModel(
      lines(
        "Keep {==this claim==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Needs proof."',
        "    by: user",
        `    at: ${AT}`,
        "  c2:",
        '    body: "This sentence contradicts the timeline."',
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
    );
    expect(model.comments.find((item) => item.id === "c2")).toMatchObject({
      scope: "document",
      lostAnchor: true,
    });
    expect(model.diagnostics.map((item) => item.code)).toEqual([
      "orphan-endmatter-entry",
    ]);
  });

  it("decodes <br> in bodies and resolution summaries to line breaks", () => {
    const c1 = comment(
      lines(
        "Keep {==this==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "First line.<br><br>Second paragraph.<BR/>Third."',
        "    by: user",
        `    at: ${AT}`,
        "    status: resolved",
        '    resolved: "Done.<br>Both parts."',
        "",
      ),
      "c1",
    );
    expect(c1.body).toBe("First line.\n\nSecond paragraph.\nThird.");
    expect(c1.status).toBe("resolved");
    expect(c1.resolved).toBe("Done.\nBoth parts.");
  });

  it("threads replies by `re` wherever they are stored, aN ids included", () => {
    const model = parseReviewModel(
      lines(
        "Keep {==this==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Why?"',
        "    by: user",
        `    at: ${AT}`,
        "  a1:",
        '    body: "Because."',
        "    by: AI",
        `    at: ${AT}`,
        "    re: c1",
        "  c2:",
        '    body: "Fair."',
        "    by: user",
        `    at: ${AT}`,
        "    re: a1",
        "  a2:",
        '    body: "Round 1 done."',
        "    by: AI",
        `    at: ${AT}`,
        "    scope: document",
        "",
      ),
    );
    const byId = (id: string) => model.comments.find((item) => item.id === id);
    expect(byId("c1")?.replies).toEqual(["a1"]);
    expect(byId("a1")).toMatchObject({
      kind: "reply",
      parentId: "c1",
      rootId: "c1",
      scope: "inline",
      replies: ["c2"],
    });
    expect(byId("c2")).toMatchObject({ rootId: "c1", parentId: "a1" });
    expect(byId("a2")).toMatchObject({ kind: "comment", scope: "document" });
    expect(model.ids).toEqual(["c1", "a1", "c2", "a2"]);
    expect(model.diagnostics).toEqual([]);
  });

  it("links suggestion parts by `continues` and threads replies to suggestions", () => {
    const markdown = lines(
      "{--Delta repeats the budget.--}{#s1}",
      "",
      "{--Epsilon repeats the timeline.--}{#s2}",
      "",
      "Use {~~rough~>specific~~}{#s3} wording.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Keep the budget."',
      "    by: user",
      `    at: ${AT}`,
      "    re: s1",
      "suggestions:",
      "  s1:",
      "    by: user",
      `    at: ${AT}`,
      "  s2:",
      "    by: user",
      `    at: ${AT}`,
      "    continues: s1",
      "  s3:",
      "    by: AI",
      `    at: ${AT}`,
      "",
    );
    expect(suggestion(markdown, "s1")).toMatchObject({
      suggestionKind: "deletion",
      continues: null,
      continuedBy: ["s2"],
      replies: ["c1"],
    });
    expect(suggestion(markdown, "s2")).toMatchObject({ continues: "s1" });
    expect(suggestion(markdown, "s3")).toMatchObject({
      suggestionKind: "substitution",
      originalText: "rough",
      replacementText: "specific",
      text: "specific",
    });
    expect(comment(markdown, "c1")).toMatchObject({
      kind: "reply",
      rootId: "s1",
      scope: "inline",
    });
  });

  it("keeps unknown entry keys on the model entry", () => {
    const c1 = comment(
      lines(
        "Keep {==this==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Check."',
        "    by: user",
        `    at: ${AT}`,
        "    priority: high",
        "",
      ),
      "c1",
    );
    expect(c1.entry).toMatchObject({ priority: "high" });
  });
});

describe("parseReviewModel: legacy forms", () => {
  it("reads a compact train with its body inline (the 0.1.10 skill form)", () => {
    const c1 = comment(
      lines(
        "Keep {==this==}{>>Needs proof<<}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
      "c1",
    );
    expect(c1).toMatchObject({
      body: "Needs proof",
      bodySource: "inline",
      metadataSource: "endmatter",
      scope: "inline",
      by: "user",
    });
  });

  it("reads inline attribute blocks, with status and unknown attributes", () => {
    const c1 = comment(
      'Keep this.{>>Root<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z" status="resolved" resolved="Done." color="blue"}\n',
      "c1",
    );
    expect(c1).toMatchObject({
      body: "Root",
      scope: "standalone",
      status: "resolved",
      resolved: "Done.",
      metadataSource: "attribute",
      attributes: {
        id: "c1",
        by: "user",
        at: "2026-10-03T12:00:00.000Z",
        status: "resolved",
        resolved: "Done.",
        color: "blue",
      },
    });
  });

  it("reads legacy {@ ... @} blocks", () => {
    expect(
      comment(
        "{>>Legacy<<}{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}\n",
        "c1",
      ),
    ).toMatchObject({ body: "Legacy", by: "AI", metadataSource: "legacy" });
  });

  it("reads inline attribute replies as replies of their root", () => {
    const model = parseReviewModel(
      'Keep {==this==}{>>Why?<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"}{>>Because.<<}{id="c2" by="AI" at="2026-10-03T12:01:00.000Z" re="c1"}.\n',
    );
    expect(model.comments.map((item) => [item.id, item.kind])).toEqual([
      ["c1", "comment"],
      ["c2", "reply"],
    ]);
    expect(model.comments[0]?.replies).toEqual(["c2"]);
    expect(model.comments[1]?.anchors).toEqual([]);
  });

  it("merges replicated trains with the same text into one comment with several anchors", () => {
    const train =
      '{>>Reconcile these.<<}{id="c1" by="user" at="2026-10-04T19:00:18.444Z"}';
    const reply =
      '{>>Done.<<}{id="c2" by="AI" at="2026-10-04T20:00:00.000Z" re="c1"}';
    const model = parseReviewModel(
      lines(
        `{==Alpha paragraph.==}${train}${reply}`,
        "",
        `{==Beta paragraph.==}${train}${reply}`,
        "",
      ),
    );
    expect(model.comments.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(model.comments[0]?.anchors.map((anchor) => anchor.text)).toEqual([
      "Alpha paragraph.",
      "Beta paragraph.",
    ]);
    expect(model.comments[0]?.replies).toEqual(["c2"]);
    expect(model.diagnostics.map((item) => item.code)).toEqual([
      "legacy-inline-body",
      "replicated-comment",
      "replicated-comment",
    ]);
  });

  it("keeps trains with different text under one id as a duplicate-id error, listing the id once", () => {
    const model = parseReviewModel(
      lines(
        '{==One==}{>>First text<<}{id="c1" by="user" at="2026-10-04T19:00:18.444Z"}',
        "",
        '{==Two==}{>>Second text<<}{id="c1" by="user" at="2026-10-04T19:00:18.444Z"}',
        "",
      ),
    );
    expect(model.ids).toEqual(["c1"]);
    expect(model.comments[0]?.body).toBe("First text");
    expect(model.diagnostics.map((item) => item.code)).toContain(
      "duplicate-id",
    );
  });

  it("reads a train on the first block and a continuation ref on the next", () => {
    const c1 = comment(
      lines(
        "The {==caption==}{>>Split these.<<}{#c1}",
        "",
        "{==Ops gives the go==}{#c1}.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    by: user",
        `    at: ${AT}`,
        "",
      ),
      "c1",
    );
    expect(c1.body).toBe("Split these.");
    expect(c1.anchors.map((anchor) => anchor.text)).toEqual([
      "caption",
      "Ops gives the go",
    ]);
  });

  it("reads multi-line highlight spans", () => {
    const c1 = comment(
      'The line {==runs on\ninto the next==}{>>Split.<<}{id="c1" by="user" at="2026-10-04T09:00:00.000Z"} here.\n',
      "c1",
    );
    expect(c1.primaryAnchor?.text).toBe("runs on\ninto the next");
  });

  it("reads replicated legacy suggestion markers as one suggestion with several parts", () => {
    const meta = '{id="s1" by="user" at="2026-10-04T19:00:50.725Z"}';
    const s1 = suggestion(
      lines(
        `{--Delta paragraph.--}${meta}`,
        "",
        `{--Epsilon paragraph.--}${meta}`,
        "",
      ),
      "s1",
    );
    expect(s1.parts.map((part) => part.text)).toEqual([
      "Delta paragraph.",
      "Epsilon paragraph.",
    ]);
  });

  it("gives review markup without metadata a synthetic id, as 0.1.10 did", () => {
    const model = parseReviewModel("{>>No metadata<<}\n");
    expect(model.comments[0]?.id).toBe("comment-0");
  });
});
