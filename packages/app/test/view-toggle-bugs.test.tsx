import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocationForDocumentEditorViewMode,
  type DocumentEditorViewMode,
  getDocumentEditorViewModeFromLocation,
} from "../src/app-navigation";
import {
  DocumentSaveStatusIndicator,
  DocumentWorkspace,
  shouldLatchDocumentChangedSinceOpen,
} from "../src/DocumentWorkspace";
import type { DocumentSaveState } from "../src/PageCard";
import type {
  BackendInfo,
  CompleteReviewOptions,
  CompleteReviewResult,
  HandoffRecord,
  Page,
  ReviewWatchStatus,
  StorageBackend,
} from "../src/storage";

function createBackend({
  watcherCount,
  kind = "local-storage",
  status = {},
}: {
  watcherCount?: number;
  kind?: BackendInfo["kind"];
  status?: Partial<ReviewWatchStatus>;
} = {}): StorageBackend {
  const backend: StorageBackend = {
    info: {
      kind,
      label: "Test backend",
      detail: "In-memory",
    },
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
    resolveFileUrl(path) {
      return `file://${path}`;
    },
    async openProject() {},
  };

  if (watcherCount !== undefined) {
    backend.getReviewWatchStatus = async () => ({
      watching: watcherCount > 0,
      watcherCount,
      ...status,
    });
  }

  return backend;
}

function createPage(content = "Hello world"): Page {
  return {
    id: "test-doc",
    title: "Test Doc",
    content,
  };
}

function setupDomMocks() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 640,
    height: 480,
    right: 640,
    bottom: 480,
    toJSON() {
      return this;
    },
  } as DOMRect);

  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
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

  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 80,
        height: 20,
        right: 80,
        bottom: 20,
        toJSON() {
          return this;
        },
      } as DOMRect;
    },
  });

  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [
        {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 20,
          right: 80,
          bottom: 20,
          toJSON() {
            return this;
          },
        } as DOMRect,
      ];
    },
  });

  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [this.getBoundingClientRect()];
    },
  });

  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [
        {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 20,
          right: 80,
          bottom: 20,
          toJSON() {
            return this;
          },
        } as DOMRect,
      ];
    },
  });

  window.scrollBy = vi.fn();
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function change(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function queryByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  const element = queryByTestId<T>(container, testId);
  expect(element).not.toBeNull();
  return element as T;
}

describe("view mode toggle uses client-side state (issue 1 fix)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("buildLocationForDocumentEditorViewMode produces a URL for history.replaceState", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=/test/doc.md&editor=rich-text",
    );

    const nextLocation = buildLocationForDocumentEditorViewMode("code");

    expect(nextLocation).toContain("editor=code");
    expect(typeof nextLocation).toBe("string");
  });

  it("view mode can be read from the URL query param", () => {
    window.history.replaceState(null, "", "/?editor=rich-text");
    expect(getDocumentEditorViewModeFromLocation("rich-text")).toBe(
      "rich-text",
    );

    window.history.replaceState(null, "", "/?editor=code");
    expect(getDocumentEditorViewModeFromLocation("rich-text")).toBe("code");
  });

  it("buildLocationForDocumentEditorViewMode returns the expected path+search", () => {
    window.history.replaceState(null, "", "/doc.md?editor=rich-text");

    const result = buildLocationForDocumentEditorViewMode("code");

    expect(result).toBe("/doc.md?editor=code");
  });
});

