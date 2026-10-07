import type { Editor } from "@tiptap/react";
import {
  Check,
  ChevronRight,
  FileText,
  Reply,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CommentActionDefinition,
  type CommentActionsRenderContext,
  type CommentContentRenderContext,
  CommentEditorList,
} from "./CommentEditorList";
import {
  type CriticChangeAttrs,
  type CriticChangeKind,
  type CriticComment,
  getThreadComments,
  isGlobalThreadRoot,
  isResolvedComment,
} from "./critic-markup";
import {
  buildCommentThreadRailItems,
  type CommentGroupAnchor,
  type CommentThreadRailItem,
  getPreferredCommentId,
  getRootThreadIdForCommentId,
  normalizeCommentMeasurement,
  resolveAnchoredRailLayouts,
} from "./document-comments";
import { Badge } from "./components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { SUGGESTED_PARAGRAPH_SENTINEL } from "./editor-extensions";
import { cn } from "./lib/utils";
import type { DraftSuggestionState } from "./PageCard";

const SUGGESTION_QUOTE_PREVIEW_LIMIT = 140;

export interface CriticChangeRailItem {
  changeId: string;
  change: CriticChangeAttrs;
  kind: CriticChangeKind;
  oldText: string;
  newText: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

interface DocumentReviewRailProps {
  commentGroups: CommentGroupAnchor[];
  comments: Map<string, CriticComment>;
  suggestions: CriticChangeRailItem[];
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  selectedChangeId: string | null;
  hoveredChangeId: string | null;
  contentHeight: number;
  className?: string;
  layout?: "anchored" | "flow";
  testId?: string;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onReplyComment: (commentId: string) => void;
  onSelectComment: (commentId: string) => void;
  onFocusComment: (commentId: string) => void;
  onHoverComment: (commentId: string | null) => void;
  onResolveComment?: (commentId: string) => void;
  onReopenComment?: (commentId: string) => void;
  onAcceptSuggestion: (changeId: string) => void;
  onRejectSuggestion: (changeId: string) => void;
  onReplySuggestion: (changeId: string) => void;
  onSelectSuggestion: (changeId: string) => void;
  onFocusSuggestion: (changeId: string) => void;
  onHoverSuggestion: (changeId: string | null) => void;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  onDraftChange?: (commentId: string, text: string) => void;
  draftSuggestion?: DraftSuggestionState | null;
  onDraftSuggestionTextChange?: (text: string) => void;
  onApplyDraftSuggestion?: () => void;
  onCancelDraftSuggestion?: () => void;
  editor?: Editor | null;
}

function railLayoutItemClass(layout: "anchored" | "flow") {
  return cn(
    "left-0 right-0 rounded-xl border border-transparent bg-transparent shadow-none transition-all duration-200 ease-out will-change-transform",
    layout === "anchored" ? "absolute" : "relative",
  );
}

function railLayoutItemStyle(
  layout: "anchored" | "flow",
  railTop: number,
): CSSProperties | undefined {
  return layout === "anchored" ? { top: railTop } : undefined;
}

function getSuggestionPreview(suggestion: CriticChangeRailItem) {
  const oldText = suggestion.oldText.trim();
  const newText = suggestion.newText.trim();

  if (suggestion.kind === "addition") return newText || "Inserted text";
  if (suggestion.kind === "deletion") return oldText || "Deleted text";
  if (oldText && newText) return `${oldText} -> ${newText}`;
  return oldText || newText || "Changed text";
}

function getSuggestionRootComment(
  suggestion: CriticChangeRailItem,
): CriticComment {
  return {
    id: suggestion.changeId,
    content: getSuggestionPreview(suggestion),
    createdAt: suggestion.change.createdAt,
    authorType: suggestion.change.authorType,
    authorId: suggestion.change.authorId,
  };
}

function truncateSuggestionQuote(text: string) {
  if (text.length <= SUGGESTION_QUOTE_PREVIEW_LIMIT) return text;
  return `${text.slice(0, SUGGESTION_QUOTE_PREVIEW_LIMIT)}...`;
}

function renderQuotedSuggestionText(text: string, fallback: string) {
  const withoutParagraphSentinels = text.replaceAll(
    SUGGESTED_PARAGRAPH_SENTINEL,
    "",
  );
  const fullDisplayText =
    withoutParagraphSentinels.trim() ||
    (text.includes(SUGGESTED_PARAGRAPH_SENTINEL)
      ? "Inserted paragraph"
      : fallback);
  const displayText = truncateSuggestionQuote(fullDisplayText);

  return (
    <span className="italic text-slate-600 dark:text-slate-400">
      "{displayText}"
    </span>
  );
}

function SuggestionCommentContent({
  suggestion,
}: {
  suggestion: CriticChangeRailItem;
}) {
  const oldText = suggestion.oldText.trim();
  const newText = suggestion.newText.trim();

  if (suggestion.kind === "addition") {
    return (
      <>
        <span className="font-semibold text-slate-800 dark:text-slate-200">
          Insert:
        </span>{" "}
        {renderQuotedSuggestionText(newText, "Inserted text")}
      </>
    );
  }

  if (suggestion.kind === "deletion") {
    return (
      <>
        <span className="font-semibold text-slate-800 dark:text-slate-200">
          Delete:
        </span>{" "}
        {renderQuotedSuggestionText(oldText, "Deleted text")}
      </>
    );
  }

  return (
    <>
      <span className="font-semibold text-slate-800 dark:text-slate-200">
        Replace:
      </span>{" "}
      {renderQuotedSuggestionText(oldText, "Original text")}{" "}
      <span className="text-slate-500 dark:text-slate-400">with</span>{" "}
      {renderQuotedSuggestionText(newText, "Changed text")}
    </>
  );
}

const GLOBAL_SECTION_KEY = "__global_comments__";
const RESOLVED_THREADS_KEY = "__resolved_comments__";

export interface CommentThreadHandlers {
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onReplyComment: (commentId: string) => void;
  onSelectComment: (commentId: string) => void;
  onFocusComment: (commentId: string) => void;
  onHoverComment: (commentId: string | null) => void;
  onResolveComment?: (commentId: string) => void;
  onReopenComment?: (commentId: string) => void;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  onDraftChange?: (commentId: string, text: string) => void;
}

function sortNewestFirst(comments: CriticComment[]) {
  return [...comments].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return right.createdAt.localeCompare(left.createdAt);
    }
    return rightTime - leftTime;
  });
}

