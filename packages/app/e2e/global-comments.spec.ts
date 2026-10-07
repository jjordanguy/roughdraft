// Batch 4: the Global comment button and section, resolved folding, the
// agent's round note and the "AI editing..." badge. Real files on disk, the
// real API server, the controls a person uses, and the built CLI run from
// the test for the agent's side (run `pnpm build` first).
//
//   pnpm test:e2e --grep @batch4
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const run = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "packages/server/bin/roughdraft.mjs");

// The built CLI, pointed at the API server Playwright started.
async function roughdraft(stateDir: string, args: string[]) {
  const { stdout } = await run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      ROUGHDRAFT_PORT: String(Number(process.env.API_PORT ?? 4317)),
      ROUGHDRAFT_STATE_DIR: stateDir,
      ROUGHDRAFT_NO_OPEN: "1",
    },
  });
  return JSON.parse(stdout);
}

interface Entry {
  body?: string;
  by?: string;
  at?: string;
  re?: string;
  scope?: string;
  status?: string;
  lines?: number[];
  quote?: string;
}

function reviewBlock(markdown: string): {
  body: string;
  comments: Record<string, Entry>;
} {
  const index = markdown.lastIndexOf("\n---\n");
  if (index < 0) return { body: markdown, comments: {} };
  const data = parseYaml(markdown.slice(index + 5)) as {
    comments?: Record<string, Entry>;
  } | null;
  return {
    body: markdown.slice(0, index + 1),
    comments: data?.comments ?? {},
  };
}

function globalSection(page: Page) {
  return page.getByTestId("global-comments-section");
}

const PLAIN = ["# Plan", "", "The pilot runs for two weeks.", ""].join("\n");

const WITH_GLOBAL = [
  "# Plan",
  "",
  "The pilot runs for two weeks.",
  "",
  "---",
  "comments:",
  "  c1:",
  '    body: "Say who signs off on the pilot."',
  "    by: user",
  '    at: "2026-10-05T09:00:00.000Z"',
  "    scope: document",
  "",
].join("\n");

