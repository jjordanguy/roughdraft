// The global section (batch 4): the agent's round note is an AI card that
// takes replies and Resolve, resolved global threads fold into one row with
// Reopen, the section order puts an open draft first and then newest first,
// and a draft that has nowhere to go (an older file with no review block)
// is refused with a message instead of being dropped on save.
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCriticComment } from "../src/critic-markup";
import { getGlobalThreadRoots } from "../src/DocumentReviewRail";
import { PageCard } from "../src/PageCard";
import type { StorageBackend } from "../src/storage";

const fixturesDir = path.resolve(process.cwd(), "../../docs/spec/fixtures");

function fixture(name: string) {
  return fs.readFileSync(path.join(fixturesDir, `${name}.md`), "utf8");
}

function rect(top = 0, height = 24, width = 120) {
  return {
    x: 0,
    y: top,
    left: 0,
    top,
    width,
    height,
    right: width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

function createBackend(): StorageBackend {
  return {
    info: { kind: "local-storage", label: "Test backend", detail: "In-memory" },
    canManageProjects: false,
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
    },
    async saveMarkdownFile() {
      return undefined;
    },
    async saveAsset(file) {
      return {
        markdownPath: file.name,
        previewUrl: `file://${file.name}`,
        mimeType: file.type || "application/octet-stream",
      };
    },
    resolveFileUrl(filePath) {
      return `file://${filePath}`;
    },
    async openProject() {},
  } as StorageBackend;
}

function byTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

async function saveAfterDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(600);
    await Promise.resolve();
  });
}

const cleanups: Array<() => Promise<void>> = [];

async function renderDocument(
  content: string,
  {
    globalCommentRequest = null,
  }: { globalCommentRequest?: number | null } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn().mockResolvedValue(undefined);
  const render = async (request: number | null) => {
    await act(async () => {
      root.render(
        <PageCard
          page={{ id: "doc", title: "doc", content }}
          selected
          onSave={onSave}
          backend={createBackend()}
          globalCommentRequest={request}
        />,
      );
      await Promise.resolve();
    });
    await flush();
  };
  await render(globalCommentRequest);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onSave, render };
}

