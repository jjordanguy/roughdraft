import {
  AlertTriangle,
  Check,
  ChevronDown,
  CodeXml,
  Copy,
  Eye,
  Loader2,
  MessageSquarePlus,
  MessageSquareText,
  PencilLine,
  RefreshCcw,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AiRoundBadge } from "./AiRoundBadge";
import type { DocumentEditorViewMode } from "./app-navigation";
import { Button } from "./components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "./components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  criticMarkdownHasReviewRail,
  criticMarkdownToRenderedHtml,
} from "./critic-markup";
import {
  type DocumentSync,
  type DocumentSyncView,
  HandoffError,
  type Snapshot,
} from "./document-sync";
import { cn } from "./lib/utils";
import {
  type DocumentInteractionMode,
  type DocumentReviewController,
  type DocumentSaveState,
  PageCard,
} from "./PageCard";
import { RobotsHighFiveToy } from "./RobotsHighFiveToy";
import {
  createClientId,
  type DiskChangeState,
  getReviewHandoffView,
  type ReviewHandoffErrorKind,
  type ReviewHandoffPhase,
} from "./review-handoff";
import type {
  CompleteReviewResult,
  HandoffRecord,
  Page,
  StorageBackend,
} from "./storage";
import { useReviewLayoutShiftAnimation } from "./useReviewLayoutShiftAnimation";

type FileCopyAction = "path" | "filename" | "markdown" | "rich-text";
const FILE_COPY_PREVIEW_MAX_LENGTH = 34;
const reviewCompleteTitles = [
  "Great work!",
  "Nice one!",
  "Well done!",
  "All set!",
  "Review complete!",
  "That’ll do!",
  "Lovely stuff!",
  "Job done!",
  "Done and dusted!",
  "Nailed it!",
  "Good stuff!",
  "Sorted!",
  "Cracking work!",
  "Top work!",
  "Brilliant!",
  "Ace!",
  "Spot on!",
  "Beauty!",
  "Too easy!",
  "Good on ya!",
  "You’re golden!",
  "That’s the ticket!",
  "And that’s that!",
  "Wrapped!",
  "In the bag!",
  "Shipshape!",
  "Right as rain!",
] as const;
type ReviewCompleteTitle = (typeof reviewCompleteTitles)[number];

function buildReviewHandoffCopyMessage(documentPath: string) {
  return `I am done reviewing this file: ${documentPath}`;
}

function getRandomReviewCompleteTitle(random: () => number = Math.random) {
  const index = Math.floor(random() * reviewCompleteTitles.length);
  return reviewCompleteTitles[Math.min(index, reviewCompleteTitles.length - 1)];
}

function getRandomReviewCompleteTitleExcept(
  currentTitle: ReviewCompleteTitle,
  random: () => number = Math.random,
): ReviewCompleteTitle {
  const otherTitles = reviewCompleteTitles.filter(
    (title) => title !== currentTitle,
  );
  if (otherTitles.length === 0) return currentTitle;

  const index = Math.floor(random() * otherTitles.length);
  return otherTitles[Math.min(index, otherTitles.length - 1)];
}

const documentInteractionModeOptions = [
  { value: "editing", label: "Editing", Icon: PencilLine },
  { value: "suggesting", label: "Suggesting", Icon: MessageSquarePlus },
  { value: "viewing", label: "Viewing", Icon: Eye },
] satisfies {
  value: DocumentInteractionMode;
  label: string;
  Icon: typeof Eye;
}[];

const conflictNoticeCopy: Record<
  "changed" | "conflict" | "paused",
  {
    title: string;
    body: string;
  }
> = {
  changed: {
    title: "File changed on disk",
    body: "Roughdraft found a newer version of this file on disk. Reload to use that version, or overwrite it with your current draft.",
  },
  conflict: {
    title: "Save conflict",
    body: "This file changed on disk while you have unsaved edits. Autosave is paused so your draft will not overwrite those changes.",
  },
  paused: {
    title: "Autosave paused",
    body: "Keep editing locally, then reload from disk to discard your draft or overwrite the disk file when you are ready.",
  },
};

const fileCopyMenuOptions = [
  { action: "path", label: "Path" },
  { action: "filename", label: "Filename" },
  { action: "markdown", label: "Markdown" },
  { action: "rich-text", label: "Rich text" },
] satisfies {
  action: FileCopyAction;
  label: string;
}[];

function formatFileCopyPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= FILE_COPY_PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, FILE_COPY_PREVIEW_MAX_LENGTH - 1)}...`;
}

async function writePlainTextToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

function markdownToPlainText(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = markdownToCleanRichHtml(markdown);
  return (template.content.textContent ?? "").trimEnd();
}

function unwrapElement(element: HTMLElement) {
  element.replaceWith(...element.childNodes);
}

function markdownToCleanRichHtml(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = criticMarkdownToRenderedHtml(markdown).html;

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>(
      "[data-comment-anchorless='true']",
    ),
  )) {
    element.remove();
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-comment-ids]"),
  )) {
    unwrapElement(element);
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>(
      "[data-critic-change-kind='addition'], [data-critic-change-kind='substitution-new']",
    ),
  )) {
    element.remove();
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-critic-change-kind]"),
  )) {
    unwrapElement(element);
  }

  return template.innerHTML;
}

async function writeRichTextToClipboard(markdown: string) {
  const clipboardWithRichText = navigator.clipboard as Clipboard & {
    write?: Clipboard["write"];
  };
  const html = markdownToCleanRichHtml(markdown);
  const plainText = markdownToPlainText(markdown);

  if (clipboardWithRichText.write && typeof ClipboardItem !== "undefined") {
    await clipboardWithRichText.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
    return;
  }

  await writePlainTextToClipboard(plainText);
}

// One place that turns the controller's state into the two values the
// status icon, the banner and the Done button read.
export function getSyncStatus(view: DocumentSyncView): {
  saveState: DocumentSaveState;
  diskState: DiskChangeState;
} {
  const unsavedOrSaved = view.dirty ? "unsaved" : "saved";
  switch (view.state.kind) {
    case "synced":
      return { saveState: view.dirty ? "saving" : "saved", diskState: "clean" };
    case "pending":
    case "saving":
      return { saveState: "saving", diskState: "clean" };
    case "offline":
      return { saveState: "offline", diskState: "clean" };
    case "unavailable":
      return { saveState: unsavedOrSaved, diskState: "unavailable" };
    case "changed":
    case "conflict":
      return {
        saveState: unsavedOrSaved,
        diskState: view.paused ? "paused" : view.state.kind,
      };
  }
}

function formatDiskVersion(snapshot: Snapshot): string {
  const shortHash = snapshot.contentHash.replace(/^local:\d+:/, "").slice(0, 7);
  const mtime = Number(snapshot.version.split(":")[0]);
  if (Number.isFinite(mtime) && mtime > 0) {
    const time = new Date(mtime).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
    return `Disk version from ${time} (${shortHash})`;
  }
  return `Disk version ${shortHash}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

const noopSubscribe = () => () => {};

