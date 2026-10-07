import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// The open documents list at `/` against the real server. Every test here
// works on its own files and session labels: the server is shared with the
// other specs running in parallel, so assertions look at these rows only.

async function registerSession(
  request: APIRequestContext,
  filePath: string,
  label: string,
  harness = "openclaw",
) {
  const separator = filePath.lastIndexOf("/");
  const response = await request.post("/api/documents/session", {
    data: {
      projectPath: filePath.slice(0, separator),
      path: filePath.slice(separator + 1),
      harness,
      label,
    },
  });
  expect(response.ok()).toBe(true);
}

async function postDone(request: APIRequestContext, filePath: string) {
  const separator = filePath.lastIndexOf("/");
  const response = await request.post("/api/review-events", {
    data: {
      projectPath: filePath.slice(0, separator),
      path: filePath.slice(separator + 1),
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { handoff: { handoffId: string } };
}

async function trackedDocument(request: APIRequestContext, filePath: string) {
  const response = await request.get("/api/documents");
  const body = (await response.json()) as {
    documents: Array<Record<string, unknown> & { documentPath: string }>;
  };
  return body.documents.find((document) => document.documentPath === filePath);
}

function row(page: Page, filePath: string) {
  return page.locator(
    `[data-testid="open-document-row"][data-document-path="${filePath}"]`,
  );
}

function group(page: Page, label: string) {
  return page.locator(
    `[data-testid="open-documents-group"][data-session-label="${label}"]`,
  );
}

test.describe("open documents list", () => {
  let projectDir: string;
  let label: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-documents");
    label = `Session ${test.info().testId}`;
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("lists a registered document under its session with its heading @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "plan.md",
      "# Fork plan\n\nBody.\n",
    );
    await registerSession(request, filePath, label, "claude-code");

    await page.goto("/");
    await expect(page).toHaveTitle("Open documents");
    const session = group(page, label);
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute(
      "aria-label",
      `Claude Code session: ${label}`,
    );
    await expect(session.getByTestId("open-documents-harness")).toHaveText(
      "Claude Code",
    );
    const documentRow = row(page, filePath);
    await expect(documentRow.getByTestId("open-document-title")).toHaveText(
      "Fork plan",
    );
    await expect(documentRow).toHaveAttribute(
      "aria-label",
      /^Fork plan, plan\.md · /,
    );
    await expect(documentRow.getByTestId("open-document-status")).toContainText(
      "no Done yet",
    );
  });

  test("a document window is titled with its heading and session, and its file menu opens the list", async ({
    page,
    request,
    context,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "notes.md",
      "# Launch notes\n\nBody.\n",
    );
    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("rich-text-editor")).toContainText("Body.");
    await expect(page).toHaveTitle("Launch notes");

    // The title follows the session the server reports.
    await registerSession(request, filePath, label);
    await expect(page).toHaveTitle(`Launch notes · ${label}`);

    await page.getByTestId("document-file-menu-trigger").click();
    const [listPage] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("document-file-menu-open-documents").click(),
    ]);
    await expect(listPage).toHaveURL(/\/$/);
    await expect(row(listPage, filePath)).toBeVisible();
    await expect(
      row(listPage, filePath).getByTestId("open-document-status"),
    ).toContainText("1 window");
  });

  test("Close closes a window Roughdraft opened and the file stays as it was", async ({
    page,
    request,
    context,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "closing.md",
      "# Closing\n\nKeep me.\n",
    );
    await registerSession(request, filePath, label);
    await page.goto("/");

    // Open: no window has the file yet, so the list opens one.
    const [documentPage] = await Promise.all([
      context.waitForEvent("page"),
      row(page, filePath).getByTestId("open-document-open").click(),
    ]);
    await expect(documentPage.getByTestId("rich-text-editor")).toContainText(
      "Keep me.",
    );
    await expect(
      row(page, filePath).getByTestId("open-document-status"),
    ).toContainText("1 window");

    const closed = documentPage.waitForEvent("close");
    await row(page, filePath).getByTestId("open-document-close").click();
    await closed;

    await expect(row(page, filePath)).toHaveCount(0);
    await page.getByTestId("open-documents-earlier-trigger").click();
    const earlier = page.locator(
      `[data-testid="open-documents-earlier-row"][data-document-path="${filePath}"]`,
    );
    await expect(earlier).toContainText(label);
    expect(
      await earlier.getByTestId("open-documents-reopen").getAttribute("href"),
    ).toContain(new URLSearchParams({ path: filePath }).toString());
    expect(readProjectFile(projectDir, "closing.md")).toBe(
      "# Closing\n\nKeep me.\n",
    );
    expect(await trackedDocument(request, filePath)).toMatchObject({
      session: null,
      lastSession: { label },
      closedAt: expect.any(String),
    });
  });

  test("a tab the browser will not let a page close shows the closed notice", async ({
    page,
    request,
  }) => {
    const other = writeProjectFile(projectDir, "other.md", "# Other\n");
    const filePath = writeProjectFile(projectDir, "tab.md", "# Tab\n\nText.\n");
    await registerSession(request, filePath, label);
    // Two entries in the tab's history: a page may not close such a tab.
    await openMarkdownFile(page, other);
    await expect(page.getByTestId("rich-text-editor")).toContainText("Other");
    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("rich-text-editor")).toContainText("Text.");

    const response = await request.post("/api/documents/close", {
      data: { projectPath: projectDir, path: "tab.md" },
    });
    expect(await response.json()).toMatchObject({ ok: true, closedTabs: 1 });

    await expect(page.getByTestId("closed-from-list")).toHaveText(
      /Closed from the open documents list\. You can close this tab\./,
    );
    await expect(page).toHaveTitle(/^Closed · /);
  });

  test("a document with unsaved text in a window cannot be closed from the list", async ({
    page,
    request,
    browser,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "dirty.md",
      "# Dirty\n\nStart.\n",
    );
    await registerSession(request, filePath, label);
    // Saves never reach the server, so the typed text stays unsaved.
    await page.route("**/api/markdown-file?**", (route) =>
      route.request().method() === "PUT" ? route.abort() : route.continue(),
    );
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, " Unsaved words.");

    const listContext = await browser.newContext();
    const list = await listContext.newPage();
    await list.goto("/");
    const documentRow = row(list, filePath);
    await expect(documentRow.getByTestId("open-document-status")).toContainText(
      "unsaved text in a window",
      { timeout: 15_000 },
    );
    await expect(documentRow.getByTestId("open-document-close")).toBeDisabled();

    const refused = await request.post("/api/documents/close", {
      data: { projectPath: projectDir, path: "dirty.md" },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "TAB_DIRTY" });
    await expect(page.getByTestId("closed-from-list")).toHaveCount(0);
    await listContext.close();
  });

  test("Drop takes a waiting Done out of pending", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(projectDir, "done.md", "# Done here\n");
    await registerSession(request, filePath, label);
    await postDone(request, filePath);
    expect(await trackedDocument(request, filePath)).toMatchObject({
      pendingHandoffs: 1,
    });

    await page.goto("/");
    const documentRow = row(page, filePath);
    await expect(documentRow.getByTestId("open-document-status")).toContainText(
      "Done waiting since",
    );
    await documentRow.getByTestId("open-document-drop").click();

    await expect(documentRow.getByTestId("open-document-status")).toContainText(
      "Done dropped",
    );
    await expect(documentRow.getByTestId("open-document-drop")).toHaveCount(0);
    expect(await trackedDocument(request, filePath)).toMatchObject({
      pendingHandoffs: 0,
      latestHandoff: { state: "dropped" },
    });
  });

  test("works at phone width without scrolling sideways", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "narrow.md",
      `# ${"A long heading that has to wrap or truncate on a phone ".repeat(2)}\n`,
    );
    await registerSession(request, filePath, label);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await expect(row(page, filePath)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
