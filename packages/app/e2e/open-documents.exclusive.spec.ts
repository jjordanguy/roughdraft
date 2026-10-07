import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// "Close all finished" acts on every document the shared server knows, so
// this spec runs in the chromium-exclusive project, after the others.

async function register(
  request: APIRequestContext,
  projectDir: string,
  file: string,
  label: string,
) {
  const response = await request.post("/api/documents/session", {
    data: { projectPath: projectDir, path: file, harness: "openclaw", label },
  });
  expect(response.ok()).toBe(true);
}

async function postDone(
  request: APIRequestContext,
  projectDir: string,
  file: string,
) {
  const response = await request.post("/api/review-events", {
    data: { projectPath: projectDir, path: file },
  });
  return ((await response.json()) as { handoff: { handoffId: string } }).handoff
    .handoffId;
}

test.describe("Close all finished", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("close-finished");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("closes the documents whose Done was picked up and leaves a waiting one", async ({
    page,
    request,
  }) => {
    const picked = writeProjectFile(projectDir, "picked.md", "# Picked up\n");
    const waiting = writeProjectFile(projectDir, "waiting.md", "# Waiting\n");
    await register(request, projectDir, "picked.md", "Finished session");
    await register(request, projectDir, "waiting.md", "Busy session");
    const handoffId = await postDone(request, projectDir, "picked.md");
    await request.post("/api/review-events/ack", { data: { handoffId } });
    await postDone(request, projectDir, "waiting.md");

    await page.goto("/");
    const pickedRow = page.locator(
      `[data-testid="open-document-row"][data-document-path="${picked}"]`,
    );
    const waitingRow = page.locator(
      `[data-testid="open-document-row"][data-document-path="${waiting}"]`,
    );
    await expect(pickedRow.getByTestId("open-document-status")).toContainText(
      "Done picked up at",
    );

    await page.getByTestId("open-documents-close-finished").click();

    await expect(pickedRow).toHaveCount(0);
    await expect(waitingRow).toBeVisible();
    await expect(page.getByTestId("open-documents-message")).toContainText(
      "Closed",
    );
    await page.getByTestId("open-documents-earlier-trigger").click();
    await expect(
      page.locator(
        `[data-testid="open-documents-earlier-row"][data-document-path="${picked}"]`,
      ),
    ).toContainText("Finished session");
  });
});
