import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// Batch 2: one WebSocket per tab, catch-up after gaps, the sync controller.
// Every test here needs the batch 2 server (tab channel, state route,
// content-hash saves, Done with expectedVersion):
//   pnpm test:e2e --grep @batch2-server

const isMarkdownFileRoute = (url: URL) => url.pathname === "/api/markdown-file";

async function setVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test.describe("tab sync", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("sync");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("changes made while the socket was down appear after it recovers @batch2-server", async ({
    page,
  }) => {
    let socketDown = true;
    await page.routeWebSocket(/\/api\/tab\?/, (socket) => {
      if (socketDown) {
        socket.close();
        return;
      }
      socket.connectToServer();
    });
    const filePath = writeProjectFile(
      projectDir,
      "socket-down.md",
      "# Socket\n\nOriginal.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");

    fs.writeFileSync(
      filePath,
      "# Socket\n\nOriginal.\n\nWritten while the socket was down.\n",
    );
    await page.waitForTimeout(1_500);
    await expect(codeEditor(page)).not.toContainText("Written while");

    socketDown = false;
    // The reconnect backoff tops out at 5 s; the hello carries the state.
    await expect(codeEditor(page)).toContainText(
      "Written while the socket was down.",
      { timeout: 10_000 },
    );
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
  });

  test("the tab catches up after becoming visible @batch2-server", async ({
    page,
  }) => {
    let muted = false;
    await page.routeWebSocket(/\/api\/tab\?/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (!muted) socket.send(message);
      });
    });
    const filePath = writeProjectFile(
      projectDir,
      "visible.md",
      "# Visible\n\nOriginal.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");
    await page.waitForTimeout(500);

    // Only the visibility resync can deliver this change.
    muted = true;
    await setVisibility(page, "hidden");
    fs.writeFileSync(
      filePath,
      "# Visible\n\nOriginal.\n\nWritten while away.\n",
    );
    await page.waitForTimeout(1_500);
    await expect(codeEditor(page)).not.toContainText("Written while away.");

    await setVisibility(page, "visible");
    await expect(codeEditor(page)).toContainText("Written while away.");
  });

  test("slow saves do not conflict with themselves @batch2-server", async ({
    page,
  }) => {
    await page.route(isMarkdownFileRoute, async (route) => {
      if (route.request().method() === "PUT") {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.fallback();
    });
    const putStatuses: number[] = [];
    page.on("response", (response) => {
      if (
        isMarkdownFileRoute(new URL(response.url())) &&
        response.request().method() === "PUT"
      ) {
        putStatuses.push(response.status());
      }
    });
    const filePath = writeProjectFile(
      projectDir,
      "slow.md",
      "# Slow\n\nOriginal.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");

    await appendInCodeEditor(page, "\nFirst burst.");
    await page.waitForTimeout(800);
    await page.keyboard.type(" Second burst.");

    await expect
      .poll(() => readProjectFile(projectDir, "slow.md"), { timeout: 10_000 })
      .toContain("First burst. Second burst.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    expect(putStatuses.length).toBeGreaterThanOrEqual(2);
    expect(putStatuses.every((status) => status === 200)).toBe(true);
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
  });

  test("Done immediately after typing hands off @batch2-server", async ({
    page,
    request,
  }) => {
    const conflicts: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 409) conflicts.push(response.url());
    });
    const filePath = writeProjectFile(
      projectDir,
      "quick-done.md",
      "# Quick Done\n\nReview this.\n",
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "quick-done.md",
        timeoutSeconds: 15,
      },
    });

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Review this.");
    await expect(
      page.getByTestId("review-handoff-split-button"),
    ).toHaveAttribute("data-watcher-state", "listening");

    await appendInCodeEditor(page, "\nQuick note.\n");
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toContainText(
      /Your agent (is now working|picked this up)/,
    );
    const payload = (await (
      (await pendingWatch) as { json: () => Promise<unknown> }
    ).json()) as { events: unknown[] };
    expect(payload.events).toHaveLength(1);
    expect(readProjectFile(projectDir, "quick-done.md")).toContain(
      "Quick note.",
    );
    expect(conflicts).toEqual([]);
  });

  test("a failed save is retried after the server comes back @batch2-server", async ({
    page,
  }) => {
    let failPuts = true;
    await page.route(isMarkdownFileRoute, async (route) => {
      if (failPuts && route.request().method() === "PUT") {
        await route.abort();
        return;
      }
      await route.fallback();
    });
    const filePath = writeProjectFile(
      projectDir,
      "retry.md",
      "# Retry\n\nOriginal.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");

    await appendInCodeEditor(page, "\nSaved after the outage.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save failed, retrying",
    );
    await expect(page.getByTestId("sync-status-notice")).toHaveAttribute(
      "data-sync-state",
      "offline",
    );

    failPuts = false;
    await expect
      .poll(() => readProjectFile(projectDir, "retry.md"), { timeout: 15_000 })
      .toContain("Saved after the outage.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(page.getByTestId("sync-status-notice")).toHaveCount(0);
  });

  test("four pages in one context all render and text typed in page 1 reaches disk within 3 s @batch2-server", async ({
    page,
    context,
  }) => {
    const pages = [page];
    for (let index = 1; index < 4; index += 1) {
      pages.push(await context.newPage());
    }
    const files = pages.map((_, index) =>
      writeProjectFile(
        projectDir,
        `page-${index + 1}.md`,
        `# Page ${index + 1}\n\nBody ${index + 1}.\n`,
      ),
    );

    for (const [index, current] of pages.entries()) {
      await openMarkdownFile(current, files[index] as string, "code");
    }
    for (const [index, current] of pages.entries()) {
      await expect(codeEditor(current)).toContainText(`Body ${index + 1}.`);
    }

    await pages[0]?.bringToFront();
    await appendInCodeEditor(page, "\nTyped in page one.\n");
    await expect
      .poll(() => readProjectFile(projectDir, "page-1.md"), { timeout: 3_000 })
      .toContain("Typed in page one.");
  });

  test("a file that disappears and reappears recovers without user action and still receives later changes @batch2-server", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "flaky.md",
      "# Flaky\n\nOriginal.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");

    fs.renameSync(filePath, `${filePath}.away`);
    await expect(page.getByTestId("sync-status-notice")).toHaveAttribute(
      "data-sync-state",
      "unavailable",
    );

    fs.renameSync(`${filePath}.away`, filePath);
    await expect(page.getByTestId("sync-status-notice")).toHaveCount(0);
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    fs.writeFileSync(filePath, "# Flaky\n\nOriginal.\n\nA later change.\n");
    await expect(codeEditor(page)).toContainText("A later change.");
  });

  test("a start-up failure shows Retry and recovers @batch2-server", async ({
    page,
  }) => {
    let failLoads = true;
    await page.route(isMarkdownFileRoute, async (route) => {
      if (failLoads && route.request().method() === "GET") {
        await route.abort();
        return;
      }
      await route.fallback();
    });
    const filePath = writeProjectFile(
      projectDir,
      "start.md",
      "# Start\n\nLoaded after a retry.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(page.getByTestId("startup-error-message")).toContainText(
      "Could not load start.md: The Roughdraft server did not answer (GET /api/markdown-file)",
    );
    await expect(page.getByTestId("startup-error-retry")).toBeVisible();

    failLoads = false;
    // The automatic retry may win the race with the click; either recovers.
    await page
      .getByTestId("startup-error-retry")
      .click({ timeout: 1_000 })
      .catch(() => undefined);
    await expect(codeEditor(page)).toContainText("Loaded after a retry.");
  });
});
