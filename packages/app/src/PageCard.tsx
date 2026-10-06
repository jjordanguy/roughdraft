import type { JSONContent } from "@tiptap/core";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { AlertTriangle, Info, RefreshCcw } from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { CommentEditorList } from "./CommentEditorList";
import { Button } from "./components/ui/button";
import {
  type CriticChangeAttrs,
  type CriticComment,
  createCriticChange,
  createCriticComment,
  criticMarkdownHasReviewRail,
  findReviewDelimiter,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
  getReviewBlockError,
  getReviewFormat,
  getThreadComments,
  REVIEW_FORMAT_NOTICE,
  type ReviewFormat,
} from "./critic-markup";
import {
  type CommentThreadHandlers,
  type CriticChangeRailItem,
  DocumentReviewRail,
  GlobalCommentsSection,
  getGlobalThreadRoots,
  isGlobalSectionRoot,
} from "./DocumentReviewRail";
import {
  getPreferredCommentId,
  getRootThreadIdForCommentId,
  parseCommentIds,
} from "./document-comments";
import type { DocumentSync } from "./document-sync";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
  criticChangeHighlightPluginKey,
  parseCodeCommentAnchors,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { toHtml } from "./markdown";
import type { Page, StorageBackend } from "./storage";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";
import { useReviewLayoutShiftAnimation } from "./useReviewLayoutShiftAnimation";

// "offline": the save failed and the sync controller is retrying it.
export type DocumentSaveState =
  | "saved"
  | "unsaved"
  | "saving"
  | "error"
  | "offline";

// Set by an editor surface: applies new markdown without remounting so the
// selection and focus stay. Returns false when the editor is not ready.
export type ExternalContentApplier = (markdown: string) => boolean;

export type ManualSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "error"; error: unknown };

export interface DocumentSaveController {
  flushSave: () => Promise<ManualSaveResult>;
}

// What the workspace asks of the review rail: Done saves an open global
// comment draft first. False when a draft could not be saved (its text has
// a review-markup delimiter); the composer stays open and says why.
export interface DocumentReviewController {
  saveOpenGlobalDrafts: () => boolean;
}

type EditorViewMode = "rich-text" | "code";
export type DocumentInteractionMode = "viewing" | "suggesting" | "editing";

interface PageCardProps {
  page: Page;
  activeDocumentPath?: string | null;
  selected?: boolean;
  layout?: "default" | "embedded-demo";
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
  // When set, the controller owns saving, the draft and disk updates; `page`
  // only gives the id and the content at mount.
  sync?: DocumentSync | null;
  // A request from the Global comment button: the rich-text surface opens
  // a draft at the top of the global section, then reports it handled.
  globalCommentRequest?: number | null;
  onGlobalCommentRequestHandled?: () => void;
  onReviewControllerChange?: (
    controller: DocumentReviewController | null,
  ) => void;
}

interface GlobalCommentProps {
  globalCommentRequest?: number | null;
  onGlobalCommentRequestHandled?: () => void;
  onReviewControllerChange?: (
    controller: DocumentReviewController | null,
  ) => void;
}

interface PageCardEditorSurfaceProps extends GlobalCommentProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
  sync?: DocumentSync | null;
}

interface RestoreSelectionRequest {
  key: string;
  from: number;
  to: number;
}

interface RichTextEditorSurfaceProps extends GlobalCommentProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  externalApplyRef?: RefObject<ExternalContentApplier | null>;
  restoreSelection?: RestoreSelectionRequest | null;
  notice?: ReactNode;
}

interface CodeEditorSurfaceProps {
  notice?: ReactNode;
  markdown: string;
  hasCommentRailSpace: boolean;
  interactionMode: DocumentInteractionMode;
  layout: "default" | "embedded-demo";
  onMarkdownChange: (markdown: string) => void;
  externalApplyRef?: RefObject<ExternalContentApplier | null>;
}

export interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentRef").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentRef") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentRef") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function getSelectionCriticChangeIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directChangeId = editor.getAttributes("criticChange").changeId;

  if (typeof directChangeId === "string" && directChangeId.length > 0) {
    return [directChangeId];
  }

  const { from, to, empty, $from } = editor.state.selection;
  const changeIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId === "string") {
        changeIds.add(mark.attrs.changeId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "criticChange") continue;
        if (typeof mark.attrs.changeId === "string") {
          changeIds.add(mark.attrs.changeId);
        }
      }
    });
  }

  return [...changeIds];
}

function getPreferredCriticChangeId(
  changeIds: string[],
  currentChangeId: string | null,
): string | null {
  if (currentChangeId && changeIds.includes(currentChangeId)) {
    return currentChangeId;
  }

  return changeIds[0] ?? null;
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    ".comment-anchor[data-comment-ids]",
  );

  return (
    [...anchors].find((anchor) =>
      parseCommentIds(anchor.dataset.commentIds).includes(commentId),
    ) ?? null
  );
}

function documentHasCommentMark(editor: Editor, commentId: string) {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (
      node.isText &&
      node.marks.some(
        (mark) =>
          mark.type.name === "commentRef" &&
          Array.isArray(mark.attrs.commentIds) &&
          mark.attrs.commentIds.includes(commentId),
      )
    ) {
      found = true;
    }
    return undefined;
  });
  return found;
}

// Adds a comment id to every piece of the selection that can carry a comment,
// keeping the ids each piece already has (add, do not overwrite).
function addCommentIdToSelection(editor: Editor, commentId: string) {
  const markType = editor.state.schema.marks.commentRef;
  if (!markType) return;

  const { from, to } = editor.state.selection;
  const tr = editor.state.tr;

  editor.state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !parent?.type.allowsMarkType(markType)) return;

    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    if (start >= end) return;

    const mark = node.marks.find((candidate) => candidate.type === markType);
    const commentIds = Array.isArray(mark?.attrs.commentIds)
      ? (mark.attrs.commentIds as string[])
      : [];
    const refOnlyIds = Array.isArray(mark?.attrs.refOnlyIds)
      ? (mark.attrs.refOnlyIds as string[])
      : [];
    tr.addMark(
      start,
      end,
      markType.create({
        ...mark?.attrs,
        commentIds: [...new Set([...commentIds, commentId])],
        refOnlyIds,
      }),
    );
  });

  editor.view.dispatch(tr);
  editor.commands.focus();
}

// Ids the loaded file uses (entries the editor does not show included),
// per editor, so new suggestion ids never reuse one.
const reservedIdsByEditor = new WeakMap<Editor, readonly string[]>();

function getDocumentCriticChanges(
  editor: Editor,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const changes = new Map<string, Pick<CriticChangeAttrs, "changeId">>();
  for (const id of reservedIdsByEditor.get(editor) ?? []) {
    changes.set(id, { changeId: id });
  }

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId !== "string") continue;

      changes.set(mark.attrs.changeId, { changeId: mark.attrs.changeId });
      // A later part of a suggestion over several blocks has its own id.
      if (typeof mark.attrs.partId === "string" && mark.attrs.partId) {
        changes.set(mark.attrs.partId, { changeId: mark.attrs.partId });
      }
    }
  });

  return [...changes.values()];
}

function getReusableSuggestionInputMark(
  editor: Editor,
  position: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableSuggestionMark = (mark: ProseMirrorMark) =>
    mark.type === markType &&
    (mark.attrs.kind === "addition" || mark.attrs.kind === "substitution-new");
  const $position = editor.state.doc.resolve(position);
  const previousMark = $position.nodeBefore?.marks.find(
    isReusableSuggestionMark,
  );

  if (previousMark) return previousMark;

  return $position.nodeAfter?.marks.find(isReusableSuggestionMark) ?? null;
}

