// The browser writer (batch 3b). A file in the canonical shape, or one with
// no review items yet, gets every new item in the canonical shape: anchors in
// the prose, every body in the review block, written by rfm's writer. A file
// in an older shape is written back as it was and says how to convert it
// (D11). These tests drive the real editor path: select, comment, type,
// save, then read the saved file with rfm, the frozen 0.1.10 reader and the
// browser again.
import fs from "node:fs";
import path from "node:path";
import {
  appendRoughdraftDocumentComment,
  extractReviewIndexWithLegacyReader,
  extractRoughdraftReviewIndex,
  normalizeRoughdraftMetadata,
  parseReviewModel,
  validateRoughdraftMarkdown,
  validateWithLegacyReader,
} from "@roughdraft/rfm";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  REVIEW_FORMAT_NOTICE,
} from "../src/critic-markup";
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

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

const cleanups: Array<() => Promise<void>> = [];

async function renderDocument(
  content: string,
  interactionMode: "editing" | "suggesting" = "editing",
) {
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
        interactionMode={interactionMode}
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

  const getEditor = () => {
    expect(editor).not.toBeNull();
    return editor as unknown as Editor;
  };

  return {
    container,
    onSave,
    getEditor,
    /** The last markdown the card saved. */
    saved() {
      const call = onSave.mock.calls.at(-1);
      expect(call, "the card saved").toBeDefined();
      return call?.[1] as string;
    },
  };
}

// Document positions of text in the editor (the first match).
function textPosition(editor: Editor, text: string, edge: "start" | "end") {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isText || !node.text) return undefined;
    const offset = node.text.indexOf(text);
    if (offset < 0) return undefined;
    found = pos + offset + (edge === "end" ? text.length : 0);
    return false;
  });
  // Text inside a code block is one text node of the block.
  if (found === null) {
    editor.state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name !== "codeBlock") return undefined;
      const offset = node.textContent.indexOf(text);
      if (offset < 0) return false;
      found = pos + 1 + offset + (edge === "end" ? text.length : 0);
      return false;
    });
  }
  expect(found, `"${text}" is in the document`).not.toBeNull();
  return found as unknown as number;
}

async function select(editor: Editor, fromText: string, toText: string) {
  const from = textPosition(editor, fromText, "start");
  const to = textPosition(editor, toText, "end");
  await act(async () => {
    editor.commands.focus();
    editor.commands.setTextSelection({ from, to });
  });
  await flush();
}

async function addComment(container: HTMLElement) {
  await nextFrame();
  const button = byTestId(document, "selection-menu-action-comment");
  expect(button, "the selection menu offers Comment").not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
  await nextFrame();
  void container;
}

function commentEditor(container: HTMLElement, id: string) {
  return (byTestId<HTMLTextAreaElement>(
    container,
    `comment-rail-${id}-editor`,
  ) ??
    byTestId<HTMLTextAreaElement>(
      container,
      `comment-banner-${id}-editor`,
    )) as HTMLTextAreaElement | null;
}

async function typeInComposer(
  container: HTMLElement,
  id: string,
  text: string,
) {
  const textarea = commentEditor(container, id);
  expect(textarea, `the composer for ${id} is open`).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, text);
    textarea?.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await flush();
}

async function pressEnterInComposer(container: HTMLElement, id: string) {
  const textarea = commentEditor(container, id);
  await act(async () => {
    textarea?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush();
}

async function saveComposer(container: HTMLElement, id: string) {
  const button =
    byTestId(container, `comment-rail-${id}-action-save`) ??
    byTestId(container, `comment-banner-${id}-action-save`);
  expect(button, `the composer for ${id} has Save`).not.toBeNull();
  vi.useFakeTimers();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(600);
    await Promise.resolve();
  });
  vi.useRealTimers();
  await flush();
}

