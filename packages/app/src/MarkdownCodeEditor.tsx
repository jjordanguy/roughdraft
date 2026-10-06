import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

function replaceInPlace(
  view: EditorView,
  value: string,
  lastValueRef: { current: string },
) {
  const currentValue = view.state.doc.toString();
  lastValueRef.current = value;
  if (currentValue === value) return;
  view.dispatch({ changes: minimalChange(currentValue, value) });
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
}: MarkdownCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
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
      replaceInPlace(view, nextValue, lastValueRef);
      return true;
    };
    externalApplyRef.current = apply;
    return () => {
      if (externalApplyRef.current === apply) externalApplyRef.current = null;
    };
  }, [externalApplyRef]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