test.describe("global comments @batch4", () => {
  let projectDir: string;
  let stateDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("global-comments");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-b4-state-"));
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("adds a global comment with no watcher", async ({ page }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", PLAIN);
    await openMarkdownFile(page, filePath);
    await expect(
      page.getByTestId("review-handoff-split-button"),
    ).toHaveAttribute("data-watcher-state", "none");

    await page.getByTestId("global-comment-add").click();
    const editor = globalSection(page).getByTestId("comment-rail-c1-editor");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAttribute(
      "placeholder",
      "Comment on the whole document",
    );
    await editor.fill("Name the approver before the pilot starts.");
    await globalSection(page)
      .getByTestId("comment-rail-c1-action-save")
      .click();

    await expect
      .poll(() => reviewBlock(readProjectFile(projectDir, "plan.md")).comments)
      .toMatchObject({
        c1: {
          body: "Name the approver before the pilot starts.",
          by: "user",
          scope: "document",
        },
      });
    const saved = reviewBlock(readProjectFile(projectDir, "plan.md"));
    expect(saved.comments.c1?.re).toBeUndefined();
    // No anchor: the prose is untouched (the block follows a blank line).
    expect(saved.body).toBe(`${PLAIN}\n`);

    await page.reload();
    await expect(
      globalSection(page).getByTestId("global-comment-thread-c1"),
    ).toContainText("Name the approver before the pilot starts.");
  });

  test("replies to a global comment from the rail", async ({ page }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", WITH_GLOBAL);
    await openMarkdownFile(page, filePath);

    const thread = globalSection(page).getByTestId("global-comment-thread-c1");
    await thread.click();
    await thread.getByTestId("comment-rail-c1-action-reply").click();
    await globalSection(page)
      .getByTestId("comment-rail-c2-editor")
      .fill("The operations lead signs off.");
    await globalSection(page)
      .getByTestId("comment-rail-c2-action-save")
      .click();

    await expect
      .poll(() => reviewBlock(readProjectFile(projectDir, "plan.md")).comments)
      .toMatchObject({
        c2: { body: "The operations lead signs off.", re: "c1", by: "user" },
      });
    await expect(thread.getByTestId("comment-rail-c2")).toContainText(
      "The operations lead signs off.",
    );
  });

  test("resolves and reopens a global comment", async ({ page }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", WITH_GLOBAL);
    await openMarkdownFile(page, filePath);

    const thread = globalSection(page).getByTestId("global-comment-thread-c1");
    await thread.click();
    await thread.getByTestId("comment-rail-c1-action-resolve").click();

    await expect
      .poll(
        () =>
          reviewBlock(readProjectFile(projectDir, "plan.md")).comments.c1
            ?.status,
      )
      .toBe("resolved");
    await expect(thread).toHaveCount(0);
    const toggle = globalSection(page).getByTestId(
      "global-comments-resolved-toggle",
    );
    await expect(toggle).toHaveText("1 resolved");
    await expect(page.getByTestId("resolved-comment-thread-c1")).toHaveCount(0);

    await toggle.click();
    const resolved = globalSection(page).getByTestId(
      "resolved-comment-thread-c1",
    );
    await expect(resolved).toContainText("Say who signs off on the pilot.");
    await resolved.click();
    await resolved.getByTestId("comment-rail-c1-action-reopen").click();

    await expect
      .poll(
        () =>
          reviewBlock(readProjectFile(projectDir, "plan.md")).comments.c1
            ?.status,
      )
      .toBeUndefined();
    await expect(thread).toBeVisible();
    await expect(toggle).toHaveCount(0);
  });

  test("an agent round note from roughdraft note shows as an AI card within two seconds", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", PLAIN);
    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("two weeks");

    const result = await roughdraft(stateDir, [
      "note",
      filePath,
      "Round 1: named the approver.",
      "--json",
    ]);
    expect(result).toMatchObject({ ok: true, id: "a1" });
    const writtenAt = Date.now();

    const card = globalSection(page).getByTestId("global-comment-thread-a1");
    await expect(card).toContainText("Round 1: named the approver.", {
      timeout: 2_000,
    });
    expect(Date.now() - writtenAt).toBeLessThan(2_000);
    await expect(card).toHaveAttribute("data-author", "ai");
    await expect(card.getByTestId("comment-rail-a1")).toContainText("AI");

    // Jordan can reply to it.
    await card.click();
    await card.getByTestId("comment-rail-a1-action-reply").click();
    await globalSection(page)
      .getByTestId("comment-rail-c1-editor")
      .fill("Thanks.");
    await globalSection(page)
      .getByTestId("comment-rail-c1-action-save")
      .click();
    await expect
      .poll(() => reviewBlock(readProjectFile(projectDir, "plan.md")).comments)
      .toMatchObject({
        a1: { by: "AI", scope: "document" },
        c1: { body: "Thanks.", re: "a1" },
      });
  });

  test("a comment on a code block shows in the global section with the quoted lines", async ({
    page,
  }) => {
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
    const filePath = writeProjectFile(projectDir, "code.md", source);
    await openMarkdownFile(page, filePath);

    await richTextEditor(page).focus();
    await page.evaluate(() => {
      const editor = document.querySelector(".ProseMirror");
      const walker = document.createTreeWalker(
        editor as Node,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const start = text.indexOf("const port");
        if (start < 0) continue;
        const end =
          text.indexOf("start({ port });") + "start({ port });".length;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      throw new Error("code text not found");
    });
    await page.getByTestId("selection-menu-action-comment").click();
    await globalSection(page)
      .getByTestId("comment-rail-c1-editor")
      .fill("Read the port from the environment.");
    await globalSection(page)
      .getByTestId("comment-rail-c1-action-save")
      .click();

    await expect
      .poll(() => reviewBlock(readProjectFile(projectDir, "code.md")).comments)
      .toMatchObject({
        c1: {
          lines: [3, 4],
          quote: "const port = 3000;\nstart({ port });",
        },
      });

    await page.reload();
    const card = globalSection(page).getByTestId("global-comment-thread-c1");
    await expect(card.getByTestId("comment-code-lines-c1")).toHaveText(
      "Lines 3–4",
    );
    await expect(card.getByTestId("comment-code-quote-c1")).toContainText(
      "const port = 3000;\nstart({ port });",
    );
    await expect(
      page.getByTestId("document-review-rail").getByTestId("comment-thread-c1"),
    ).toHaveCount(0);

    const anchor = page.getByTestId("comment-code-anchor-c1");
    await expect(anchor).not.toHaveClass(/comment-decoration-active/);
    await card.click();
    await expect(anchor).toHaveClass(/comment-decoration-active/);
  });

  test("the badge appears when roughdraft round runs and disappears on apply", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", PLAIN);
    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("two weeks");
    await expect(page.getByTestId("ai-round-badge")).toHaveCount(0);

    const round = await roughdraft(stateDir, ["round", filePath, "--json"]);
    expect(round.roundFlag).toBe("open");

    const badge = page.getByTestId("ai-round-badge");
    await expect(badge).toHaveAttribute("data-round-state", "open");
    await expect(badge).toContainText("AI editing...");
    await expect(page.getByTestId("ai-round-elapsed")).toHaveText(/^\d+:\d\d$/);
    // A badge, never a lock.
    await expect(richTextEditor(page)).toHaveAttribute(
      "contenteditable",
      "true",
    );

    const response = JSON.parse(fs.readFileSync(round.files.response, "utf8"));
    response.note = "Round 1: no changes needed.";
    fs.writeFileSync(round.files.response, JSON.stringify(response));
    const applied = await roughdraft(stateDir, [
      "apply",
      round.files.response,
      "--json",
    ]);
    expect(applied).toMatchObject({ ok: true, roundFlag: "closed" });

    await expect(badge).toHaveCount(0);
    await expect(
      globalSection(page).getByTestId("global-comment-thread-a1"),
    ).toContainText("Round 1: no changes needed.");
    // Batch 5: the round's write takes over from the badge as the quiet
    // notice.
    await expect(page.getByTestId("disk-update-notice")).toContainText(
      "Updated from disk: 1 comment added",
    );
  });

  test("Done saves an open global draft first", async ({ page }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", PLAIN);
    await openMarkdownFile(page, filePath);

    await page.getByTestId("global-comment-add").click();
    await globalSection(page)
      .getByTestId("comment-rail-c1-editor")
      .fill("Ship it after the approver signs.");
    // No Save: Done saves the draft first.
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Done, waiting",
    );
    expect(
      reviewBlock(readProjectFile(projectDir, "plan.md")).comments,
    ).toMatchObject({
      c1: {
        body: "Ship it after the approver signs.",
        by: "user",
        scope: "document",
      },
    });
    await page.keyboard.press("Escape");
    await expect(
      globalSection(page).getByTestId("global-comment-thread-c1"),
    ).toContainText("Ship it after the approver signs.");
    await expect(
      globalSection(page).getByTestId("comment-rail-c1-editor"),
    ).toHaveCount(0);
  });

  test("global comments show below 1100px", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const filePath = writeProjectFile(projectDir, "plan.md", WITH_GLOBAL);
    await openMarkdownFile(page, filePath);

    const fallback = page.getByTestId("global-comments-fallback");
    await expect(fallback).toBeVisible();
    await expect(
      fallback.getByTestId("global-comment-thread-c1"),
    ).toContainText("Say who signs off on the pilot.");
    await expect(page.getByTestId("global-comments-section")).toBeHidden();

    await page.getByTestId("global-comment-add").click();
    const editor = fallback.getByTestId("comment-banner-c2-editor");
    await expect(editor).toBeFocused();
    await editor.fill("Add the budget table.");
    await fallback.getByTestId("comment-banner-c2-action-save").click();

    await expect
      .poll(() => reviewBlock(readProjectFile(projectDir, "plan.md")).comments)
      .toMatchObject({
        c2: { body: "Add the budget table.", scope: "document" },
      });
  });
});
