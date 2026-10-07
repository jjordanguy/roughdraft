import { ChevronRight, ExternalLink, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { cn } from "./lib/utils";
import {
  closeDocument,
  closeFinishedDocuments,
  type DocumentGroup,
  describeCounts,
  describeStatus,
  documentLink,
  documentPlace,
  documentTitle,
  dropHandoff,
  fetchOpenDocuments,
  fetchPeerUrl,
  formatClock,
  groupOpenDocuments,
  harnessName,
  isDoneWaiting,
  type OpenDocument,
  openDocumentWindow,
  peerLabel,
  type StatusPart,
} from "./open-documents";

export const OPEN_DOCUMENTS_POLL_MS = 5_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; documents: OpenDocument[]; updatedAt: number }
  | { kind: "error"; message: string; documents: OpenDocument[] | null };

function openInNewWindow(url: string) {
  window.open(url, "_blank");
}

const toneDot: Record<StatusPart["tone"], string> = {
  good: "bg-emerald-600 dark:bg-emerald-400",
  warn: "bg-amber-600 dark:bg-amber-400",
  muted: "bg-stone-400 dark:bg-stone-500",
};

function StatusLine({ document }: { document: OpenDocument }) {
  return (
    <p
      data-testid="open-document-status"
      className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-5 text-stone-500 dark:text-stone-400"
    >
      {describeStatus(document).map((part) => (
        <span key={part.text} className="inline-flex items-center gap-1.5">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", toneDot[part.tone])}
            aria-hidden="true"
          />
          {part.text}
        </span>
      ))}
    </p>
  );
}

function SessionTitle({ group }: { group: DocumentGroup }) {
  if (!group.session) {
    return (
      <span className="truncate font-semibold text-stone-800 dark:text-stone-200">
        No session
      </span>
    );
  }
  const { label, link } = group.session;
  return link ? (
    <a
      href={link}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 font-semibold text-stone-800 underline-offset-4 hover:underline dark:text-stone-200"
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-60" aria-hidden="true" />
    </a>
  ) : (
    <span className="truncate font-semibold text-stone-800 dark:text-stone-200">
      {label}
    </span>
  );
}

interface RowActions {
  busy: boolean;
  onOpen: (document: OpenDocument) => void;
  onClose: (document: OpenDocument) => void;
  onDrop: (document: OpenDocument) => void;
}

function DocumentRow({
  document,
  actions,
}: {
  document: OpenDocument;
  actions: RowActions;
}) {
  const title = documentTitle(document);
  const place = documentPlace(document.documentPath);
  const dirty = document.tabsDirty > 0;
  return (
    <li
      data-testid="open-document-row"
      data-document-path={document.documentPath}
      aria-label={`${title}, ${place}`}
      className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-stone-200 px-3 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center dark:border-stone-800"
    >
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.84rem] leading-5">
          <span
            data-testid="open-document-title"
            className="min-w-0 truncate font-semibold text-stone-900 dark:text-stone-100"
          >
            {title}
          </span>
          <span className="min-w-0 truncate text-xs text-stone-500 dark:text-stone-400">
            {place}
          </span>
        </p>
        <StatusLine document={document} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="open-document-open"
          aria-label={`Open ${title}`}
          onClick={() => actions.onOpen(document)}
        >
          Open
        </Button>
        {isDoneWaiting(document) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="open-document-drop"
            aria-label={`Drop the waiting Done on ${title}`}
            disabled={actions.busy}
            onClick={() => actions.onDrop(document)}
          >
            Drop
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="open-document-close"
          aria-label={`Close ${title}`}
          title={dirty ? "A window has unsaved text" : undefined}
          disabled={dirty || actions.busy}
          onClick={() => actions.onClose(document)}
        >
          Close
        </Button>
      </div>
    </li>
  );
}

