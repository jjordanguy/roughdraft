import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  createMarkdownCodeEditorExtensions,
  lineChanges,
} from "./MarkdownCodeEditor";

describe("createMarkdownCodeEditorExtensions", () => {
  it("loads YAML frontmatter and Markdown content without rewriting the document", () => {
    const input = "---\ntitle: Code mode\n---\n\n# Body\n";
    const onChange = vi.fn();
    const state = EditorState.create({
      doc: input,
      extensions: createMarkdownCodeEditorExtensions(false, onChange, {
        current: input,
      }),
    });

    expect(state.doc.toString()).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("lineChanges", () => {
  it("keeps a cursor between two separate changes from disk in place", () => {
    const current = "# Plan\n\nOne.\n\nTwo, mine.\n\nThree.\n";
    const next = "# Plan, agent\n\nOne.\n\nTwo, mine.\n\nThree, agent.\n";
    const cursor = current.indexOf("mine") + "mine".length;
    const state = EditorState.create({
      doc: current,
      selection: { anchor: cursor },
    });

    const transaction = state.update({ changes: lineChanges(current, next) });

    expect(transaction.state.doc.toString()).toBe(next);
    const head = transaction.state.selection.main.head;
    expect(next.slice(head - "mine".length, head)).toBe("mine");
  });

  it("turns any text into any other", () => {
    const pairs: Array<[string, string]> = [
      ["", "a\nb"],
      ["a\nb", ""],
      ["a\nb\nc", "a\nc"],
      ["a\nb", "a\nb\n"],
      ["x\n", "y"],
    ];
    for (const [current, next] of pairs) {
      const state = EditorState.create({ doc: current });
      expect(
        state
          .update({ changes: lineChanges(current, next) })
          .state.doc.toString(),
      ).toBe(next);
    }
  });
});