describe("saving/saved status indicator (issue 2 fix)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderSaveStatus({
    saveState = "saved",
    documentDiskChangeState = "clean",
  }: {
    saveState?: DocumentSaveState;
    documentDiskChangeState?: "clean" | "changed" | "conflict" | "paused";
  } = {}) {
    await act(async () => {
      root.render(
        <DocumentSaveStatusIndicator
          saveState={saveState}
          diskChangeState={documentDiskChangeState}
        />,
      );
      await Promise.resolve();
    });
  }

  async function renderWorkspace({
    documentDiskChangeState = "clean",
    documentContent = "Hello world",
    documentCopyPath = "test.md",
    watcherCount = 0,
    backendKind = "local-storage",
    onSaveDocument = async () => {},
  }: {
    documentDiskChangeState?: "clean" | "changed" | "conflict" | "paused";
    documentContent?: string;
    documentCopyPath?: string | null;
    watcherCount?: number;
    backendKind?: BackendInfo["kind"];
    onSaveDocument?: (id: string, content: string) => Promise<void>;
  } = {}) {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage(documentContent)}
          activeDocumentPath="test.md"
          documentCopyPath={documentCopyPath}
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          onSaveDocument={onSaveDocument}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState={documentDiskChangeState}
          documentForceResetKey={null}
          onReloadDocumentFromDisk={() => {}}
          onKeepEditingWithoutAutosave={() => {}}
          onOverwriteDocumentOnDisk={() => {}}
          onCompleteReview={async () => ({ delivered: false })}
          backend={createBackend({ watcherCount, kind: backendKind })}
        />,
      );
      await Promise.resolve();
    });
  }

  async function openFileMenu() {
    await click(getByTestId(container, "document-file-menu-trigger"));
    return getByTestId(document.body, "document-file-menu");
  }

  it.each([
    ["saved", "Saved", "document-save-status-saved"],
    ["saving", "Saving", "animate-spin"],
    ["unsaved", "Unsaved changes", "animate-spin"],
    ["error", "Save failed", ""],
  ] satisfies Array<
    [DocumentSaveState, string, string]
  >)("shows icon-only %s save status", async (saveState, label, iconClass) => {
    await renderSaveStatus({ saveState });

    const status = getByTestId(container, "document-save-status");
    expect(status.getAttribute("aria-label")).toBe(label);
    expect(status.textContent).toBe("");
    const icon = getByTestId(status, "document-save-status-icon");
    if (iconClass) {
      expect(icon.classList.contains(iconClass)).toBe(true);
    }
  });

  it.each([
    ["changed", "File changed on disk"],
    ["conflict", "Save conflict"],
    ["paused", "Autosave paused"],
  ] as const)("shows disk-blocked %s save status", async (state, label) => {
    await renderSaveStatus({ documentDiskChangeState: state });

    const status = getByTestId(container, "document-save-status");
    expect(status.getAttribute("aria-label")).toBe(label);
    expect(status.textContent).toBe("");
    expect(getByTestId(status, "document-save-status-icon")).not.toBeNull();
  });

  it("renders save status in the fixed corner when handoff exists", async () => {
    await renderWorkspace({ watcherCount: 1, backendKind: "local-files" });

    const stack = queryByTestId(container, "document-status-stack");
    const header = getByTestId(container, "document-page-header");
    const corner = getByTestId(container, "document-save-status-corner");
    const doneReviewingButton = queryByTestId(
      container,
      "review-handoff-button",
    );
    expect(stack).not.toBeNull();
    expect(doneReviewingButton).toBeDefined();
    expect(doneReviewingButton?.textContent).toContain("Approve");
    expect(doneReviewingButton?.textContent).not.toContain("Saved");
    expect(stack?.textContent).not.toContain("Saved");
    expect(header.textContent).toContain("test.md");
    expect(header.textContent).not.toContain("Saved");
    expect(queryByTestId(header, "document-save-status")).toBeNull();
    expect(
      getByTestId(corner, "document-save-status").getAttribute("aria-label"),
    ).toBe("Saved");
  });

  it("renders save status in the fixed corner without handoff", async () => {
    await renderWorkspace();

    const stack = queryByTestId(container, "document-status-stack");
    const header = getByTestId(container, "document-page-header");
    const corner = getByTestId(container, "document-save-status-corner");
    expect(stack).not.toBeNull();
    expect(stack?.textContent).not.toContain("I'm done");
    expect(stack?.textContent).not.toContain("Saved");
    expect(header.textContent).toContain("test.md");
    expect(header.textContent).not.toContain("Saved");
    expect(queryByTestId(header, "document-save-status")).toBeNull();
    expect(
      getByTestId(corner, "document-save-status").getAttribute("aria-label"),
    ).toBe("Saved");
  });

  it.each([
    ["path", "/Users/me/project/test.md"],
    ["filename", "test.md"],
    ["markdown", "# Heading\n\nBody"],
  ] as const)("copies document %s from the file menu", async (action, text) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await renderWorkspace({
      documentContent: "# Heading\n\nBody",
      documentCopyPath: "/Users/me/project/test.md",
    });
    await openFileMenu();
    await click(getByTestId(document.body, `document-file-menu-${action}`));

    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("keeps the file menu open and shows temporary copied feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await renderWorkspace({ documentContent: "# Heading\n\nBody" });
    await openFileMenu();
    await click(getByTestId(document.body, "document-file-menu-path"));

    const menu = getByTestId(document.body, "document-file-menu");
    expect(menu.textContent).toContain("Copied!");
    expect(menu.textContent).not.toContain("Copy:");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(
      getByTestId(document.body, "document-file-menu").textContent,
    ).toContain("Path");
    vi.useRealTimers();
  });

  it("shows copy previews below each file menu action", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    await renderWorkspace({ documentContent: "# Heading\n\nBody" });
    await openFileMenu();

    const menu = getByTestId(document.body, "document-file-menu");
    expect(menu.textContent).toContain("Path");
    expect(menu.textContent).toContain("test.md");
    expect(menu.textContent).toContain("Filename");
    expect(menu.textContent).toContain("Markdown");
    expect(menu.textContent).toContain("# Heading Body");
    expect(menu.textContent).toContain("Rich text");
    const richTextAction = getByTestId(
      document.body,
      "document-file-menu-rich-text",
    );
    expect(richTextAction.textContent).toContain("Heading Body");
    expect(richTextAction.textContent).not.toContain("# Heading");
  });

  it("copies document rich text with html and plain markdown flavors", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const clipboardItems: Array<Record<string, Blob>> = [];
    class ClipboardItemMock {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
        clipboardItems.push(items);
      }
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });

    await renderWorkspace({ documentContent: "# Heading\n\nBody" });
    await openFileMenu();
    await click(getByTestId(document.body, "document-file-menu-rich-text"));

    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems[0]).toEqual({
      "text/html": expect.any(Blob),
      "text/plain": expect.any(Blob),
    });
    await expect(clipboardItems[0]["text/html"].text()).resolves.toContain(
      "<h1>Heading</h1>",
    );
    await expect(clipboardItems[0]["text/plain"].text()).resolves.toBe(
      "Heading\nBody",
    );
    expect(write).toHaveBeenCalledWith([
      expect.objectContaining({ items: expect.any(Object) }),
    ]);
  });

  it("strips comments and suggestions from copied rich text", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const clipboardItems: Array<Record<string, Blob>> = [];
    class ClipboardItemMock {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
        clipboardItems.push(items);
      }
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });

    await renderWorkspace({
      documentContent:
        'Keep {==the launch date==}{>>Verify this.<<}{#c1}, omit {++new claim++}{#s1}, keep {--old claim--}{#s2}, and use {~~rough~>polished~~}{#s3} wording.\n\n{>>Standalone note<<}{#c2}\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-04-28T12:00:00.000Z"\n  c2:\n    by: user\n    at: "2026-04-28T12:01:00.000Z"\nsuggestions:\n  s1:\n    by: AI\n    at: "2026-04-28T12:02:00.000Z"\n  s2:\n    by: AI\n    at: "2026-04-28T12:03:00.000Z"\n  s3:\n    by: AI\n    at: "2026-04-28T12:04:00.000Z"\n',
    });
    await openFileMenu();
    await click(getByTestId(document.body, "document-file-menu-rich-text"));

    const html = await clipboardItems[0]["text/html"].text();
    const plain = await clipboardItems[0]["text/plain"].text();

    expect(html).toContain("Keep the launch date");
    expect(html).toContain("old claim");
    expect(html).toContain("rough");
    expect(html).not.toContain("Verify this");
    expect(html).not.toContain("Standalone note");
    expect(html).not.toContain("new claim");
    expect(html).not.toContain("polished");
    expect(html).not.toContain("data-comment-ids");
    expect(html).not.toContain("data-critic-change-kind");
    expect(plain).toBe(
      "Keep the launch date, omit , keep old claim, and use rough wording.",
    );
  });

  it.each([
    ["Meta+S", { key: "s", metaKey: true }],
    ["Control+S", { key: "s", ctrlKey: true }],
  ])("prevents browser save on %s", async (_label, init) => {
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);
    await renderWorkspace({ onSaveDocument });

    const event = new KeyboardEvent("keydown", {
      ...init,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
  });

  it("prevents browser save even when disk conflict blocks persistence", async () => {
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);
    await renderWorkspace({
      documentDiskChangeState: "conflict",
      onSaveDocument,
    });

    const event = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onSaveDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save conflict");
  });

  it("shows conflict status without replacing the existing conflict banner", async () => {
    await renderWorkspace({ documentDiskChangeState: "conflict" });

    expect(container.textContent).toContain("Save conflict");
    expect(container.textContent).toContain("This file changed on disk");
    expect(
      getByTestId(container, "document-save-status").getAttribute("aria-label"),
    ).toBe("Save conflict");
  });

  it("ignores initial editor dirty signals before user input is possible", () => {
    expect(
      shouldLatchDocumentChangedSinceOpen({
        isDirty: true,
        documentChangeTrackingReady: false,
      }),
    ).toBe(false);
    expect(
      shouldLatchDocumentChangedSinceOpen({
        isDirty: true,
        documentChangeTrackingReady: true,
      }),
    ).toBe(true);
  });
});