function getReusableSuggestionDeletionMark(
  editor: Editor,
  from: number,
  to: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableDeletionMark = (mark: ProseMirrorMark) =>
    mark.type === markType && mark.attrs.kind === "deletion";
  const beforeRange = editor.state.doc
    .resolve(from)
    .nodeBefore?.marks.find(isReusableDeletionMark);

  if (beforeRange) return beforeRange;

  return (
    editor.state.doc
      .resolve(to)
      .nodeAfter?.marks.find(isReusableDeletionMark) ?? null
  );
}

function getDocumentCriticChangeRailItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, CriticComment>,
): CriticChangeRailItem[] {
  if (!editor) return [];

  const changes = new Map<string, CriticChangeRailItem>();
  const anchors = new Map<
    string,
    {
      anchorTop: number;
      anchorBottom: number;
    }
  >();
  let editorElement: HTMLElement;

  try {
    editorElement = editor.view.dom as HTMLElement;
  } catch {
    return [];
  }

  const changeElements = editorElement.querySelectorAll<HTMLElement>(
    ".critic-change[data-critic-change-id]",
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of changeElements) {
    const changeId = element.dataset.criticChangeId;
    if (!changeId) continue;

    const rect = element.getBoundingClientRect();
    const existing = anchors.get(changeId);
    const anchorTop = rect.top - editorRect.top;
    const anchorBottom = rect.bottom - editorRect.top;

    if (existing) {
      existing.anchorTop = Math.min(existing.anchorTop, anchorTop);
      existing.anchorBottom = Math.max(existing.anchorBottom, anchorBottom);
    } else {
      anchors.set(changeId, {
        anchorTop,
        anchorBottom,
      });
    }
  }

  editor.state.doc.descendants((node) => {
    if (!node.isText || !node.text) return;

    const changeMark = node.marks.find(
      (mark) =>
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string",
    );
    if (!changeMark) return;

    const change = changeMark.attrs as CriticChangeAttrs;
    const changeId = change.changeId;
    const kind =
      change.kind === "substitution-new" ? "substitution-old" : change.kind;
    const existing =
      changes.get(changeId) ??
      ({
        changeId,
        change,
        kind,
        oldText: "",
        newText: "",
        commentIds: [],
        anchorTop: anchors.get(changeId)?.anchorTop ?? 0,
        anchorBottom: anchors.get(changeId)?.anchorBottom ?? 24,
      } satisfies CriticChangeRailItem);

    existing.change = {
      ...change,
      kind,
    };
    existing.kind = kind;

    if (change.kind === "addition" || change.kind === "substitution-new") {
      existing.newText += node.text;
    } else {
      existing.oldText += node.text;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentRef") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    changes.set(changeId, existing);
  });

  for (const change of changes.values()) {
    const rootCommentIds = [...comments.values()]
      .filter((comment) => comment.parentCommentId === change.changeId)
      .map((comment) => comment.id);
    const descendantIds = rootCommentIds.flatMap((commentId) =>
      getCommentDescendantIds(commentId, comments),
    );

    change.commentIds = [
      ...new Set([...change.commentIds, ...rootCommentIds, ...descendantIds]),
    ];
  }

  return [...changes.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

function getCriticChangeRange(editor: Editor | null, changeId: string) {
  if (!editor) return null;

  let from: number | null = null;
  let to: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    from = from == null ? pos : Math.min(from, pos);
    to = to == null ? pos + node.nodeSize : Math.max(to, pos + node.nodeSize);
  });

  if (from == null || to == null) return null;

  return { from, to };
}

// The first fenced code block a selection reaches into: its position and the
// selected lines (1-based, inclusive, counted inside the block) with their
// text. Code takes no marks; a comment on code is a ref on the fence line
// plus `lines` and `quote` in the comment's entry.
function findCodeBlockSelection(editor: Editor): {
  pos: number;
  lines: [number, number];
  quote: string;
} | null {
  const { from, to } = editor.state.selection;
  let found: { pos: number; lines: [number, number]; quote: string } | null =
    null;

  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.type.name !== "codeBlock") return undefined;

    const start = pos + 1;
    const end = start + node.content.size;
    const selectedFrom = Math.max(from, start) - start;
    const selectedTo = Math.min(to, end) - start;
    if (selectedTo <= selectedFrom) return false;

    const text = node.textContent;
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
    const first = lineOf(selectedFrom);
    const last = Math.max(
      first,
      lineOf(Math.max(selectedFrom, selectedTo - 1)),
    );
    found = {
      pos,
      lines: [first, last],
      quote: text
        .split("\n")
        .slice(first - 1, last)
        .join("\n"),
    };
    return false;
  });

  return found;
}

function codeBlockAnchorsOf(node: ProseMirrorNode) {
  return parseCodeCommentAnchors(
    typeof node.attrs.codeAnchors === "string" ? node.attrs.codeAnchors : null,
  );
}

// Puts a comment's ref on a code block's fence line (```ts {#c3}) and
// highlights its lines.
function addCodeCommentAnchor(
  editor: Editor,
  pos: number,
  commentId: string,
  lines: [number, number],
) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "codeBlock") return false;

  const base =
    (typeof node.attrs.info === "string" && node.attrs.info) ||
    (typeof node.attrs.language === "string" && node.attrs.language) ||
    "";
  const anchors = codeBlockAnchorsOf(node).filter(
    (anchor) => anchor.id !== commentId,
  );
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      info: `${base} {#${commentId}}`,
      codeAnchors: JSON.stringify([...anchors, { id: commentId, lines }]),
    }),
  );
  return true;
}

// Takes a deleted comment's ref off every fence line that carried it.
function removeCodeCommentAnchors(editor: Editor, commentIds: string[]) {
  const ids = new Set(commentIds);
  const tr = editor.state.tr;
  let changed = false;

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return undefined;
    const anchors = codeBlockAnchorsOf(node);
    if (!anchors.some((anchor) => ids.has(anchor.id))) return false;

    let info = typeof node.attrs.info === "string" ? node.attrs.info : "";
    for (const id of ids) {
      info = info.replace(new RegExp(`[ \\t]*\\{#${id}\\}`), "");
    }
    const remaining = anchors.filter((anchor) => !ids.has(anchor.id));
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      info: info || null,
      codeAnchors: remaining.length > 0 ? JSON.stringify(remaining) : null,
    });
    changed = true;
    return false;
  });

  if (changed) editor.view.dispatch(tr);
  return changed;
}

function documentSourceOf(
  parsed: ReturnType<typeof criticMarkdownToEditorState>,
) {
  return {
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
    preservedEntryIds: parsed.preservedEntryIds,
    looseHeadings: parsed.looseHeadings,
    legacyListSpacing: parsed.legacyListSpacing,
    reviewError: parsed.reviewError,
    // Which writer the file gets (D11), fixed for this load.
    reviewFormat: parsed.reviewFormat,
    // Every id the file uses: new comments and suggestions avoid them.
    reservedIds: parsed.reservedIds,
  };
}

// New ids are allocated over the union of every id in the file (anchors,
// entries the editor does not show, suggestions) and every comment made
// since, so an orphan entry's id is never reused.
function reviewIdsInUse(
  comments: ReadonlyMap<string, CriticComment>,
  reservedIds: readonly string[],
): Array<Pick<CriticComment, "id">> {
  return [
    ...comments.keys(),
    ...reservedIds.filter((id) => !comments.has(id)),
  ].map((id) => ({ id }));
}