/**
 * Whether a root's card lives in the global section: comments on the whole
 * document, comments whose anchor is gone, replies whose parent is missing,
 * and comments on code blocks (D10), which carry their quoted lines.
 */
export function isGlobalSectionRoot(
  comment: CriticComment,
  comments: ReadonlyMap<string, CriticComment>,
) {
  if (comment.literal) return false;
  if (isGlobalThreadRoot(comment, comments)) return true;
  return comment.scope === "code" && !comment.parentCommentId;
}

/**
 * Roots shown in the global section: open ones newest first (an open draft
 * on top), resolved ones folded.
 */
export function getGlobalThreadRoots(
  comments: ReadonlyMap<string, CriticComment>,
  draftIds: readonly string[] = [],
) {
  const roots = sortNewestFirst(
    [...comments.values()].filter((comment) =>
      isGlobalSectionRoot(comment, comments),
    ),
  );
  const drafts = roots.filter((root) => draftIds.includes(root.id));
  const saved = roots.filter((root) => !draftIds.includes(root.id));

  return {
    open: [...drafts, ...saved.filter((root) => !isResolvedComment(root))],
    resolved: saved.filter((root) => isResolvedComment(root)),
  };
}

function ThreadRootContent({
  comment,
  defaultContent,
}: {
  comment: CriticComment;
  defaultContent: ReactNode;
}) {
  return (
    <>
      {comment.lostAnchor ? (
        <span
          data-testid={`comment-lost-anchor-${comment.id}`}
          className="mb-0.5 block text-[11px] font-medium text-amber-700 dark:text-amber-400"
        >
          Anchor lost: the highlighted text is no longer in the document.
        </span>
      ) : null}
      {comment.scope === "code" && comment.quote ? (
        <span
          data-testid={`comment-code-quote-${comment.id}`}
          className="mb-1.5 block overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-slate-700 dark:bg-slate-900"
        >
          {comment.codeLines ? (
            <span
              data-testid={`comment-code-lines-${comment.id}`}
              className="block border-b border-stone-200 px-2 py-0.5 text-[10px] font-medium tracking-[0.04em] text-stone-500 uppercase dark:border-slate-700 dark:text-slate-400"
            >
              {comment.codeLines[0] === comment.codeLines[1]
                ? `Line ${comment.codeLines[0]}`
                : `Lines ${comment.codeLines[0]}–${comment.codeLines[1]}`}
            </span>
          ) : null}
          <code
            data-testid={`comment-code-quote-text-${comment.id}`}
            className="block max-h-32 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre text-stone-700 dark:text-slate-300"
          >
            {comment.quote}
          </code>
        </span>
      ) : null}
      {defaultContent}
      {isResolvedComment(comment) ? (
        <span
          data-testid={`comment-resolved-summary-${comment.id}`}
          className="mt-1 flex items-start gap-1 text-[12px] text-emerald-700 dark:text-emerald-400"
        >
          <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>Resolved{comment.resolved ? `: ${comment.resolved}` : ""}</span>
        </span>
      ) : null}
    </>
  );
}