async function commentOn(
  rendered: Awaited<ReturnType<typeof renderDocument>>,
  fromText: string,
  toText: string,
  id: string,
  body: string,
) {
  await select(rendered.getEditor(), fromText, toText);
  await addComment(rendered.container);
  await typeInComposer(rendered.container, id, body);
  await saveComposer(rendered.container, id);
}

function bodyOf(markdown: string) {
  return parseReviewModel(markdown).split.body;
}

// rfm's normalization finds nothing to change: the file is canonical.
function expectCanonical(markdown: string) {
  const normalized = normalizeRoughdraftMetadata(markdown);
  expect(normalized.refused).toEqual([]);
  expect(normalized.changes).toEqual([]);
  expect(normalized.markdown).toBe(markdown);
}

// rfm and the frozen 0.1.10 reader both read the file without errors and list
// the same comment ids.
function expectBothReaders(markdown: string, commentIds: string[]) {
  const fork = validateRoughdraftMarkdown(markdown);
  expect(fork.errors).toEqual([]);
  const legacy = validateWithLegacyReader(markdown);
  expect(legacy.errors).toEqual([]);
  const forkIds = extractRoughdraftReviewIndex(markdown)
    .items.filter((item) => item.kind === "comment")
    .map((item) => item.id);
  const legacyIds = extractReviewIndexWithLegacyReader(markdown)
    .items.filter((item: { kind: string }) => item.kind === "comment")
    .map((item: { id: string }) => item.id);
  expect(forkIds).toEqual(commentIds);
  expect(legacyIds).toEqual(commentIds);
}

