import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import {
  acceptBeforeUnload,
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  holdSaves,
  openMarkdownFile,
  placeCodeCaretAfter,
  placeRichTextCaretAfter,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  useEditingMode,
  writeProjectFile,
} from "./helpers";

// Batch 5: a disk change that lands while the tab has unsaved edits is
// merged into the draft instead of blocking it; overlapping prose becomes
// Jordan's suggestion; drafts survive a reload in IndexedDB; the two
// notices. Needs the batch 2 server or later.
//   pnpm test:e2e --grep @batch5

const ENTRY =
  '  c1:\n    body: "Why?"\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
const MARKUP_BASE = `# T\n\nHi {==there==}{#c1}.\n\n---\ncomments:\n${ENTRY}`;
const MARKUP_MINE = `# T\n\nHi {==there you==}{#c1}.\n\n---\ncomments:\n${ENTRY}`;
const MARKUP_THEIRS = `# T\n\nHi {==there me==}{#c1}.\n\n---\ncomments:\n${ENTRY}`;

function reviewBlock(markdown: string) {
  const index = markdown.lastIndexOf("\n---\n");
  return parseYaml(markdown.slice(index + 5)) as {
    comments?: Record<string, Record<string, unknown>>;
    suggestions?: Record<string, Record<string, unknown>>;
  };
}

