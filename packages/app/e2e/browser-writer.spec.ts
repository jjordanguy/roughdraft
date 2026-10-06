// Batch 3b: the browser writes new review items in the canonical shape.
// Real files on disk, the real API server, the controls a person uses: the
// six browser-repro cases created in the UI, a comment on code lines and a
// two-paragraph comment typed with Enter, each saved, read by rfm and the
// frozen 0.1.10 reader, and reloaded as one card.
//
//   pnpm test:e2e --grep @batch3b
import { expect, type Page, test } from "@playwright/test";
import {
  extractReviewIndexWithLegacyReader,
  extractRoughdraftReviewIndex,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  validateWithLegacyReader,
} from "@roughdraft/rfm";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

// Selects from the start of one text to the end of another, across blocks.
async function selectAcross(page: Page, fromText: string, toText: string) {
  await richTextEditor(page).focus();
  await page.evaluate(
    ([startText, endText]) => {
      const editor = document.querySelector(".ProseMirror");
      if (!editor) throw new Error("Could not find rich-text editor");
      const find = (text: string) => {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.indexOf(text) ?? -1;
          if (index >= 0) return { node, index };
        }
        throw new Error(`Could not find text "${text}"`);
      };
      const start = find(startText);
      const end = find(endText);
      const range = document.createRange();
      range.setStart(start.node, start.index);
      range.setEnd(end.node, end.index + endText.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    },
    [fromText, toText],
  );
}

async function comment(
  page: Page,
  fromText: string,
  toText: string,
  id: string,
  text: string,
) {
  await selectAcross(page, fromText, toText);
  await page.getByTestId("selection-menu-action-comment").click();
  await page.getByTestId(`comment-rail-${id}-editor`).fill(text);
  await page.getByTestId(`comment-rail-${id}-action-save`).click();
}

function expectCanonical(markdown: string) {
  const normalized = normalizeRoughdraftMetadata(markdown);
  expect(normalized.refused).toEqual([]);
  expect(normalized.changes).toEqual([]);
}

function expectOneCommentInBothReaders(markdown: string, ids: string[]) {
  expect(validateWithLegacyReader(markdown).errors).toEqual([]);
  expect(
    extractRoughdraftReviewIndex(markdown)
      .items.filter((item) => item.kind === "comment")
      .map((item) => item.id),
  ).toEqual(ids);
  expect(
    extractReviewIndexWithLegacyReader(markdown)
      .items.filter((item: { kind: string }) => item.kind === "comment")
      .map((item: { id: string }) => item.id),
  ).toEqual(ids);
}

// After a reload: one card for the thread, and the highlight covers every
// selected piece of text.
async function expectOneCardWithHighlight(
  page: Page,
  id: string,
  segments: string[],
) {
  const rail = page.getByTestId("document-review-rail");
  await expect(rail.getByTestId(`comment-thread-${id}`)).toHaveCount(1);
  const anchors = page.locator(
    `.ProseMirror .comment-anchor[data-comment-ids*='"${id}"']`,
  );
  await expect
    .poll(async () => (await anchors.allInnerTexts()).join("|"))
    .toBe(segments.join("|"));
  const railText = await rail.innerText();
  expect(railText).not.toContain("{>>");
  expect(railText).not.toContain("{#");
}