// One thread (a root and every reply under it, from the comment map) as a
// card. Collapsed until selected, like an anchored thread.
export function CommentThreadCard({
  rootId,
  comments,
  handlers,
  variant = "rail",
  testId,
  className,
  style,
  selected,
  muted = false,
  cardRef,
  onActivate,
}: {
  rootId: string;
  comments: ReadonlyMap<string, CriticComment>;
  handlers: CommentThreadHandlers;
  variant?: "rail" | "banner";
  testId: string;
  className?: string;
  style?: CSSProperties;
  selected: boolean;
  muted?: boolean;
  cardRef?: (node: HTMLDivElement | null) => void;
  onActivate?: (commentId: string) => void;
}) {
  const threadComments = getThreadComments(rootId, comments);
  if (threadComments.length === 0) return null;

  const primaryCommentId =
    getPreferredCommentId(
      threadComments.map((comment) => comment.id),
      handlers.selectedCommentId,
    ) ?? rootId;
  const root = threadComments[0];

  return (
    <div
      ref={cardRef}
      data-testid={testId}
      data-comment-thread-container="true"
      data-thread-root-id={rootId}
      data-author={root?.authorType === "ai" ? "ai" : "user"}
      className={cn(
        "rounded-xl border border-transparent bg-transparent shadow-none transition-all duration-200 ease-out",
        selected
          ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
          : "cursor-pointer",
        muted && !selected && "opacity-70",
        className,
      )}
      style={style}
      onMouseEnter={() => handlers.onHoverComment(primaryCommentId)}
      onMouseLeave={() => handlers.onHoverComment(null)}
      onClick={() => {
        if (selected) return;
        (onActivate ?? handlers.onFocusComment)(primaryCommentId);
      }}
    >
      <CommentEditorList
        comments={threadComments}
        variant={variant}
        className={cn(!selected && "pointer-events-none")}
        interactive={selected}
        selectedCommentId={handlers.selectedCommentId}
        hoveredCommentId={handlers.hoveredCommentId}
        onDeleteComment={handlers.onDeleteComment}
        onUpdateComment={handlers.onUpdateComment}
        onReplyComment={handlers.onReplyComment}
        onSelectComment={handlers.onSelectComment}
        onFocusComment={handlers.onFocusComment}
        onHoverComment={handlers.onHoverComment}
        pendingFocusCommentId={handlers.pendingFocusCommentId}
        newCommentDraftIds={handlers.newCommentDraftIds}
        onAutoFocusComment={handlers.onAutoFocusComment}
        onDraftChange={handlers.onDraftChange}
        renderCommentContent={({ comment, depth, defaultContent }) =>
          depth === 0 ? (
            <ThreadRootContent
              comment={comment}
              defaultContent={defaultContent}
            />
          ) : (
            defaultContent
          )
        }
        getCommentActions={({ comment, depth, isEditing, defaultActions }) => {
          if (depth !== 0 || isEditing) return defaultActions;
          if (isResolvedComment(comment)) {
            return handlers.onReopenComment
              ? [
                  ...defaultActions,
                  {
                    key: "reopen",
                    label: "Reopen",
                    icon: <RotateCcw className="size-3.5" />,
                    onClick: (event) => {
                      event.stopPropagation();
                      handlers.onReopenComment?.(comment.id);
                    },
                  },
                ]
              : defaultActions;
          }
          return handlers.onResolveComment
            ? [
                ...defaultActions,
                {
                  key: "resolve",
                  label: "Resolve",
                  icon: <Check className="size-3.5" />,
                  compact: true,
                  onClick: (event) => {
                    event.stopPropagation();
                    handlers.onResolveComment?.(comment.id);
                  },
                },
              ]
            : defaultActions;
        }}
      />
    </div>
  );
}