test.describe("merging instead of blocking", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("merge");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("an agent edit in another paragraph while the user types merges without a banner @batch5", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "merge.md",
      "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n",
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await expect(richTextEditor(page)).toContainText("Second paragraph.");
    await useEditingMode(page);
    const release = await holdSaves(page);

    await placeRichTextCaretAfter(page, "First paragraph.");
    await page.keyboard.type(" Typed", { delay: 20 });
    fs.writeFileSync(
      filePath,
      "# Plan\n\nFirst paragraph.\n\nSecond paragraph, by the agent.\n",
    );
    await page.keyboard.type(" more.", { delay: 20 });
    await page.waitForTimeout(300);
    release();

    await expect
      .poll(() => readProjectFile(projectDir, "merge.md"), { timeout: 10_000 })
      .toBe(
        "# Plan\n\nFirst paragraph. Typed more.\n\nSecond paragraph, by the agent.\n",
      );
    await expect(richTextEditor(page)).toContainText(
      "Second paragraph, by the agent.",
    );
    await expect(page.getByTestId("disk-update-notice")).toContainText(
      "Updated from disk: text changed",
    );
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
  });

  test("overlapping edits keep both versions as a suggestion @batch5", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "overlap.md",
      "# Plan\n\nThe pilot is limited on purpose.\n",
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await expect(richTextEditor(page)).toContainText("limited");
    await useEditingMode(page);
    const release = await holdSaves(page);

    await selectRichText(page, "limited");
    await page.keyboard.type("tiny");
    fs.writeFileSync(filePath, "# Plan\n\nThe pilot is small on purpose.\n");
    await page.waitForTimeout(300);
    release();

    await expect
      .poll(() => readProjectFile(projectDir, "overlap.md"), {
        timeout: 10_000,
      })
      .toContain("The pilot is {~~small~>tiny~~}{#s1} on purpose.");
    const saved = readProjectFile(projectDir, "overlap.md");
    expect(reviewBlock(saved).suggestions?.s1).toMatchObject({ by: "user" });
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
    await expect(page.getByTestId("disk-update-notice")).toContainText(
      "your overlapping edit is kept as a suggestion",
    );
  });

  test("a draft survives a page reload while a conflict is open @batch5", async ({
    page,
  }) => {
    acceptBeforeUnload(page);
    const filePath = writeProjectFile(projectDir, "conflict.md", MARKUP_BASE);
    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Hi {==there==}{#c1}.");
    const release = await holdSaves(page);

    await placeCodeCaretAfter(page, "there");
    await page.keyboard.type(" you");
    fs.writeFileSync(filePath, MARKUP_THEIRS);
    await page.waitForTimeout(300);
    release();

    await expect(page.getByTestId("file-conflict-notice")).toContainText(
      "Your edit overlaps a change on disk",
    );
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Resolve 1 overlap first",
    );
    expect(readProjectFile(projectDir, "conflict.md")).toBe(MARKUP_THEIRS);
    // The draft write is debounced by 250 ms.
    await page.waitForTimeout(500);

    await page.reload();

    await expect(codeEditor(page)).toContainText("Hi {==there you==}{#c1}.");
    await expect(page.getByTestId("draft-restored-notice")).toHaveText(
      "Restored unsaved edits from your last session",
    );
    await expect(page.getByTestId("file-conflict-notice")).toBeVisible();
    expect(readProjectFile(projectDir, "conflict.md")).toBe(MARKUP_THEIRS);

    await page.getByTestId("file-conflict-hunk-h1-ours").click();
    await expect
      .poll(() => readProjectFile(projectDir, "conflict.md"))
      .toBe(MARKUP_MINE);
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
  });

  test("keystrokes typed right after an external update land in the document @batch5", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "after-update.md",
      "# Plan\n\nFirst paragraph.\n",
    );
    await openMarkdownFile(page, filePath, "rich-text");
    await expect(richTextEditor(page)).toContainText("First paragraph.");
    await useEditingMode(page);
    await placeRichTextCaretAfter(page, "First paragraph.");

    fs.writeFileSync(
      filePath,
      "# Plan\n\nFirst paragraph.\n\nAgent paragraph.\n",
    );
    await expect(richTextEditor(page)).toContainText("Agent paragraph.");
    await page.keyboard.type(" Typed after.");

    await expect
      .poll(() => readProjectFile(projectDir, "after-update.md"), {
        timeout: 10_000,
      })
      .toBe("# Plan\n\nFirst paragraph. Typed after.\n\nAgent paragraph.\n");
  });

  test("two tabs on the same file converge @batch5", async ({
    page,
    context,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "two-tabs.md",
      "# Plan\n\nLine one.\n\nLine two.\n",
    );
    const other = await context.newPage();
    await openMarkdownFile(page, filePath, "code");
    await openMarkdownFile(other, filePath, "code");
    await expect(codeEditor(page)).toContainText("Line two.");
    await expect(codeEditor(other)).toContainText("Line two.");

    await placeCodeCaretAfter(page, "Line one.");
    await page.keyboard.type(" From tab A.");
    await placeCodeCaretAfter(other, "Line two.");
    await other.keyboard.type(" From tab B.");

    const expected =
      "# Plan\n\nLine one. From tab A.\n\nLine two. From tab B.\n";
    await expect
      .poll(() => readProjectFile(projectDir, "two-tabs.md"), {
        timeout: 10_000,
      })
      .toBe(expected);
    await expect(codeEditor(page)).toContainText("From tab B.");
    await expect(codeEditor(other)).toContainText("From tab A.");
    for (const tab of [page, other]) {
      await expect(documentSaveStatus(tab)).toHaveAttribute(
        "aria-label",
        "Saved",
      );
      await expect(tab.getByTestId("file-conflict-notice")).toHaveCount(0);
    }
    await other.close();
  });

  test("the removed-text notice offers restore @batch5", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "removed.md",
      "# Plan\n\nIntro.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Intro.");

    await appendInCodeEditor(page, "\nMy point about the rollout.\n");
    await expect
      .poll(() => readProjectFile(projectDir, "removed.md"))
      .toContain("My point about the rollout.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    // A blind write from an old read drops the paragraph.
    fs.writeFileSync(filePath, "# Plan\n\nIntro, edited by the agent.\n");

    const notice = page.getByTestId("removed-text-notice");
    await expect(notice).toContainText(
      "An outside write removed text you saved. Restore it?",
    );
    await expect(page.getByTestId("removed-text-preview")).toHaveText(
      "My point about the rollout.",
    );
    await page.getByTestId("removed-text-restore").click();

    await expect
      .poll(() => readProjectFile(projectDir, "removed.md"))
      .toContain(
        "Intro, edited by the agent.\n\n{++My point about the rollout.++}{#s1}\n",
      );
    const saved = readProjectFile(projectDir, "removed.md");
    expect(reviewBlock(saved).suggestions?.s1).toMatchObject({ by: "user" });
    await expect(notice).toHaveCount(0);
  });

  test("the restore from a stored draft shows its notice @batch5", async ({
    page,
  }) => {
    acceptBeforeUnload(page);
    const filePath = writeProjectFile(
      projectDir,
      "stored.md",
      "# Plan\n\nIntro.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Intro.");
    // Saves fail, so the edit only lives in the tab and in IndexedDB.
    const markdownFileRoute = (url: URL) =>
      url.pathname === "/api/markdown-file";
    await page.route(markdownFileRoute, async (route) => {
      if (route.request().method() === "PUT") {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await appendInCodeEditor(page, "\nTyped before the crash.\n");
    await page.waitForTimeout(600);
    expect(readProjectFile(projectDir, "stored.md")).toBe("# Plan\n\nIntro.\n");
    await page.unroute(markdownFileRoute);

    await page.reload();

    await expect(page.getByTestId("draft-restored-notice")).toHaveText(
      "Restored unsaved edits from your last session",
    );
    await expect(codeEditor(page)).toContainText("Typed before the crash.");
    await expect
      .poll(() => readProjectFile(projectDir, "stored.md"))
      .toBe("# Plan\n\nIntro.\n\nTyped before the crash.\n");
  });
});