describe("interaction mode preserved across view toggle (issue 3 fix)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("interaction mode is preserved when view mode changes without remount", async () => {
    // With the fix, view mode changes use React state (no page reload),
    // so the DocumentWorkspace component stays mounted and interaction
    // mode is preserved.

    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const renderWorkspace = async (viewMode: DocumentEditorViewMode) => {
      await act(async () => {
        root.render(
          <DocumentWorkspace
            documentPage={createPage()}
            activeDocumentPath="test.md"
            documentFilenameLabel="test.md"
            documentEditorViewMode={viewMode}
            onDocumentEditorViewModeChange={() => {}}
            onSaveDocument={async () => {}}
            onDocumentSaveStateChange={() => {}}
            onDocumentDirtyStateChange={() => {}}
            onDocumentLocalContentChange={() => {}}
            documentDiskChangeState="clean"
            documentForceResetKey={null}
            onReloadDocumentFromDisk={() => {}}
            onKeepEditingWithoutAutosave={() => {}}
            onOverwriteDocumentOnDisk={() => {}}
            onCompleteReview={async () => ({ delivered: false })}
            backend={createBackend()}
          />,
        );
      });
    };

    // Mount with rich-text -> mode is "Suggesting" by default
    await renderWorkspace("rich-text");
    expect(
      getByTestId(container, "document-mode-trigger").textContent,
    ).toContain("Suggesting");

    // Rerender with code view (same component instance, no remount) ->
    // mode stays "Suggesting" because the component is not destroyed.
    await renderWorkspace("code");
    expect(
      getByTestId(container, "document-mode-trigger").textContent,
    ).toContain("Suggesting");
  });
});

