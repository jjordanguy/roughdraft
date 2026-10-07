// The browser reads review markup through rfm: every fixture and every real
// document must give the same review items through the editor's load path
// as through rfm's review index, and a canonical file must survive a save
// with nothing changed.
import fs from "node:fs";
import path from "node:path";
import {
  extractRoughdraftReviewIndex,
  parseReviewModel,
  splitRoughdraftDocument,
} from "@roughdraft/rfm";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  type CriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getReviewBlockError,
  getReviewFormat,
} from "../src/critic-markup";
import { parseCodeCommentAnchors } from "../src/editor-extensions";

const repoRoot = path.resolve(process.cwd(), "../..");
const fixturesDir = path.join(repoRoot, "docs/spec/fixtures");
const corpusDir = path.join(repoRoot, "packages/rfm/test/corpus");

interface Item {
  id: string;
  kind: string;
  scope: string;
  parent: string | null;
  text: string;
  status: string | null;
}

function readMarkdownFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({
      name: file.replace(/\.md$/, ""),
      markdown: fs.readFileSync(path.join(dir, file), "utf8"),
    }));
}

const fixtures = readMarkdownFiles(fixturesDir);
const corpus = readMarkdownFiles(corpusDir);
const canonical = fixtures.filter((fixture) =>
  fixture.name.startsWith("canonical-"),
);

// rfm names a train with no id `comment-<offset>`; the browser names it
// `cN` as it always has. Such items are compared by everything but the id.
const syntheticId = /^(comment|suggestion)-\d+$/;

// Known limits of the editor, each one reported by rfm's own diagnostics:
// an empty suggestion marker has no text to put a mark on, and an inline
// comment with a blank line is split by Markdown into two paragraphs
// (`inline-comment-blank-line`), so its highlight cannot be shown.
function rfmItems(markdown: string) {
  const index = extractRoughdraftReviewIndex(markdown);
  const unplaceable = new Set(
    index.diagnostics
      .filter((diagnostic) => diagnostic.code === "inline-comment-blank-line")
      .flatMap((diagnostic) =>
        [...diagnostic.message.matchAll(/`([^`]+)`/g)].map(
          (match) => match[1] ?? "",
        ),
      ),
  );
  // The later parts of a suggestion over several blocks (`continues`) show
  // as one suggestion in the browser, under the first part's id.
  const partsOf = new Map<string, string[]>();
  for (const item of index.items) {
    if (item.kind === "suggestion" && item.continues) {
      partsOf.set(item.continues, [
        ...(partsOf.get(item.continues) ?? []),
        item.anchors.map((anchor) => anchor.text).join(""),
      ]);
    }
  }
  const items: Item[] = index.items
    .filter((item) => !(item.kind === "suggestion" && item.text === ""))
    .filter((item) => !(item.kind === "suggestion" && item.continues))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      parent: item.parentId,
      // A legacy suggestion replicated on several blocks shows all its parts.
      text:
        item.kind === "suggestion"
          ? [
              item.anchors.map((anchor) => anchor.text).join(""),
              ...(partsOf.get(item.id) ?? []),
            ].join("")
          : item.text,
      status: item.kind === "suggestion" ? null : item.status,
    }));

  return { items, unplaceable };
}

interface SuggestionText {
  id: string;
  oldText: string;
  newText: string;
  kind: string;
}

function collectDoc(doc: JSONContent) {
  const suggestions = new Map<string, SuggestionText>();
  const placed = new Set<string>();

  const visit = (node: JSONContent) => {
    if (node.type === "codeBlock") {
      const anchors = parseCodeCommentAnchors(
        typeof node.attrs?.codeAnchors === "string"
          ? node.attrs.codeAnchors
          : null,
      );
      for (const anchor of anchors) placed.add(anchor.id);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "commentRef") {
        for (const id of (mark.attrs?.commentIds as string[]) ?? []) {
          placed.add(id);
        }
      }
      if (mark.type === "criticChange") {
        const id = mark.attrs?.changeId as string;
        const kind = mark.attrs?.kind as string;
        const entry = suggestions.get(id) ?? {
          id,
          oldText: "",
          newText: "",
          kind: kind === "substitution-new" ? "substitution-old" : kind,
        };
        if (kind === "addition" || kind === "substitution-new") {
          entry.newText += node.text ?? "";
        } else {
          entry.oldText += node.text ?? "";
        }
        suggestions.set(id, entry);
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);

  return { suggestions, placed };
}

function browserItems(markdown: string) {
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  const { suggestions, placed } = collectDoc(doc);
  const items: Item[] = [...comments.values()].map(
    (comment: CriticComment) => ({
      id: comment.id,
      kind: comment.parentCommentId ? "reply" : "comment",
      scope: comment.scope ?? "inline",
      parent: comment.parentCommentId ?? null,
      text: comment.content,
      status: comment.status ?? null,
    }),
  );
  for (const suggestion of suggestions.values()) {
    items.push({
      id: suggestion.id,
      kind: "suggestion",
      scope: "inline",
      parent: null,
      text:
        suggestion.kind === "deletion"
          ? suggestion.oldText
          : suggestion.newText,
      status: null,
    });
  }

  return { items, comments, placed };
}

function normalize(items: Item[]) {
  return items
    .map((item) => (syntheticId.test(item.id) ? { ...item, id: "*" } : item))
    .map((item) => JSON.stringify(item))
    .sort();
}

function stripMarkdownFormatting(text: string) {
  return text.replace(/[*_`]/g, "");
}