// Comments the rail can show (markup the editor keeps literal does not count).
function hasVisibleComments(comments: ReadonlyMap<string, CriticComment>) {
  for (const comment of comments.values()) {
    if (!comment.literal) return true;
  }
  return false;
}

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    '[data-comment-thread-container="true"], [data-suggestion-thread-container="true"], .comment-anchor[data-comment-ids], .critic-change[data-critic-change-id]',
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  externalApplyRef,
  restoreSelection = null,
  notice = null,
  globalCommentRequest = null,
  onGlobalCommentRequestHandled,
  onReviewControllerChange,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const criticChangeFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [criticChanges, setCriticChanges] = useState<CriticChangeRailItem[]>(
    [],
  );
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);
  const [newCommentDraftIds, setNewCommentDraftIds] = useState<string[]>([]);
  // A comment on code was asked for on an older-format file.
  const [codeCommentRefused, setCodeCommentRefused] = useState(false);
  // A global comment was asked for on an older-format file with no review
  // block (nothing converts on save, so there is nowhere to put it).
  const [globalCommentRefused, setGlobalCommentRefused] = useState(false);
  // The text typed in each open composer (Done saves an open global draft).
  const draftTextsRef = useRef(new Map<string, string>());

  const resolveFileUrl = useCallback(
    (path: string) => backend.resolveFileUrl(path),
    [backend],
  );
  const resolveLinkUrl = useCallback(
    (path: string) =>
      buildLocationForLinkedMarkdownDocument({
        projectPath: backend.info.projectPath,
        currentDocumentPath: activeDocumentPath,
        href: path,
      }),
    [activeDocumentPath, backend],
  );

  const parsedContent = useMemo(
    () =>
      criticMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      }),
    [resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [comments, setComments] = useState<Map<string, CriticComment>>(
    () => parsedContent.comments,
  );
  // What the load keeps beside the editor for the next save: frontmatter,
  // the review block (never in the editor), entries the editor does not show,
  // the file's spacing style, and whether the review block could be read.
  const sourceRef = useRef(documentSourceOf(parsedContent));

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    onCommentRailPresenceChange?.(
      hasVisibleComments(comments) || criticChanges.length > 0,
    );
  }, [comments, criticChanges.length, onCommentRailPresenceChange]);

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return;

      // A review block that could not be read is never rewritten: the
      // serializer does not run on such a document.
      if (sourceRef.current.reviewError) return;

      onMarkdownChange(
        editorStateToCriticMarkdown(
          currentDoc,
          nextComments ?? commentsRef.current,
          sourceRef.current,
        ),
      );
    },
    [onMarkdownChange],
  );

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || files.length === 0) return;

      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${asset.markdownPath})`;
          }
          return `[${file?.name || "Attachment"}](${asset.markdownPath})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(markdown, {
            resolveFileUrl,
            resolveLinkUrl,
          }),
        )
        .run();
    },
    [backend, resolveFileUrl, resolveLinkUrl],
  );

  const refreshCriticChanges = useCallback(() => {
    if (criticChangeFrameRef.current != null) {
      cancelAnimationFrame(criticChangeFrameRef.current);
    }

    criticChangeFrameRef.current = requestAnimationFrame(() => {
      criticChangeFrameRef.current = null;
      setCriticChanges(
        getDocumentCriticChangeRailItems(
          editorRef.current,
          commentsRef.current,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      if (criticChangeFrameRef.current != null) {
        cancelAnimationFrame(criticChangeFrameRef.current);
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing..."),
      content: parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: "tiptap min-h-[70vh]",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }

          if (interactionModeRef.current !== "suggesting") return false;

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          event.preventDefault();

          const { selection } = view.state;
          const from = selection.from;
          const to = selection.to;
          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (interactionModeRef.current !== "suggesting") return false;
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.key === "Enter") {
            event.preventDefault();

            const currentEditor = editorRef.current;
            if (!currentEditor) return true;

            const { selection } = view.state;
            if (!selection.empty) return true;

            const $from = selection.$from;
            if (!$from.parent.isTextblock) return true;
            if ($from.parentOffset !== $from.parent.content.size) return true;

            const change = createCriticChange("addition", undefined, {
              existingChanges: getDocumentCriticChanges(currentEditor),
            });
            const mark = view.state.schema.marks.criticChange.create(change);
            const tr = view.state.tr.split(selection.from);
            const insertPos = tr.selection.from;

            tr.insert(
              insertPos,
              view.state.schema.text(SUGGESTED_PARAGRAPH_SENTINEL, [mark]),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                insertPos + SUGGESTED_PARAGRAPH_SENTINEL.length,
              ),
            );
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          }

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (selection.empty) return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to);
            void navigator.clipboard.writeText(selectedText);

            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const tr = view.state.tr;
            for (const seg of [...segments].reverse()) {
              if (seg.isAddition) {
                tr.delete(seg.from, seg.to);
              } else {
                const deletionMark =
                  getReusableSuggestionDeletionMark(
                    currentEditor,
                    seg.from,
                    seg.to,
                  ) ??
                  view.state.schema.marks.criticChange.create(
                    createCriticChange("deletion", undefined, {
                      existingChanges: getDocumentCriticChanges(currentEditor),
                    }),
                  );
                tr.addMark(seg.from, seg.to, deletionMark);
              }
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          if (event.key !== "Backspace" && event.key !== "Delete") return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const { selection } = view.state;
          let from = selection.from;
          let to = selection.to;

          if (selection.empty) {
            const $pos = view.state.doc.resolve(selection.from);
            const blockStart = $pos.start($pos.depth);
            const blockEnd = $pos.end($pos.depth);

            if (event.key === "Backspace") {
              if (event.ctrlKey || event.altKey) {
                const textBefore = view.state.doc.textBetween(
                  blockStart,
                  selection.from,
                );
                const match = textBefore.match(/\S+\s*$/);
                from = match
                  ? selection.from - match[0].length
                  : Math.max(blockStart, selection.from - 1);
              } else {
                from = Math.max(blockStart, selection.from - 1);
              }
            } else {
              if (event.ctrlKey || event.altKey) {
                const textAfter = view.state.doc.textBetween(
                  selection.to,
                  blockEnd,
                );
                const match = textAfter.match(/^\s*\S+/);
                to = match
                  ? selection.to + match[0].length
                  : Math.min(blockEnd, selection.to + 1);
              } else {
                to = Math.min(blockEnd, selection.to + 1);
              }
            }
          }

          if (from === to) {
            event.preventDefault();
            return true;
          }

          event.preventDefault();

          const criticMarkType = view.state.schema.marks.criticChange;
          const isAdditionKind = (m: ProseMirrorMark) =>
            m.type === criticMarkType &&
            (m.attrs.kind === "addition" ||
              m.attrs.kind === "substitution-new");

          // Collect segments, distinguishing suggested-insertion text
          // from original text so we can delete the former and mark the
          // latter.
          type Segment = {
            from: number;
            to: number;
            isAddition: boolean;
          };
          const segments: Segment[] = [];
          view.state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText) return;
            const segFrom = Math.max(pos, from);
            const segTo = Math.min(pos + node.nodeSize, to);
            if (segFrom >= segTo) return;
            const isAdd = node.marks.some(isAdditionKind);
            const prev = segments[segments.length - 1];
            if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
              prev.to = segTo;
            } else {
              segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
            }
          });

          const tr = view.state.tr;

          // Process right-to-left so earlier positions stay valid.
          for (const seg of [...segments].reverse()) {
            if (seg.isAddition) {
              tr.delete(seg.from, seg.to);
            } else {
              const deletionMark =
                getReusableSuggestionDeletionMark(
                  currentEditor,
                  seg.from,
                  seg.to,
                ) ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("deletion", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.addMark(seg.from, seg.to, deletionMark);
            }
          }

          const basePos = event.key === "Backspace" ? from : to;
          const mappedPos = tr.mapping.map(basePos, -1);
          tr.setSelection(TextSelection.create(tr.doc, mappedPos));
          tr.scrollIntoView();

          view.dispatch(tr);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        emitMarkdownChange(currentEditor.getJSON());
        refreshCriticChanges();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;

  useEffect(() => {
    editor?.setEditable(
      interactionMode !== "viewing" && !parsedContent.reviewError,
      false,
    );
  }, [editor, interactionMode, parsedContent.reviewError]);

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];
  const activeChangeIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCriticChangeIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, hasVisibleComments(comments));

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  useEffect(() => {
    setSelectedChangeId((current) =>
      getPreferredCriticChangeId(activeChangeIds, current),
    );
  }, [activeChangeIds]);

  useEffect(() => {
    if (!editor) return;

    sourceRef.current = documentSourceOf(parsedContent);
    reservedIdsByEditor.set(editor, parsedContent.reservedIds);
    commentsRef.current = parsedContent.comments;
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setSelectedChangeId(null);
    setHoveredChangeId(null);
    setDraftSuggestion(null);
    setPendingFocusCommentId(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }

    refreshCriticChanges();
  }, [editor, parsedContent, refreshCriticChanges]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  // After a forced remount, put the caret back where it was and keep focus,
  // so the next keystrokes land in the document instead of the page body.
  const restoredSelectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || !restoreSelection) return;
    if (restoredSelectionKeyRef.current === restoreSelection.key) return;
    restoredSelectionKeyRef.current = restoreSelection.key;
    const size = editor.state.doc.content.size;
    const clamp = (position: number) => Math.max(1, Math.min(position, size));
    editor
      .chain()
      .focus()
      .setTextSelection({
        from: clamp(restoreSelection.from),
        to: clamp(restoreSelection.to),
      })
      .run();
  }, [editor, restoreSelection]);

  // New markdown from disk, applied as one transaction that replaces only
  // the range that differs, so the selection maps through and focus stays.
  // (Batch 5 replaces this with full transaction mapping and merging.)
  const applyExternalMarkdown = useCallback(
    (nextMarkdown: string): boolean => {
      const currentEditor = editorRef.current;
      if (!currentEditor || currentEditor.isDestroyed) return false;

      const parsed = criticMarkdownToEditorState(nextMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      });
      let nextDoc: ReturnType<typeof currentEditor.schema.nodeFromJSON>;
      try {
        nextDoc = currentEditor.schema.nodeFromJSON(parsed.doc);
      } catch (error) {
        console.error("Could not apply the file from disk in place:", error);
        return false;
      }

      sourceRef.current = documentSourceOf(parsed);
      reservedIdsByEditor.set(currentEditor, parsed.reservedIds);
      commentsRef.current = parsed.comments;
      setComments(parsed.comments);

      const { state, view } = currentEditor;
      const start = state.doc.content.findDiffStart(nextDoc.content);
      if (start !== null && start !== undefined) {
        const end = state.doc.content.findDiffEnd(nextDoc.content);
        let endA = end?.a ?? state.doc.content.size;
        let endB = end?.b ?? nextDoc.content.size;
        const overlap = start - Math.min(endA, endB);
        if (overlap > 0) {
          endA += overlap;
          endB += overlap;
        }
        const transaction = state.tr
          .replace(start, endA, nextDoc.slice(start, endB))
          .setMeta("addToHistory", false);
        suppressNextMarkdownUpdateRef.current = true;
        view.dispatch(transaction);
        suppressNextMarkdownUpdateRef.current = false;
      }
      refreshCriticChanges();
      return true;
    },
    [refreshCriticChanges, resolveFileUrl, resolveLinkUrl],
  );

  useEffect(() => {
    if (!externalApplyRef) return;
    externalApplyRef.current = applyExternalMarkdown;
    return () => {
      if (externalApplyRef.current === applyExternalMarkdown) {
        externalApplyRef.current = null;
      }
    };
  }, [applyExternalMarkdown, externalApplyRef]);

  useEffect(() => {
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
    refreshCriticChanges();
  }, [comments, hoveredCommentId, refreshCriticChanges, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(criticChangeHighlightPluginKey, {
        selectedChangeId,
        hoveredChangeId: effectiveHoveredChangeId,
      }),
    );
  }, [editor, hoveredChangeId, selectedChangeId]);

  // Delegated, so anchors drawn later (new comments, code line ranges that
  // are decorations and redraw on every selection) respond too.
  useEffect(() => {
    if (!editor) return;

    const root = editor.view.dom as HTMLElement;
    const anchorIdsFor = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const anchor = target.closest<HTMLElement>(
        ".comment-anchor[data-comment-ids]",
      );
      if (!anchor || !root.contains(anchor)) return null;
      const commentIds = parseCommentIds(anchor.dataset.commentIds);
      return commentIds.length > 0 ? { anchor, commentIds } : null;
    };

    const handleMouseOver = (event: MouseEvent) => {
      const hit = anchorIdsFor(event.target);
      if (!hit) return;
      const nextCommentId = getPreferredCommentId(
        hit.commentIds,
        selectedCommentIdRef.current,
      );
      if (nextCommentId) {
        setHoveredCommentId(nextCommentId);
      }
    };

    const handleMouseOut = (event: MouseEvent) => {
      const hit = anchorIdsFor(event.target);
      if (!hit) return;
      if (
        event.relatedTarget instanceof Node &&
        hit.anchor.contains(event.relatedTarget)
      ) {
        return;
      }
      setHoveredCommentId((current) =>
        current && hit.commentIds.includes(current) ? null : current,
      );
    };

    const handleClick = (event: MouseEvent) => {
      const hit = anchorIdsFor(event.target);
      if (!hit) return;
      const nextCommentId = getPreferredCommentId(
        hit.commentIds,
        selectedCommentIdRef.current,
      );
      if (nextCommentId) {
        setSelectedCommentId(nextCommentId);
      }
    };

    root.addEventListener("mouseover", handleMouseOver);
    root.addEventListener("mouseout", handleMouseOut);
    root.addEventListener("click", handleClick);

    return () => {
      root.removeEventListener("mouseover", handleMouseOver);
      root.removeEventListener("mouseout", handleMouseOut);
      root.removeEventListener("click", handleClick);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const changeElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".critic-change[data-critic-change-id]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const element of changeElements) {
      const changeId = element.dataset.criticChangeId;
      if (!changeId) continue;

      const handleMouseEnter = () => {
        setHoveredChangeId(changeId);
      };

      const handleMouseLeave = () => {
        setHoveredChangeId((current) =>
          current === changeId ? null : current,
        );
      };

      const handleClick = () => {
        setSelectedChangeId(changeId);
      };

      element.addEventListener("mouseenter", handleMouseEnter);
      element.addEventListener("mouseleave", handleMouseLeave);
      element.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        element.removeEventListener("mouseenter", handleMouseEnter);
        element.removeEventListener("mouseleave", handleMouseLeave);
        element.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!selectedCommentIdRef.current && !selectedChangeIdRef.current) return;
      if (!shouldDismissCommentThread(event.target)) return;

      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setSelectedChangeId(null);
      setHoveredChangeId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, []);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    // A selection reaching into a code block anchors the comment on the
    // block's fence line with the selected lines (canonical files only: an
    // older-format file has no shape for it, so the code part is skipped).
    const codeSelection = findCodeBlockSelection(currentEditor);
    const canAnchorCode =
      codeSelection !== null && sourceRef.current.reviewFormat === "canonical";
    setCodeCommentRefused(
      codeSelection !== null && sourceRef.current.reviewFormat === "legacy",
    );

    const comment = createCriticComment(
      canAnchorCode
        ? {
            codeLines: codeSelection.lines,
            quote: codeSelection.quote,
          }
        : undefined,
      {
        existingComments: reviewIdsInUse(
          commentsRef.current,
          sourceRef.current.reservedIds,
        ),
      },
    );
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);
    setNewCommentDraftIds((current) =>
      current.includes(comment.id) ? current : [...current, comment.id],
    );

    suppressNextMarkdownUpdateRef.current = true;
    // Keep the ids each piece of the selection already carries and add the
    // new one (a selection over two comments keeps both).
    addCommentIdToSelection(currentEditor, comment.id);
    if (canAnchorCode) {
      addCodeCommentAnchor(
        currentEditor,
        codeSelection.pos,
        comment.id,
        codeSelection.lines,
      );
    }
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    const hasProseAnchor = documentHasCommentMark(currentEditor, comment.id);
    // Nothing in the selection could take a comment.
    if (!hasProseAnchor && !canAnchorCode) {
      const withoutDraft = new Map(commentsRef.current);
      withoutDraft.delete(comment.id);
      commentsRef.current = withoutDraft;
      setComments(withoutDraft);
      setNewCommentDraftIds((current) =>
        current.filter((commentId) => commentId !== comment.id),
      );
      return;
    }
    if (canAnchorCode && !hasProseAnchor) {
      const codeOnly = new Map(commentsRef.current);
      codeOnly.set(comment.id, { ...comment, scope: "code" });
      commentsRef.current = codeOnly;
      setComments(codeOnly);
    }

    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

  // The Global comment button: a draft card at the top of the global
  // section. It has no anchor and is written only once it has text.
  const addGlobalComment = useCallback(() => {
    if (sourceRef.current.reviewError) return;
    if (
      sourceRef.current.reviewFormat === "legacy" &&
      !sourceRef.current.endmatter
    ) {
      setGlobalCommentRefused(true);
      return;
    }
    setGlobalCommentRefused(false);

    const openDraft = [...commentsRef.current.values()].find(
      (comment) =>
        comment.scope === "document" &&
        !comment.parentCommentId &&
        !comment.source &&
        comment.content.trim() === "",
    );
    const draft =
      openDraft ??
      createCriticComment(
        { scope: "document" },
        {
          existingComments: reviewIdsInUse(
            commentsRef.current,
            sourceRef.current.reservedIds,
          ),
        },
      );
    if (!openDraft) {
      const nextComments = new Map(commentsRef.current);
      nextComments.set(draft.id, draft);
      commentsRef.current = nextComments;
      setComments(nextComments);
    }
    setNewCommentDraftIds((current) =>
      current.includes(draft.id) ? current : [draft.id, ...current],
    );
    setSelectedChangeId(null);
    setSelectedCommentId(draft.id);
    setPendingFocusCommentId(draft.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

  const handleSuggestDeletion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const change = createCriticChange("deletion", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });

    currentEditor.chain().focus().setCriticChange(change).run();
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestReplacement = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const { from, to } = currentEditor.state.selection;
    setDraftSuggestion({
      type: "replacement",
      from,
      to,
      sourceText: currentEditor.state.doc.textBetween(from, to, "\n"),
      text: "",
    });
  }, []);

  const applyDraftSuggestion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || !draftSuggestion) return;

    const nextText = draftSuggestion.text;
    if (!nextText) {
      setDraftSuggestion(null);
      return;
    }

    if (draftSuggestion.type === "insertion") {
      const change = createCriticChange("addition", undefined, {
        existingChanges: getDocumentCriticChanges(currentEditor),
      });

      currentEditor
        .chain()
        .focus()
        .insertContentAt(draftSuggestion.from, {
          type: "text",
          text: nextText,
          marks: [
            {
              type: "criticChange",
              attrs: change,
            },
          ],
        })
        .run();
      setSelectedChangeId(change.changeId);
      setDraftSuggestion(null);
      emitMarkdownChange(currentEditor.getJSON());
      refreshCriticChanges();
      return;
    }

    const change = createCriticChange("substitution-old", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });
    const replacementChange: CriticChangeAttrs = {
      ...change,
      kind: "substitution-new",
    };

    currentEditor
      .chain()
      .focus()
      .setTextSelection({ from: draftSuggestion.from, to: draftSuggestion.to })
      .setCriticChange(change)
      .insertContentAt(draftSuggestion.to, {
        type: "text",
        text: nextText,
        marks: [
          {
            type: "criticChange",
            attrs: replacementChange,
          },
        ],
      })
      .run();
    setSelectedChangeId(change.changeId);
    setDraftSuggestion(null);
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [draftSuggestion, emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestInsertion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    const { from } = currentEditor.state.selection;
    const before = currentEditor.state.doc.textBetween(
      Math.max(1, from - 24),
      from,
      " ",
    );
    const after = currentEditor.state.doc.textBetween(
      from,
      Math.min(currentEditor.state.doc.content.size, from + 24),
      " ",
    );

    setDraftSuggestion({
      type: "insertion",
      from,
      to: from,
      sourceText: `${before}▮${after}`.trim(),
      text: "",
    });
  }, []);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: CriticComment) => CriticComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      setNewCommentDraftIds((current) =>
        current.filter((currentCommentId) => currentCommentId !== commentId),
      );
      draftTextsRef.current.delete(commentId);
      // A saved composer is done; it must not reopen for a pending focus.
      setPendingFocusCommentId((current) =>
        current === commentId ? null : current,
      );
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  const replyToComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      if (!commentsRef.current.has(commentId)) return;

      // A reply lives in the comment map (and is saved from it); it never
      // touches the marks, so it works on every thread, global ones included.
      const comment = createCriticComment(
        {
          parentCommentId: commentId,
        },
        {
          existingComments: reviewIdsInUse(
            commentsRef.current,
            sourceRef.current.reservedIds,
          ),
        },
      );

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout],
  );

  const setThreadResolution = useCallback(
    (commentId: string, resolved: boolean) => {
      const rootId =
        getRootThreadIdForCommentId(commentId, commentsRef.current) ??
        commentId;
      updateComment(rootId, (current) => ({
        ...current,
        status: resolved ? "resolved" : null,
        resolved: resolved ? (current.resolved ?? null) : null,
      }));
      // A resolved thread folds away into its section's "N resolved" row; a
      // reopened one is selected where it comes back.
      setSelectedCommentId(resolved ? null : rootId);
    },
    [updateComment],
  );

  const removeSuggestionComments = useCallback(
    (changeId: string, currentEditor: Editor) => {
      const directCommentIds = [...commentsRef.current.values()]
        .filter((comment) => comment.parentCommentId === changeId)
        .map((comment) => comment.id);
      const commentIdsToDelete = [
        ...directCommentIds,
        ...directCommentIds.flatMap((commentId) =>
          getCommentDescendantIds(commentId, commentsRef.current),
        ),
      ];

      if (commentIdsToDelete.length === 0) return commentsRef.current;

      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();

      commentsRef.current = nextComments;
      setComments(nextComments);
      return nextComments;
    },
    [],
  );

  const acceptSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().acceptCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const rejectSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().rejectCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const replyToSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      if (!getCriticChangeRange(currentEditor, changeId)) return;

      // A reply lives in the comment map and the review block, never on the
      // suggestion's marks.
      const comment = createCriticComment(
        {
          parentCommentId: changeId,
        },
        {
          existingComments: reviewIdsInUse(
            commentsRef.current,
            sourceRef.current.reservedIds,
          ),
        },
      );

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedChangeId(changeId);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      refreshCriticChanges();
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout, refreshCriticChanges],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const descendantIds = getCommentDescendantIds(
        commentId,
        commentsRef.current,
      );
      const commentIdsToDelete = [commentId, ...descendantIds];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();
      removeCodeCommentAnchors(currentEditor, commentIdsToDelete);
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setNewCommentDraftIds((current) =>
        current.filter((commentId) => !deletedIds.has(commentId)),
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const selectSuggestion = useCallback((changeId: string) => {
    setSelectedChangeId(changeId);
    setSelectedCommentId(null);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
      return;
    }

    const anchor = findCommentAnchorElement(currentEditor, commentId);
    if (!anchor) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    // A code comment's card sits in the global section, away from its
    // lines: bring the highlighted range into view.
    if (commentsRef.current.get(commentId)?.scope === "code") {
      anchor.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }
  }, []);

  const focusSuggestion = useCallback((changeId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedChangeId(changeId);
    setSelectedCommentId(null);

    const range = getCriticChangeRange(currentEditor, changeId);
    if (!range) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    currentEditor.view.dispatch(
      currentEditor.state.tr.setSelection(
        TextSelection.create(currentEditor.state.doc, range.from, range.to),
      ),
    );
  }, []);

  const rememberDraftText = useCallback((commentId: string, text: string) => {
    draftTextsRef.current.set(commentId, text);
  }, []);

  // Done saves an open global comment draft first, as if Save were pressed:
  // typed text is written, an empty draft is dropped.
  const saveOpenGlobalDrafts = useCallback((): boolean => {
    let saved = true;
    for (const comment of [...commentsRef.current.values()]) {
      if (comment.scope !== "document" || comment.parentCommentId) continue;
      if (comment.source || comment.content.trim() !== "") continue;
      const text = (draftTextsRef.current.get(comment.id) ?? "").trim();
      if (!text) {
        const withoutDraft = new Map(commentsRef.current);
        withoutDraft.delete(comment.id);
        commentsRef.current = withoutDraft;
        setComments(withoutDraft);
        setNewCommentDraftIds((current) =>
          current.filter((commentId) => commentId !== comment.id),
        );
        continue;
      }
      if (findReviewDelimiter(text)) {
        saved = false;
        setSelectedCommentId(comment.id);
        continue;
      }
      updateComment(comment.id, (current) => ({ ...current, content: text }));
    }
    return saved;
  }, [updateComment]);

  useEffect(() => {
    onReviewControllerChange?.({ saveOpenGlobalDrafts });
    return () => onReviewControllerChange?.(null);
  }, [onReviewControllerChange, saveOpenGlobalDrafts]);

  useEffect(() => {
    if (!editor || globalCommentRequest === null) return;
    if (interactionMode === "viewing") return;
    onGlobalCommentRequestHandled?.();
    addGlobalComment();
  }, [
    addGlobalComment,
    editor,
    globalCommentRequest,
    interactionMode,
    onGlobalCommentRequestHandled,
  ]);

  const hasReviewRail =
    hasVisibleComments(comments) || criticChanges.length > 0;
  const documentShellRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(hasReviewRail);
  // The narrow-screen fallback shows the same threads as the rail: the
  // global section, and each thread under the cursor with every reply from
  // the comment map.
  const activeRootThreadId = getRootThreadIdForCommentId(
    selectedCommentId,
    comments,
  );
  const activeThreadComments = [
    ...new Set(
      activeCommentIds.map(
        (commentId) =>
          getRootThreadIdForCommentId(commentId, comments) ?? commentId,
      ),
    ),
  ]
    .filter((rootId) => {
      const root = comments.get(rootId);
      return !root || !isGlobalSectionRoot(root, comments);
    })
    .flatMap((rootId) => getThreadComments(rootId, comments));
  const globalThreadRoots = getGlobalThreadRoots(comments, newCommentDraftIds);
  const hasFallbackThreads =
    activeThreadComments.length > 0 ||
    globalThreadRoots.open.length > 0 ||
    globalThreadRoots.resolved.length > 0;
  const fallbackThreadHandlers: CommentThreadHandlers = {
    selectedCommentId,
    hoveredCommentId,
    onDeleteComment: deleteComment,
    onUpdateComment: (commentId, nextContent) => {
      updateComment(commentId, (current) => ({
        ...current,
        content: nextContent,
      }));
    },
    onReplyComment: replyToComment,
    onSelectComment: selectComment,
    onFocusComment: focusComment,
    onHoverComment: setHoveredCommentId,
    onResolveComment: (commentId) => setThreadResolution(commentId, true),
    onReopenComment: (commentId) => setThreadResolution(commentId, false),
    pendingFocusCommentId,
    newCommentDraftIds,
    onAutoFocusComment: (commentId) => {
      setPendingFocusCommentId((current) =>
        current === commentId ? null : current,
      );
    },
    onDraftChange: rememberDraftText,
  };
  const contentCardClass =
    "rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-800 bg-white dark:bg-card shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]";
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "review-layout-grid",
    !hasReviewRail && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasReviewRail &&
      "review-layout-grid--centered",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo"
      ? "max-w-none"
      : "review-layout-main max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const fallbackClass = cn(
    "document-comment-fallback mb-4",
    layout === "embedded-demo" ? "hidden" : "min-[1100px]:hidden",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "review-layout-rail hidden min-[1100px]:block",
  );

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div
        ref={documentShellRef}
        data-testid="document-page-shell"
        className={documentShellClass}
      >
        <div className={documentMainClass}>
          {notice}
          {codeCommentRefused ? (
            <div
              data-testid="review-format-code-comment-message"
              role="alert"
              className="mb-4 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950 sm:px-4 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              Comments on code need the current review format. Run roughdraft
              doctor --fix to convert this file.
            </div>
          ) : null}
          {globalCommentRefused ? (
            <div
              data-testid="review-format-global-comment-message"
              role="alert"
              className="mb-4 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950 sm:px-4 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              Global comments need the current review format. Run roughdraft
              doctor --fix to convert this file.
            </div>
          ) : null}
          {hasFallbackThreads ? (
            <div className={fallbackClass}>
              <GlobalCommentsSection
                comments={comments}
                handlers={fallbackThreadHandlers}
                activeRootThreadId={activeRootThreadId}
                variant="banner"
                testId="global-comments-fallback"
                resolvedToggleTestId="global-comments-fallback-resolved-toggle"
              />
              {activeThreadComments.length > 0 ? (
                <CommentEditorList
                  comments={activeThreadComments}
                  testId="document-comment-fallback"
                  selectedCommentId={selectedCommentId}
                  hoveredCommentId={hoveredCommentId}
                  onDeleteComment={deleteComment}
                  onUpdateComment={(commentId, nextContent) => {
                    updateComment(commentId, (current) => ({
                      ...current,
                      content: nextContent,
                    }));
                  }}
                  onReplyComment={replyToComment}
                  onSelectComment={selectComment}
                  onHoverComment={setHoveredCommentId}
                  pendingFocusCommentId={pendingFocusCommentId}
                  newCommentDraftIds={newCommentDraftIds}
                  onAutoFocusComment={(commentId) => {
                    setPendingFocusCommentId((current) =>
                      current === commentId ? null : current,
                    );
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={
                  interactionMode === "viewing" ? undefined : handleAddComment
                }
                onSuggestDeletion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestDeletion
                }
                onSuggestReplacement={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestReplacement
                }
                onSuggestInsertion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestInsertion
                }
              >
                <div data-testid="rich-text-editor">
                  <EditorContent editor={editor} />
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        <DocumentReviewRail
          className={reviewRailClass}
          layout={layout === "embedded-demo" ? "flow" : "anchored"}
          testId="document-review-rail"
          commentGroups={commentGroups}
          comments={comments}
          suggestions={criticChanges}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          selectedChangeId={selectedChangeId}
          hoveredChangeId={hoveredChangeId}
          contentHeight={contentHeight}
          onDeleteComment={deleteComment}
          onUpdateComment={(commentId, nextContent) => {
            updateComment(commentId, (current) => ({
              ...current,
              content: nextContent,
            }));
          }}
          onReplyComment={replyToComment}
          onSelectComment={selectComment}
          onFocusComment={focusComment}
          onHoverComment={setHoveredCommentId}
          onResolveComment={(commentId) => setThreadResolution(commentId, true)}
          onReopenComment={(commentId) => setThreadResolution(commentId, false)}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
          onReplySuggestion={replyToSuggestion}
          onSelectSuggestion={selectSuggestion}
          onFocusSuggestion={focusSuggestion}
          onHoverSuggestion={setHoveredChangeId}
          pendingFocusCommentId={pendingFocusCommentId}
          newCommentDraftIds={newCommentDraftIds}
          onAutoFocusComment={(commentId) => {
            setPendingFocusCommentId((current) =>
              current === commentId ? null : current,
            );
          }}
          onDraftChange={rememberDraftText}
          draftSuggestion={draftSuggestion}
          onDraftSuggestionTextChange={(text) => {
            setDraftSuggestion((current) =>
              current ? { ...current, text } : current,
            );
          }}
          onApplyDraftSuggestion={applyDraftSuggestion}
          onCancelDraftSuggestion={() => setDraftSuggestion(null)}
          editor={editor}
        />
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  hasCommentRailSpace,
  interactionMode,
  layout,
  onMarkdownChange,
  externalApplyRef,
  notice = null,
}: CodeEditorSurfaceProps) {
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "review-layout-grid",
    !hasCommentRailSpace && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasCommentRailSpace &&
      "review-layout-grid--centered",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo"
      ? "max-w-none"
      : "review-layout-main max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const reviewRailClass = cn(
    "document-comment-rail pointer-events-none invisible",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "review-layout-rail hidden min-[1100px]:block",
  );
  const documentShellRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(hasCommentRailSpace);

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div
        ref={documentShellRef}
        data-testid="document-page-shell"
        className={documentShellClass}
      >
        <div className={documentMainClass}>
          {notice}
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-800 bg-white dark:bg-card py-10 pr-6 pl-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:py-14 sm:pr-10 sm:pl-8"
              data-testid="document-content-card"
            >
              <MarkdownCodeEditor
                testId="markdown-code-editor"
                value={markdown}
                onChange={onMarkdownChange}
                readOnly={interactionMode === "viewing"}
                autoFocus
                externalApplyRef={externalApplyRef}
              />
            </div>
          </div>
        </div>
        {hasCommentRailSpace ? (
          <div
            data-testid="document-review-rail"
            className={reviewRailClass}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked = false,
  forceResetKey = null,
  sync = null,
  globalCommentRequest = null,
  onGlobalCommentRequestHandled,
  onReviewControllerChange,
}: PageCardEditorSurfaceProps) {
  const initialContent = sync ? sync.draft : page.content;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<ManualSaveResult> | null>(null);
  const pendingMarkdownRef = useRef(initialContent);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const lastAcceptedMarkdownRef = useRef(initialContent);
  const localDirtyRef = useRef(false);
  const forceResetKeyRef = useRef(forceResetKey);
  const [markdown, setMarkdown] = useState(initialContent);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] =
    useState(initialContent);
  const [richTextSourceVersion, setRichTextSourceVersion] = useState(0);
  // Sync mode: the controller epoch of the content the editor shows, so an
  // edit typed before new content lands is replayed on that content.
  const appliedEpochRef = useRef(sync?.epoch ?? 0);
  const pendingRemountEpochRef = useRef<number | null>(null);
  const richTextApplyRef = useRef<ExternalContentApplier | null>(null);
  const codeApplyRef = useRef<ExternalContentApplier | null>(null);
  const editorViewModeRef = useRef(editorViewMode);
  editorViewModeRef.current = editorViewMode;
  const editorReadyRef = useRef<Editor | null>(null);
  const [restoreSelection, setRestoreSelection] =
    useState<RestoreSelectionRequest | null>(null);

  const reportDirtyState = useCallback(
    (isDirty: boolean) => {
      if (localDirtyRef.current === isDirty) return;
      localDirtyRef.current = isDirty;
      onDirtyStateChange?.(isDirty);
    },
    [onDirtyStateChange],
  );

  const acceptMarkdown = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      lastAcceptedMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      setRichTextSourceMarkdown(nextMarkdown);
      setRichTextSourceVersion((current) => current + 1);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(false);
      onSaveStateChange("saved");
    },
    [onLocalContentChange, onSaveStateChange, reportDirtyState],
  );

  const rememberRecentMarkdown = useCallback((nextMarkdown: string) => {
    recentMarkdownRef.current.add(nextMarkdown);
    if (recentMarkdownRef.current.size > 10) {
      const iterator = recentMarkdownRef.current.values();
      recentMarkdownRef.current.delete(iterator.next().value as string);
    }
  }, []);

  const performSave = useCallback(
    async (nextMarkdown: string): Promise<ManualSaveResult> => {
      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return { status: "blocked" };
      }

      rememberRecentMarkdown(nextMarkdown);
      onSaveStateChange("saving");

      try {
        await onSave(page.id, nextMarkdown);
        lastAcceptedMarkdownRef.current = nextMarkdown;
        reportDirtyState(pendingMarkdownRef.current !== nextMarkdown);
        onSaveStateChange(
          pendingMarkdownRef.current === nextMarkdown ? "saved" : "saving",
        );
        return { status: "saved" };
      } catch (error) {
        console.error("Failed to save page:", error);
        onSaveStateChange("error");
        return { status: "error", error };
      }
    },
    [
      onSave,
      onSaveStateChange,
      page.id,
      rememberRecentMarkdown,
      reportDirtyState,
      saveBlocked,
    ],
  );

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return;
      }

      onSaveStateChange("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
          inFlightSaveRef.current = null;
        });
        void inFlightSaveRef.current;
      }, 500);
    },
    [onSaveStateChange, performSave, saveBlocked],
  );

  const flushSave = useCallback(async (): Promise<ManualSaveResult> => {
    if (sync) {
      const result = await sync.flush();
      if (result.status === "saved") return { status: "saved" };
      if (result.status === "blocked") return { status: "blocked" };
      return {
        status: "error",
        error:
          result.status === "error"
            ? result.error
            : new Error("The file changed on disk."),
      };
    }

    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const currentMarkdown = pendingMarkdownRef.current;

    if (
      currentMarkdown === lastAcceptedMarkdownRef.current &&
      !inFlightSaveRef.current
    ) {
      onSaveStateChange("saved");
      return { status: "saved" };
    }

    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current;
      if (pendingMarkdownRef.current === lastAcceptedMarkdownRef.current) {
        onSaveStateChange("saved");
        return { status: "saved" };
      }
    }

    return await performSave(pendingMarkdownRef.current);
  }, [onSaveStateChange, performSave, sync]);

  useEffect(() => {
    onSaveControllerChange?.({ flushSave });
    return () => onSaveControllerChange?.(null);
  }, [flushSave, onSaveControllerChange]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      // Autosave is paused while the review block cannot be read; an edit in
      // the code view that repairs it saves as usual.
      if (getReviewBlockError(nextMarkdown)) {
        reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
        return;
      }
      if (sync) {
        sync.edit(nextMarkdown, appliedEpochRef.current);
        reportDirtyState(sync.getView().dirty);
        return;
      }
      reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
      scheduleSave(nextMarkdown);
    },
    [onLocalContentChange, reportDirtyState, scheduleSave, sync],
  );

  const handleEditorReady = useCallback(
    (nextEditor: Editor | null) => {
      editorReadyRef.current = nextEditor;
      onEditorReady?.(nextEditor);
    },
    [onEditorReady],
  );

  // Sync mode: content from disk (fast-forward, reload, replayed keystrokes)
  // goes straight into the live editor. Only when the editor cannot take it
  // in place does the rich-text surface remount, and then it gets the caret
  // and focus back.
  useEffect(() => {
    if (!sync) return;
    const stopContent = sync.onContentUpdate((update) => {
      pendingMarkdownRef.current = update.content;
      lastAcceptedMarkdownRef.current = update.content;
      const inCode = editorViewModeRef.current === "code";
      const apply = inCode ? codeApplyRef.current : richTextApplyRef.current;
      const applied = apply?.(update.content) ?? false;
      setMarkdown(update.content);
      onLocalContentChange?.(update.content);
      if (applied || inCode) {
        appliedEpochRef.current = update.epoch;
      } else {
        const currentEditor = editorReadyRef.current;
        const hadFocus = !!currentEditor?.isFocused;
        const selection = currentEditor?.state.selection;
        pendingRemountEpochRef.current = update.epoch;
        setRichTextSourceMarkdown(update.content);
        setRichTextSourceVersion((current) => current + 1);
        if (hadFocus && selection) {
          setRestoreSelection({
            key: `epoch:${update.epoch}`,
            from: selection.from,
            to: selection.to,
          });
        }
      }
      reportDirtyState(sync.getView().dirty);
    });
    const stopView = sync.subscribe(() => {
      reportDirtyState(sync.getView().dirty);
    });
    return () => {
      stopContent();
      stopView();
    };
  }, [onLocalContentChange, reportDirtyState, sync]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the remount that richTextSourceVersion triggers commits
  useEffect(() => {
    if (pendingRemountEpochRef.current === null) return;
    appliedEpochRef.current = pendingRemountEpochRef.current;
    pendingRemountEpochRef.current = null;
  }, [richTextSourceVersion]);

  useEffect(() => {
    if (sync) return;
    const forceResetChanged = forceResetKeyRef.current !== forceResetKey;
    forceResetKeyRef.current = forceResetKey;

    if (forceResetChanged) {
      recentMarkdownRef.current.delete(page.content);
      acceptMarkdown(page.content);
      return;
    }

    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = markdown;
      reportDirtyState(markdown !== page.content);
      return;
    }

    if (localDirtyRef.current && markdown !== page.content) {
      return;
    }

    if (markdown === page.content) {
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = page.content;
      reportDirtyState(false);
      return;
    }

    acceptMarkdown(page.content);
  }, [
    acceptMarkdown,
    forceResetKey,
    markdown,
    page.content,
    reportDirtyState,
    sync,
  ]);

  useEffect(() => {
    if (!saveBlocked || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    onSaveStateChange(
      pendingMarkdownRef.current === lastAcceptedMarkdownRef.current
        ? "saved"
        : "unsaved",
    );
  }, [onSaveStateChange, saveBlocked]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (previousEditorViewMode !== "code" || editorViewMode !== "rich-text") {
      return;
    }

    setRichTextSourceMarkdown(markdown);
    setRichTextSourceVersion((current) => current + 1);
  }, [editorViewMode, markdown]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  const hasCommentRailSpace = useMemo(
    () => criticMarkdownHasReviewRail(markdown),
    [markdown],
  );
  const reviewBlockError = useMemo(
    () => getReviewBlockError(markdown),
    [markdown],
  );
  const reloadAfterReviewBlockError = useCallback(() => {
    if (sync) {
      void sync.reloadFromDisk();
      return;
    }
    acceptMarkdown(page.content);
  }, [acceptMarkdown, page.content, sync]);
  // D11: an older-format file is never converted on save; the notice names
  // the command that converts it.
  const reviewFormat = useMemo<ReviewFormat>(
    () => getReviewFormat(markdown),
    [markdown],
  );
  const reviewBlockNotice = reviewBlockError ? (
    <ReviewBlockErrorNotice
      message={reviewBlockError}
      onReload={reloadAfterReviewBlockError}
    />
  ) : reviewFormat === "legacy" ? (
    <ReviewFormatNotice />
  ) : null;

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        notice={reviewBlockNotice}
        markdown={markdown}
        hasCommentRailSpace={hasCommentRailSpace}
        interactionMode={interactionMode}
        layout={layout}
        onMarkdownChange={handleMarkdownChange}
        externalApplyRef={codeApplyRef}
      />
    );
  }

  const effectiveRichTextSourceMarkdown =
    !sync &&
    !localDirtyRef.current &&
    !recentMarkdownRef.current.has(page.content) &&
    markdown !== page.content
      ? page.content
      : richTextSourceMarkdown;

  return (
    <RichTextEditorSurface
      notice={reviewBlockNotice}
      key={`${page.id}:${richTextSourceVersion}:${effectiveRichTextSourceMarkdown}`}
      page={page}
      activeDocumentPath={activeDocumentPath}
      selected={selected}
      layout={layout}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      interactionMode={interactionMode}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      backend={backend}
      onEditorReady={handleEditorReady}
      externalApplyRef={richTextApplyRef}
      restoreSelection={restoreSelection}
      globalCommentRequest={globalCommentRequest}
      onGlobalCommentRequestHandled={onGlobalCommentRequestHandled}
      onReviewControllerChange={onReviewControllerChange}
    />
  );
});