function section(container: HTMLElement) {
  const element = byTestId(container, "global-comments-section");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

describe("global section", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 24),
    );
    if (!("ResizeObserver" in globalThis)) {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      });
    }
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    for (const prototype of [Range.prototype, Text.prototype]) {
      Object.defineProperty(prototype, "getClientRects", {
        configurable: true,
        value: () => [rect(0, 20, 80)],
      });
    }
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(0, 20, 80),
    });
    window.scrollBy = vi.fn();
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the agent's round note as an AI card that takes a reply and Resolve", async () => {
    const { container, onSave } = await renderDocument(
      fixture("canonical-document-comments"),
    );

    const note = byTestId(section(container), "global-comment-thread-a2");
    expect(note?.dataset.author).toBe("ai");
    expect(note?.textContent).toContain("AI");
    expect(note?.textContent).toContain("Round 1 done: 2 comments answered.");
    expect(
      byTestId(section(container), "global-comment-thread-c2")?.dataset.author,
    ).toBe("user");

    await click(note);
    expect(
      byTestId(note as HTMLElement, "comment-rail-a2-action-reply"),
    ).not.toBeNull();
    vi.useFakeTimers();
    await click(
      byTestId(note as HTMLElement, "comment-rail-a2-action-resolve"),
    );
    await saveAfterDebounce();

    const saved = onSave.mock.calls.at(-1)?.[1] as string;
    expect(saved).toMatch(
      / {2}a2:\n {4}body: "Round 1 done: 2 comments answered\."\n {4}by: AI\n {4}at: "2026-10-05T10:01:00\.000Z"\n {4}status: resolved\n {4}scope: document\n/,
    );
    // Folded into the section's resolved row.
    expect(byTestId(section(container), "global-comment-thread-a2")).toBeNull();
    expect(
      byTestId(section(container), "global-comments-resolved-toggle")
        ?.textContent,
    ).toBe("1 resolved");
  });

  it("resolves a global comment into the folded row and reopens it from there", async () => {
    const { container, onSave } = await renderDocument(
      fixture("canonical-document-comments"),
    );
    expect(
      byTestId(section(container), "global-comments-resolved-toggle"),
    ).toBeNull();

    const thread = byTestId(section(container), "global-comment-thread-c2");
    await click(thread);
    vi.useFakeTimers();
    await click(
      byTestId(thread as HTMLElement, "comment-rail-c2-action-resolve"),
    );
    await saveAfterDebounce();
    expect(onSave.mock.calls.at(-1)?.[1]).toMatch(
      / {2}c2:\n(?: {4}.*\n)*? {4}status: resolved\n/,
    );

    const toggle = byTestId(
      section(container),
      "global-comments-resolved-toggle",
    );
    expect(toggle?.textContent).toBe("1 resolved");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(byTestId(container, "resolved-comment-thread-c2")).toBeNull();

    await click(toggle);
    const resolved = byTestId(container, "resolved-comment-thread-c2");
    expect(resolved?.textContent).toContain("Overall this reads well.");
    expect(resolved?.className).toContain("opacity-70");
    await click(resolved);
    await click(byTestId(container, "comment-rail-c2-action-reopen"));
    await saveAfterDebounce();

    expect(onSave.mock.calls.at(-1)?.[1]).not.toMatch(
      / {2}c2:\n(?: {4}.*\n)*? {4}status: resolved\n/,
    );
    expect(
      byTestId(section(container), "global-comment-thread-c2"),
    ).not.toBeNull();
    expect(
      byTestId(section(container), "global-comments-resolved-toggle"),
    ).toBeNull();
  });

  it("refuses a global comment on an older file with no review block, with a message", async () => {
    const { container, onSave } = await renderDocument(
      fixture("legacy-multiline-span"),
      { globalCommentRequest: 1 },
    );

    expect(
      byTestId(container, "review-format-global-comment-message")?.textContent,
    ).toContain("Global comments need the current review format.");
    expect(byTestId(container, "global-comments-section")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("opens the draft card at the top with the placeholder, and an empty draft is never written", async () => {
    const { container, onSave } = await renderDocument(
      fixture("canonical-document-comments"),
      { globalCommentRequest: 1 },
    );

    const cards = [
      ...section(container).querySelectorAll<HTMLElement>(
        '[data-testid^="global-comment-thread-"]',
      ),
    ].map((card) => card.dataset.testid);
    expect(cards).toEqual([
      "global-comment-thread-c3",
      "global-comment-thread-a2",
      "global-comment-thread-c2",
    ]);
    expect(
      byTestId<HTMLTextAreaElement>(
        section(container),
        "comment-rail-c3-editor",
      )?.placeholder,
    ).toBe("Comment on the whole document");
    // The open count counts saved threads only.
    expect(
      byTestId(section(container), "global-comments-open-count")?.textContent,
    ).toBe("2");

    // An unrelated change saves the file; the empty draft is not in it.
    const thread = byTestId(section(container), "global-comment-thread-c2");
    await click(thread);
    vi.useFakeTimers();
    await click(
      byTestId(thread as HTMLElement, "comment-rail-c2-action-resolve"),
    );
    await saveAfterDebounce();
    const saved = onSave.mock.calls.at(-1)?.[1] as string;
    expect(saved).toContain("status: resolved");
    expect(saved).not.toContain("c3:");
  });
});

describe("getGlobalThreadRoots", () => {
  const at = (minute: number) =>
    `2026-10-05T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const comments = new Map(
    [
      createCriticComment({
        id: "c1",
        content: "Oldest note.",
        createdAt: at(1),
        scope: "document",
      }),
      createCriticComment({
        id: "c2",
        content: "On the code.",
        createdAt: at(2),
        scope: "code",
        codeLines: [1, 2],
        quote: "a\nb",
      }),
      createCriticComment({
        id: "c3",
        content: "Resolved note.",
        createdAt: at(3),
        scope: "document",
        status: "resolved",
      }),
      createCriticComment({
        id: "c4",
        content: "Inline.",
        createdAt: at(4),
        scope: "inline",
      }),
      createCriticComment({
        id: "a1",
        content: "Reply.",
        createdAt: at(5),
        authorType: "ai",
        parentCommentId: "c1",
      }),
      createCriticComment({
        id: "a2",
        content: "Round note.",
        createdAt: at(6),
        authorType: "ai",
        scope: "document",
      }),
      createCriticComment({
        id: "c5",
        content: "",
        createdAt: at(0),
        scope: "document",
      }),
    ].map((comment) => [comment.id, comment]),
  );

  it("lists an open draft first, then open roots newest first, with code comments and without replies", () => {
    const roots = getGlobalThreadRoots(comments, ["c5"]);
    expect(roots.open.map((root) => root.id)).toEqual(["c5", "a2", "c2", "c1"]);
    expect(roots.resolved.map((root) => root.id)).toEqual(["c3"]);
  });
});
