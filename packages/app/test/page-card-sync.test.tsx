import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSync } from "../src/document-sync";
import { PageCard } from "../src/PageCard";
import type { Page, StorageBackend } from "../src/storage";

// Sync finding 9: an update from disk on a clean tab used to remount the
// rich-text editor, which dropped focus, so the next keystrokes went to the
// page body and never reached disk.

function rect(width = 120, height = 24) {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

class Disk {
  content: string;
  version = 1;

  constructor(content: string) {
    this.content = content;
  }

  page(): Page {
    return {
      id: "doc",
      title: "Doc",
      content: this.content,
      version: `v${this.version}`,
    };
  }

  write(content: string) {
    this.content = content;
    this.version += 1;
  }

  backend(): StorageBackend {
    return {
      info: { kind: "local-files", label: "Test", detail: "Test" },
      canManageProjects: false,
      getMarkdownFile: async () => this.page(),
      saveMarkdownFile: async (_path, content) => {
        this.write(content);
        return this.page();
      },
      getMarkdownFileState: async () => {
        const { localContentHash } = await import("../src/content-hash");
        return {
          exists: true,
          available: true,
          version: `v${this.version}`,
          contentHash: localContentHash(this.content),
          seq: this.version,
        };
      },
      openTabChannel: () => ({ send() {}, close() {} }),
      async saveAsset(file) {
        return {
          markdownPath: file.name,
          previewUrl: "",
          mimeType: file.type,
        };
      },
      resolveFileUrl: () => null,
      async openProject() {},
    };
  }
}

const cleanups: Array<() => Promise<void>> = [];

async function renderWithSync(
  disk: Disk,
  editorViewMode: "rich-text" | "code",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const backend = disk.backend();
  const sync = new DocumentSync({
    backend,
    path: "doc.md",
    tabId: "tab",
    initialPage: disk.page(),
    environment: { isVisible: () => true, listen: () => () => {} },
  });
  sync.start();
  const editors: Editor[] = [];

  await act(async () => {
    root.render(
      <PageCard
        page={disk.page()}
        selected
        onSave={async () => {}}
        editorViewMode={editorViewMode}
        interactionMode="editing"
        backend={backend}
        onEditorReady={(editor) => {
          if (editor) editors.push(editor);
        }}
        sync={sync}
      />,
    );
    await Promise.resolve();
  });

  cleanups.push(async () => {
    sync.dispose();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  return { container, sync, editors };
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect(640, 240),
  );
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
  for (const proto of [Range.prototype, Text.prototype]) {
    Object.defineProperty(proto, "getClientRects", {
      configurable: true,
      value: () => [rect(80, 20)],
    });
  }
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(80, 20),
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  window.scrollBy = vi.fn();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
});

describe("PageCard with a sync controller", () => {
  it("applies a change from disk in place: same editor, focus and caret kept, next keystroke saved with it", async () => {
    const disk = new Disk("First paragraph.\n\nSecond paragraph.\n");
    const { container, sync, editors } = await renderWithSync(
      disk,
      "rich-text",
    );
    const editor = editors.at(-1) as Editor;

    await act(async () => {
      // jsdom only focuses elements it considers focusable.
      editor.view.dom.setAttribute("tabindex", "0");
      editor.view.dom.focus();
      editor.commands.setTextSelection(3);
    });
    expect(document.activeElement).toBe(editor.view.dom);

    disk.write("First paragraph.\n\nSecond paragraph.\n\nAgent reply.\n");
    await act(async () => {
      await sync.resync();
    });

    expect(container.textContent).toContain("Agent reply.");
    expect(editors).toHaveLength(1);
    expect(editor.isDestroyed).toBe(false);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);

    await act(async () => {
      editor.commands.insertContent("X");
    });
    await act(async () => {
      await sync.flush();
    });

    expect(disk.content).toContain("FiXrst paragraph.");
    expect(disk.content).toContain("Agent reply.");
  });

  it("applies a change from disk to the code editor without moving the cursor", async () => {
    const disk = new Disk("# Title\n\nBody.\n");
    const { container, sync } = await renderWithSync(disk, "code");
    const host = container.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(host) as EditorView;

    await act(async () => {
      view.dispatch({ selection: { anchor: 4 } });
    });

    disk.write("# Title\n\nBody.\n\nAgent reply.\n");
    await act(async () => {
      await sync.resync();
    });

    expect(EditorView.findFromDOM(host)).toBe(view);
    expect(view.state.doc.toString()).toBe(
      "# Title\n\nBody.\n\nAgent reply.\n",
    );
    expect(view.state.selection.main.head).toBe(4);

    await act(async () => {
      view.dispatch({ changes: { from: 4, insert: "X" } });
    });
    await act(async () => {
      await sync.flush();
    });

    expect(disk.content).toBe("# TiXtle\n\nBody.\n\nAgent reply.\n");
  });
});
