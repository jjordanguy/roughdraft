import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocationForDocumentEditorViewMode,
  type DocumentEditorViewMode,
  getDocumentEditorViewModeFromLocation,
} from "../src/app-navigation";
import { localContentHash } from "../src/content-hash";
import {
  DocumentSaveStatusIndicator,
  DocumentWorkspace,
  shouldLatchDocumentChangedSinceOpen,
} from "../src/DocumentWorkspace";
import { DocumentSync } from "../src/document-sync";
import type { DocumentSaveState } from "../src/PageCard";
import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type HandoffRecord,
  MarkdownFileConflictError,
  type Page,
  type RoundFlag,
  type SessionRecord,
  type StorageBackend,
  type TabChannelHandlers,
  type TabServerMessage,
} from "../src/storage";

// A fake Roughdraft server for one document: a disk, a tab channel the
// test speaks for, and a Done endpoint the test controls.
class TestServer {
  content: string;
  version = 1;
  kind: BackendInfo["kind"];
  saves: string[] = [];
  conflictOnSave = false;
  channels: TabChannelHandlers[] = [];
  completeReview: (
    options?: CompleteReviewOptions,
  ) => Promise<CompleteReviewResult>;

  constructor({
    content = "Hello world",
    kind = "local-storage",
    completeReview = async () => ({ delivered: false }),
  }: {
    content?: string;
    kind?: BackendInfo["kind"];
    completeReview?: (
      options?: CompleteReviewOptions,
    ) => Promise<CompleteReviewResult>;
  } = {}) {
    this.content = content;
    this.kind = kind;
    this.completeReview = completeReview;
  }

  page(): Page {
    return {
      id: "test-doc",
      title: "Test Doc",
      content: this.content,
      version: `v${this.version}`,
    };
  }

  // An outside writer (the agent).
  write(content: string) {
    this.content = content;
    this.version += 1;
  }

