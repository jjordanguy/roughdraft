// Batch 3a: the browser reads review markup through rfm. Real files on disk,
// the real API server, and the controls a person uses.
//
//   pnpm test:e2e --grep @batch3a
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  extractRoughdraftReviewIndex,
  splitRoughdraftDocument,
} from "@roughdraft/rfm";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/spec/fixtures",
);

function fixture(name: string) {
  return fs.readFileSync(path.join(fixturesDir, `${name}.md`), "utf8");
}

function fixtureNames(prefix: string) {
  return fs
    .readdirSync(fixturesDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""))
    .sort();
}

// The browser-repro cases as the 0.1.10 browser and the agent methods left
// them on disk (legacy inline bodies, attribute blocks, replicas).
const reproCases = fixtureNames("repro-");
const canonicalCases = fixtureNames("canonical-");

function reviewBlock(markdown: string) {
  return splitRoughdraftDocument(markdown).endmatter;
}

test.describe("review format readers @batch3a", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-format");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const name of reproCases) {
    test(`${name}: one card per logical comment, replies nested @batch3a`, async ({
      page,
    }) => {
      const markdown = fixture(name);
      const filePath = writeProjectFile(projectDir, `${name}.md`, markdown);
      const index = extractRoughdraftReviewIndex(markdown);
      // An inline comment with a blank line cannot be shown (rfm reports
      // `inline-comment-blank-line`); its thread stays literal text.
      const unplaceable = new Set(
        index.diagnostics
          .filter((item) => item.code === "inline-comment-blank-line")
          .flatMap((item) =>
            [...item.message.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""),
          ),
      );
      const itemById = new Map(index.items.map((item) => [item.id, item]));
      const rootOf = (id: string): string => {
        let current = itemById.get(id);
        const seen = new Set<string>();
        while (current?.parentId && itemById.has(current.parentId)) {
          if (seen.has(current.id)) break;
          seen.add(current.id);
          current = itemById.get(current.parentId);
        }
        return current?.id ?? id;
      };
      const cardTestId = (rootId: string) => {
        const root = itemById.get(rootId);
        if (root?.kind === "suggestion") return `suggestion-thread-${rootId}`;
        // Comments on the whole document and on code blocks (batch 4)
        // live in the global section.
        return root?.scope === "document" || root?.scope === "code"
          ? `global-comment-thread-${rootId}`
          : `comment-thread-${rootId}`;
      };

      await openMarkdownFile(page, filePath);
      await expect(richTextEditor(page)).toBeVisible();
      const rail = page.getByTestId("document-review-rail");

      let cards = 0;
      for (const item of index.items) {
        const rootId = rootOf(item.id);
        if (unplaceable.has(rootId)) continue;
        if (item.kind === "suggestion" || item.parentId === null) {
          cards += 1;
          await expect(rail.getByTestId(cardTestId(item.id))).toHaveCount(1);
          continue;
        }
        // A reply: inside its root's card, wherever the file stores it.
        await expect(
          rail
            .getByTestId(cardTestId(rootId))
            .getByTestId(`comment-rail-${item.id}`),
        ).toHaveCount(1);
        await expect(rail.getByTestId(`comment-thread-${item.id}`)).toHaveCount(
          0,
        );
      }

      const allCards = rail.locator(
        '[data-testid^="comment-thread-"], [data-testid^="global-comment-thread-"], [data-testid^="suggestion-thread-"]',
      );
      // A thread whose highlight cannot be shown may still get one card
      // from a ref it carries; never more than one.
      await expect
        .poll(async () => (await allCards.count()) - cards)
        .toBeGreaterThanOrEqual(0);
      expect((await allCards.count()) - cards).toBeLessThanOrEqual(
        unplaceable.size,
      );
      for (const rootId of unplaceable) {
        expect(
          await rail.getByTestId(cardTestId(rootId)).count(),
        ).toBeLessThanOrEqual(1);
      }
      // No raw review markup leaks into the rail.
      const railText = (await rail.count()) ? await rail.innerText() : "";
      expect(railText).not.toContain("{>>");
      expect(railText).not.toContain('id="');
    });
  }

  for (const name of canonicalCases) {
    test(`${name}: an unrelated edit keeps the review block byte for byte @batch3a`, async ({
      page,
    }) => {
      const markdown = fixture(name);
      const filePath = writeProjectFile(projectDir, `${name}.md`, markdown);

      await openMarkdownFile(page, filePath, "rich-text");
      const editor = richTextEditor(page);
      await expect(editor).toBeVisible();
      // Editing mode: the words are typed as text, not as a suggestion.
      await page.getByTestId("document-mode-trigger").click();
      await page.getByTestId("document-mode-option-editing").click();
      await editor.focus();
      // The caret at the end of the last paragraph.
      await page.evaluate(() => {
        const editorElement = document.querySelector(".ProseMirror");
        const last = [...(editorElement?.children ?? [])]
          .filter((child) => child.tagName === "P")
          .at(-1);
        if (!last) throw new Error("no paragraph");
        const range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await page.keyboard.type(" Unrelated edit.");

      await expect
        .poll(() => readProjectFile(projectDir, `${name}.md`))
        .toContain("Unrelated edit.");
      const saved = readProjectFile(projectDir, `${name}.md`);
      expect(reviewBlock(saved)).toBe(reviewBlock(markdown));
      expect(splitRoughdraftDocument(saved).frontmatter).toBe(
        splitRoughdraftDocument(markdown).frontmatter,
      );
      // Only the typed words changed.
      expect(saved.replace(" Unrelated edit.", "")).toBe(markdown);
    });
  }

  test("a file with two review blocks shows the banner and is never saved @batch3a", async ({
    page,
  }) => {
    const markdown = fixture("probe-R13-two-endmatter-blocks");
    const filePath = writeProjectFile(projectDir, "two-blocks.md", markdown);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().includes("/api/markdown-file")
      ) {
        writes.push(request.url());
      }
    });

    await openMarkdownFile(page, filePath, "rich-text");
    const notice = page.getByTestId("review-block-error-notice");
    await expect(notice).toBeVisible();
    await expect(page.getByTestId("review-block-error-message")).toHaveText(
      "The review block at the end of this file could not be read: line 3: the file has two review blocks (lines 3 and 9); merge them into the last one",
    );
    await expect(
      page.getByTestId("review-block-error-action-reload"),
    ).toBeVisible();

    const editor = richTextEditor(page);
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(editor).not.toContainText("comments:");
    await editor.click();
    await page.keyboard.type(" typed while blocked");
    await page.waitForTimeout(1500);

    expect(writes).toEqual([]);
    expect(readProjectFile(projectDir, "two-blocks.md")).toBe(markdown);
  });
});
