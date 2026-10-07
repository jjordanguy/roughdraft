import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diffSequences } from "@roughdraft/rfm";
import { basicSetup } from "codemirror";
import { type RefObject, useEffect, useRef } from "react";
import { cn } from "./lib/utils";

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
  // Receives a function that replaces the document with new text in place
  // (only the changed range), keeping the selection and focus.
  externalApplyRef?: RefObject<((value: string) => boolean) | null>;
  // "show me" on the Updated from disk notice: scroll to the last change
  // applied through `externalApplyRef`.
  revealRequest?: { key: number } | null;
}

// The smallest single replacement that turns `current` into `next`, so a
// cursor outside the changed range stays where it was.
export function minimalChange(current: string, next: string) {
  const limit = Math.min(current.length, next.length);
  let from = 0;
  while (from < limit && current.charCodeAt(from) === next.charCodeAt(from)) {
    from += 1;
  }
  let suffix = 0;
  while (
    suffix < limit - from &&
    current.charCodeAt(current.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    from,
    to: current.length - suffix,
    insert: next.slice(from, next.length - suffix),
  };
}

// One change per changed run of lines, each narrowed to its common prefix
// and suffix, so a cursor between two separate changes from disk stays
// where it was (a single replacement would swallow it).
export function lineChanges(current: string, next: string) {
  // Lines with their line breaks, so the last line without one differs
  // from the same line with one.
  const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const offsetsOf = (lines: string[]) => {
    const offsets = [0];
    for (const line of lines) {
      offsets.push((offsets.at(-1) ?? 0) + line.length);
    }
    return offsets;
  };
  const a = linesOf(current);
  const b = linesOf(next);
  const offsetsA = offsetsOf(a);
  const offsetsB = offsetsOf(b);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const hunk of diffSequences(a, b)) {
    const fromA = offsetsA[hunk.aStart] ?? current.length;
    const toA = offsetsA[hunk.aEnd] ?? current.length;
    const fromB = offsetsB[hunk.bStart] ?? next.length;
    const toB = offsetsB[hunk.bEnd] ?? next.length;
    const change = minimalChange(
      current.slice(fromA, toA),
      next.slice(fromB, toB),
    );
    changes.push({
      from: fromA + change.from,
      to: fromA + change.to,
      insert: change.insert,
    });
  }
  return changes;
}

function replaceInPlace(
  view: EditorView,
  value: string,
  lastValueRef: { current: string },
) {
  const currentValue = view.state.doc.toString();
  lastValueRef.current = value;
  if (currentValue === value) return;
  view.dispatch({ changes: lineChanges(currentValue, value) });
}

export function createMarkdownCodeEditorExtensions(
  readOnly: boolean,
  onDocumentChange: (value: string) => void,
  lastValueRef: { current: string },
): Extension[] {
  return [
    basicSetup,
    yamlFrontmatter({ content: markdown() }),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const nextValue = update.state.doc.toString();
      if (nextValue === lastValueRef.current) return;

      lastValueRef.current = nextValue;
      onDocumentChange(nextValue);
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "inherit",
        fontFamily:
          'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "0.95rem",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.75",
        overflow: "auto",
      },
      ".cm-content": {
        minHeight: "70vh",
        padding: "0",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "rgb(148 163 184)",
        marginRight: "0.75rem",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--cm-selection-bg, rgb(224 242 254))",
      },
      ".cm-gutterElement": {
        padding: "0 0.5rem 0 0",
      },
      ".cm-foldGutter": {
        display: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "rgb(100 116 139)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}

export function MarkdownCodeEditor({
  value,
  onChange,
  autoFocus = false,
  readOnly = false,
  className,
  testId,
  externalApplyRef,
  revealRequest = null,
}: MarkdownCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lastExternalChangeRef = useRef<{ from: number; to: number } | null>(
    null,
  );
  const editorViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const lastValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;

    const view = new EditorView({
      parent: hostElement,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: createMarkdownCodeEditorExtensions(
          readOnly,
          (nextValue) => onChangeRef.current(nextValue),
          lastValueRef,
        ),
      }),
    });

    editorViewRef.current = view;
    lastValueRef.current = view.state.doc.toString();

    if (autoFocus) {
      view.focus();
    }

    return () => {
      editorViewRef.current = null;
      view.destroy();
    };
  }, [autoFocus, readOnly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    replaceInPlace(view, value, lastValueRef);
  }, [value]);

  useEffect(() => {
    if (!externalApplyRef) return;
    const apply = (nextValue: string) => {
      const view = editorViewRef.current;
      if (!view) return false;
      const currentValue = view.state.doc.toString();
      if (currentValue !== nextValue) {
        const change = minimalChange(currentValue, nextValue);
        lastExternalChangeRef.current = {
          from: change.from,
          to: change.from + change.insert.length,
        };
      }
      replaceInPlace(view, nextValue, lastValueRef);
      return true;
    };
    externalApplyRef.current = apply;
    return () => {
      if (externalApplyRef.current === apply) externalApplyRef.current = null;
    };
  }, [externalApplyRef]);

  const revealKey = revealRequest?.key ?? null;
  useEffect(() => {
    const view = editorViewRef.current;
    const range = lastExternalChangeRef.current;
    if (revealKey === null || !view || !range) return;
    const size = view.state.doc.length;
    const from = Math.min(range.from, size);
    view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [revealKey]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