  backend(): StorageBackend {
    return {
      info: {
        kind: this.kind,
        label: "Test backend",
        detail: "In-memory",
      },
      canManageProjects: false,
      getMarkdownFile: async () => this.page(),
      saveMarkdownFile: async (_path, content) => {
        if (this.conflictOnSave) {
          throw new MarkdownFileConflictError({
            ...this.page(),
            content: "Changed elsewhere",
            version: "v99",
          });
        }
        this.saves.push(content);
        this.write(content);
        return this.page();
      },
      getMarkdownFileState: async () => ({
        exists: true,
        available: true,
        version: `v${this.version}`,
        contentHash: localContentHash(this.content),
        seq: this.version,
      }),
      openTabChannel: (_path, _tabId, handlers) => {
        this.channels.push(handlers);
        return { send() {}, close() {} };
      },
      completeReview: (_path, options) => this.completeReview(options),
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
  }

  // What the batch 2 server sends on connect.
  async hello({
    watchers = 0,
    session = null,
    handoff = null,
    round = null,
  }: {
    watchers?: number;
    session?: SessionRecord | null;
    handoff?: HandoffRecord | null;
    round?: RoundFlag | null;
  } = {}) {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("the tab never opened its channel");
    await act(async () => {
      channel.onOpen();
      channel.onMessage({
        type: "hello",
        instanceId: "instance-1",
        document: {
          exists: true,
          available: true,
          version: `v${this.version}`,
          contentHash: localContentHash(this.content),
          seq: this.version,
        },
        tabs: 1,
        watchers,
        session,
        handoff,
        latestSequence: null,
        round,
      });
      await Promise.resolve();
    });
  }

  async send(message: TabServerMessage) {
    const channel = this.channels.at(-1);
    if (!channel) throw new Error("the tab never opened its channel");
    await act(async () => {
      channel.onMessage(message);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  }
}

const openSyncs: DocumentSync[] = [];

function createSync(server: TestServer) {
  const sync = new DocumentSync({
    backend: server.backend(),
    path: "test.md",
    tabId: "tab-test",
    initialPage: server.page(),
    environment: { isVisible: () => true, listen: () => () => {} },
  });
  sync.start();
  openSyncs.push(sync);
  return sync;
}

afterEach(() => {
  for (const sync of openSyncs.splice(0)) sync.dispose();
});

// Puts the tab in the state the old `documentDiskChangeState` prop forced:
// a save that answered 409, optionally followed by "keep editing".
async function driveDiskState(
  server: TestServer,
  sync: DocumentSync,
  state: "clean" | "changed" | "conflict" | "paused",
) {
  if (state === "clean") return;
  await act(async () => {
    if (state === "changed") {
      sync.edit(`${server.content} (local)`);
      server.write("Changed elsewhere");
      await sync.resync();
      return;
    }
    server.conflictOnSave = true;
    sync.edit(`${server.content} (local)`);
    await sync.flush();
    if (state === "paused") sync.keepEditing();
  });
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
    documentDiskChangeState?:
      | "clean"
      | "changed"
      | "conflict"
      | "paused"
      | "unavailable";
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
    backendKind = "local-storage",
  }: {
    documentDiskChangeState?: "clean" | "changed" | "conflict" | "paused";
    documentContent?: string;
    documentCopyPath?: string | null;
    backendKind?: BackendInfo["kind"];
  } = {}) {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const server = new TestServer({
      content: documentContent,
      kind: backendKind,
    });
    const sync = createSync(server);

    await act(async () => {
      root.render(
        <DocumentWorkspace
          sync={sync}
          activeDocumentPath="test.md"
          documentCopyPath={documentCopyPath}
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          backend={server.backend()}
        />,
      );
      await Promise.resolve();
    });
    await driveDiskState(server, sync, documentDiskChangeState);
    return { server, sync };
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
    ["offline", "Save failed, retrying", ""],
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
    ["unavailable", "File unavailable"],
  ] as const)("shows disk-blocked %s save status", async (state, label) => {
    await renderSaveStatus({ documentDiskChangeState: state });

    const status = getByTestId(container, "document-save-status");
    expect(status.getAttribute("aria-label")).toBe(label);
    expect(status.textContent).toBe("");
    expect(getByTestId(status, "document-save-status-icon")).not.toBeNull();
  });

