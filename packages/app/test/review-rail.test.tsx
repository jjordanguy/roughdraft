// The rail reads threads from the comment map: replies stored in the review
// block show nested, a comment over several blocks is one card, document
// comments sit in the global section, resolved threads fold, comments on code
// highlight their lines, and a review block that cannot be read blocks the
// editor instead of being rewritten.
import fs from "node:fs";
import path from "node:path";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCriticComment } from "../src/critic-markup";
import { DocumentReviewRail } from "../src/DocumentReviewRail";
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

function allByTestId(container: ParentNode, testId: string) {
  return [...container.querySelectorAll(`[data-testid="${testId}"]`)];
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
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

const cleanups: Array<() => Promise<void>> = [];

async function renderDocument(content: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn().mockResolvedValue(undefined);
  let editor: Editor | null = null;

  await act(async () => {
    root.render(
      <PageCard
        page={{ id: "doc", title: "doc", content }}
        selected
        onSave={onSave}
        backend={createBackend()}
        onEditorReady={(next) => {
          editor = next;
        }}
      />,
    );
    await Promise.resolve();
  });
  await flush();
  await nextFrame();
  await flush();

  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  return {
    container,
    onSave,
    getEditor() {
      expect(editor).not.toBeNull();
      return editor as unknown as Editor;
    },
  };
}

function rail(container: HTMLElement) {
  const element = byTestId(container, "document-review-rail");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

describe("review rail from the comment map", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // Anchors measure lower the later they come in the document.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.classList.contains("ProseMirror")) return rect(0, 600, 640);
        if (this.classList.contains("comment-anchor")) {
          const all = [
            ...document.querySelectorAll(".comment-anchor[data-comment-ids]"),
          ];
          return rect(40 + all.indexOf(this) * 60, 20, 80);
        }
        return rect(0, 24);
      },
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

  it("nests a reply stored in the review block under its anchored comment", async () => {
    const { container } = await renderDocument(
      fixture("repro-control-compact-single"),
    );

    const thread = byTestId(rail(container), "comment-thread-c1");
    expect(thread?.textContent).toContain(
      "These two paragraphs contradict the timeline doc.",
    );
    expect(
      byTestId(thread as HTMLElement, "comment-rail-c2")?.textContent,
    ).toContain("Reconciled both sections with the timeline doc");
    expect(allByTestId(container, "comment-thread-c2")).toHaveLength(0);
  });

  it("shows a comment over several blocks as one card and highlights every anchor", async () => {
    const { container, getEditor } = await renderDocument(
      fixture("canonical-continuation"),
    );

    expect(allByTestId(rail(container), "comment-thread-c1")).toHaveLength(1);
    const thread = byTestId(rail(container), "comment-thread-c1");
    expect(thread?.textContent).toContain("Split these checks by owner");
    expect(thread?.textContent).toContain("Split into creator and ops checks.");

    const anchors = [
      ...getEditor().view.dom.querySelectorAll<HTMLElement>(
        '.comment-anchor[data-comment-ids="[\\"c1\\"]"]',
      ),
    ].map((anchor) => anchor.textContent);
    expect(anchors).toEqual([
      "Pre-flight",
      "The creator confirms the caption with ops before scheduling.",
      "Caption matches the approved copy deck",
    ]);

    await click(
      getEditor().view.dom.querySelector(".comment-anchor[data-comment-ids]"),
    );
    const active = [
      ...getEditor().view.dom.querySelectorAll(
        '[data-testid="comment-decoration"]',
      ),
    ].filter((element) =>
      element.classList.contains("comment-decoration-active"),
    );
    expect(active.map((element) => element.textContent)).toEqual(anchors);
  });

  it("puts document comments in the global section, newest first, with replies nested", async () => {
    const { container } = await renderDocument(
      fixture("canonical-document-comments"),
    );

    const section = byTestId(rail(container), "global-comments-section");
    expect(section?.textContent).toContain("Global comments");
    const threads = [
      ...(section?.querySelectorAll<HTMLElement>(
        '[data-testid^="global-comment-thread-"]',
      ) ?? []),
    ];
    expect(threads.map((thread) => thread.dataset.testid)).toEqual([
      "global-comment-thread-a2",
      "global-comment-thread-c2",
    ]);
    // `<br>` in a body is a line break.
    expect(threads[1]?.textContent).toContain(
      "Overall this reads well.\n\nTwo things before Friday:\n- shorten the intro",
    );
    expect(
      byTestId(threads[1] as HTMLElement, "comment-rail-a1")?.textContent,
    ).toContain("Shortened the intro and added the table.");
  });

  it("folds resolved threads into one row and reopens one", async () => {
    const { container, onSave } = await renderDocument(
      fixture("canonical-document-comments"),
    );

    // `c1` is resolved: no card at its anchor, one "1 resolved" row instead.
    expect(byTestId(rail(container), "comment-thread-c1")).toBeNull();
    const toggle = byTestId(rail(container), "comment-threads-resolved-toggle");
    expect(toggle?.textContent).toBe("1 resolved");
    expect(byTestId(container, "resolved-comment-thread-c1")).toBeNull();

    await click(toggle);
    const resolved = byTestId(container, "resolved-comment-thread-c1");
    expect(resolved?.textContent).toContain("Needs a source.");
    expect(resolved?.textContent).toContain("Resolved: Added the citation.");

    await click(resolved);
    vi.useFakeTimers();
    await click(byTestId(container, "comment-rail-c1-action-reopen"));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const saved = onSave.mock.calls.at(-1)?.[1] as string;
    expect(saved).toContain("Keep {==this claim==}{#c1} as written.");
    expect(saved).not.toContain("status: resolved");
    expect(saved).not.toContain("Added the citation.");
    expect(byTestId(rail(container), "comment-thread-c1")).not.toBeNull();
  });

  it("folds resolved global comments at the bottom of the global section", async () => {
    const { container } = await renderDocument(
      [
        "Body text.",
        "",
        "---",
        "comments:",
        "  c1:",
        '    body: "Open note."',
        "    by: user",
        '    at: "2026-10-05T09:00:00.000Z"',
        "  c2:",
        '    body: "Done note."',
        "    by: user",
        '    at: "2026-10-05T09:01:00.000Z"',
        "    status: resolved",
        "",
      ].join("\n"),
    );

    const section = byTestId(rail(container), "global-comments-section");
    expect(
      byTestId(section as HTMLElement, "global-comment-thread-c1"),
    ).not.toBeNull();
    expect(
      byTestId(section as HTMLElement, "global-comment-thread-c2"),
    ).toBeNull();
    const toggle = byTestId(
      section as HTMLElement,
      "global-comments-resolved-toggle",
    );
    expect(toggle?.textContent).toBe("1 resolved");
    await click(toggle);
    expect(
      byTestId(section as HTMLElement, "resolved-comment-thread-c2")
        ?.textContent,
    ).toContain("Done note.");
  });

  it("highlights the commented lines of a code block and shows the card", async () => {
    const { container, getEditor } = await renderDocument(
      fixture("canonical-code-block"),
    );

    const c1 = getEditor().view.dom.querySelector(
      '[data-testid="comment-code-anchor-c1"]',
    );
    expect(c1?.textContent).toBe("const port = 3000;\nstart({ port });");
    expect(c1?.classList.contains("comment-anchor")).toBe(true);
    const c3 = getEditor().view.dom.querySelector(
      '[data-testid="comment-code-anchor-c3"]',
    );
    expect(c3?.textContent).toBe('import { start } from "./server";');

    // Code comments live in the global section (D10), not at their lines.
    const section = byTestId(
      rail(container),
      "global-comments-section",
    ) as HTMLElement;
    const thread = byTestId(section, "global-comment-thread-c1");
    expect(thread?.textContent).toContain(
      "Read the port from the environment instead.",
    );
    expect(thread?.textContent).toContain("Changed both.");
    expect(byTestId(section, "global-comment-thread-c3")).not.toBeNull();
    expect(byTestId(rail(container), "comment-thread-c1")).toBeNull();
    expect(byTestId(rail(container), "comment-thread-c3")).toBeNull();
    // The prose comment stays at its anchor.
    expect(byTestId(rail(container), "comment-thread-c2")).not.toBeNull();
    // The code itself carries no review markup.
    expect(getEditor().getText()).not.toContain("{#");
  });

  it("shows a code comment's quoted lines in a small code block and highlights them when selected", async () => {
    const { container, getEditor } = await renderDocument(
      fixture("canonical-code-block"),
    );
    const thread = byTestId(rail(container), "global-comment-thread-c1");
    const quote = byTestId(thread as HTMLElement, "comment-code-quote-c1");
    expect(
      byTestId(quote as HTMLElement, "comment-code-lines-c1")?.textContent,
    ).toBe("Lines 3\u20134");
    expect(
      byTestId(quote as HTMLElement, "comment-code-quote-text-c1")?.textContent,
    ).toBe("const port = 3000;\nstart({ port });");
    expect(
      byTestId(
        byTestId(rail(container), "global-comment-thread-c3") as HTMLElement,
        "comment-code-lines-c3",
      )?.textContent,
    ).toBe("Line 1");

    const anchor = () =>
      getEditor().view.dom.querySelector(
        '[data-testid="comment-code-anchor-c1"]',
      );
    expect(anchor()?.classList.contains("comment-decoration-active")).toBe(
      false,
    );
    await click(thread);
    expect(anchor()?.classList.contains("comment-decoration-active")).toBe(
      true,
    );
  });

  it("blocks a file whose review block cannot be read and never saves it", async () => {
    const content = fixture("probe-R02-duplicate-endmatter-key");
    const { container, onSave, getEditor } = await renderDocument(content);

    const notice = byTestId(container, "review-block-error-notice");
    expect(
      byTestId(notice as HTMLElement, "review-block-error-message")
        ?.textContent,
    ).toBe(
      "The review block at the end of this file could not be read: line 13: duplicate key c2",
    );
    expect(
      byTestId(container, "review-block-error-action-reload"),
    ).not.toBeNull();

    const editor = getEditor();
    expect(editor.isEditable).toBe(false);
    expect(editor.getText()).toContain("Keep this.");
    expect(editor.getText()).not.toContain("comments:");

    vi.useFakeTimers();
    await act(async () => {
      editor.setEditable(true);
      editor.commands.insertContentAt(1, "Edited ");
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the global section in the narrow-screen fallback", async () => {
    const { container } = await renderDocument(
      fixture("canonical-document-comments"),
    );

    const fallback = byTestId(container, "global-comments-fallback");
    expect(
      byTestId(fallback as HTMLElement, "global-comment-thread-c2")
        ?.textContent,
    ).toContain("Shortened the intro and added the table.");
  });

  it("replies to a global comment from the rail into the review block", async () => {
    const { container, onSave } = await renderDocument(
      fixture("canonical-document-comments"),
    );

    const thread = byTestId(rail(container), "global-comment-thread-a2");
    await click(thread);
    await click(
      byTestId(thread as HTMLElement, "comment-rail-a2-action-reply"),
    );

    const editor = byTestId<HTMLTextAreaElement>(
      container,
      "comment-rail-c3-editor",
    );
    expect(editor).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(editor, "Thanks for the summary.");
      editor?.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    vi.useFakeTimers();
    await click(byTestId(container, "comment-rail-c3-action-save"));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const saved = onSave.mock.calls.at(-1)?.[1] as string;
    expect(saved).toMatch(
      / {2}c3:\n {4}body: "Thanks for the summary\."\n {4}by: user\n {4}at: "[^"\n]+"\n {4}re: a2\n/,
    );
    expect(saved.split("\n---\n")[0]).not.toContain("Thanks for the summary.");
  });
});

describe("DocumentReviewRail", () => {
  it("renders global threads with no anchor groups", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const comments = new Map(
      [
        createCriticComment({
          id: "c1",
          content: "Overall: tighten the intro.",
          createdAt: "2026-10-05T09:00:00.000Z",
          scope: "document",
        }),
        createCriticComment({
          id: "a1",
          content: "Done.",
          createdAt: "2026-10-05T10:00:00.000Z",
          authorType: "ai",
          parentCommentId: "c1",
          scope: "document",
        }),
      ].map((comment) => [comment.id, comment]),
    );

    act(() => {
      root.render(
        <DocumentReviewRail
          commentGroups={[]}
          comments={comments}
          suggestions={[]}
          selectedCommentId={null}
          hoveredCommentId={null}
          selectedChangeId={null}
          hoveredChangeId={null}
          contentHeight={0}
          testId="rail"
          onDeleteComment={() => {}}
          onUpdateComment={() => {}}
          onReplyComment={() => {}}
          onSelectComment={() => {}}
          onFocusComment={() => {}}
          onHoverComment={() => {}}
          onAcceptSuggestion={() => {}}
          onRejectSuggestion={() => {}}
          onReplySuggestion={() => {}}
          onSelectSuggestion={() => {}}
          onFocusSuggestion={() => {}}
          onHoverSuggestion={() => {}}
        />,
      );
    });

    const railElement = byTestId(container, "rail");
    expect(railElement?.getAttribute("aria-hidden")).toBeNull();
    const thread = byTestId(container, "global-comment-thread-c1");
    expect(thread?.textContent).toContain("Overall: tighten the intro.");
    expect(
      byTestId(thread as HTMLElement, "comment-rail-a1")?.textContent,
    ).toContain("Done.");

    act(() => root.unmount());
    container.remove();
  });
});