function expectSameItems(markdown: string) {
  const { items: expected, unplaceable } = rfmItems(markdown);
  const actual = browserItems(markdown);
  const syntheticIds = new Set(
    actual.items
      .filter(
        (item) =>
          !expected.some((candidate) => candidate.id === item.id) &&
          expected.some((candidate) => syntheticId.test(candidate.id)),
      )
      .map((item) => item.id),
  );
  const browser = actual.items.map((item) =>
    syntheticIds.has(item.id) ? { ...item, id: "comment-0" } : item,
  );
  // Suggestion text is compared as the editor shows it (Markdown rendered).
  const comparable = (items: Item[]) =>
    items.map((item) =>
      item.kind === "suggestion"
        ? { ...item, text: stripMarkdownFormatting(item.text) }
        : item,
    );

  expect(normalize(comparable(browser))).toEqual(
    normalize(comparable(expected)),
  );

  // Every thread with an anchor in the text is placed in the editor.
  for (const item of expected) {
    if (item.kind !== "comment" || item.scope === "document") continue;
    if (syntheticId.test(item.id) || unplaceable.has(item.id)) continue;
    const comment = actual.comments.get(item.id);
    if (comment?.parentCommentId) continue;
    expect(actual.placed.has(item.id), `${item.id} has an anchor`).toBe(true);
  }
}

describe("browser load path agrees with rfm", () => {
  it.each(
    fixtures.map((fixture) => [fixture.name, fixture.markdown]),
  )("%s", (_name, markdown) => {
    expectSameItems(markdown);
  });

  it
    .skipIf(corpus.length === 0)
    .each(corpus.map((file) => [file.name, file.markdown]))(
    "corpus: %s",
    (_name, markdown) => {
      expectSameItems(markdown);
    },
  );
});

function saveUnchanged(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown);
  return editorStateToCriticMarkdown(parsed.doc, parsed.comments, {
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
    preservedEntryIds: parsed.preservedEntryIds,
    looseHeadings: parsed.looseHeadings,
    legacyListSpacing: parsed.legacyListSpacing,
  });
}