test.describe("browser writer @batch3b", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("browser-writer");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  const commentCases = [
    {
      name: "case1-two-paragraphs",
      lines: [
        "# Case 1: two paragraphs",
        "",
        "Alpha paragraph says the launch moves to May and nothing else changes.",
        "",
        "Beta paragraph lists the owners for each step of the rollout.",
        "",
        "Tail line for the save trigger.",
      ],
      from: "Alpha paragraph",
      to: "step of the rollout.",
      body: "These two paragraphs contradict the timeline doc. Reconcile them before Friday.",
      segments: [
        "Alpha paragraph says the launch moves to May and nothing else changes.",
        "Beta paragraph lists the owners for each step of the rollout.",
      ],
    },
    {
      name: "case2-heading-paragraph-list",
      lines: [
        "# Case 2: heading, paragraph and list",
        "",
        "Intro sentence above the section.",
        "",
        "## Pre-flight",
        "",
        "The creator confirms the caption with ops before scheduling.",
        "",
        "- Caption matches the approved copy deck",
        "- Tracking link is the campaign short link",
        "- Pin window is agreed with the brand",
        "",
        "Tail line for the save trigger.",
      ],
      from: "Pre-flight",
      to: "agreed with the brand",
      body: "Split these checks by owner; ops has been two people since May.",
      segments: [
        "Pre-flight",
        "The creator confirms the caption with ops before scheduling.",
        "Caption matches the approved copy deck",
        "Tracking link is the campaign short link",
        "Pin window is agreed with the brand",
      ],
    },
    {
      name: "case3-mid-paragraph",
      lines: [
        "# Case 3: mid paragraph to mid paragraph",
        "",
        "First paragraph has an opening clause and a closing clause that runs on.",
        "",
        "Second paragraph starts with a lead phrase and ends with a trailing phrase.",
        "",
        "Tail line for the save trigger.",
      ],
      from: "a closing clause",
      to: "with a lead phrase",
      body: "The handoff between these two sentences is abrupt.",
      segments: [
        "a closing clause that runs on.",
        "Second paragraph starts with a lead phrase",
      ],
    },
    {
      name: "case4-blank-line-body",
      lines: [
        "# Case 4: comment body with a blank line",
        "",
        "Gamma paragraph proposes a two week pilot with three customers.",
        "",
        "Tail line for the save trigger.",
      ],
      from: "two week pilot",
      to: "three customers",
      body: "First point about scope.\n\nSecond point about timing.",
      segments: ["two week pilot with three customers"],
    },
  ];

  for (const testCase of commentCases) {
    test(`${testCase.name}: one entry, one card, highlight across the selection @batch3b`, async ({
      page,
    }) => {
      const file = `${testCase.name}.md`;
      const filePath = writeProjectFile(
        projectDir,
        file,
        `${testCase.lines.join("\n")}\n`,
      );
      await openMarkdownFile(page, filePath, "rich-text");
      await expect(richTextEditor(page)).toBeVisible();

      await comment(page, testCase.from, testCase.to, "c1", testCase.body);
      await expect
        .poll(() => readProjectFile(projectDir, file))
        .toContain("comments:\n  c1:\n");

      const saved = readProjectFile(projectDir, file);
      const model = parseReviewModel(saved);
      expect(model.split.body).not.toContain("{>>");
      expect(model.split.entries.comments.size).toBe(1);
      expect(model.comments[0]?.body).toBe(testCase.body);
      expect(model.comments[0]?.anchors.map((anchor) => anchor.text)).toEqual(
        testCase.segments,
      );
      expectCanonical(saved);
      expectOneCommentInBothReaders(saved, ["c1"]);

      await page.reload();
      await expectOneCardWithHighlight(page, "c1", testCase.segments);
      await expect(
        page.getByTestId("document-review-rail").getByTestId("comment-rail-c1"),
      ).toContainText(testCase.body.split("\n")[0] ?? "");
    });
  }

  test("case5-suggested-deletion: two linked parts, one card @batch3b", async ({
    page,
  }) => {
    const file = "case5.md";
    const filePath = writeProjectFile(
      projectDir,
      file,
      [
        "# Case 5: suggested deletion across two paragraphs",
        "",
        "Keep this opening paragraph as it is.",
        "",
        "Delta paragraph repeats the budget numbers from the appendix.",
        "",
        "Epsilon paragraph repeats the timeline from the appendix.",
        "",
        "Tail line for the save trigger.",
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-option-suggesting").click();
    await selectAcross(
      page,
      "Delta paragraph",
      "the timeline from the appendix.",
    );
    await page.keyboard.press("Backspace");

    await expect
      .poll(() => readProjectFile(projectDir, file))
      .toContain("continues: s1");
    const saved = readProjectFile(projectDir, file);
    expect(saved).toContain(
      "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}\n\n{--Epsilon paragraph repeats the timeline from the appendix.--}{#s2}",
    );
    expectCanonical(saved);
    expect(validateWithLegacyReader(saved).errors).toEqual([]);

    await page.reload();
    const rail = page.getByTestId("document-review-rail");
    await expect(rail.getByTestId("suggestion-thread-s1")).toHaveCount(1);
    await expect(rail.getByTestId("suggestion-thread-s2")).toHaveCount(0);
    await expect(page.locator('[data-critic-change-id="s1"]')).toHaveCount(2);
  });

  test("case6-two-comments: two entries, two cards @batch3b", async ({
    page,
  }) => {
    const file = "case6.md";
    const filePath = writeProjectFile(
      projectDir,
      file,
      [
        "# Case 6: two separate comments",
        "",
        "Zeta paragraph explains why the pilot is small.",
        "",
        "Eta paragraph explains who signs off on the pilot.",
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await comment(
      page,
      "why the pilot is small",
      "why the pilot is small",
      "c1",
      "Say how small: number of customers.",
    );
    await expect
      .poll(() => readProjectFile(projectDir, file))
      .toContain("  c1:\n");
    await comment(
      page,
      "who signs off",
      "who signs off",
      "c2",
      "Name the person, not the team.",
    );
    await expect
      .poll(() => readProjectFile(projectDir, file))
      .toContain("  c2:\n");

    const saved = readProjectFile(projectDir, file);
    expectCanonical(saved);
    expectOneCommentInBothReaders(saved, ["c1", "c2"]);

    await page.reload();
    await expectOneCardWithHighlight(page, "c1", ["why the pilot is small"]);
    await expectOneCardWithHighlight(page, "c2", ["who signs off"]);
  });

  test("a comment on code lines writes a fence-line ref and highlights the lines @batch3b", async ({
    page,
  }) => {
    const file = "code.md";
    const source = [
      "# Setup",
      "",
      "Run the server.",
      "",
      "```ts",
      'import { start } from "./server";',
      "",
      "const port = 3000;",
      "start({ port });",
      "```",
      "",
      "That is all.",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, file, source);
    await openMarkdownFile(page, filePath, "rich-text");
    await comment(
      page,
      "const port",
      "start({ port });",
      "c1",
      "Read the port from the environment.",
    );

    await expect
      .poll(() => readProjectFile(projectDir, file))
      .toContain("```ts {#c1}");
    const saved = readProjectFile(projectDir, file);
    expect(parseReviewModel(saved).split.body).toBe(
      `${source.replace("```ts\n", "```ts {#c1}\n")}\n`,
    );
    expect(saved).toContain("    lines: [3, 4]");
    expect(saved).toContain(
      '    quote: "const port = 3000;\\nstart({ port });"',
    );
    expectCanonical(saved);
    expectOneCommentInBothReaders(saved, ["c1"]);

    await page.reload();
    await expect(page.getByTestId("comment-code-anchor-c1")).toHaveText(
      "const port = 3000;\nstart({ port });",
    );
    // A code comment's card lives in the global section (batch 4).
    await expect(
      page
        .getByTestId("global-comments-section")
        .getByTestId("global-comment-thread-c1"),
    ).toHaveCount(1);
  });

  test("a two-paragraph comment typed with Enter is stored with <br> and shown on two lines @batch3b", async ({
    page,
  }) => {
    const file = "two-paragraphs.md";
    const filePath = writeProjectFile(
      projectDir,
      file,
      "Gamma paragraph proposes a two week pilot with three customers.\n",
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await selectAcross(page, "two week pilot", "three customers");
    await page.getByTestId("selection-menu-action-comment").click();
    const composer = page.getByTestId("comment-rail-c1-editor");
    await composer.click();
    await page.keyboard.type("First point about scope.");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second point about timing.");
    // Enter did not save: the composer is still open.
    await expect(composer).toBeVisible();
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, file))
      .toContain(
        'body: "First point about scope.<br><br>Second point about timing."',
      );
    const saved = readProjectFile(projectDir, file);
    expectCanonical(saved);
    expectOneCommentInBothReaders(saved, ["c1"]);

    await page.reload();
    const card = page
      .getByTestId("document-review-rail")
      .getByTestId("comment-rail-c1");
    await expect(card).toContainText("First point about scope.");
    const text = await card.innerText();
    expect(text).toMatch(
      /First point about scope\.\n+Second point about timing\./,
    );
  });

  test("a close delimiter in the composer is refused with a message @batch3b", async ({
    page,
  }) => {
    const file = "delimiter.md";
    const source = "Keep this sentence.\n";
    const filePath = writeProjectFile(projectDir, file, source);
    await openMarkdownFile(page, filePath, "rich-text");
    await selectAcross(page, "this", "sentence");
    await page.getByTestId("selection-menu-action-comment").click();
    await page.getByTestId("comment-rail-c1-editor").fill("Use <<} here.");
    await page.getByTestId("comment-rail-c1-action-save").click();
    await expect(page.getByTestId("comment-rail-c1-error")).toContainText(
      "<<}",
    );
    await page.waitForTimeout(1000);
    expect(readProjectFile(projectDir, file)).toBe(source);
  });
});