  it("renders save status in the fixed corner when handoff exists", async () => {
    const { server } = await renderWorkspace({ backendKind: "local-files" });
    await server.hello({ watchers: 1 });

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

  it("copies the unsaved draft, not only the saved file, as markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { sync } = await renderWorkspace({ documentContent: "# Heading" });
    sync.edit("# Heading\n\nTyped a moment ago");
    await openFileMenu();
    await click(getByTestId(document.body, "document-file-menu-markdown"));

    expect(writeText).toHaveBeenCalledWith("# Heading\n\nTyped a moment ago");
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
  ])("prevents browser save on %s and saves the draft", async (_label, init) => {
    const { server, sync } = await renderWorkspace();
    sync.edit("Hello world, saved by shortcut");

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
    expect(server.saves).toEqual(["Hello world, saved by shortcut"]);
  });

  it("prevents browser save even when disk conflict blocks persistence", async () => {
    const { server } = await renderWorkspace({
      documentDiskChangeState: "conflict",
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
    expect(server.saves).toEqual([]);
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

  it("names the disk version that Overwrite will replace", async () => {
    await renderWorkspace({ documentDiskChangeState: "conflict" });

    expect(
      getByTestId(container, "file-conflict-disk-version").textContent,
    ).toContain("Overwrite replaces this version");
  });

  it("shows a change that lands while autosave is paused", async () => {
    const { server, sync } = await renderWorkspace({
      documentDiskChangeState: "paused",
    });
    expect(queryByTestId(container, "file-conflict-later-change")).toBeNull();

    server.write("Changed again by the agent");
    await act(async () => {
      await sync.resync();
    });

    expect(
      getByTestId(container, "file-conflict-later-change").textContent,
    ).toContain("The file changed on disk again");
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
    const server = new TestServer();
    const sync = createSync(server);

    const renderWorkspace = async (viewMode: DocumentEditorViewMode) => {
      await act(async () => {
        root.render(
          <DocumentWorkspace
            sync={sync}
            activeDocumentPath="test.md"
            documentCopyPath="test.md"
            documentFilenameLabel="test.md"
            documentEditorViewMode={viewMode}
            onDocumentEditorViewModeChange={() => {}}
            backend={server.backend()}
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  async function renderWorkspace({
    watchers,
    session = null,
    onCompleteReview = async () => ({ delivered: false, pending: true }),
    backendKind = "local-files",
    content = "Hello world",
  }: {
    // Undefined: the server never says hello (an older server).
    watchers?: number;
    session?: SessionRecord | null;
    onCompleteReview?: (
      options?: CompleteReviewOptions,
    ) => Promise<CompleteReviewResult>;
    backendKind?: BackendInfo["kind"];
    content?: string;
  } = {}) {
    const server = new TestServer({
      content,
      kind: backendKind,
      completeReview: onCompleteReview,
    });
    const sync = createSync(server);
    await act(async () => {
      root.render(
        <DocumentWorkspace
          sync={sync}
          activeDocumentPath="test.md"
          documentCopyPath="test.md"
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onDocumentEditorViewModeChange={() => {}}
          backend={server.backend()}
        />,
      );
      await Promise.resolve();
    });
    if (watchers !== undefined) await server.hello({ watchers, session });
    return { server, sync };
  }

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
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

  async function openStatusPopover() {
    await click(getByTestId(container, "review-handoff-status-trigger"));
    return getByTestId(document.body, "review-handoff-status");
  }

  function splitButton() {
    return getByTestId(container, "review-handoff-split-button");
  }

  it("does not show the Done button outside a local files document", async () => {
    await renderWorkspace({ watchers: 1, backendKind: "local-storage" });

    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
  });

  it("takes the watcher count from the tab channel, with no status poll", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { server } = await renderWorkspace();

    expect(splitButton().getAttribute("data-watcher-state")).toBe("none");

    await server.hello({ watchers: 1 });
    expect(splitButton().getAttribute("data-watcher-state")).toBe("listening");

    await server.send({ type: "watchers", count: 0 });
    expect(splitButton().getAttribute("data-watcher-state")).toBe("none");

    await server.send({ type: "watchers", count: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(splitButton().getAttribute("data-watcher-state")).toBe("listening");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows the Done button with no watcher and says no agent is listening", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false, pending: true });

    await renderWorkspace({ watchers: 0, onCompleteReview });

    const doneButton = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(doneButton.textContent).toContain("Approve");
    expect(doneButton.disabled).toBe(false);
    expect(splitButton().getAttribute("data-watcher-state")).toBe("none");

    await openStatusPopover();

    expect(
      getByTestId(document.body, "review-handoff-agent-status").textContent,
    ).toBe(
      "No agent is listening. Roughdraft keeps your Done until it checks in.",
    );
    expect(onCompleteReview).not.toHaveBeenCalled();
  });

  it("says the agent is waiting and names its session when one is registered", async () => {
    await renderWorkspace({
      watchers: 1,
      session: {
        harness: "claude-code",
        label: "Plan review chat",
        link: null,
        sessionId: null,
        routeId: null,
        registeredAt: "2026-10-05T15:00:00.000Z",
      },
    });
    await settle();

    expect(splitButton().getAttribute("data-watcher-state")).toBe("listening");

    await openStatusPopover();

    expect(
      getByTestId(document.body, "review-handoff-agent-status").textContent,
    ).toBe("Your agent is waiting");
    expect(
      getByTestId(document.body, "review-handoff-session-label").textContent,
    ).toBe("Opened by Plan review chat");
  });

  it("sends Done with a client handoff id and the version it is based on", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ watchers: 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(onCompleteReview).toHaveBeenCalledWith({
      handoffId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: "v1",
      expectedContentHash: localContentHash("Hello world"),
    });
    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Sent");
  });

  it("hands off right after typing with one save and no second PUT", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });
    const { server, sync } = await renderWorkspace({
      watchers: 1,
      onCompleteReview,
    });

    sync.edit("Hello world. Quick note.");
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(server.saves).toEqual(["Hello world. Quick note."]);
    expect(onCompleteReview).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "v2" }),
    );
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

    await renderWorkspace({ watchers: 0, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));

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

    await settle();
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

    await renderWorkspace({ watchers: 0, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

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

  it("moves to Picked up when the tab channel reports the handoff acknowledged", async () => {
    let handoffId = "";
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

    const { server } = await renderWorkspace({ watchers: 0, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    await server.send({
      type: "handoff",
      handoff: handoffRecord({
        handoffId,
        state: "acknowledged",
        ackedAt: "2026-10-05T15:45:00.000Z",
      }),
    });

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Picked up");
    expect(
      getByTestId(document.body, "review-handoff-status").textContent,
    ).toContain("Your agent picked this up at");
  });

  it("ignores an acknowledged handoff that belongs to another Done", async () => {
    const { server } = await renderWorkspace({
      watchers: 0,
      onCompleteReview: async (options) => ({
        delivered: false,
        pending: true,
        handoff: handoffRecord({ handoffId: options?.handoffId }),
      }),
    });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();
    await server.send({
      type: "handoff",
      handoff: handoffRecord({
        handoffId: "someone-else",
        state: "acknowledged",
        ackedAt: "2026-10-05T15:45:00.000Z",
      }),
    });

    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Done, waiting");
  });

  it("retries a failed Done with the same handoff id", async () => {
    let calls = 0;
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return { delivered: false, pending: true };
      });

    await renderWorkspace({ watchers: 0, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

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
    await settle();

    expect(onCompleteReview).toHaveBeenCalledTimes(2);
    const [first, second] = onCompleteReview.mock.calls.map(
      ([options]) => options,
    );
    expect(second?.handoffId).toBe(first?.handoffId);
    expect(second?.overallComment).toBeUndefined();
    expect(
      getByTestId(container, "review-handoff-button").textContent,
    ).toContain("Done, waiting");
  });

  it("says the file changed when the Done answers 409, and blocks Retry until it is resolved", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockRejectedValue(
        new MarkdownFileConflictError({
          id: "test-doc",
          title: "Test Doc",
          content: "The agent wrote this first",
          version: "v7",
        }),
      );

    await renderWorkspace({ watchers: 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    const status = getByTestId(document.body, "review-handoff-status");
    expect(status.textContent).toContain(
      "The file changed on disk before Roughdraft could record your Done.",
    );
    expect(
      getByTestId<HTMLButtonElement>(status, "review-handoff-retry").disabled,
    ).toBe(true);
    expect(
      getByTestId(container, "document-save-status").getAttribute("aria-label"),
    ).toBe("Save conflict");
    expect(getByTestId(container, "file-conflict-notice")).not.toBeNull();
  });

  it("says the server did not answer when the Done never got a reply", async () => {
    const { ServerUnreachableError } = await import("../src/storage");
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockRejectedValue(new ServerUnreachableError("POST /api/review-events"));

    await renderWorkspace({ watchers: 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    const status = getByTestId(document.body, "review-handoff-status");
    expect(status.textContent).toContain(
      "The Roughdraft server did not answer, so your Done was not recorded.",
    );
    expect(
      getByTestId<HTMLButtonElement>(status, "review-handoff-retry").disabled,
    ).toBe(false);
  });

  it("has no comment box in the Done dropdown, only the status", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false, pending: true });
    await renderWorkspace({ watchers: 1, onCompleteReview });

    const status = await openStatusPopover();
    expect(status.textContent).not.toContain("Submit with comment");
    expect(
      queryByTestId(document.body, "review-handoff-overall-comment"),
    ).toBeNull();
    expect(
      queryByTestId(document.body, "review-handoff-submit-comment"),
    ).toBeNull();
    expect(getByTestId(status, "review-handoff-agent-status").textContent).toBe(
      "Your agent is waiting",
    );
    expect(
      getByTestId(container, "review-handoff-status-trigger").getAttribute(
        "aria-label",
      ),
    ).toBe("Review status");

    await click(getByTestId(container, "review-handoff-button"));
    await settle();
    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(onCompleteReview.mock.calls[0]?.[0]?.overallComment).toBeUndefined();
  });

  it("disables Done with a reason while the file is in conflict", async () => {
    const { server, sync } = await renderWorkspace({ watchers: 1 });
    await driveDiskState(server, sync, "conflict");

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

    await renderWorkspace({ watchers: 1, onCompleteReview });

    const doneReviewingButton = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    const commentTrigger = getByTestId<HTMLButtonElement>(
      container,
      "review-handoff-status-trigger",
    );

    await click(doneReviewingButton);
    await settle();

    expect(splitButton().className).toContain("opacity-50");
    expect(doneReviewingButton.className).toContain("disabled:opacity-100");
    expect(commentTrigger.className).toContain("disabled:opacity-100");
  });

  it("says no agent received a Done that an older server neither delivered nor kept", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false });

    await renderWorkspace({ watchers: 1, onCompleteReview });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Not sent");
    expect(
      getByTestId(document.body, "review-handoff-status").textContent,
    ).toContain("No agent received this");
  });

  it("Done saves an open global comment draft first and it stays in the global section", async () => {
    let contentAtDone: string | null = null;
    let server: TestServer | null = null;
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        contentAtDone = server?.content ?? null;
        return { delivered: true };
      });
    const rendered = await renderWorkspace({ watchers: 1, onCompleteReview });
    server = rendered.server;

    await click(getByTestId(container, "global-comment-add"));
    await settle();
    const editor = getByTestId<HTMLTextAreaElement>(
      container,
      "comment-rail-c1-editor",
    );
    expect(editor.getAttribute("placeholder")).toBe(
      "Comment on the whole document",
    );
    await change(editor, "  Please prioritize the CLI contract.  ");

    // The pointer leaves the draft for the Done button, as a click does.
    await act(async () => {
      getByTestId(container, "review-handoff-button").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(onCompleteReview.mock.calls[0]?.[0]?.overallComment).toBeUndefined();
    // The draft reached disk before the Done was sent.
    expect(contentAtDone).toMatch(
      / {2}c1:\n {4}body: "Please prioritize the CLI contract\."\n {4}by: user\n {4}at: "[^"\n]+"\n {4}scope: document\n/,
    );
    const thread = getByTestId(container, "global-comment-thread-c1");
    expect(thread.textContent).toContain("Please prioritize the CLI contract.");
    expect(queryByTestId(container, "comment-rail-c1-editor")).toBeNull();
  });

  it("Done drops an empty global comment draft and writes nothing for it", async () => {
    const onCompleteReview = vi
      .fn<(options?: CompleteReviewOptions) => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });
    const { server } = await renderWorkspace({ watchers: 1, onCompleteReview });

    await click(getByTestId(container, "global-comment-add"));
    await settle();
    expect(queryByTestId(container, "global-comment-thread-c1")).not.toBeNull();
    await click(getByTestId(container, "review-handoff-button"));
    await settle();

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(server.content).toBe("Hello world");
    expect(queryByTestId(container, "global-comment-thread-c1")).toBeNull();
  });

  it("keeps visible sent feedback after the watcher receives the event", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    const { server } = await renderWorkspace({ watchers: 1, onCompleteReview });

    await click(getByTestId(container, "review-handoff-button"));
    await settle();
    await server.send({ type: "watchers", count: 0 });

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Sent");
    expect(container.textContent).not.toContain("Approve");
    expect(container.textContent).not.toContain("I'm done");
  });

  it("lets a new watcher start another handoff after sent feedback", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    const { server } = await renderWorkspace({ watchers: 1, onCompleteReview });

    await click(getByTestId(container, "review-handoff-button"));
    await settle();
    await server.send({ type: "watchers", count: 0 });

    expect(container.textContent).toContain("Sent");
    expect(container.textContent).not.toContain("Approve");

    await server.send({ type: "watchers", count: 1 });
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
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    const { server } = await renderWorkspace({ watchers: 1, onCompleteReview });

    await click(getByTestId(container, "review-handoff-button"));
    await settle();
    await server.send({ type: "watchers", count: 0 });

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
  describe("Global comment button", () => {
    it("shows one Global comment button next to Done for a local document", async () => {
      await renderWorkspace({ watchers: 0 });

      const button = getByTestId(container, "global-comment-add");
      expect(button.textContent).toBe("Global comment");
      // It sits in the fixed stack, before the Done split button.
      const stack = getByTestId(container, "document-status-stack");
      const order = [
        ...stack.querySelectorAll<HTMLElement>("[data-testid]"),
      ].map((element) => element.dataset.testid);
      expect(order.indexOf("global-comment-add")).toBeLessThan(
        order.indexOf("review-handoff-split-button"),
      );
    });

    it("is not shown outside a local files document", async () => {
      await renderWorkspace({ watchers: 0, backendKind: "local-storage" });
      expect(queryByTestId(container, "global-comment-add")).toBeNull();
    });

    it("opens a draft at the top of the global section, newest first, and Save writes a document entry", async () => {
      const { server } = await renderWorkspace({
        watchers: 0,
        content: [
          "Body text.",
          "",
          "---",
          "comments:",
          "  c1:",
          '    body: "Older note."',
          "    by: user",
          '    at: "2026-10-05T09:00:00.000Z"',
          "",
        ].join("\n"),
      });

      await click(getByTestId(container, "global-comment-add"));
      await settle();
      const section = getByTestId(container, "global-comments-section");
      const cards = [
        ...section.querySelectorAll<HTMLElement>(
          '[data-testid^="global-comment-thread-"]',
        ),
      ].map((card) => card.dataset.testid);
      expect(cards).toEqual([
        "global-comment-thread-c2",
        "global-comment-thread-c1",
      ]);

      const editor = getByTestId<HTMLTextAreaElement>(
        section,
        "comment-rail-c2-editor",
      );
      await change(editor, "Tighten the intro.");
      vi.useFakeTimers();
      await click(getByTestId(section, "comment-rail-c2-action-save"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(server.content.split("\n---\n")[0]).toBe("Body text.\n");
      expect(server.content).toMatch(
        / {2}c2:\n {4}body: "Tighten the intro\."\n {4}by: user\n {4}at: "[^"\n]+"\n {4}scope: document\n/,
      );
      for (const view of [
        getByTestId(container, "global-comments-section"),
        getByTestId(container, "global-comments-fallback"),
      ]) {
        const card = getByTestId(view, "global-comment-thread-c2");
        expect(card.textContent).toContain("Tighten the intro.");
        expect(queryByTestId(card, "comment-rail-c2-editor")).toBeNull();
        expect(queryByTestId(card, "comment-banner-c2-editor")).toBeNull();
      }
    });

    it("discards an empty draft on Escape and never writes it", async () => {
      const { server } = await renderWorkspace({ watchers: 0 });

      await click(getByTestId(container, "global-comment-add"));
      await settle();
      const editor = getByTestId<HTMLTextAreaElement>(
        container,
        "comment-rail-c1-editor",
      );
      await act(async () => {
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        await Promise.resolve();
      });
      await settle();

      expect(queryByTestId(container, "global-comment-thread-c1")).toBeNull();
      expect(server.saves).toEqual([]);
      expect(server.content).toBe("Hello world");
    });

    it("reuses the open draft when pressed twice", async () => {
      await renderWorkspace({ watchers: 0 });

      await click(getByTestId(container, "global-comment-add"));
      await settle();
      await click(getByTestId(container, "global-comment-add"));
      await settle();

      const section = getByTestId(container, "global-comments-section");
      expect(getByTestId(section, "global-comment-thread-c1")).not.toBeNull();
      expect(queryByTestId(section, "global-comment-thread-c2")).toBeNull();
    });

    it("switches code view to rich text and opens the draft", async () => {
      const server = new TestServer({ kind: "local-files" });
      const sync = createSync(server);
      const modes: DocumentEditorViewMode[] = [];
      const render = async (mode: DocumentEditorViewMode) => {
        await act(async () => {
          root.render(
            <DocumentWorkspace
              sync={sync}
              activeDocumentPath="test.md"
              documentCopyPath="test.md"
              documentFilenameLabel="test.md"
              documentEditorViewMode={mode}
              onDocumentEditorViewModeChange={(next) => {
                modes.push(next);
              }}
              backend={server.backend()}
            />,
          );
          await Promise.resolve();
        });
      };
      await render("code");
      await server.hello({ watchers: 0 });

      await click(getByTestId(container, "global-comment-add"));
      expect(modes).toEqual(["rich-text"]);
      await render("rich-text");
      await settle();

      expect(
        getByTestId<HTMLTextAreaElement>(container, "comment-rail-c1-editor")
          .placeholder,
      ).toBe("Comment on the whole document");
    });
  });

  describe("AI editing badge", () => {
    function round(overrides: Partial<RoundFlag> = {}): RoundFlag {
      return {
        roundId: "r-1",
        state: "open",
        openedAt: new Date(Date.now() - 65_000).toISOString(),
        updatedAt: null,
        stalledAt: null,
        closedAt: null,
        ...overrides,
      };
    }

    it("shows nothing with no round", async () => {
      await renderWorkspace({ watchers: 0 });
      expect(queryByTestId(container, "ai-round-badge")).toBeNull();
    });

    it("says AI editing with the elapsed time while the round is open, and the editor stays editable", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(new Date("2026-10-06T10:00:00.000Z"));
      const { server } = await renderWorkspace();
      await server.hello({
        watchers: 1,
        round: round({ openedAt: "2026-10-06T09:58:55.000Z" }),
      });

      const badge = getByTestId(container, "ai-round-badge");
      expect(badge.dataset.roundState).toBe("open");
      expect(badge.textContent).toContain("AI editing...");
      expect(getByTestId(badge, "ai-round-elapsed").textContent).toBe("1:05");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(getByTestId(badge, "ai-round-elapsed").textContent).toBe("1:15");
      // A badge, never a lock.
      expect(
        container
          .querySelector('[data-testid="rich-text-editor"] .ProseMirror')
          ?.getAttribute("contenteditable"),
      ).toBe("true");
    });

    it("turns into a dismissable stalled badge, and disappears when the round closes", async () => {
      const { server } = await renderWorkspace({ watchers: 0 });
      await server.send({ type: "round", round: round() });
      expect(getByTestId(container, "ai-round-badge").dataset.roundState).toBe(
        "open",
      );

      await server.send({
        type: "round",
        round: round({
          state: "stalled",
          stalledAt: new Date().toISOString(),
        }),
      });
      const stalled = getByTestId(container, "ai-round-badge");
      expect(stalled.dataset.roundState).toBe("stalled");
      expect(stalled.textContent).toContain("AI round stalled");
      await click(getByTestId(stalled, "ai-round-badge-dismiss"));
      expect(queryByTestId(container, "ai-round-badge")).toBeNull();

      // A new round shows again.
      await server.send({
        type: "round",
        round: round({ roundId: "r-2", openedAt: new Date().toISOString() }),
      });
      expect(getByTestId(container, "ai-round-badge").dataset.roundState).toBe(
        "open",
      );
      await server.send({
        type: "round",
        round: round({
          roundId: "r-2",
          state: "closed",
          closedAt: new Date().toISOString(),
        }),
      });
      expect(queryByTestId(container, "ai-round-badge")).toBeNull();
    });
  });
});