function useDocumentSyncView(sync: DocumentSync | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sync ? sync.subscribe(listener) : noopSubscribe(),
    [sync],
  );
  const getSnapshot = useCallback(() => sync?.getView() ?? null, [sync]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function getSaveStatusViewModel(
  saveState: DocumentSaveState,
  diskChangeState: DiskChangeState,
) {
  if (diskChangeState === "conflict") {
    return {
      label: "Save conflict",
      ariaLabel: "Save conflict",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "changed") {
    return {
      label: "File changed on disk",
      ariaLabel: "File changed on disk",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "paused") {
    return {
      label: "Autosave paused",
      ariaLabel: "Autosave paused",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "unavailable") {
    return {
      label: "File unavailable",
      ariaLabel: "File unavailable",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "offline") {
    return {
      label: "Save failed, retrying",
      ariaLabel: "Save failed, retrying",
      tone: "danger" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "saving") {
    return {
      label: "Saving",
      ariaLabel: "Saving",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  if (saveState === "error") {
    return {
      label: "Save failed",
      ariaLabel: "Save failed",
      tone: "danger" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "unsaved") {
    return {
      label: "Unsaved changes",
      ariaLabel: "Unsaved changes",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  return {
    label: "Saved",
    ariaLabel: "Saved",
    tone: "success" as const,
    Icon: Check,
  };
}

// PageCard needs an onSave; with a sync controller it is never called.
const noopSave = async () => {};

export function DocumentSaveStatusIndicator({
  saveState,
  diskChangeState,
}: {
  saveState: DocumentSaveState;
  diskChangeState: DiskChangeState;
}) {
  const saveStatus = getSaveStatusViewModel(saveState, diskChangeState);
  const SaveStatusIcon = saveStatus.Icon;

  return (
    <span
      data-testid="document-save-status"
      role="status"
      aria-label={saveStatus.ariaLabel}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center text-stone-400 dark:text-stone-500",
        saveStatus.tone === "warning" && "text-amber-600 dark:text-amber-400",
        saveStatus.tone === "danger" && "text-red-600 dark:text-red-400",
      )}
    >
      <SaveStatusIcon
        data-testid="document-save-status-icon"
        className={cn(
          "size-3.5 shrink-0",
          (saveStatus.label === "Saving" ||
            saveStatus.label === "Unsaved changes") &&
            "animate-spin",
          saveStatus.label === "Saved" && "document-save-status-saved",
        )}
        aria-hidden="true"
      />
    </span>
  );
}

export function shouldLatchDocumentChangedSinceOpen({
  isDirty,
  documentChangeTrackingReady,
}: {
  isDirty: boolean;
  documentChangeTrackingReady: boolean;
}) {
  return isDirty && documentChangeTrackingReady;
}

interface DocumentWorkspaceProps {
  // The open document's sync controller; null before a document loads.
  sync: DocumentSync | null;
  activeDocumentPath: string | null;
  documentCopyPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  sync,
  activeDocumentPath,
  documentCopyPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  backend,
}: DocumentWorkspaceProps) {
  const syncView = useDocumentSyncView(sync);
  const syncBase = syncView?.base ?? null;
  // The saved page. The live draft is `sync.draft`; reading it here would
  // re-render the workspace on every keystroke.
  const documentPage = useMemo<Page | null>(
    () =>
      sync && syncBase
        ? {
            id: sync.pageId,
            title: sync.title,
            content: syncBase.content,
            version: syncBase.version,
          }
        : null,
    [sync, syncBase],
  );
  const { saveState, diskState: documentDiskChangeState } = syncView
    ? getSyncStatus(syncView)
    : { saveState: "saved" as const, diskState: "clean" as const };
  const reviewWatcherCount = syncView?.watchers ?? 0;
  const reviewSessionLabel = syncView?.session?.label ?? null;
  const channelHandoff = syncView?.handoff ?? null;
  const [documentInteractionMode, setDocumentInteractionMode] =
    useState<DocumentInteractionMode>("suggesting");
  const [reviewHandoffErrorKind, setReviewHandoffErrorKind] =
    useState<ReviewHandoffErrorKind | null>(null);
  const [reviewHandoffPhase, setReviewHandoffPhase] =
    useState<ReviewHandoffPhase>("idle");
  const [reviewHandoffResult, setReviewHandoffResult] =
    useState<CompleteReviewResult | null>(null);
  const [reviewHandoffRecord, setReviewHandoffRecord] =
    useState<HandoffRecord | null>(null);
  const [copiedHandoffMessage, setCopiedHandoffMessage] = useState(false);
  const [reviewHandoffPopoverOpen, setReviewHandoffPopoverOpen] =
    useState(false);
  const [reviewCompleteTitle, setReviewCompleteTitle] = useState(() =>
    getRandomReviewCompleteTitle(),
  );
  const [fileCopyMenuOpen, setFileCopyMenuOpen] = useState(false);
  const [copiedFileAction, setCopiedFileAction] =
    useState<FileCopyAction | null>(null);
  // A press of the Global comment button not yet turned into a draft (the
  // rich-text surface may still be mounting after a switch from code view).
  const [globalCommentRequest, setGlobalCommentRequest] = useState<
    number | null
  >(null);
  const reviewControllerRef = useRef<DocumentReviewController | null>(null);
  const [documentChangedSinceOpen, setDocumentChangedSinceOpen] =
    useState(false);
  const sawNoWatcherAfterNotifiedRef = useRef(false);
  const reviewHandoffPhaseRef = useRef<ReviewHandoffPhase>("idle");
  reviewHandoffPhaseRef.current = reviewHandoffPhase;
  // Reused by every Done attempt until one gets a 2xx, so a retry after a
  // lost response cannot make the server write the overall comment twice.
  const pendingHandoffIdRef = useRef<string | null>(null);
  // The id of the last Done the server accepted; the status poll only
  // updates the handoff record when it reports this id.
  const completedHandoffIdRef = useRef<string | null>(null);
  // Document versions that belong to the last Done. Any other version from
  // disk (the agent replied) starts a new round.
  const completedHandoffVersionsRef = useRef<Set<string>>(new Set());
  const documentVersionRef = useRef<string | undefined>(documentPage?.version);
  documentVersionRef.current = documentPage?.version;
  const copiedFileActionTimeoutRef = useRef<number | null>(null);
  const documentChangeTrackingReadyRef = useRef(false);

  const [documentHasComments, setDocumentHasComments] = useState(
    () =>
      !!documentPage?.content &&
      criticMarkdownHasReviewRail(documentPage.content),
  );
  const documentHeaderRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(documentHasComments);

  useEffect(() => {
    setDocumentHasComments(
      !!documentPage?.content &&
        criticMarkdownHasReviewRail(documentPage.content),
    );
  }, [documentPage?.content]);

  useEffect(() => {
    const documentIdentity = `${activeDocumentPath ?? ""}:${documentPage?.id ?? ""}`;
    if (!documentIdentity) return;
    documentChangeTrackingReadyRef.current = false;
    setReviewHandoffPhase("idle");
    setReviewHandoffResult(null);
    setReviewHandoffRecord(null);
    pendingHandoffIdRef.current = null;
    completedHandoffIdRef.current = null;
    completedHandoffVersionsRef.current = new Set();
    setReviewHandoffPopoverOpen(false);
    setDocumentChangedSinceOpen(false);
    setGlobalCommentRequest(null);
    const readyTimer = window.setTimeout(() => {
      documentChangeTrackingReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(readyTimer);
  }, [activeDocumentPath, documentPage?.id]);

  // The tab channel pushes the latest handoff record (hello and handoff
  // messages). Only this tab's Done moves its button to "Picked up".
  useEffect(() => {
    if (
      channelHandoff &&
      channelHandoff.handoffId === completedHandoffIdRef.current
    ) {
      completedHandoffVersionsRef.current.add(channelHandoff.version);
      setReviewHandoffRecord(channelHandoff);
    }
  }, [channelHandoff]);

  const reviewHandoffSettledKind =
    reviewHandoffPhase !== "completed" || !reviewHandoffResult
      ? null
      : (reviewHandoffRecord ?? reviewHandoffResult.handoff)?.state ===
          "acknowledged"
        ? "picked-up"
        : reviewHandoffResult.delivered
          ? "sent"
          : "kept";

  useEffect(() => {
    // After a Done that reached an agent, a watcher that disconnects and a new
    // one that connects means the agent is waiting for another round. A Done
    // kept for later stays put: the next watcher is about to pick it up.
    if (
      reviewHandoffSettledKind !== "sent" &&
      reviewHandoffSettledKind !== "picked-up"
    ) {
      sawNoWatcherAfterNotifiedRef.current = false;
      return;
    }

    if (reviewWatcherCount === 0) {
      sawNoWatcherAfterNotifiedRef.current = true;
      return;
    }

    if (sawNoWatcherAfterNotifiedRef.current) {
      sawNoWatcherAfterNotifiedRef.current = false;
      setReviewHandoffPhase("idle");
      setReviewHandoffPopoverOpen(false);
    }
  }, [reviewHandoffSettledKind, reviewWatcherCount]);

  useEffect(() => {
    const version = documentPage?.version;
    if (!version || reviewHandoffPhaseRef.current !== "completed") return;
    if (completedHandoffVersionsRef.current.has(version)) return;
    setReviewHandoffPhase("idle");
    setReviewHandoffPopoverOpen(false);
  }, [documentPage?.version]);

  useEffect(() => {
    if (reviewHandoffSettledKind === "sent") {
      setReviewCompleteTitle((currentTitle) =>
        getRandomReviewCompleteTitleExcept(currentTitle),
      );
    }
  }, [reviewHandoffSettledKind]);

  useEffect(() => {
    return () => {
      if (copiedFileActionTimeoutRef.current !== null) {
        window.clearTimeout(copiedFileActionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!documentPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isSaveShortcut) return;

      event.preventDefault();
      event.stopPropagation();

      if (documentDiskChangeState !== "clean") return;

      void sync?.flush();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [documentDiskChangeState, documentPage, sync]);

  const handleCompleteReview = useCallback(async () => {
    if (
      !sync ||
      !activeDocumentPath ||
      reviewHandoffPhaseRef.current === "sending"
    ) {
      return;
    }
    // An open global comment draft is saved first, as if Save were
    // pressed; the flush below writes it with the rest of the review.
    if (reviewControllerRef.current?.saveOpenGlobalDrafts() === false) {
      return;
    }

    const handoffId = pendingHandoffIdRef.current ?? createClientId();
    pendingHandoffIdRef.current = handoffId;
    reviewHandoffPhaseRef.current = "sending";
    setReviewHandoffPhase("sending");
    setReviewHandoffErrorKind(null);
    // The status popover says "Sending your review" until the answer.
    setReviewHandoffPopoverOpen(true);
    try {
      // The controller flushes pending edits first and sends the version
      // the flush left as expectedVersion; it never saves a second time.
      const result = await sync.completeReview({ handoffId });
      pendingHandoffIdRef.current = null;
      completedHandoffIdRef.current = result.handoff?.handoffId ?? handoffId;
      completedHandoffVersionsRef.current = new Set(
        [sync.getView().base.version, result.handoff?.version].filter(
          (version): version is string => !!version,
        ),
      );
      setReviewHandoffResult(result);
      setReviewHandoffRecord(result.handoff ?? null);
      setReviewHandoffPhase("completed");
      setReviewHandoffPopoverOpen(true);
    } catch (error) {
      console.error("Failed to complete review:", error);
      setReviewHandoffErrorKind(
        error instanceof HandoffError ? error.kind : "failed",
      );
      setReviewHandoffPhase("error");
      setReviewHandoffPopoverOpen(true);
    }
  }, [activeDocumentPath, sync]);

  const handleReviewControllerChange = useCallback(
    (controller: DocumentReviewController | null) => {
      reviewControllerRef.current = controller;
    },
    [],
  );
  const handleGlobalCommentRequestHandled = useCallback(() => {
    setGlobalCommentRequest(null);
  }, []);

  const handleDocumentDirtyStateChange = useCallback((isDirty: boolean) => {
    if (
      shouldLatchDocumentChangedSinceOpen({
        isDirty,
        documentChangeTrackingReady: documentChangeTrackingReadyRef.current,
      })
    ) {
      setDocumentChangedSinceOpen(true);
      // An edit after Done starts a new round. A failed Done keeps its
      // handoff id, so the next attempt still cannot write twice.
      setReviewHandoffPhase((phase) =>
        phase === "completed" || phase === "error" ? "idle" : phase,
      );
    }
  }, []);

  const handleCopyHandoffMessage = useCallback(async (message: string) => {
    try {
      await writePlainTextToClipboard(message);
      setCopiedHandoffMessage(true);
      window.setTimeout(() => setCopiedHandoffMessage(false), 2000);
    } catch (error) {
      console.error("Failed to copy handoff message:", error);
    }
  }, []);

  const handleCopyFileMenuAction = useCallback(
    async (action: FileCopyAction) => {
      if (!documentPage) return;

      const copyTextByAction: Record<
        Exclude<FileCopyAction, "rich-text">,
        string
      > = {
        path: documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
        filename: documentFilenameLabel,
        markdown: sync?.draft ?? documentPage.content,
      };

      try {
        if (action === "rich-text") {
          await writeRichTextToClipboard(sync?.draft ?? documentPage.content);
        } else {
          await writePlainTextToClipboard(copyTextByAction[action]);
        }

        setCopiedFileAction(action);
        if (copiedFileActionTimeoutRef.current !== null) {
          window.clearTimeout(copiedFileActionTimeoutRef.current);
        }
        copiedFileActionTimeoutRef.current = window.setTimeout(() => {
          setCopiedFileAction(null);
          copiedFileActionTimeoutRef.current = null;
        }, 3000);
      } catch (error) {
        console.error("Failed to copy document data:", error);
      }
    },
    [
      activeDocumentPath,
      documentCopyPath,
      documentFilenameLabel,
      documentPage,
      sync,
    ],
  );

  const editorViewModeToggleLabel =
    documentEditorViewMode === "rich-text"
      ? "Switch to code view"
      : "Switch to rich text view";
  const fileCopyPreviewByAction: Record<FileCopyAction, string> = {
    path: formatFileCopyPreview(
      documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
    ),
    filename: formatFileCopyPreview(documentFilenameLabel),
    markdown: formatFileCopyPreview(documentPage?.content ?? ""),
    "rich-text": formatFileCopyPreview(
      documentPage ? markdownToPlainText(documentPage.content) : "",
    ),
  };
  const activeDocumentInteractionMode = documentInteractionModeOptions.find(
    (option) => option.value === documentInteractionMode,
  );
  const ActiveDocumentInteractionModeIcon =
    activeDocumentInteractionMode?.Icon ?? PencilLine;
  const conflictNotice =
    documentDiskChangeState === "changed" ||
    documentDiskChangeState === "conflict" ||
    documentDiskChangeState === "paused"
      ? conflictNoticeCopy[documentDiskChangeState]
      : null;
  const conflictTheirs =
    syncView?.state.kind === "changed" || syncView?.state.kind === "conflict"
      ? syncView.state.theirs
      : null;
  const offlineRetryAt =
    syncView?.state.kind === "offline" ? syncView.state.retryAt : null;
  const now = useNow(offlineRetryAt !== null);
  const syncNotice =
    syncView?.state.kind === "unavailable"
      ? {
          state: "unavailable" as const,
          title:
            syncView.state.reason === "missing"
              ? "File not found on disk"
              : "File unavailable",
          body:
            syncView.state.reason === "missing"
              ? `Roughdraft cannot find ${documentCopyPath ?? documentFilenameLabel}. Your edits stay in this tab and save when the file is back.`
              : `Roughdraft cannot read this file (${syncView.state.reason}). Your edits stay in this tab and save when it can read it again.`,
          retry: false,
        }
      : offlineRetryAt !== null
        ? {
            state: "offline" as const,
            title: "Roughdraft is not answering",
            body: `Your edits stay in this tab and save when it is back. Trying again in ${Math.max(
              0,
              Math.ceil((offlineRetryAt - now) / 1000),
            )} s.`,
            retry: true,
          }
        : null;
  const hasNotice = !!conflictNotice || !!syncNotice;
  const reviewHandoffView = getReviewHandoffView({
    enabled: !!activeDocumentPath && backend?.info.kind === "local-files",
    watcherCount: reviewWatcherCount,
    diskState: documentDiskChangeState,
    saveState,
    phase: reviewHandoffPhase,
    errorKind: reviewHandoffErrorKind,
    result: reviewHandoffResult,
    handoff: reviewHandoffRecord,
    sessionLabel: reviewSessionLabel,
    documentChangedSinceOpen,
    sentTitle: reviewCompleteTitle,
  });
  const showReviewHandoffButton = reviewHandoffView.kind !== "hidden";
  const round = syncView?.round ?? null;
  const roundBadge = useMemo(() => <AiRoundBadge round={round} />, [round]);
  const reviewHandoffIsReady =
    reviewHandoffView.kind === "ready-listening" ||
    reviewHandoffView.kind === "ready-no-agent";
  const ReviewHandoffButtonIcon =
    reviewHandoffView.icon === "spinner"
      ? Loader2
      : reviewHandoffView.icon === "alert"
        ? AlertTriangle
        : null;
  const reviewHandoffCopyMessage = buildReviewHandoffCopyMessage(
    activeDocumentPath ?? documentFilenameLabel,
  );
  const reviewHandoffTooltip =
    reviewHandoffView.blockedReason ?? reviewHandoffView.agentStatusText;
  // One Global comment button, next to Done, whenever a local document is
  // open outside Viewing mode.
  const showGlobalCommentButton =
    !!documentPage &&
    !!activeDocumentPath &&
    backend?.info.kind === "local-files" &&
    documentInteractionMode !== "viewing";
  const handleGlobalCommentClick = () => {
    if (documentEditorViewMode === "code") {
      onDocumentEditorViewModeChange("rich-text");
    }
    setGlobalCommentRequest((current) => (current ?? 0) + 1);
  };

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-8 pb-8 sm:px-12",
        hasNotice ? "pt-40 sm:pt-28" : "pt-10",
      )}
    >
      {documentPage ? (
        <div
          className="fixed top-3 left-3 z-[60]"
          data-testid="document-save-status-corner"
        >
          <DocumentSaveStatusIndicator
            saveState={saveState}
            diskChangeState={documentDiskChangeState}
          />
        </div>
      ) : null}
      <div
        className={cn(
          "fixed right-3 z-[60] flex max-w-[min(22rem,calc(100vw-1rem))] flex-col items-end gap-1.5",
          hasNotice ? "top-[19rem] sm:top-[11rem]" : "top-3",
        )}
        data-testid="document-status-stack"
        data-document-status-stack="true"
      >
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {showGlobalCommentButton ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="global-comment-add"
                    className="h-9 gap-1.5 rounded-[7px] border-[#DCD6CC] bg-[#FFFDFC] px-3 text-sm font-semibold text-stone-800 shadow-[0_10px_28px_rgba(0,0,0,0.12)] hover:bg-[#F3EFE8] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                    onClick={handleGlobalCommentClick}
                  >
                    <MessageSquareText className="size-4" aria-hidden="true" />
                    Global comment
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Comment on the whole document
              </TooltipContent>
            </Tooltip>
          ) : null}
          {showReviewHandoffButton ? (
            <Popover
              open={reviewHandoffPopoverOpen}
              onOpenChange={setReviewHandoffPopoverOpen}
            >
              <Tooltip disabled={!reviewHandoffTooltip}>
                <TooltipTrigger
                  render={
                    <div
                      data-testid="review-handoff-split-button"
                      data-watcher-state={reviewHandoffView.watcherState}
                      data-handoff-state={reviewHandoffView.kind}
                      className={cn(
                        "relative flex items-center overflow-hidden rounded-[7px] shadow-[0_10px_28px_rgba(0,0,0,0.18)] transition-opacity after:pointer-events-none after:absolute after:top-px after:right-8 after:bottom-px after:z-10 after:w-px after:bg-[#4a4038] after:content-[''] dark:after:bg-slate-600",
                        reviewHandoffView.dimmed && "opacity-50",
                      )}
                    />
                  }
                >
                  <Button
                    type="button"
                    data-testid="review-handoff-button"
                    size="lg"
                    className="h-9 rounded-r-none rounded-l-[7px] border-0 bg-[#2B2420] px-3 text-sm font-bold text-white hover:bg-[#3a322b] focus-visible:ring-slate-300 disabled:opacity-100 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 dark:focus-visible:ring-slate-600"
                    disabled={reviewHandoffView.buttonDisabled}
                    focusableWhenDisabled={reviewHandoffView.kind === "blocked"}
                    aria-disabled={
                      reviewHandoffView.buttonDisabled || undefined
                    }
                    aria-describedby={
                      reviewHandoffView.blockedReason
                        ? "review-handoff-blocked-reason"
                        : undefined
                    }
                    onClick={() => {
                      if (reviewHandoffView.buttonDisabled) return;
                      if (!reviewHandoffIsReady) {
                        setReviewHandoffPopoverOpen(true);
                        return;
                      }

                      void handleCompleteReview();
                    }}
                  >
                    {ReviewHandoffButtonIcon ? (
                      <ReviewHandoffButtonIcon
                        className={cn(
                          "size-4",
                          reviewHandoffView.icon === "spinner" &&
                            "animate-spin",
                        )}
                      />
                    ) : null}
                    {reviewHandoffView.buttonLabel}
                  </Button>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        data-testid="review-handoff-status-trigger"
                        size="icon-lg"
                        className="h-9 w-8 rounded-l-none rounded-r-[7px] border-0 bg-[#2B2420] text-white hover:bg-[#3a322b] focus-visible:ring-slate-300 disabled:opacity-100 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 dark:focus-visible:ring-slate-600"
                        disabled={reviewHandoffView.triggerDisabled}
                        aria-label="Review status"
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    }
                  />
                  {reviewHandoffView.blockedReason ? (
                    <span
                      id="review-handoff-blocked-reason"
                      data-testid="review-handoff-blocked-reason"
                      className="sr-only"
                    >
                      {reviewHandoffView.blockedReason}
                    </span>
                  ) : null}
                </TooltipTrigger>
                {reviewHandoffTooltip ? (
                  <TooltipContent
                    side="bottom"
                    data-testid="review-handoff-tooltip"
                  >
                    {reviewHandoffTooltip}
                  </TooltipContent>
                ) : null}
              </Tooltip>
              <PopoverContent
                className={reviewHandoffIsReady ? undefined : "pt-0"}
                aria-label="Review handoff status"
                data-testid="review-handoff-status"
              >
                {reviewHandoffIsReady ? (
                  <div className="space-y-1 text-xs leading-5 text-stone-500 dark:text-slate-400">
                    <p
                      data-testid="review-handoff-agent-status"
                      className="text-sm leading-5 text-stone-800 dark:text-slate-200"
                    >
                      {reviewHandoffView.agentStatusText}
                    </p>
                    {reviewHandoffView.sessionText ? (
                      <p data-testid="review-handoff-session-label">
                        {reviewHandoffView.sessionText}
                      </p>
                    ) : null}
                  </div>
                ) : reviewHandoffView.kind === "sent" ? (
                  <div>
                    <div className="mb-3 flex h-[170px] items-center justify-center overflow-hidden">
                      <RobotsHighFiveToy
                        onHighFive={() =>
                          setReviewCompleteTitle((currentTitle) =>
                            getRandomReviewCompleteTitleExcept(currentTitle),
                          )
                        }
                      />
                    </div>
                    <div className="text-xl font-semibold leading-6 text-stone-950 dark:text-slate-50">
                      {reviewHandoffView.title}
                    </div>
                    <div className="mt-1">
                      <p className="text-sm leading-[1.32rem] text-stone-500 dark:text-slate-400">
                        Your agent is now working in the background on this, in
                        all likelihood. If our signal didn't make it, just{" "}
                        <button
                          type="button"
                          data-testid="review-handoff-copy-message"
                          className="font-normal text-inherit underline decoration-stone-300 underline-offset-4 hover:decoration-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950/25 dark:decoration-slate-600 dark:hover:decoration-slate-200 dark:focus-visible:ring-slate-50/30"
                          onClick={() =>
                            void writePlainTextToClipboard(
                              reviewHandoffCopyMessage,
                            )
                          }
                        >
                          click here
                        </button>{" "}
                        to copy a line you can send it to keep going.
                      </p>
                      <Button
                        type="button"
                        data-testid="review-handoff-close-window"
                        size="lg"
                        variant="outline"
                        className="mt-4 w-full rounded-[7px] text-sm font-semibold"
                        onClick={() => window.close()}
                      >
                        Close window
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="pt-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                        {reviewHandoffView.icon === "spinner" ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : reviewHandoffView.icon === "alert" ? (
                          <AlertTriangle className="size-4" />
                        ) : (
                          <Check className="size-4" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-base font-semibold leading-6 text-stone-950 dark:text-slate-50">
                          {reviewHandoffView.title}
                        </div>
                        {reviewHandoffView.body ? (
                          <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-slate-300">
                            {reviewHandoffView.body}
                          </p>
                        ) : null}
                        {reviewHandoffView.wakeLine ? (
                          <p
                            data-testid="review-handoff-wake-status"
                            className="mt-1 text-xs leading-5 text-stone-500 dark:text-slate-400"
                          >
                            {reviewHandoffView.wakeLine}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {reviewHandoffView.showCopyMessage ||
                    reviewHandoffView.showRetry ? (
                      <div className="mt-4 flex flex-col gap-2">
                        {reviewHandoffView.showCopyMessage ? (
                          <div
                            data-testid="review-handoff-message-preview"
                            className="rounded-[7px] border border-stone-200 px-2.5 py-2 text-xs leading-5 break-words text-stone-700 dark:border-slate-700 dark:text-slate-300"
                          >
                            {reviewHandoffCopyMessage}
                          </div>
                        ) : null}
                        {reviewHandoffView.showRetry ? (
                          <Button
                            type="button"
                            data-testid="review-handoff-retry"
                            size="lg"
                            className="w-full rounded-[7px] bg-black text-sm font-bold text-white hover:bg-black/85 focus-visible:ring-black/25 dark:bg-white dark:text-black dark:hover:bg-white/90"
                            disabled={reviewHandoffView.retryDisabled}
                            onClick={() => void handleCompleteReview()}
                          >
                            <RefreshCcw className="size-4" />
                            Retry
                          </Button>
                        ) : null}
                        {reviewHandoffView.showCopyMessage ? (
                          <Button
                            type="button"
                            data-testid="review-handoff-copy-message"
                            size="lg"
                            variant={
                              reviewHandoffView.showRetry
                                ? "outline"
                                : "default"
                            }
                            className={cn(
                              "w-full rounded-[7px] text-sm font-semibold",
                              !reviewHandoffView.showRetry &&
                                "bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/90",
                            )}
                            onClick={() =>
                              void handleCopyHandoffMessage(
                                reviewHandoffCopyMessage,
                              )
                            }
                          >
                            <Copy className="size-4" />
                            {copiedHandoffMessage ? "Copied" : "Copy message"}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {conflictNotice ? (
        <div
          data-testid="file-conflict-notice"
          role="status"
          aria-label="File conflict"
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:flex-row sm:items-center sm:justify-between sm:px-4"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-5">
                {conflictNotice.title}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                {conflictNotice.body}
                {documentDiskChangeState === "paused" &&
                syncView &&
                syncView.theirsUpdates > 0 ? (
                  <span data-testid="file-conflict-later-change">
                    {" "}
                    The file changed on disk again while autosave was paused.
                  </span>
                ) : null}
              </div>
              {conflictTheirs ? (
                <div
                  data-testid="file-conflict-disk-version"
                  className="mt-0.5 text-[0.68rem] leading-4 text-amber-800/80 dark:text-amber-300/80"
                >
                  {formatDiskVersion(conflictTheirs)}. Overwrite replaces this
                  version.
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
            <Button
              type="button"
              data-testid="file-conflict-action-reload"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
              onClick={() => void sync?.reloadFromDisk()}
            >
              <RefreshCcw className="size-3.5" />
              Reload from disk
            </Button>
            {documentDiskChangeState !== "paused" ? (
              <Button
                type="button"
                data-testid="file-conflict-action-keep-editing"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                onClick={() => sync?.keepEditing()}
              >
                <PencilLine className="size-3.5" />
                Keep editing with autosave paused
              </Button>
            ) : null}
            <Button
              type="button"
              data-testid="file-conflict-action-overwrite"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-amber-900 dark:bg-amber-600 px-2 text-xs text-white hover:bg-amber-800 dark:hover:bg-amber-500"
              onClick={() => void sync?.overwrite()}
            >
              <Upload className="size-3.5" />
              Overwrite disk file
            </Button>
          </div>
        </div>
      ) : null}
      {!conflictNotice && syncNotice ? (
        <div
          data-testid="sync-status-notice"
          data-sync-state={syncNotice.state}
          role="status"
          aria-label={syncNotice.title}
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-stone-300 bg-stone-50 px-3 py-3 text-stone-900 shadow-[0_14px_40px_rgba(41,37,36,0.14)] sm:flex-row sm:items-center sm:justify-between sm:px-4 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)]"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-stone-500 dark:text-slate-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-5">
                {syncNotice.title}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-stone-600 dark:text-slate-300">
                {syncNotice.body}
              </div>
            </div>
          </div>
          {syncNotice.retry ? (
            <div className="flex shrink-0 items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                data-testid="sync-status-retry"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/70 px-2 text-xs hover:bg-white dark:bg-white/10 dark:hover:bg-white/20"
                onClick={() => sync?.retrySave()}
              >
                <RefreshCcw className="size-3.5" />
                Retry now
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mx-auto min-h-full max-w-[1080px]">
        {documentPage ? (
          <div
            ref={documentHeaderRef}
            data-testid="document-page-header"
            className={cn(
              "review-layout-grid document-page-shell mb-2 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400",
              !documentHasComments &&
                "review-layout-grid--centered document-page-shell-no-comments",
            )}
          >
            <div className="review-layout-main document-page-main w-full max-w-[46.5rem] min-w-0">
              <div className="flex w-full flex-wrap items-center gap-1.5 px-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-testid="document-editor-view-toggle"
                        className="grid shrink-0 grid-cols-2 rounded-[999px] bg-[#E8E3DB] dark:bg-slate-800 px-[2px] pt-[3px] pb-[2px] shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] dark:border-b dark:border-b-slate-800 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      >
                        <span
                          className={`flex w-[1.375rem] items-center justify-center rounded-full py-[2px] transition ${
                            documentEditorViewMode === "rich-text"
                              ? "bg-[#FFFDFC] dark:bg-slate-600 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <Eye className="size-[0.75rem]" />
                        </span>
                        <span
                          className={`flex w-[1.375rem] items-center justify-center rounded-full py-[2px] transition ${
                            documentEditorViewMode === "code"
                              ? "bg-[#FFFDFC] dark:bg-slate-600 text-stone-700 dark:text-white shadow-[0_1px_2px_rgba(41,37,36,0.12)]"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <CodeXml className="size-[0.75rem]" />
                        </span>
                      </button>
                    }
                    aria-label={editorViewModeToggleLabel}
                    onClick={() =>
                      onDocumentEditorViewModeChange(
                        documentEditorViewMode === "rich-text"
                          ? "code"
                          : "rich-text",
                      )
                    }
                  />
                  <TooltipContent>{editorViewModeToggleLabel}</TooltipContent>
                </Tooltip>
                <Popover
                  open={fileCopyMenuOpen}
                  onOpenChange={setFileCopyMenuOpen}
                >
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        data-testid="document-file-menu-trigger"
                        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1 py-0.5 text-[0.8rem] font-medium tracking-[0.01em] text-stone-400 outline-none transition hover:text-stone-500 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-slate-400 dark:hover:text-slate-300 dark:focus-visible:ring-slate-600/70"
                        title={documentFilenameLabel}
                        aria-label="Document file actions"
                      >
                        <span className="min-w-0 truncate">
                          {documentFilenameLabel}
                        </span>
                        <ChevronDown
                          className="size-[0.62rem] shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    }
                  />
                  <PopoverContent
                    aria-label="Document file actions"
                    data-testid="document-file-menu"
                    className="w-56 p-1"
                    align="start"
                    sideOffset={4}
                  >
                    <div className="flex flex-col">
                      {fileCopyMenuOptions.map(({ action, label }) => (
                        <button
                          key={action}
                          type="button"
                          data-testid={`document-file-menu-${action}`}
                          className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-[0.72rem] leading-none text-stone-700 outline-none transition hover:bg-[#EEE9E1] focus-visible:bg-[#EEE9E1] dark:text-stone-300 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700"
                          onClick={() => void handleCopyFileMenuAction(action)}
                        >
                          <Copy
                            className="mt-[0.06rem] size-4 shrink-0 text-stone-500 dark:text-slate-400"
                            aria-hidden="true"
                          />
                          <span className="grid min-w-0 flex-1 gap-1">
                            <span className="truncate font-medium">
                              {copiedFileAction === action ? "Copied!" : label}
                            </span>
                            <span className="truncate text-[0.66rem] leading-none text-stone-400 dark:text-slate-500">
                              {fileCopyPreviewByAction[action]}
                            </span>
                          </span>
                          {copiedFileAction === action ? (
                            <Check className="mt-[0.06rem] ml-auto size-3 shrink-0 text-stone-500 dark:text-stone-400" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                {roundBadge}
                <div className="ml-auto inline-flex h-[1.25rem] shrink-0 items-center">
                  <Select<DocumentInteractionMode>
                    value={documentInteractionMode}
                    onValueChange={(value) => {
                      if (value) setDocumentInteractionMode(value);
                    }}
                  >
                    <SelectTrigger
                      data-testid="document-mode-trigger"
                      aria-label="Document mode"
                      className="h-[1.5rem] gap-1.5 px-1 text-[0.8rem] leading-[1.25rem] font-medium tracking-[0.01em] text-stone-400 dark:text-slate-400 hover:text-stone-500 dark:hover:text-slate-300"
                    >
                      <ActiveDocumentInteractionModeIcon className="size-[0.8rem]" />
                      <span className="truncate">
                        {activeDocumentInteractionMode?.label}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {documentInteractionModeOptions.map(
                        ({ value, label, Icon }) => (
                          <SelectItem
                            key={value}
                            data-testid={`document-mode-option-${value}`}
                            value={value}
                            label={label}
                            className="text-[0.8rem]"
                          >
                            <Icon className="size-3 text-stone-500 dark:text-slate-400" />
                            <SelectItemText className="font-medium">
                              {label}
                            </SelectItemText>
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {documentPage ? (
          backend ? (
            <PageCard
              key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
              page={documentPage}
              activeDocumentPath={activeDocumentPath}
              selected
              onSave={noopSave}
              editorViewMode={documentEditorViewMode}
              interactionMode={documentInteractionMode}
              backend={backend}
              onCommentRailPresenceChange={setDocumentHasComments}
              onDirtyStateChange={handleDocumentDirtyStateChange}
              sync={sync}
              globalCommentRequest={globalCommentRequest}
              onGlobalCommentRequestHandled={handleGlobalCommentRequestHandled}
              onReviewControllerChange={handleReviewControllerChange}
            />
          ) : null
        ) : (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Open a markdown file to begin.
          </div>
        )}
      </div>
    </div>
  );
}