describe("browser writer", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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

  describe("composer", () => {
    it("keeps a line break typed with Enter, stores it as <br> and shows it after a reload", async () => {
      const rendered = await renderDocument(
        "Gamma paragraph proposes a two week pilot with three customers.\n",
      );
      await select(rendered.getEditor(), "two week pilot", "three customers");
      await addComment(rendered.container);
      await typeInComposer(
        rendered.container,
        "c1",
        "First point about scope.",
      );
      // Enter is a line break, not Save: the composer is still open.
      await pressEnterInComposer(rendered.container, "c1");
      expect(commentEditor(rendered.container, "c1")).not.toBeNull();
      await typeInComposer(
        rendered.container,
        "c1",
        "First point about scope.\n\nSecond point about timing.",
      );
      await saveComposer(rendered.container, "c1");

      const saved = rendered.saved();
      expect(saved).toBe(
        [
          "Gamma paragraph proposes a {==two week pilot with three customers==}{#c1}.",
          "",
          "---",
          "comments:",
          "  c1:",
          '    body: "First point about scope.<br><br>Second point about timing."',
          "    by: user",
          `    at: "${parseReviewModel(saved).comments[0]?.at}"`,
          "",
        ].join("\n"),
      );
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);

      // Reloaded: one card, the two paragraphs shown with the break.
      const reloaded = await renderDocument(saved);
      await select(reloaded.getEditor(), "two week", "two week");
      const card =
        byTestId(reloaded.container, "comment-rail-c1") ??
        byTestId(reloaded.container, "comment-banner-c1");
      expect(card?.textContent).toContain(
        "First point about scope.\n\nSecond point about timing.",
      );
    });

    it.each([
      "<<}",
      "++}",
      "--}",
      "~~}",
      "==}",
    ])("refuses %s with a visible message and saves nothing", async (delimiter) => {
      const rendered = await renderDocument("Keep this sentence.\n");
      await select(rendered.getEditor(), "this", "sentence");
      await addComment(rendered.container);
      await typeInComposer(rendered.container, "c1", `Use ${delimiter} here.`);
      await saveComposer(rendered.container, "c1");

      const message =
        byTestId(rendered.container, "comment-rail-c1-error") ??
        byTestId(rendered.container, "comment-banner-c1-error");
      expect(message?.textContent).toContain(delimiter);
      expect(commentEditor(rendered.container, "c1")).not.toBeNull();
      for (const call of rendered.onSave.mock.calls) {
        expect(call[1]).not.toContain(delimiter);
      }

      // Fixing the text clears the message and saves.
      await typeInComposer(rendered.container, "c1", "Use this here.");
      expect(
        byTestId(rendered.container, "comment-rail-c1-error") ??
          byTestId(rendered.container, "comment-banner-c1-error"),
      ).toBeNull();
      await saveComposer(rendered.container, "c1");
      expect(rendered.saved()).toContain('body: "Use this here."');
    });
  });

  // The six browser-repro cases, created in the editor on the plain text.
  describe("cross-block selections", () => {
    it("case 1: two paragraphs are one comment, one entry, two anchors", async () => {
      const rendered = await renderDocument(
        [
          "# Case 1: two paragraphs",
          "",
          "Alpha paragraph says the launch moves to May and nothing else changes.",
          "",
          "Beta paragraph lists the owners for each step of the rollout.",
          "",
          "Tail line for the save trigger.",
          "",
        ].join("\n"),
      );
      await commentOn(
        rendered,
        "Alpha paragraph",
        "step of the rollout.",
        "c1",
        "These two paragraphs contradict the timeline doc. Reconcile them before Friday.",
      );

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain(
        "{==Alpha paragraph says the launch moves to May and nothing else changes.==}{#c1}\n\n{==Beta paragraph lists the owners for each step of the rollout.==}{#c1}",
      );
      expect(saved.match(/^ {2}c1:$/gm)).toHaveLength(1);
      expect(bodyOf(saved)).not.toContain("{>>");
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
    });

    it("case 2: heading, paragraph and list are one comment with continuations", async () => {
      const rendered = await renderDocument(
        [
          "# Case 2: heading, paragraph and list",
          "",
          "Intro sentence above the section.",
          "",
          "## Pre-flight",
          "",
          "The creator confirms the caption with ops before scheduling.",
          "",
          "- Caption matches the approved copy deck",
          "- Tracking link is the campaign short link",
          "- Pin window is agreed with the brand",
          "",
          "Tail line for the save trigger.",
          "",
        ].join("\n"),
      );
      await commentOn(
        rendered,
        "Pre-flight",
        "agreed with the brand",
        "c1",
        "Split these checks by owner; ops has been two people since May.",
      );

      const saved = rendered.saved();
      const body = bodyOf(saved);
      expect(body).toContain("## {==Pre-flight==}{#c1}");
      expect(body).toContain(
        "{==The creator confirms the caption with ops before scheduling.==}{#c1}",
      );
      expect(body).toContain(
        "- {==Caption matches the approved copy deck==}{#c1}",
      );
      expect(body).toContain(
        "- {==Pin window is agreed with the brand==}{#c1}",
      );
      // Heading, paragraph and three list items: one entry, five anchors.
      expect(body.match(/\{#c1\}/g)).toHaveLength(5);
      expect(saved.match(/^ {2}c1:$/gm)).toHaveLength(1);
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
    });

    it("case 3: mid paragraph to mid paragraph highlights only the selection", async () => {
      const rendered = await renderDocument(
        [
          "# Case 3: mid paragraph to mid paragraph",
          "",
          "First paragraph has an opening clause and a closing clause that runs on.",
          "",
          "Second paragraph starts with a lead phrase and ends with a trailing phrase.",
          "",
        ].join("\n"),
      );
      await commentOn(
        rendered,
        "a closing clause",
        "with a lead phrase",
        "c1",
        "The handoff between these two sentences is abrupt.",
      );

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain(
        "First paragraph has an opening clause and {==a closing clause that runs on.==}{#c1}\n\n{==Second paragraph starts with a lead phrase==}{#c1} and ends with a trailing phrase.",
      );
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
    });

    it("case 4: a comment body with a blank line stays one comment", async () => {
      const rendered = await renderDocument(
        [
          "# Case 4: comment body with a blank line",
          "",
          "Gamma paragraph proposes a two week pilot with three customers.",
          "",
        ].join("\n"),
      );
      await commentOn(
        rendered,
        "two week pilot",
        "three customers",
        "c1",
        "First point about scope.\n\nSecond point about timing.",
      );

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain(
        "{==two week pilot with three customers==}{#c1}.",
      );
      expect(saved).toContain(
        'body: "First point about scope.<br><br>Second point about timing."',
      );
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
    });

    it("case 5: a deletion across two paragraphs is one suggestion in two linked parts", async () => {
      const rendered = await renderDocument(
        [
          "# Case 5: suggested deletion across two paragraphs",
          "",
          "Keep this opening paragraph as it is.",
          "",
          "Delta paragraph repeats the budget numbers from the appendix.",
          "",
          "Epsilon paragraph repeats the timeline from the appendix.",
          "",
          "Tail line for the save trigger.",
          "",
        ].join("\n"),
        "suggesting",
      );
      await select(
        rendered.getEditor(),
        "Delta paragraph",
        "the timeline from the appendix.",
      );
      await nextFrame();
      const deletion = byTestId(
        document,
        "selection-menu-action-suggest-deletion",
      );
      vi.useFakeTimers();
      await act(async () => {
        if (deletion) {
          deletion.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        } else {
          rendered
            .getEditor()
            .view.someProp("handleKeyDown", (handler) =>
              handler(
                rendered.getEditor().view,
                new KeyboardEvent("keydown", { key: "Backspace" }),
              ),
            );
        }
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });
      vi.useRealTimers();

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain(
        "{--Delta paragraph repeats the budget numbers from the appendix.--}{#s1}\n\n{--Epsilon paragraph repeats the timeline from the appendix.--}{#s2}",
      );
      expect(saved).toMatch(
        / {2}s2:\n {4}by: user\n {4}at: "[^"]+"\n {4}continues: s1\n/,
      );
      expectCanonical(saved);
      expect(validateWithLegacyReader(saved).errors).toEqual([]);

      // Reloaded: the parts are one suggestion in the editor.
      const { doc } = criticMarkdownToEditorState(saved);
      const ids = new Set<string>();
      const visit = (node: typeof doc) => {
        for (const mark of node.marks ?? []) {
          if (mark.type === "criticChange") ids.add(mark.attrs?.changeId);
        }
        for (const child of node.content ?? []) visit(child);
      };
      visit(doc);
      expect([...ids]).toEqual(["s1"]);
    });

    it("case 6: two separate comments get two entries", async () => {
      const rendered = await renderDocument(
        [
          "# Case 6: two separate comments",
          "",
          "Zeta paragraph explains why the pilot is small.",
          "",
          "Eta paragraph explains who signs off on the pilot.",
          "",
        ].join("\n"),
      );
      await commentOn(
        rendered,
        "why the pilot is small",
        "why the pilot is small",
        "c1",
        "Say how small: number of customers.",
      );
      await commentOn(
        rendered,
        "who signs off",
        "who signs off",
        "c2",
        "Name the person, not the team.",
      );

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain(
        "Zeta paragraph explains {==why the pilot is small==}{#c1}.",
      );
      expect(bodyOf(saved)).toContain(
        "Eta paragraph explains {==who signs off==}{#c2} on the pilot.",
      );
      expectCanonical(saved);
      expectBothReaders(saved, ["c1", "c2"]);
    });
  });

  describe("comments on code", () => {
    const source = [
      "# Setup",
      "",
      "Run the server.",
      "",
      "```ts",
      'import { start } from "./server";',
      "",
      "const port = 3000;",
      "start({ port });",
      "```",
      "",
      "That is all.",
      "",
    ].join("\n");

    it("writes a fence-line ref with the selected lines and leaves the code alone", async () => {
      const rendered = await renderDocument(source);
      await commentOn(
        rendered,
        "port = 3000",
        "start({ port",
        "c1",
        "Read the port from the environment.",
      );

      const saved = rendered.saved();
      // The code is untouched; the ref sits on the fence line.
      expect(bodyOf(saved)).toBe(
        `${source.replace("```ts\n", "```ts {#c1}\n")}\n`,
      );
      expect(saved).toContain("    lines: [3, 4]");
      expect(saved).toContain(
        '    quote: "const port = 3000;\\nstart({ port });"',
      );
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
      const index = extractRoughdraftReviewIndex(saved);
      expect(index.items[0]).toMatchObject({ id: "c1", scope: "code" });
    });

    it("anchors a selection from prose into code on both, under one id", async () => {
      const rendered = await renderDocument(source);
      await commentOn(
        rendered,
        "the server.",
        "import { start }",
        "c1",
        "Name the module.",
      );

      const saved = rendered.saved();
      expect(bodyOf(saved)).toContain("Run {==the server.==}{#c1}");
      expect(bodyOf(saved)).toContain("```ts {#c1}\nimport { start }");
      expect(saved).toContain("    lines: [1, 1]");
      expectCanonical(saved);
      expectBothReaders(saved, ["c1"]);
    });

    it("drops the fence ref when the code comment is deleted", async () => {
      const rendered = await renderDocument(source);
      await commentOn(rendered, "port = 3000", "port = 3000", "c1", "Why?");
      expect(rendered.saved()).toContain("```ts {#c1}");

      const remove =
        byTestId(rendered.container, "comment-rail-c1-action-delete-thread") ??
        byTestId(rendered.container, "comment-banner-c1-action-delete-thread");
      vi.useFakeTimers();
      await act(async () => {
        remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });
      vi.useRealTimers();
      expect(rendered.saved()).toBe(source);
    });
  });

  it("keeps both ids where two selections overlap", async () => {
    const rendered = await renderDocument("Alpha beta gamma delta epsilon.\n");
    await commentOn(rendered, "beta", "gamma", "c1", "First.");
    await commentOn(rendered, "gamma", "delta", "c2", "Second.");

    const saved = rendered.saved();
    // c1 keeps "beta gamma", c2 gets "gamma delta"; "gamma" carries both.
    // (Spaces at the edge of a highlight are written outside it.)
    expect(bodyOf(saved)).toBe(
      "Alpha {==beta==}{#c1} {==gamma==}{#c1}{#c2} {==delta==}{#c2} epsilon.\n\n",
    );
    expectCanonical(saved);
    expectBothReaders(saved, ["c1", "c2"]);
    const index = extractRoughdraftReviewIndex(saved);
    expect(
      index.items.map((item) => [item.id, item.anchors.map((a) => a.text)]),
    ).toEqual([
      ["c1", ["beta", "gamma"]],
      ["c2", ["gamma", "delta"]],
    ]);
  });

  it("allocates new ids over every id in the file, entries it does not show included", async () => {
    // R15: an orphan `c2` entry (no anchor, no body) the editor never shows.
    const source = fixture("probe-R15-orphan-resolved-entry");
    expect(source).toContain("  c2:");
    expect(parseReviewModel(source).orphans.map((orphan) => orphan.id)).toEqual(
      ["c2"],
    );
    const rendered = await renderDocument(
      `${source.split("\n---\n")[0]}\n\nA fresh line to comment on.\n\n---\n${source.split("\n---\n")[1]}`,
    );
    await select(rendered.getEditor(), "fresh line", "fresh line");
    await addComment(rendered.container);
    // c1 and the orphan c2 are taken: the new comment is c3.
    expect(commentEditor(rendered.container, "c2")).toBeNull();
    expect(commentEditor(rendered.container, "c3")).not.toBeNull();
  });

  it("replies go to the review block, never onto a mark", async () => {
    const source = fixture("canonical-prose-anchor");
    const rendered = await renderDocument(source);
    await select(rendered.getEditor(), "the caption", "the caption");
    const reply =
      byTestId(rendered.container, "comment-rail-c1-action-reply") ??
      byTestId(rendered.container, "comment-banner-c1-action-reply");
    expect(reply).not.toBeNull();
    await act(async () => {
      reply?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    // c1, a1 and c2 are taken.
    const replyId = "c3";
    await typeInComposer(rendered.container, replyId, "On it.");
    await saveComposer(rendered.container, replyId);

    const saved = rendered.saved();
    expect(bodyOf(saved)).toBe(bodyOf(source));
    expect(saved).toMatch(
      new RegExp(
        `  ${replyId}:\\n    body: "On it\\."\\n    by: user\\n    at: "[^"]+"\\n    re: c1\\n`,
      ),
    );
    expectCanonical(saved);
  });

  it("keeps unknown keys, extra top-level keys, status and resolved when it adds a comment", async () => {
    const source = [
      "Keep {==this==}{#c1} and {==that==}{#c2}.",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Check the numbers."',
      "    by: user",
      '    at: "2026-10-05T09:00:00.000Z"',
      "    priority: high",
      "    tags: [budget, q4]",
      "  c2:",
      '    body: "Done already."',
      "    by: user",
      '    at: "2026-10-05T09:01:00.000Z"',
      "    status: resolved",
      '    resolved: "Fixed in the intro."',
      "workflow:",
      "  owner: editorial",
      "",
    ].join("\n");
    const rendered = await renderDocument(source);
    await commentOn(rendered, "Keep", "Keep", "c3", "New one.");

    const saved = rendered.saved();
    const existingEntries = source.slice(
      source.indexOf("comments:\n"),
      source.indexOf("workflow:"),
    );
    expect(saved).toContain(existingEntries);
    expect(saved).toContain(
      '  c3:\n    body: "New one."\n    by: user\n    at: "',
    );
    expect(saved.endsWith("workflow:\n  owner: editorial\n")).toBe(true);
    expectCanonical(saved);
  });

  describe("files in an older review format (D11)", () => {
    it("shows the notice and saves an unrelated edit with every review byte unchanged", async () => {
      const source = fixture("repro-case2-ui-saved");
      const rendered = await renderDocument(source);
      expect(
        byTestId(rendered.container, "review-format-notice")?.textContent,
      ).toBe(
        "This file uses an older review format. Run roughdraft doctor --fix to convert it.",
      );
      expect(REVIEW_FORMAT_NOTICE).toBe(
        "This file uses an older review format. Run roughdraft doctor --fix to convert it.",
      );

      vi.useFakeTimers();
      await act(async () => {
        const editor = rendered.getEditor();
        const at = textPosition(editor, "Intro sentence", "start");
        editor.chain().focus().insertContentAt(at, "New ").run();
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });
      vi.useRealTimers();

      expect(rendered.saved()).toBe(
        source.replace("Intro sentence", "New Intro sentence"),
      );
    });

    it("writes a new comment in the shape the file already uses", async () => {
      const source = fixture("repro-case6-ui-saved");
      const rendered = await renderDocument(source);
      await commentOn(
        rendered,
        "Tail line",
        "Tail line",
        "c3",
        "Two lines\nhere.",
      );

      const saved = rendered.saved();
      expect(saved).toMatch(
        /\{==Tail line==\}\{>>Two lines<br>here\.<<\}\{id="c3" by="user" at="[^"]+"\}/,
      );
      // Everything that was there is unchanged.
      expect(
        saved.replace(/\{==Tail line==\}\{>>[^}]+\}\{[^}]+\}/, "Tail line"),
      ).toBe(source);
      expect(saved).not.toContain("\n---\n");
      expect(validateRoughdraftMarkdown(saved).errors).toEqual([]);
    });

    it("does not comment on code in an older-format file and says why", async () => {
      const source = [
        'Keep {==this==}{>>Old comment.<<}{id="c1" by="user" at="2026-10-01T00:00:00.000Z"}.',
        "",
        "```ts",
        "const port = 3000;",
        "```",
        "",
      ].join("\n");
      const rendered = await renderDocument(source);
      await select(rendered.getEditor(), "port = 3000", "port = 3000");
      await addComment(rendered.container);
      expect(
        byTestId(rendered.container, "review-format-code-comment-message"),
      ).not.toBeNull();
      expect(commentEditor(rendered.container, "c2")).toBeNull();
    });
  });

  it("saves a canonical file holding every item kind byte for byte after an edit that is undone", async () => {
    const source = [
      "# Plan",
      "",
      "Keep {==this claim==}{#c1} and add {++one example++}{#s1}.",
      "",
      "## {==Pre-flight==}{#c2}",
      "",
      "- {==Caption matches the deck==}{#c2}",
      "",
      "The pilot runs two weeks.{#c3}",
      "",
      "{--Delta repeats the appendix.--}{#s2}",
      "",
      "{--Epsilon repeats the appendix.--}{#s3}",
      "",
      "```ts {#c4}",
      "const port = 3000;",
      "start({ port });",
      "```",
      "",
      "---",
      "comments:",
      "  c1:",
      '    body: "Needs a source.<br><br>Two of them."',
      "    by: user",
      '    at: "2026-10-05T09:00:00.000Z"',
      "    status: resolved",
      '    resolved: "Added."',
      "  c2:",
      '    body: "Split by owner."',
      "    by: user",
      '    at: "2026-10-05T09:01:00.000Z"',
      "  c3:",
      '    body: "Name the customers."',
      "    by: user",
      '    at: "2026-10-05T09:02:00.000Z"',
      "  c4:",
      '    body: "Read the port from the environment."',
      "    by: user",
      '    at: "2026-10-05T09:03:00.000Z"',
      "    lines: [1, 1]",
      '    quote: "const port = 3000;"',
      "  c5:",
      '    body: "Overall this reads well."',
      "    by: user",
      '    at: "2026-10-05T09:04:00.000Z"',
      "    scope: document",
      "  a1:",
      '    body: "Added two sources."',
      "    by: AI",
      '    at: "2026-10-05T10:00:00.000Z"',
      "    re: c1",
      "  c6:",
      '    body: "Why this one?"',
      "    by: user",
      '    at: "2026-10-05T09:05:00.000Z"',
      "    re: s1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-10-05T08:00:00.000Z"',
      "  s2:",
      "    by: user",
      '    at: "2026-10-05T08:01:00.000Z"',
      "  s3:",
      "    by: user",
      '    at: "2026-10-05T08:01:00.000Z"',
      "    continues: s2",
      "",
    ].join("\n");
    expectCanonical(source);

    const rendered = await renderDocument(source);
    expect(byTestId(rendered.container, "review-format-notice")).toBeNull();
    vi.useFakeTimers();
    await act(async () => {
      const editor = rendered.getEditor();
      const at = textPosition(editor, "The pilot", "start");
      editor.chain().focus().insertContentAt(at, "X").run();
    });
    await act(async () => {
      const editor = rendered.getEditor();
      const at = textPosition(editor, "XThe pilot", "start");
      editor
        .chain()
        .focus()
        .deleteRange({ from: at, to: at + 1 })
        .run();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    vi.useRealTimers();

    expect(rendered.saved()).toBe(source);
  });

  it("shows the global comment the Done box writes after the reload", async () => {
    // The server writes it with rfm's writer (this batch leaves that route
    // as it is); the browser reads it back in the global section.
    const source = fixture("canonical-prose-anchor");
    const withDone = appendRoughdraftDocumentComment(source, {
      message: "Left comments, please review.\nTwo of them are urgent.",
      author: "user",
      at: "2026-10-06T00:00:00.000Z",
    });
    expectCanonical(withDone);

    const rendered = await renderDocument(withDone);
    const global =
      byTestId(rendered.container, "document-comments-section") ??
      byTestId(rendered.container, "document-comment-fallback-global");
    expect(global?.textContent).toContain(
      "Left comments, please review.\nTwo of them are urgent.",
    );

    // An unrelated save keeps it as the server wrote it.
    const { doc, comments, ...rest } = criticMarkdownToEditorState(withDone);
    expect(editorStateToCriticMarkdown(doc, comments, rest)).toBe(withDone);
  });
});