// "N resolved", folded by default; opens on click or when one of its threads
// is selected. Each thread inside keeps its Reopen action.
function ResolvedThreadsFold({
  rootIds,
  comments,
  handlers,
  activeRootThreadId,
  variant,
  testId,
}: {
  rootIds: string[];
  comments: ReadonlyMap<string, CriticComment>;
  handlers: CommentThreadHandlers;
  activeRootThreadId: string | null;
  variant: "rail" | "banner";
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const containsActive =
    !!activeRootThreadId && rootIds.includes(activeRootThreadId);
  const expanded = open || containsActive;

  if (rootIds.length === 0) return null;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(nextOpen) => setOpen(nextOpen)}
      data-comment-thread-container="true"
      className="grid gap-2"
    >
      <CollapsibleTrigger
        data-testid={testId}
        className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:text-stone-400 dark:hover:bg-slate-800 dark:hover:text-stone-200"
        onClick={(event) => event.stopPropagation()}
      >
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        {rootIds.length} resolved
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2">
        {rootIds.map((rootId) => (
          <CommentThreadCard
            key={rootId}
            rootId={rootId}
            comments={comments}
            handlers={handlers}
            variant={variant}
            testId={`resolved-comment-thread-${rootId}`}
            selected={activeRootThreadId === rootId}
            muted
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// The global section: comments on the whole document (an open draft on
// top), comments on code blocks, comments whose anchor is gone and replies
// whose parent is missing, newest first, resolved ones folded into one row
// at the bottom.
export function GlobalCommentsSection({
  comments,
  handlers,
  activeRootThreadId,
  variant = "rail",
  testId = "global-comments-section",
  resolvedToggleTestId = "global-comments-resolved-toggle",
}: {
  comments: ReadonlyMap<string, CriticComment>;
  handlers: CommentThreadHandlers;
  activeRootThreadId: string | null;
  variant?: "rail" | "banner";
  testId?: string;
  resolvedToggleTestId?: string;
}) {
  const { open, resolved } = getGlobalThreadRoots(
    comments,
    handlers.newCommentDraftIds,
  );
  if (open.length === 0 && resolved.length === 0) return null;
  const openCount = open.filter(
    (root) => root.content.trim().length > 0,
  ).length;

  return (
    <section
      data-testid={testId}
      aria-label="Global comments"
      className="grid gap-2"
    >
      <div className="flex items-center gap-1.5 px-3 text-[11px] font-semibold tracking-[0.08em] text-stone-500 uppercase dark:text-stone-400">
        <FileText className="size-3.5" aria-hidden="true" />
        Global comments
        {openCount > 0 ? (
          <Badge
            variant="secondary"
            data-testid="global-comments-open-count"
            className="h-4 px-1.5 tracking-normal text-stone-600 dark:text-slate-300"
          >
            {openCount}
          </Badge>
        ) : null}
      </div>
      {open.map((root) => (
        <CommentThreadCard
          key={root.id}
          rootId={root.id}
          comments={comments}
          handlers={handlers}
          variant={variant}
          testId={`global-comment-thread-${root.id}`}
          selected={activeRootThreadId === root.id}
        />
      ))}
      <ResolvedThreadsFold
        rootIds={resolved.map((root) => root.id)}
        comments={comments}
        handlers={handlers}
        activeRootThreadId={activeRootThreadId}
        variant={variant}
        testId={resolvedToggleTestId}
      />
    </section>
  );
}

export function DocumentReviewRail({
  commentGroups,
  comments,
  suggestions,
  selectedCommentId,
  hoveredCommentId,
  selectedChangeId,
  hoveredChangeId,
  contentHeight,
  className,
  layout: railLayout = "anchored",
  testId,
  onDeleteComment,
  onUpdateComment,
  onReplyComment,
  onSelectComment,
  onFocusComment,
  onHoverComment,
  onResolveComment,
  onReopenComment,
  onAcceptSuggestion,
  onRejectSuggestion,
  onReplySuggestion,
  onSelectSuggestion,
  onFocusSuggestion,
  onHoverSuggestion,
  pendingFocusCommentId = null,
  newCommentDraftIds = [],
  onAutoFocusComment,
  onDraftChange,
  draftSuggestion = null,
  onDraftSuggestionTextChange,
  onApplyDraftSuggestion,
  onCancelDraftSuggestion,
  editor = null,
}: DocumentReviewRailProps) {
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({});

  const activeRootThreadId = useMemo(
    () => getRootThreadIdForCommentId(selectedCommentId, comments),
    [comments, selectedCommentId],
  );

  const suggestionCommentIds = useMemo(
    () => new Set(suggestions.flatMap((suggestion) => suggestion.commentIds)),
    [suggestions],
  );

  const globalRoots = useMemo(
    () => getGlobalThreadRoots(comments, newCommentDraftIds),
    [comments, newCommentDraftIds],
  );

  const visibleCommentThreads = useMemo(() => {
    const excludeRootIds = new Set<string>(suggestionCommentIds);
    for (const comment of comments.values()) {
      if (comment.literal || isGlobalSectionRoot(comment, comments)) {
        excludeRootIds.add(comment.id);
      }
    }

    return buildCommentThreadRailItems(commentGroups, comments, {
      excludeRootIds,
    })
      .map((item) => {
        const visibleComments = item.commentIds
          .map((commentId) => comments.get(commentId))
          .filter((comment): comment is CriticComment => Boolean(comment));

        if (visibleComments.length === 0) return null;

        return {
          ...item,
          visibleComments,
        };
      })
      .filter(
        (
          item,
        ): item is CommentThreadRailItem & {
          visibleComments: CriticComment[];
        } => Boolean(item),
      );
  }, [commentGroups, comments, suggestionCommentIds]);

  const resolvedThreadRootIds = useMemo(
    () =>
      visibleCommentThreads
        .filter((thread) =>
          isResolvedComment(comments.get(thread.rootCommentId)),
        )
        .map((thread) => thread.rootCommentId),
    [comments, visibleCommentThreads],
  );

  const commentEntries = useMemo(
    () =>
      visibleCommentThreads
        .filter(
          (thread) => !isResolvedComment(comments.get(thread.rootCommentId)),
        )
        .map((thread) => ({
          type: "comment" as const,
          key: thread.key,
          anchorTop: thread.anchorTop,
          anchorBottom: thread.anchorBottom,
          thread,
        })),
    [comments, visibleCommentThreads],
  );

  const globalEntry = useMemo(
    () =>
      globalRoots.open.length > 0 || globalRoots.resolved.length > 0
        ? {
            type: "global" as const,
            key: GLOBAL_SECTION_KEY,
            anchorTop: 0,
            anchorBottom: 0,
          }
        : null,
    [globalRoots],
  );

  const suggestionEntries = useMemo(
    () =>
      suggestions.map((suggestion) => ({
        type: "suggestion" as const,
        key: suggestion.changeId,
        anchorTop: suggestion.anchorTop,
        anchorBottom: suggestion.anchorBottom,
        suggestion,
      })),
    [suggestions],
  );

  const draftAnchorTop = useMemo(() => {
    if (!draftSuggestion || !editor) return 0;
    try {
      const editorElement = editor.view.dom as HTMLElement;
      const editorRect = editorElement.getBoundingClientRect();
      const coords = editor.view.coordsAtPos(draftSuggestion.from);
      return coords.top - editorRect.top;
    } catch {
      return 0;
    }
  }, [draftSuggestion, editor]);

  const draftEntry = useMemo(() => {
    if (!draftSuggestion) return null;
    return {
      type: "draft" as const,
      key: "__draft_suggestion__",
      anchorTop: draftAnchorTop,
      anchorBottom: draftAnchorTop + 20,
    };
  }, [draftSuggestion, draftAnchorTop]);

  const activeSuggestionIdForComment = useMemo(
    () =>
      selectedCommentId
        ? (suggestions.find((suggestion) =>
            suggestion.commentIds.includes(selectedCommentId),
          )?.changeId ?? null)
        : null,
    [selectedCommentId, suggestions],
  );

  const layouts = useMemo(() => {
    const anchoredEntries = [
      ...suggestionEntries,
      ...commentEntries,
      ...(draftEntry ? [draftEntry] : []),
    ];
    // Resolved anchored threads fold into one row below every other card.
    const lastAnchorTop = Math.max(
      0,
      ...anchoredEntries.map((entry) => entry.anchorTop),
    );
    const resolvedEntry =
      resolvedThreadRootIds.length > 0
        ? {
            type: "resolved" as const,
            key: RESOLVED_THREADS_KEY,
            anchorTop: lastAnchorTop + 1,
            anchorBottom: lastAnchorTop + 1,
          }
        : null;
    const entries: Array<
      | (typeof anchoredEntries)[number]
      | NonNullable<typeof resolvedEntry>
      | NonNullable<typeof globalEntry>
    > = [...anchoredEntries, ...(resolvedEntry ? [resolvedEntry] : [])].sort(
      (left, right) => left.anchorTop - right.anchorTop,
    );
    // The global section always sits first, at the top of the rail.
    if (globalEntry) {
      entries.unshift(globalEntry);
    }
    const activeRootIsGlobal =
      !!activeRootThreadId &&
      [...globalRoots.open, ...globalRoots.resolved].some(
        (root) => root.id === activeRootThreadId,
      );
    const activeRootIsResolved =
      !!activeRootThreadId &&
      resolvedThreadRootIds.includes(activeRootThreadId);
    const activeKey =
      draftEntry?.key ??
      selectedChangeId ??
      activeSuggestionIdForComment ??
      (activeRootIsGlobal
        ? GLOBAL_SECTION_KEY
        : activeRootIsResolved
          ? RESOLVED_THREADS_KEY
          : activeRootThreadId);

    return resolveAnchoredRailLayouts(entries, itemHeights, activeKey);
  }, [
    activeRootThreadId,
    activeSuggestionIdForComment,
    commentEntries,
    draftEntry,
    globalEntry,
    globalRoots,
    itemHeights,
    resolvedThreadRootIds,
    selectedChangeId,
    suggestionEntries,
  ]);

  const threadHandlers: CommentThreadHandlers = {
    selectedCommentId,
    hoveredCommentId,
    onDeleteComment,
    onUpdateComment,
    onReplyComment,
    onSelectComment,
    onFocusComment,
    onHoverComment,
    onResolveComment,
    onReopenComment,
    pendingFocusCommentId,
    newCommentDraftIds,
    onAutoFocusComment,
    onDraftChange,
  };

  const setItemRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      itemRefs.current.set(key, node);
    } else {
      itemRefs.current.delete(key);
    }
  }, []);

  useLayoutEffect(() => {
    if (layouts.length === 0) {
      setItemHeights((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }

    const updateHeights = () => {
      setItemHeights((current) => {
        const next: Record<string, number> = {};
        let changed = false;

        for (const layout of layouts) {
          const element = itemRefs.current.get(layout.key);
          const measuredHeight = Math.ceil(
            element?.getBoundingClientRect().height ?? 0,
          );
          const height =
            measuredHeight > 0
              ? Math.ceil(normalizeCommentMeasurement(measuredHeight, 1))
              : (current[layout.key] ?? 0);
          next[layout.key] = height;
          if (current[layout.key] !== height) {
            changed = true;
          }
        }

        if (
          !changed &&
          Object.keys(current).length === Object.keys(next).length
        ) {
          return current;
        }

        return next;
      });
    };

    updateHeights();

    const resizeObserver = new ResizeObserver(() => {
      updateHeights();
    });

    for (const layout of layouts) {
      const element = itemRefs.current.get(layout.key);
      if (element) {
        resizeObserver.observe(element);
      }
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [layouts]);

  useEffect(() => {
    if (draftSuggestion && draftTextareaRef.current) {
      draftTextareaRef.current.focus();
    }
  }, [draftSuggestion]);

  const railHeight =
    railLayout === "flow"
      ? undefined
      : Math.max(contentHeight, layouts.at(-1)?.railBottom ?? 0) + 24;

  const hasDraftOnly = layouts.length === 0 && !draftSuggestion;
  if (hasDraftOnly) {
    return <aside className={cn("min-w-0", className)} aria-hidden="true" />;
  }

  return (
    <aside className={cn("min-w-0", className)} data-testid={testId}>
      <div
        className={cn(railLayout === "flow" ? "grid gap-3" : "relative")}
        style={railHeight ? { minHeight: railHeight } : undefined}
      >
        {layouts.map((layout) => {
          if (layout.type === "global") {
            return (
              <div
                key={layout.key}
                ref={(node) => setItemRef(layout.key, node)}
                className={railLayoutItemClass(railLayout)}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
              >
                <GlobalCommentsSection
                  comments={comments}
                  handlers={threadHandlers}
                  activeRootThreadId={activeRootThreadId}
                />
              </div>
            );
          }

          if (layout.type === "resolved") {
            return (
              <div
                key={layout.key}
                ref={(node) => setItemRef(layout.key, node)}
                className={railLayoutItemClass(railLayout)}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
              >
                <ResolvedThreadsFold
                  rootIds={resolvedThreadRootIds}
                  comments={comments}
                  handlers={threadHandlers}
                  activeRootThreadId={activeRootThreadId}
                  variant="rail"
                  testId="comment-threads-resolved-toggle"
                />
              </div>
            );
          }

          if (layout.type === "comment") {
            const isSelected =
              !!activeRootThreadId &&
              layout.thread.rootCommentId === activeRootThreadId;

            return (
              <CommentThreadCard
                key={layout.key}
                cardRef={(node) => setItemRef(layout.key, node)}
                rootId={layout.thread.rootCommentId}
                comments={comments}
                handlers={threadHandlers}
                testId={`comment-thread-${layout.thread.rootCommentId}`}
                selected={isSelected}
                className={cn(
                  railLayoutItemClass(railLayout),
                  isSelected && "-translate-x-2 cursor-default",
                )}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
              />
            );
          }

          if (layout.type === "draft") {
            return (
              <div
                key={layout.key}
                ref={(node) => setItemRef(layout.key, node)}
                data-testid="draft-suggestion-thread"
                data-suggestion-thread-container="true"
                className={cn(
                  railLayoutItemClass(railLayout),
                  "-translate-x-2 border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card px-4 py-3 shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]",
                )}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-stone-500 dark:text-stone-400 uppercase">
                      {draftSuggestion?.type === "replacement"
                        ? "Replacement"
                        : "Insertion"}
                    </div>
                    <div className="mt-1 text-sm leading-5 text-slate-700 dark:text-slate-300">
                      {draftSuggestion?.sourceText || "Current cursor position"}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-dismiss"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-stone-500 dark:text-stone-400 transition hover:bg-stone-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600"
                    aria-label="Cancel suggestion"
                    onClick={() => onCancelDraftSuggestion?.()}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <textarea
                  ref={draftTextareaRef}
                  data-testid="draft-suggestion-editor"
                  value={draftSuggestion?.text ?? ""}
                  rows={2}
                  className="mt-3 min-h-16 w-full resize-y rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm leading-6 text-slate-800 dark:text-slate-200 outline-none transition focus:border-emerald-300 dark:focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900"
                  placeholder={
                    draftSuggestion?.type === "replacement"
                      ? "Replacement text"
                      : "Inserted text"
                  }
                  onChange={(event) => {
                    onDraftSuggestionTextChange?.(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "enter"
                    ) {
                      event.preventDefault();
                      onApplyDraftSuggestion?.();
                    }
                  }}
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-cancel"
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium text-stone-600 dark:text-stone-400 transition hover:bg-stone-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600"
                    onClick={() => onCancelDraftSuggestion?.()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-apply"
                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 dark:bg-emerald-700 px-3 text-sm font-medium text-white transition hover:bg-emerald-700 dark:hover:bg-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 dark:focus-visible:ring-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!draftSuggestion?.text}
                    onClick={() => onApplyDraftSuggestion?.()}
                  >
                    <Check className="size-4" />
                    Suggest
                  </button>
                </div>
              </div>
            );
          }

          const suggestion = layout.suggestion;
          const isSelected = selectedChangeId === suggestion.changeId;
          const isHovered = hoveredChangeId === suggestion.changeId;
          const suggestionComments = suggestion.commentIds
            .map((commentId) => comments.get(commentId))
            .filter((comment): comment is CriticComment => Boolean(comment));
          const suggestionCommentIds = new Set(
            suggestionComments.map((comment) => comment.id),
          );
          const normalizedSuggestionComments = suggestionComments.map(
            (comment) =>
              comment.parentCommentId === suggestion.changeId ||
              (comment.parentCommentId &&
                suggestionCommentIds.has(comment.parentCommentId))
                ? comment
                : {
                    ...comment,
                    parentCommentId: suggestion.changeId,
                  },
          );
          const suggestionRootComment = getSuggestionRootComment(suggestion);
          const suggestionThreadComments = [
            suggestionRootComment,
            ...normalizedSuggestionComments,
          ];
          const renderCommentContent = ({
            comment,
            defaultContent,
          }: CommentContentRenderContext) =>
            comment.id === suggestion.changeId ? (
              <SuggestionCommentContent suggestion={suggestion} />
            ) : (
              defaultContent
            );
          const getCommentActions = ({
            comment,
            defaultActions,
          }: CommentActionsRenderContext): CommentActionDefinition[] =>
            comment.id === suggestion.changeId
              ? [
                  {
                    key: "accept",
                    label: "Accept suggestion",
                    icon: <Check className="size-3.5" />,
                    compact: true,
                    onClick: (event) => {
                      event.stopPropagation();
                      onAcceptSuggestion(suggestion.changeId);
                    },
                  },
                  {
                    key: "reject",
                    label: "Reject suggestion",
                    tone: "danger",
                    icon: <X className="size-3.5" />,
                    compact: true,
                    onClick: (event) => {
                      event.stopPropagation();
                      onRejectSuggestion(suggestion.changeId);
                    },
                  },
                  {
                    key: "reply",
                    label: "Reply",
                    icon: <Reply className="size-3.5" />,
                    compact: true,
                    onClick: (event) => {
                      event.stopPropagation();
                      onReplySuggestion(suggestion.changeId);
                    },
                  },
                ]
              : defaultActions;

          return (
            <div
              key={layout.key}
              ref={(node) => setItemRef(layout.key, node)}
              data-testid={`suggestion-thread-${suggestion.changeId}`}
              data-suggestion-thread-container="true"
              className={cn(
                railLayoutItemClass(railLayout),
                isSelected
                  ? "-translate-x-2 border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                  : "",
                isHovered && !isSelected && "cursor-pointer",
              )}
              style={railLayoutItemStyle(railLayout, layout.railTop)}
              onMouseEnter={() => onHoverSuggestion(suggestion.changeId)}
              onMouseLeave={() => onHoverSuggestion(null)}
              onPointerDown={() => onSelectSuggestion(suggestion.changeId)}
              onClick={() => {
                if (isSelected) return;
                onFocusSuggestion(suggestion.changeId);
              }}
            >
              <CommentEditorList
                comments={suggestionThreadComments}
                variant="rail"
                selectedCommentId={
                  selectedCommentId ?? (isSelected ? suggestion.changeId : null)
                }
                hoveredCommentId={
                  hoveredCommentId ?? (isHovered ? suggestion.changeId : null)
                }
                onDeleteComment={onDeleteComment}
                onUpdateComment={onUpdateComment}
                onReplyComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onReplySuggestion(suggestion.changeId);
                    return;
                  }

                  onReplyComment(commentId);
                }}
                onSelectComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onSelectSuggestion(suggestion.changeId);
                    return;
                  }

                  onSelectComment(commentId);
                }}
                onFocusComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onFocusSuggestion(suggestion.changeId);
                    return;
                  }

                  onFocusComment(commentId);
                }}
                onHoverComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onHoverSuggestion(suggestion.changeId);
                    return;
                  }

                  onHoverComment(commentId);
                }}
                pendingFocusCommentId={pendingFocusCommentId}
                newCommentDraftIds={newCommentDraftIds}
                onAutoFocusComment={onAutoFocusComment}
                renderCommentContent={renderCommentContent}
                getCommentActions={getCommentActions}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