describe("canonical files survive a save with nothing changed", () => {
  it("covers every canonical fixture", () => {
    expect(canonical.length).toBeGreaterThanOrEqual(10);
  });

  it.each(
    canonical.map((fixture) => [fixture.name, fixture.markdown]),
  )("%s", (_name, markdown) => {
    expect(saveUnchanged(markdown)).toBe(markdown);
  });

  it.each(
    canonical.map((fixture) => [fixture.name, fixture.markdown]),
  )("%s keeps its review block byte for byte after an unrelated edit", (_name, markdown) => {
    const parsed = criticMarkdownToEditorState(markdown);
    const doc = structuredClone(parsed.doc);
    doc.content?.push({
      type: "paragraph",
      content: [{ type: "text", text: "An unrelated new paragraph." }],
    });
    const saved = editorStateToCriticMarkdown(doc, parsed.comments, {
      frontmatter: parsed.frontmatter,
      endmatter: parsed.endmatter,
      preservedEntryIds: parsed.preservedEntryIds,
      looseHeadings: parsed.looseHeadings,
      legacyListSpacing: parsed.legacyListSpacing,
    });

    expect(saved).toContain("An unrelated new paragraph.");
    expect(splitRoughdraftDocument(saved).endmatter).toBe(
      splitRoughdraftDocument(markdown).endmatter,
    );
  });
});

// D11: nothing converts an older-format file on save. Its review markup and
// its review block come back byte for byte through a save with an unrelated
// edit. (Prose the rich-text editor cannot round-trip yet, such as tables
// and hard-wrapped lines, is a separate, older limit; it is not compared
// here, only every run of review markup in order.)
function markupRuns(markdown: string) {
  const model = parseReviewModel(markdown);
  // Emphasis inside a highlight is rewritten as `_x_` by the editor's prose
  // writer (the same older limit), so it is compared without the markers.
  return model.markup.map((run) =>
    markdown
      .slice(run.offset, run.endOffset)
      .replace(/\s+/g, " ")
      .replace(/[*_]/g, ""),
  );
}

function saveWithUnrelatedEdit(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown);
  const doc = structuredClone(parsed.doc);
  doc.content?.unshift({
    type: "paragraph",
    content: [{ type: "text", text: "An unrelated first line." }],
  });
  return editorStateToCriticMarkdown(doc, parsed.comments, {
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
    preservedEntryIds: parsed.preservedEntryIds,
    looseHeadings: parsed.looseHeadings,
    legacyListSpacing: parsed.legacyListSpacing,
    reviewFormat: parsed.reviewFormat,
  });
}

const legacyFiles = [...fixtures, ...corpus].filter(
  (file) =>
    getReviewFormat(file.markdown) === "legacy" &&
    getReviewBlockError(file.markdown) === null,
);

describe("older-format files keep their review markup on save (D11)", () => {
  it("covers the legacy fixtures", () => {
    expect(
      legacyFiles.filter((file) => fixtures.includes(file)).length,
    ).toBeGreaterThanOrEqual(30);
  });

  it.each(
    legacyFiles.map((file) => [file.name, file.markdown]),
  )("%s keeps every review byte through an unrelated edit", (_name, markdown) => {
    const saved = saveWithUnrelatedEdit(markdown);
    expect(saved).toContain("An unrelated first line.");
    expect(markupRuns(saved)).toEqual(markupRuns(markdown));
    expect(splitRoughdraftDocument(saved).endmatter).toBe(
      splitRoughdraftDocument(markdown).endmatter,
    );
    // rfm names a train with no id after its offset; compare those by place.
    const ids = (text: string) =>
      extractRoughdraftReviewIndex(text).items.map((item) =>
        syntheticId.test(item.id) ? "*" : item.id,
      );
    expect(ids(saved)).toEqual(ids(markdown));
  });

  it.each(
    fixtures
      .filter((file) => legacyFiles.includes(file))
      // The rich-text editor joins a hard-wrapped line (an older limit).
      .filter((file) => file.name !== "legacy-multiline-span")
      .map((file) => [file.name, file.markdown]),
  )("%s saves byte for byte with nothing changed", (_name, markdown) => {
    const parsed = criticMarkdownToEditorState(markdown);
    expect(
      editorStateToCriticMarkdown(parsed.doc, parsed.comments, parsed),
    ).toBe(markdown);
  });
});