describe("review handoff watcher affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  async function renderWorkspace({
    getWatcherCount,
    getStatus = () => ({}),
    onCompleteReview = async () => ({ delivered: false, pending: true }),
    backendKind = "local-files",
    documentPage = createPage(),
  }: {
    getWatcherCount: () => number;
    getStatus?: () => Partial<ReviewWatchStatus>;
    onCompleteReview?: (
      options?: CompleteReviewOptions,
    ) => Promise<CompleteReviewResult>;
    backendKind?: BackendInfo["kind"];
    documentPage?: Page;
  }) {
    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={documentPage}
          activeDocumentPath="test.md"
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          onSaveDocument={async () => {}}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState="clean"
          documentForceResetKey={null}
          onReloadDocumentFromDisk={() => {}}
          onKeepEditingWithoutAutosave={() => {}}
          onOverwriteDocumentOnDisk={() => {}}
          onCompleteReview={onCompleteReview}
          backend={createBackend({
            watcherCount: getWatcherCount(),
            kind: backendKind,
            status: getStatus(),
          })}
        />,
      );
      await Promise.resolve();
    });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function handoffRecord(
    overrides: Partial<HandoffRecord> = {},
  ): HandoffRecord {
    return {
      sequence: 1,
      handoffId: "server-handoff",
      createdAt: "2026-10-05T15:42:00.000Z",
      version: "v2",
      summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
      overallComment: null,
      state: "pending",
      deliveredTo: [],
      ackedAt: null,
      ackedBy: null,
      wake: { routeId: null, state: "none", at: null, error: null },
      ...overrides,
    };
  }

  async function openOverallCommentPopover() {
    await click(getByTestId(container, "review-handoff-comment-trigger"));
    return getByTestId<HTMLTextAreaElement>(
      document.body,
      "review-handoff-overall-comment",
    );
  }

  it("does not show the Done button outside a local files document", async () => {
    await renderWorkspace({
      getWatcherCount: () => 1,
      backendKind: "local-storage",
    });

    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
  });

  it("shows the Done button with no watcher and says no agent is listening", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false, pending: true });

    await renderWorkspace({ getWatcherCount: () => 0, onCompleteReview });

    const doneButton = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(doneButton.textContent).toContain("Approve");
    expect(doneButton.disabled).toBe(false);
    expect(
      getByTestId(container, "review-handoff-split-button").getAttribute(
        "data-watcher-state",
      ),
    ).toBe("none");

    await openOverallCommentPopover();

    expect(
      getByTestId(document.body, "review-handoff-agent-status").textContent,
    ).toBe(
      "No agent is listening. Roughdraft keeps your Done until it checks in.",
    );
    expect(onCompleteReview).not.toHaveBeenCalled();
  });

  it("says the agent is waiting and names its session when one is registered", async () => {
    await renderWorkspace({
      getWatcherCount: () => 1,
      getStatus: () => ({
        session: {
          harness: "claude-code",
          label: "Plan review chat",
          link: null,
          sessionId: null,
          routeId: null,
          registeredAt: "2026-10-05T15:00:00.000Z",
        },
      }),
    });
    await settle();

    expect(
      getByTestId(container, "review-handoff-split-button").getAttribute(
        "data-watcher-state",
      ),
    ).toBe("listening");

    await openOverallCommentPopover();

    expect(
      getByTestId(document.body, "review-handoff-agent-status").textContent,
    ).toBe("Your agent is waiting");
    expect(
      getByTestId(document.body, "review-handoff-session-label").textContent,
    ).toBe("Opened by Plan review chat");
  });

  it("sends Done with a client handoff id", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(onCompleteReview).toHaveBeenCalledWith({
      handoffId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Sent");
  });

  it("shows the sending copy while Done is in flight", async () => {
    let resolveReview: (result: CompleteReviewResult) => void = () => {};
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReview = resolve;
          }),
      );

    await renderWorkspace({ getWatcherCount: () => 0, onCompleteReview });
    const textarea = await openOverallCommentPopover();
    await change(textarea, "Tighten the intro.");
    await click(getByTestId(document.body, "review-handoff-submit-comment"));

    const button = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(button.textContent).toContain("Sending");
    expect(button.disabled).toBe(true);
    const status = getByTestId(document.body, "review-handoff-status");
    expect(status.textContent).toContain("Sending your review");
    expect(queryByTestId(status, "review-handoff-robots-toy")).toBeNull();
    expect(status.textContent).not.toContain("Your agent is now working");

    await act(async () => {
      resolveReview({ delivered: false, pending: true });
      await Promise.resolve();
    });
  });

  it("shows Saved for your agent with a Copy message button when nobody is listening", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({
        delivered: false,
        pending: true,
        handoff: handoffRecord(),
        wake: handoffRecord().wake,
      });

    await renderWorkspace({ getWatcherCount: () => 0, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Done, waiting");
    const status = getByTestId(document.body, "review-handoff-status");
    expect(status.textContent).toContain("Saved for your agent");
    expect(getByTestId(status, "review-handoff-wake-status").textContent).toBe(
      "No wake route registered",
    );

    await click(getByTestId(status, "review-handoff-copy-message"));

    expect(writeText).toHaveBeenCalledWith(
      "I am done reviewing this file: test.md",
    );
  });

  it("moves to Picked up when the status poll reports the handoff acknowledged", async () => {
    let handoffId = "";
    let polledHandoff: HandoffRecord | null = null;
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockImplementation(async (options) => {
        handoffId = options?.handoffId ?? "";
        const record = handoffRecord({ handoffId });
        return {
          delivered: false,
          pending: true,
          handoff: record,
          wake: record.wake,
        };
      });

    await renderWorkspace({
      getWatcherCount: () => 0,
      getStatus: () => ({ handoff: polledHandoff }),
      onCompleteReview,
    });
    await click(getByTestId(container, "review-handoff-button"));

    polledHandoff = handoffRecord({
      handoffId,
      state: "acknowledged",
      ackedAt: "2026-10-05T15:45:00.000Z",
    });
    await renderWorkspace({
      getWatcherCount: () => 0,
      getStatus: () => ({ handoff: polledHandoff }),
      onCompleteReview,
    });
    await settle();

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Picked up");
    expect(
      getByTestId(document.body, "review-handoff-status").textContent,
    ).toContain("Your agent picked this up at");
  });

  it("ignores an acknowledged handoff that belongs to another Done", async () => {
    await renderWorkspace({
      getWatcherCount: () => 0,
      getStatus: () => ({
        handoff: handoffRecord({
          handoffId: "someone-else",
          state: "acknowledged",
          ackedAt: "2026-10-05T15:45:00.000Z",
        }),
      }),
      onCompleteReview: async (options) => ({
        delivered: false,
        pending: true,
        handoff: handoffRecord({ handoffId: options?.handoffId }),
      }),
    });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Done, waiting");
  });

  it("retries a failed Done with the same handoff id so the overall comment is written once", async () => {
    // A fake server that records the overall comment once per handoff id,
    // like the batch 1 server. The first answer is lost after the write.
    const writtenComments = new Map<string, string>();
    let calls = 0;
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockImplementation(async (options) => {
        calls += 1;
        const id = options?.handoffId ?? "";
        if (!writtenComments.has(id) && options?.overallComment) {
          writtenComments.set(id, options.overallComment);
        }
        if (calls === 1) throw new Error("connection reset");
        return { delivered: false, pending: true };
      });

    await renderWorkspace({ getWatcherCount: () => 0, onCompleteReview });
    const textarea = await openOverallCommentPopover();
    await change(textarea, "Tighten the intro.");
    await click(getByTestId(container, "review-handoff-button"));

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Not sent");
    const errorStatus = getByTestId(document.body, "review-handoff-status");
    expect(errorStatus.textContent).toContain(
      "Roughdraft could not record your Done. Your saved edits are on disk.",
    );
    expect(
      queryByTestId(errorStatus, "review-handoff-copy-message"),
    ).not.toBeNull();

    await click(getByTestId(errorStatus, "review-handoff-retry"));

    expect(onCompleteReview).toHaveBeenCalledTimes(2);
    const [first, second] = onCompleteReview.mock.calls.map(
      ([options]) => options,
    );
    expect(second?.handoffId).toBe(first?.handoffId);
    expect(second?.overallComment).toBe("Tighten the intro.");
    expect([...writtenComments.values()]).toEqual(["Tighten the intro."]);
    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Done, waiting");
  });

  it("clears the overall comment on a 2xx even when nobody received the Done", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false, pending: true });
    let watcherCount = 0;

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });
    const textarea = await openOverallCommentPopover();
    await change(textarea, "Tighten the intro.");
    await click(getByTestId(document.body, "review-handoff-submit-comment"));

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(onCompleteReview.mock.calls[0]?.[0]).toMatchObject({
      overallComment: "Tighten the intro.",
    });

    // A new document version from disk (the agent replied) returns the button
    // to ready. The field must be empty so a second Done cannot repeat it.
    watcherCount = 1;
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
      documentPage: { ...createPage("Hello again"), version: "v9" },
    });
    await settle();

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Approve");
    const reopened = await openOverallCommentPopover();
    expect(reopened.value).toBe("");

    await click(getByTestId(container, "review-handoff-button"));

    expect(onCompleteReview).toHaveBeenCalledTimes(2);
    const [first, second] = onCompleteReview.mock.calls.map(
      ([options]) => options,
    );
    expect(second?.overallComment).toBeUndefined();
    expect(second?.handoffId).not.toBe(first?.handoffId);
  });

  it("disables Done with a reason while the file is in conflict", async () => {
    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage()}
          activeDocumentPath="test.md"
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          onSaveDocument={async () => {}}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState="conflict"
          documentForceResetKey={null}
          onReloadDocumentFromDisk={() => {}}
          onKeepEditingWithoutAutosave={() => {}}
          onOverwriteDocumentOnDisk={() => {}}
          onCompleteReview={async () => ({ delivered: false })}
          backend={createBackend({ watcherCount: 1, kind: "local-files" })}
        />,
      );
      await Promise.resolve();
    });

    const button = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      getByTestId(container, "review-handoff-blocked-reason").textContent,
    ).toBe("Save conflict. Resolve it before you finish.");
  });

  it("fades the whole handoff split button after sending", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });

    const splitButton = getByTestId<HTMLDivElement>(
      container,
      "review-handoff-split-button",
    );
    const doneReviewingButton = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    const commentTrigger = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-comment-trigger",
    );

    await click(doneReviewingButton);

    expect(splitButton.className).toContain("opacity-50");
    expect(doneReviewingButton.className).toContain("disabled:opacity-100");
    expect(commentTrigger.className).toContain("disabled:opacity-100");
  });

  it("says no agent received a Done that an older server neither delivered nor kept", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Not sent");
    expect(
      getByTestId(document.body, "review-handoff-status").textContent,
    ).toContain("No agent received this");
  });

  it("submits an overall comment from the handoff popover", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });

    const textarea = await openOverallCommentPopover();
    expect(textarea.getAttribute("placeholder")).toBe("Overall comment");

    await change(textarea, "  Please prioritize the CLI contract.  ");
    await click(getByTestId(document.body, "review-handoff-submit-comment"));

    expect(onCompleteReview).toHaveBeenCalledWith({
      overallComment: "Please prioritize the CLI contract.",
      handoffId: expect.any(String),
    });
    expect(document.body.textContent).not.toContain(
      "Please prioritize the CLI contract.",
    );
  });

  it("includes an overall comment when finishing from the primary handoff button", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });

    const textarea = await openOverallCommentPopover();
    await change(textarea, "  Please prioritize the CLI contract.  ");
    await click(getByTestId(container, "review-handoff-button"));

    expect(onCompleteReview).toHaveBeenCalledWith({
      overallComment: "Please prioritize the CLI contract.",
      handoffId: expect.any(String),
    });
  });

  it("keeps visible sent feedback after the watcher receives the event", async () => {
    let watcherCount = 1;
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        watcherCount = 0;
        return { delivered: true };
      });

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    await click(getByTestId(container, "review-handoff-button"));
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Sent");
    expect(container.textContent).not.toContain("Approve");
    expect(container.textContent).not.toContain("I'm done");
  });

  it("lets a new watcher start another handoff after sent feedback", async () => {
    let watcherCount = 1;
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        watcherCount = 0;
        return { delivered: true };
      });

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    await click(getByTestId(container, "review-handoff-button"));
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    expect(container.textContent).toContain("Sent");
    expect(container.textContent).not.toContain("Approve");

    watcherCount = 1;
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });
    await settle();

    expect(container.textContent).toContain("Approve");
    expect(container.textContent).not.toContain("Sent");
  });

  it("reopens the sent popover from the muted primary button", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const closeWindow = vi.spyOn(window, "close").mockImplementation(() => {});
    let watcherCount = 1;
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        watcherCount = 0;
        return { delivered: true };
      });

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    await click(getByTestId(container, "review-handoff-button"));

    expect(onCompleteReview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Sent");
    expect(document.body.textContent).toContain("Nice one!");
    expect(document.body.textContent).toContain(
      "Your agent is now working in the background on this, in all likelihood. If our signal didn't make it, just click here to copy a line you can send it to keep going.",
    );
    expect(
      getByTestId(document.body, "review-handoff-status").querySelector(
        ".h-\\[170px\\]",
      ),
    ).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(queryByTestId(document.body, "review-handoff-status")).toBeNull();

    const sentButton = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(sentButton.disabled).toBe(false);

    await click(sentButton);

    expect(onCompleteReview).toHaveBeenCalledTimes(1);
    getByTestId(document.body, "review-handoff-status");

    const toy = getByTestId(document.body, "review-handoff-robots-toy");
    await click(toy);

    expect(document.body.textContent).toContain("Great work!");

    await click(getByTestId(document.body, "review-handoff-copy-message"));

    expect(writeText).toHaveBeenCalledWith(
      "I am done reviewing this file: test.md",
    );

    await click(getByTestId(document.body, "review-handoff-close-window"));

    expect(closeWindow).toHaveBeenCalled();
  });
});
