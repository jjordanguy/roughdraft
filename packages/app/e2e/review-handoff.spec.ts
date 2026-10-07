import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  apiBaseUrl,
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("review handoff", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-handoff");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("persists an overall handoff comment from the primary done button to YAML endmatter @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "handoff-comment.md",
      ["# Handoff Comment", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "handoff-comment.md";
    const overallComment = "Please prioritize the CLI contract.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.getByTestId("review-handoff-button").click();

    // A legacy long-poll watcher acknowledges the Done as soon as it returns,
    // so the status may already read "picked up" by the time it is checked.
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      /Your agent (is now working|picked this up)/,
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(
        /---\ncomments:\n {2}c1:\n {4}body: Please prioritize the CLI contract\.\n {4}by: user\n {4}at: [^\n]+\n?$/,
      );

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      overallComment,
      summary: {
        comments: 1,
      },
    });
  });

  test("reopens the sent handoff status from the muted primary button", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "sent-handoff.md",
      ["# Sent Handoff", "", "Review already completed.", ""].join("\n"),
    );
    const relativePath = "sent-handoff.md";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      /^(Sent|Picked up)$/,
    );
    await expect(page.getByTestId("review-handoff-status")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-handoff-status")).toBeHidden();

    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toBeVisible();
    logE2eEvent("review-handoff.sent-button-reopened-status", {
      buttonLabel: await page.getByTestId("review-handoff-button").innerText(),
    });

    await pendingWatch;
  });

  test("an edit after Done returns the button to the ready state", async ({
    page,
  }) => {
    // Runs against either server: with no watcher the old server answers
    // "not sent" and the batch 1 server answers "saved for your agent". In
    // both cases an edit starts a new round.
    const filePath = writeProjectFile(
      projectDir,
      "edit-after-done.md",
      ["# Edit After Done", "", "Body.", ""].join("\n"),
    );

    await openMarkdownFile(page, filePath, "code");
    const button = page.getByTestId("review-handoff-button");
    await expect(button).toHaveText("Approve");

    await button.click();
    await expect(button).not.toHaveText(/Approve|Sending/);
    await page.keyboard.press("Escape");

    await appendInCodeEditor(page, "\nOne more line.\n");

    await expect(button).toHaveText("I'm done");
    await expect(
      page.getByTestId("review-handoff-split-button"),
    ).toHaveAttribute("data-handoff-state", "ready-no-agent");
  });

  test("a save conflict disables Done and the tooltip names the reason", async ({
    page,
  }) => {
    await page.route("**/api/markdown-file/events**", (route) => route.abort());
    const filePath = writeProjectFile(
      projectDir,
      "blocked.md",
      "# Blocked\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Blocked\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");

    const button = page.getByTestId("review-handoff-button");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByTestId("review-handoff-split-button"),
    ).toHaveAttribute("data-handoff-state", "blocked");

    await button.hover();
    await expect(page.getByTestId("review-handoff-tooltip")).toHaveText(
      "Save conflict. Resolve it before you finish.",
    );
  });

  // The tests below need the batch 1 server (handoff log, includePending,
  // ack route, idempotent handoffId). Run them once it lands:
  //   pnpm test:e2e --grep @batch1-server
  test("Done with no watcher shows Saved for your agent with Copy @batch1-server", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "no-watcher.md",
      ["# No Watcher", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "no-watcher.md";

    await openMarkdownFile(page, filePath);
    const splitButton = page.getByTestId("review-handoff-split-button");
    await expect(splitButton).toHaveAttribute("data-watcher-state", "none");

    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Done, waiting",
    );
    const status = page.getByTestId("review-handoff-status");
    await expect(status).toContainText("Saved for your agent");
    await expect(page.getByTestId("review-handoff-copy-message")).toBeVisible();
    await expect(page.getByTestId("review-handoff-wake-status")).toBeVisible();

    // T4.7: a later watch with includePending returns the Done at once, and
    // after the agent acknowledges it the tab says it was picked up.
    const watchResponse = await request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        includePending: true,
        timeoutSeconds: 5,
      },
    });
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.handoffs).toHaveLength(1);
    const handoffId = payload.handoffs[0].handoffId as string;

    const ackResponse = await request.post("/api/review-events/ack", {
      data: { handoffId, by: "e2e" },
    });
    expect(ackResponse.ok()).toBe(true);

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Picked up",
    );
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent picked this up at",
    );
  });

  test("a watch aborted by the test leaves the button in the no-agent ready state within 3 s and Done records pending instead of Sent @batch1-server", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "aborted-watch.md",
      ["# Aborted Watch", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "aborted-watch.md";

    await openMarkdownFile(page, filePath);
    const splitButton = page.getByTestId("review-handoff-split-button");

    const controller = new AbortController();
    const watch = fetch(`${apiBaseUrl()}/api/review-events/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 60,
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    pendingWatch = watch;

    await expect(splitButton).toHaveAttribute(
      "data-watcher-state",
      "listening",
    );

    controller.abort();

    await expect(splitButton).toHaveAttribute("data-watcher-state", "none", {
      timeout: 3_000,
    });
    await expect(splitButton).toHaveAttribute(
      "data-handoff-state",
      "ready-no-agent",
    );

    const doneResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/review-events") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("review-handoff-button").click();
    const body = await (await doneResponse).json();
    expect(body).toMatchObject({ delivered: false, pending: true });

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Done, waiting",
    );
    await expect(page.getByTestId("review-handoff-button")).not.toHaveText(
      "Sent",
    );
  });

  test("Done with an overall comment and no watcher, then a second Done, leaves one comment in the file @batch1-server", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "one-comment.md",
      ["# One Comment", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "one-comment.md";
    const overallComment = "Please tighten the intro.";

    await openMarkdownFile(page, filePath, "code");
    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Done, waiting",
    );
    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toContain(`body: ${overallComment}`);
    // Wait until the tab has loaded the server's write, so the edit below
    // does not race it into a "changed on disk" conflict.
    await expect(codeEditor(page)).toContainText(overallComment);
    await page.keyboard.press("Escape");

    // An edit returns the button to ready; the overall comment field must be
    // empty, so the second Done cannot repeat the comment.
    await appendInCodeEditor(page, "\nSecond round.\n");
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "I'm done",
    );
    await page.getByTestId("review-handoff-comment-trigger").click();
    await expect(
      page.getByTestId("review-handoff-overall-comment"),
    ).toHaveValue("");
    await page.keyboard.press("Escape");
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Done, waiting",
    );

    const finalContent = readProjectFile(projectDir, relativePath);
    expect(finalContent.split(`body: ${overallComment}`)).toHaveLength(2);
  });
});