// One line on a file in an older review format (D11). Saving keeps its
// review markup as it is; the command converts it.
function ReviewFormatNotice() {
  return (
    <div
      data-testid="review-format-notice"
      role="status"
      className="mb-4 flex w-full items-start gap-2.5 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950 sm:px-4 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <Info
        className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 text-sm leading-5">{REVIEW_FORMAT_NOTICE}</div>
    </div>
  );
}

// Blocking: the editor shows the text above the review block read-only, the
// block itself stays out of the editor, and nothing is saved until the block
// can be read again.
function ReviewBlockErrorNotice({
  message,
  onReload,
}: {
  message: string;
  onReload: () => void;
}) {
  return (
    <div
      data-testid="review-block-error-notice"
      role="alert"
      className="mb-4 flex w-full flex-col gap-3 rounded-[8px] border border-rose-300 bg-rose-50 px-3 py-3 text-rose-950 shadow-[0_14px_40px_rgba(136,19,55,0.12)] sm:flex-row sm:items-center sm:justify-between sm:px-4 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-rose-700 dark:text-rose-400"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div
            data-testid="review-block-error-message"
            className="text-sm font-semibold leading-5"
          >
            {message}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-rose-900 dark:text-rose-200">
            Autosave is paused for this file. Fix the block (roughdraft doctor
            names the problem; the code view can edit it), then reload.
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:justify-end">
        <Button
          type="button"
          data-testid="review-block-error-action-reload"
          variant="ghost"
          size="sm"
          className="h-8 rounded-[7px] bg-white/70 px-2 text-xs text-rose-950 hover:bg-white dark:bg-white/10 dark:text-rose-100 dark:hover:bg-white/20"
          onClick={onReload}
        >
          <RefreshCcw className="size-3.5" />
          Reload
        </Button>
      </div>
    </div>
  );
}

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  layout = "default",
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked,
  forceResetKey,
  sync,
  globalCommentRequest,
  onGlobalCommentRequestHandled,
  onReviewControllerChange,
}: PageCardProps) {
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  return (
    <div className="w-full">
      <PageCardEditorSurface
        page={page}
        activeDocumentPath={activeDocumentPath}
        selected={selected}
        layout={layout}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={setSaveState}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        backend={backend}
        onEditorReady={onEditorReady}
        onCommentRailPresenceChange={onCommentRailPresenceChange}
        onDirtyStateChange={onDirtyStateChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
        sync={sync}
        globalCommentRequest={globalCommentRequest}
        onGlobalCommentRequestHandled={onGlobalCommentRequestHandled}
        onReviewControllerChange={onReviewControllerChange}
      />
    </div>
  );
}