function EarlierRow({
  document,
  actions,
}: {
  document: OpenDocument;
  actions: RowActions;
}) {
  const title = documentTitle(document);
  const place = documentPlace(document.documentPath);
  const session = document.lastSession;
  return (
    <li
      data-testid="open-documents-earlier-row"
      data-document-path={document.documentPath}
      aria-label={`${title}, ${place}, closed`}
      className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-stone-200 px-3 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center dark:border-stone-800"
    >
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.84rem] leading-5">
          <span className="min-w-0 truncate font-semibold text-stone-700 dark:text-stone-300">
            {title}
          </span>
          <span className="min-w-0 truncate text-xs text-stone-500 dark:text-stone-400">
            {place}
          </span>
        </p>
        <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
          Closed at {formatClock(document.closedAt)}
          {session
            ? ` · ${harnessName(session.harness)} · ${session.label}`
            : null}
        </p>
        <StatusLine document={document} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          data-testid="open-documents-reopen"
          aria-label={`Reopen ${title}`}
          render={
            <a
              href={documentLink(document.documentPath, window.location.origin)}
              target="_blank"
              rel="noreferrer"
            >
              Reopen
            </a>
          }
        />
        {isDoneWaiting(document) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="open-document-drop"
            aria-label={`Drop the waiting Done on ${title}`}
            disabled={actions.busy}
            onClick={() => actions.onDrop(document)}
          >
            Drop
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function SessionGroup({
  group,
  actions,
  onCloseSession,
}: {
  group: DocumentGroup;
  actions: RowActions;
  onCloseSession: (group: DocumentGroup) => void;
}) {
  const sessionName = group.session ? group.session.label : "No session";
  return (
    <section
      data-testid="open-documents-group"
      data-session-label={group.session?.label ?? ""}
      aria-label={
        group.session
          ? `${harnessName(group.session.harness)} session: ${sessionName}`
          : "No session"
      }
      className="overflow-hidden rounded-[9px] border border-stone-200 bg-white dark:border-stone-800 dark:bg-card"
    >
      <header className="flex items-center justify-between gap-3 bg-[#F3F1EE] px-3 py-2 text-xs dark:bg-stone-900">
        <div className="flex min-w-0 items-center gap-2">
          {group.session ? (
            <Badge
              variant="outline"
              data-testid="open-documents-harness"
              className="rounded-[4px] bg-white text-[0.6rem] tracking-[0.05em] text-stone-500 uppercase dark:bg-stone-950 dark:text-stone-400"
            >
              {harnessName(group.session.harness)}
            </Badge>
          ) : null}
          <SessionTitle group={group} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="open-documents-close-session"
          aria-label={`Close every document in ${sessionName}`}
          disabled={actions.busy}
          className="text-stone-500 dark:text-stone-400"
          onClick={() => onCloseSession(group)}
        >
          {group.session ? "Close session" : "Close all"}
        </Button>
      </header>
      <ul>
        {group.documents.map((document) => (
          <DocumentRow
            key={document.key}
            document={document}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );
}

export function OpenDocumentsPage() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [peerUrl, setPeerUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const documents = await fetchOpenDocuments();
      setLoad({ kind: "ready", documents, updatedAt: Date.now() });
    } catch (error) {
      setLoad((current) => ({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : String(error),
        documents: current.kind === "ready" ? current.documents : null,
      }));
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    document.title = "Open documents";
    void fetchPeerUrl().then(setPeerUrl);
  }, []);

  // Poll every 5 s while the page is visible, and right away when it shows.
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      void refresh();
      timer = window.setInterval(() => void refresh(), OPEN_DOCUMENTS_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    else void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const documents =
    load.kind === "ready"
      ? load.documents
      : load.kind === "error"
        ? load.documents
        : null;
  const list = useMemo(
    () => (documents ? groupOpenDocuments(documents) : null),
    [documents],
  );

  const runAction = useCallback(
    async (action: () => Promise<string | null>) => {
      setBusy(true);
      try {
        setMessage(await action());
      } catch {
        setMessage("The Roughdraft server did not answer.");
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const actions: RowActions = useMemo(
    () => ({
      busy,
      onOpen: (target) => {
        void openDocumentWindow(
          target,
          window.location.origin,
          openInNewWindow,
        ).then(() => {
          // A new window connects within a second or two; show it then
          // instead of at the next poll.
          window.setTimeout(() => void refresh(), 1_500);
        });
      },
      onClose: (target) =>
        void runAction(async () => {
          const outcome = await closeDocument(target);
          if (outcome === "dirty") {
            return `${documentTitle(target)} has unsaved text in a window, so it stays open.`;
          }
          return outcome === "closed"
            ? `Closed ${documentTitle(target)}.`
            : `Could not close ${documentTitle(target)}.`;
        }),
      onDrop: (target) =>
        void runAction(async () => {
          const handoffId = target.latestHandoff?.handoffId;
          if (!handoffId) return null;
          return (await dropHandoff(handoffId))
            ? `Dropped the waiting Done on ${documentTitle(target)}.`
            : `Could not drop the Done on ${documentTitle(target)}.`;
        }),
    }),
    [busy, refresh, runAction],
  );

  const closeSession = useCallback(
    (group: DocumentGroup) =>
      void runAction(async () => {
        let closed = 0;
        let kept = 0;
        for (const target of group.documents) {
          if ((await closeDocument(target)) === "closed") closed += 1;
          else kept += 1;
        }
        return kept > 0
          ? `Closed ${closed}; ${kept} kept open (unsaved text in a window).`
          : `Closed ${closed} ${closed === 1 ? "document" : "documents"}.`;
      }),
    [runAction],
  );

  const closeFinished = useCallback(
    () =>
      void runAction(async () => {
        const result = await closeFinishedDocuments();
        if (result.closed === 0 && result.skipped === 0) {
          return "Nothing finished to close.";
        }
        return result.skipped > 0
          ? `Closed ${result.closed}; ${result.skipped} kept open (unsaved text in a window).`
          : `Closed ${result.closed} finished ${result.closed === 1 ? "document" : "documents"}.`;
      }),
    [runAction],
  );

  return (
    <main
      data-testid="open-documents-page"
      className="min-h-screen bg-[#FCFCFC] text-stone-900 dark:bg-background dark:text-stone-100"
    >
      <div className="mx-auto w-full max-w-3xl px-4 pt-5 pb-12 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant="secondary"
              className="bg-[#E8E3DB] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
            >
              Roughdraft
            </Badge>
            <h1 className="text-[0.95rem] font-semibold tracking-[-0.01em]">
              Open documents
            </h1>
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            data-testid="open-documents-close-finished"
            disabled={busy || !list}
            onClick={closeFinished}
          >
            Close all finished
          </Button>
        </div>

        {peerUrl ? (
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
            <a
              data-testid="open-documents-peer-link"
              href={peerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-stone-700 underline-offset-4 hover:underline dark:text-stone-300"
            >
              Open documents on {peerLabel(peerUrl)}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2
            data-testid="open-documents-count"
            className="text-sm font-semibold"
          >
            {list ? describeCounts(list) : "Loading"}
          </h2>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {load.kind === "ready"
              ? `Updated ${formatClock(new Date(load.updatedAt).toISOString())}`
              : null}
          </p>
        </div>

        <p
          data-testid="open-documents-message"
          aria-live="polite"
          className={cn(
            "text-xs text-stone-600 dark:text-stone-300",
            message ? "mt-2" : "sr-only",
          )}
        >
          {message}
        </p>

        {load.kind === "error" ? (
          <div
            data-testid="open-documents-error"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span>
              Could not reach the Roughdraft server ({load.message}). Trying
              again every few seconds.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
            >
              <RefreshCcw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : null}

        <div className="mt-3 grid gap-2.5">
          {list?.groups.map((group) => (
            <SessionGroup
              key={
                group.session
                  ? `${group.session.harness}:${group.session.sessionId ?? group.session.label}`
                  : "no-session"
              }
              group={group}
              actions={actions}
              onCloseSession={closeSession}
            />
          ))}
          {list && list.groups.length === 0 ? (
            <p
              data-testid="open-documents-empty"
              className="rounded-[9px] border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400"
            >
              No open documents. Files you open with{" "}
              <code className="font-mono text-[0.8rem]">roughdraft open</code>{" "}
              show up here.
            </p>
          ) : null}
        </div>

        {list && list.earlier.length > 0 ? (
          <Collapsible className="mt-4">
            <CollapsibleTrigger
              data-testid="open-documents-earlier-trigger"
              className="group flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-stone-500 outline-none hover:text-stone-700 focus-visible:ring-2 focus-visible:ring-stone-300 dark:text-stone-400 dark:hover:text-stone-200"
            >
              <ChevronRight
                className="size-3.5 transition-transform group-data-[panel-open]:rotate-90"
                aria-hidden="true"
              />
              Earlier today: {list.earlier.length}{" "}
              {list.earlier.length === 1 ? "document" : "documents"} closed
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul
                data-testid="open-documents-earlier"
                aria-label="Closed earlier today"
                className="mt-2 overflow-hidden rounded-[9px] border border-stone-200 bg-white dark:border-stone-800 dark:bg-card"
              >
                {list.earlier.map((document) => (
                  <EarlierRow
                    key={document.key}
                    document={document}
                    actions={actions}
                  />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </main>
  );
}
