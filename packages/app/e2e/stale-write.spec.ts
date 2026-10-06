import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  appendInCodeEditor,
  blockTabChannel,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  fireWindowFocus,
  logE2eEvent,
  openMarkdownFile,
  placeCodeCaretAfter,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// Batch 5: a write from outside never blocks the tab. Edits in different
// places merge; only an overlap inside review markup waits in the banner,
// and the explicit overwrite sits behind a confirmation that shows the diff.

const ENTRY =
  '  c1:\n    body: "Why?"\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
const markupDocument = (highlight: string, after = "") =>
  `# T\n\nHi {==${highlight}==}{#c1}.\n\n${after}---\ncomments:\n${ENTRY}`;

// With the tab channel down, the tab learns about the outside write from
// its own save's 409 and merges there.
async function overlapInsideMarkup(
  page: Page,
  filePath: string,
  theirs: string,
) {
  await placeCodeCaretAfter(page, "there");
  fs.writeFileSync(filePath, theirs);
  await page.keyboard.type(" you");
  await expect(fileConflictNotice(page)).toContainText(
    "Your edit overlaps a change on disk",
  );
}

test.describe("stale writes", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("stale-write");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("merges an outside change into an edit typed on the older text @smoke", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const filePath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect
      .poll(() => readProjectFile(projectDir, "conflict.md"))
      .toBe("# Conflict\n\nExternal body.\n\nLocal body.\n");
    await expect(codeEditor(page)).toContainText("External body.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(fileConflictNotice(page)).toHaveCount(0);
    await expect(page.getByTestId("disk-update-notice")).toContainText(
      "Updated from disk: text changed in Conflict",
    );

    // A later outside write comes in too, and typing goes on after it.
    fs.writeFileSync(
      filePath,
      "# Conflict\n\nExternal body, again.\n\nLocal body.\n",
    );
    await fireWindowFocus(page);
    await expect(codeEditor(page)).toContainText("External body, again.");
    await appendInCodeEditor(page, "Still local.\n");
    await expect
      .poll(() => readProjectFile(projectDir, "conflict.md"))
      .toBe(
        "# Conflict\n\nExternal body, again.\n\nLocal body.\nStill local.\n",
      );

    logE2eEvent("stale-write.merged", { file: "conflict.md" });
  });

  test("overwrite after an overlap asks first, then saves the shown version", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const filePath = writeProjectFile(
      projectDir,
      "overwrite-conflict.md",
      markupDocument("there"),
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Hi {==there==}{#c1}.");

    const conflictAnswer = page.waitForResponse(
      (response) =>
        response.url().includes("/api/markdown-file?") &&
        response.request().method() === "PUT" &&
        response.status() === 409,
    );
    await overlapInsideMarkup(page, filePath, markupDocument("there me"));
    const shownVersion = (
      (await (await conflictAnswer).json()) as { current: { version: string } }
    ).current.version;
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Overlaps a change on disk",
    );
    expect(readProjectFile(projectDir, "overwrite-conflict.md")).toBe(
      markupDocument("there me"),
    );

    await page.getByTestId("file-conflict-action-overwrite").click();
    const dialog = page.getByTestId("overwrite-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("overwrite-diff-row-removed")).toHaveText(
      "- Hi {==there me==}{#c1}.",
    );
    await expect(page.getByTestId("overwrite-diff-row-added")).toHaveText(
      "+ Hi {==there you==}{#c1}.",
    );

    const overwriteRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/markdown-file?") &&
        request.method() === "PUT",
    );
    await page.getByTestId("overwrite-confirm-submit").click();
    expect((await overwriteRequest).postDataJSON()).toMatchObject({
      expectedVersion: shownVersion,
    });

    await expect
      .poll(() => readProjectFile(projectDir, "overwrite-conflict.md"))
      .toBe(markupDocument("there you"));
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(fileConflictNotice(page)).toHaveCount(0);

    logE2eEvent("stale-write.overwrite-saved", {
      file: "overwrite-conflict.md",
      size: fs.statSync(filePath).size,
    });
  });

  test("overwrite does not replace a disk version newer than the one shown", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const filePath = writeProjectFile(
      projectDir,
      "newer-than-shown.md",
      markupDocument("there"),
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Hi {==there==}{#c1}.");
    await overlapInsideMarkup(page, filePath, markupDocument("there me"));

    await page.getByTestId("file-conflict-action-overwrite").click();
    await expect(page.getByTestId("overwrite-confirm-dialog")).toBeVisible();
    // Another write lands after the dialog showed its version.
    fs.writeFileSync(filePath, markupDocument("there us"));
    await page.getByTestId("overwrite-confirm-submit").click();

    await expect(fileConflictNotice(page)).toBeVisible();
    await expect(page.getByTestId("file-conflict-hunk-h1-disk")).toHaveText(
      "Hi {==there us==}{#c1}.",
    );
    expect(readProjectFile(projectDir, "newer-than-shown.md")).toBe(
      markupDocument("there us"),
    );
  });

  test("manual save merges an outside change instead of overwriting it", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const filePath = writeProjectFile(
      projectDir,
      "manual-conflict.md",
      "# Manual Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Manual Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "manual-conflict.md"))
      .toBe("# Manual Conflict\n\nExternal body.\n\nLocal body.\n");
    await expect(fileConflictNotice(page)).toHaveCount(0);

    logE2eEvent("stale-write.manual-merged", {
      file: "manual-conflict.md",
    });
  });

  test("merges an external content change that kept the same metadata", async ({
    page,
  }) => {
    await blockTabChannel(page);
    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const filePath = writeProjectFile(
      projectDir,
      "metadata-conflict.md",
      "# Original\n",
    );
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original");

    fs.writeFileSync(filePath, "# External\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);
    await appendInCodeEditor(page, "\nLocal body.\n");

    // The content hash, not the mtime, says disk moved: the save is
    // refused and the edit is merged onto the new text, never written over it.
    await expect
      .poll(() => readProjectFile(projectDir, "metadata-conflict.md"))
      .toBe("# External\n\nLocal body.\n");
    await expect(fileConflictNotice(page)).toHaveCount(0);

    logE2eEvent("stale-write.metadata-merged", {
      file: "metadata-conflict.md",
    });
  });

  test("keeps the overlap choices visible while scrolled in a long document", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const longBody = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${index + 1}: local review text.`,
    ).join("\n\n");
    const filePath = writeProjectFile(
      projectDir,
      "long-conflict.md",
      markupDocument("there", `${longBody}\n\n`),
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Paragraph 1");
    await overlapInsideMarkup(
      page,
      filePath,
      markupDocument("there me", `${longBody}\n\n`),
    );

    await page.mouse.wheel(0, 20_000);
    const conflictNotice = fileConflictNotice(page);
    await expect(conflictNotice).toBeVisible();
    await expect(conflictNotice).toHaveCSS("position", "fixed");
    await expect(conflictNotice).toContainText(
      "Your edit overlaps a change on disk",
    );
    await expect(
      page.getByTestId("file-conflict-hunk-h1-theirs"),
    ).toBeVisible();
    await expect(page.getByTestId("file-conflict-hunk-h1-ours")).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-overwrite"),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-keep-editing"),
    ).toHaveCount(0);
  });

  test("keeps conflict banner and save status stack from overlapping", async ({
    page,
  }) => {
    await blockTabChannel(page);

    const filePath = writeProjectFile(
      projectDir,
      "layout-conflict.md",
      markupDocument("there"),
    );

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      fs.writeFileSync(filePath, markupDocument("there"));
      await page.setViewportSize(viewport);
      await openMarkdownFile(page, filePath, "code");
      await expect(codeEditor(page)).toContainText("Hi {==there==}{#c1}.");

      await overlapInsideMarkup(page, filePath, markupDocument("there me"));

      const conflictNotice = fileConflictNotice(page);
      const statusStack = page.getByTestId("document-status-stack");
      await expect(conflictNotice).toBeVisible();
      await expect(statusStack).toBeVisible();

      const conflictBox = await conflictNotice.boundingBox();
      const stackBox = await statusStack.boundingBox();
      expect(conflictBox).not.toBeNull();
      expect(stackBox).not.toBeNull();

      if (!conflictBox || !stackBox) {
        throw new Error("Expected conflict and status stack bounds");
      }

      const intersects =
        conflictBox.x < stackBox.x + stackBox.width &&
        conflictBox.x + conflictBox.width > stackBox.x &&
        conflictBox.y < stackBox.y + stackBox.height &&
        conflictBox.y + conflictBox.height > stackBox.y;

      expect(intersects).toBe(false);
      await page.getByTestId("file-conflict-hunk-h1-theirs").click();
      await expect(conflictNotice).toBeHidden();
    }
  });
});
