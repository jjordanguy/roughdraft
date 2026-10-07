import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export function createMarkdownProject(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `roughdraft-${label}-`));
}

export function removeMarkdownProject(projectDir: string) {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

export function writeProjectFile(
  projectDir: string,
  relativePath: string,
  content: string | Buffer,
) {
  const absolutePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

export function readProjectFile(projectDir: string, relativePath: string) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

export async function openMarkdownFile(
  page: Page,
  absolutePath: string,
  editor?: "rich-text" | "code",
) {
  const params = new URLSearchParams({ path: absolutePath });
  if (editor) params.set("editor", editor);

  await page.goto(`/?${params.toString()}`);
}

export function codeEditor(page: Page) {
  return page.getByTestId("markdown-code-editor").locator(".cm-content");
}

export function richTextEditor(page: Page) {
  return page.getByTestId("rich-text-editor").locator(".ProseMirror");
}

export function documentSaveStatus(page: Page) {
  return page.getByTestId("document-save-status");
}

export function fileConflictNotice(page: Page) {
  return page.getByTestId("file-conflict-notice");
}

export async function appendInCodeEditor(page: Page, text: string) {
  const editor = codeEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await page.keyboard.type(text);
}

export async function selectRichText(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((targetText) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) {
      throw new Error("Could not find rich-text editor");
    }

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const index = node.textContent?.indexOf(targetText) ?? -1;

      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + targetText.length);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }

      node = walker.nextNode();
    }

    throw new Error(`Could not find text "${targetText}"`);
  }, text);
}

export function logE2eEvent(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/app/e2e",
      event,
      data,
    })}\n`,
  );
}

// The API server Playwright starts (see playwright.config.ts). Tests that
// must abort a connection talk to it directly instead of through the Vite
// proxy, so the abort reaches the server and not only the proxy.
export function apiBaseUrl() {
  return `http://127.0.0.1:${Number(process.env.API_PORT ?? 4317)}`;
}

// Keeps the tab channel down so the tab learns about disk changes only from
// its own saves (the stale-write tests need the 409 path).
export async function blockTabChannel(page: Page) {
  await page.routeWebSocket(/\/api\/tab\?/, (socket) => {
    socket.close();
  });
}

// Fires the window focus event, one of the tab's resync triggers.
export async function fireWindowFocus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

// Editing mode: typed words go in as text, not as suggestions.
export async function useEditingMode(page: Page) {
  await page.getByTestId("document-mode-trigger").click();
  await page.getByTestId("document-mode-option-editing").click();
}

// Puts the rich-text caret right after `text` (the first match).
export async function placeRichTextCaretAfter(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((targetText) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) throw new Error("Could not find rich-text editor");
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.indexOf(targetText) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index + targetText.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`Could not find text "${targetText}"`);
  }, text);
}

// Puts the code-view caret right after `text` (the first match inside one
// line); CodeMirror reads the DOM selection.
export async function placeCodeCaretAfter(page: Page, text: string) {
  const editor = codeEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.evaluate((targetText) => {
    const content = document.querySelector(".cm-content");
    if (!content) throw new Error("Could not find the code editor");
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.indexOf(targetText) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index + targetText.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`Could not find text "${targetText}"`);
  }, text);
}

// A reload or close with unsaved edits asks first; the tests say yes.
export function acceptBeforeUnload(page: Page) {
  page.on("dialog", (dialog) => {
    void dialog.accept();
  });
}

// Holds the tab's saves until the returned function is called, so an
// outside write lands first.
export async function holdSaves(page: Page) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/markdown-file",
    async (route) => {
      if (route.request().method() === "PUT") await held;
      await route.continue();
    },
  );
  return () => release();
}
