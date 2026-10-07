import { documentTitleFromMarkdown } from "@roughdraft/rfm";
import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  ExternalLink,
  FileText,
  MessageSquare,
  PencilLine,
  RefreshCcw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  buildLocationForDocumentEditorViewMode,
  type DocumentEditorViewMode,
  getDocumentEditorViewModeFromLocation,
  getPathLeaf,
  getRequestedPathState,
  joinPath,
  PREVIEW_PATH,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  syncRequestedPathInUrl,
} from "./app-navigation";
import { Button } from "./components/ui/button";
import { DocumentWorkspace, getSyncStatus } from "./DocumentWorkspace";
import { detectBackend } from "./detect-backend";
import { DocumentSync } from "./document-sync";
import { createIndexedDbDraftStore, type DraftStore } from "./draft-store";
import { OpenDocumentsPage } from "./OpenDocumentsPage";
import { documentWindowTitle } from "./open-documents";
import {
  acknowledgeOpenRequest,
  buildOpenRequestsUrl,
  getOrCreateTabId,
  handleOpenRequestEvent,
  readSessionStorage,
} from "./open-requests";
import type { DocumentSaveState } from "./PageCard";
import { PreviewBackend } from "./preview-backend";
import type { DiskChangeState } from "./review-handoff";
import {
  MarkdownFileNotFoundError,
  type Page,
  type StorageBackend,
  UnsupportedRouteError,
} from "./storage";
import { UpdateNotice } from "./UpdateNotice";
import { fetchUpdateStatus, type UpdateStatus } from "./update-status";

export function shouldWarnBeforeUnload({
  activeDocumentPath,
  isDirty,
  saveState,
  diskChangeState,
}: {
  activeDocumentPath: string | null;
  isDirty: boolean;
  saveState: DocumentSaveState;
  diskChangeState: DiskChangeState;
}) {
  return (
    !!activeDocumentPath &&
    (isDirty ||
      saveState !== "saved" ||
      (diskChangeState !== "clean" && diskChangeState !== "unavailable"))
  );
}

// One IndexedDB draft store per page; null where the browser has none.
let draftStore: DraftStore | null | undefined;
function getDraftStore(): DraftStore | null {
  if (draftStore === undefined) {
    try {
      draftStore = createIndexedDbDraftStore();
    } catch {
      draftStore = null;
    }
  }
  return draftStore;
}

const PREVIEW_DOCUMENT_PATH = "preview.md";
const PREVIEW_INITIAL_MARKDOWN = [
  "# Live Preview",
  "",
  "This draft only lives in memory. Edit it freely, switch between rich text and code view, and reload the page when you want a clean copy.",
  "",
  "- Comments and suggested changes use Roughdraft flavored Markdown.",
  "- Autosave updates the in-memory document, not disk or browser storage.",
  "",
  "{==Select this sentence==}{>>Try replying to this comment or suggesting a replacement.<<}{#preview-comment}",
  "",
  "---",
  "comments:",
  "  preview-comment:",
  "    by: Roughdraft",
  '    at: "2026-04-28T12:00:00.000Z"',
  "",
].join("\n");
const ROUGHDRAFT_MARKDOWN_SYNTAX = [
  {
    label: "Comment",
    syntax: "{==selected text==}{>>Comment text<<}{#c1}",
    description:
      "Highlights the reviewed text and attaches a margin comment to it.",
  },
  {
    label: "Reply",
    syntax:
      'comments:\n  c2:\n    body: I can make that edit.\n    by: AI\n    at: "2026-04-28T12:01:00.000Z"\n    re: c1',
    description:
      "Adds a threaded reply in YAML endmatter by pointing `re` at the parent id.",
  },
  {
    label: "Insertion",
    syntax: "{++new text++}{#s1}",
    description: "Suggests text to add without applying it silently.",
  },
  {
    label: "Deletion",
    syntax: "{--old text--}{#s2}",
    description: "Suggests removing text while keeping the original visible.",
  },
  {
    label: "Substitution",
    syntax: "{~~old text~>new text~~}{#s3}",
    description: "Suggests replacing one span with another.",
  },
] as const;
const ROUGHDRAFT_MARKDOWN_REFERENCES = [
  {
    title: "Official RFM spec",
    href: "/spec/roughdraft-flavored-markdown.md",
    description:
      "The normative syntax, metadata, round-trip, and JSON review-index contract for Roughdraft Flavored Markdown.",
  },
  {
    title: "CriticMarkup",
    href: "https://criticmarkup.com/",
    description:
      "The plain-text review syntax Roughdraft builds on for comments, highlights, insertions, deletions, and substitutions.",
  },
  {
    title: "Notion-flavored Markdown",
    href: "https://developers.notion.com/guides/data-apis/enhanced-markdown",
    description:
      "The product precedent for rich document affordances that still serialize to inspectable Markdown-like text.",
  },
] as const;
const ROUGHDRAFT_MARKDOWN_CONTRACT = [
  {
    title: "Metadata",
    description:
      "Compact inline references keep review anchors portable, while YAML endmatter stores authors, timestamps, statuses, and reply links.",
  },
  {
    title: "Anchors",
    description:
      "Comments attach to highlighted text when a highlight precedes the comment. A bare comment is allowed when the feedback applies to the surrounding paragraph or document.",
  },
  {
    title: "Pending changes",
    description:
      "Insertions, deletions, and substitutions stay visible until accepted or rejected. Roughdraft should not silently collapse suggested edits into normal prose.",
  },
  {
    title: "Round trips",
    description:
      "Normal Markdown should remain normal Markdown. Frontmatter, tables, task lists, links, image paths, code spans, and fenced code blocks should survive review edits with minimal serialization churn.",
  },
] as const;
const ROUGHDRAFT_MARKDOWN_EXTENSION_DETAILS = [
  {
    title: "YAML metadata",
    body: "Roughdraft stores ids inline as compact references such as {>>Looks right.<<}{#c1}, while authors, timestamps, and reply links live in final YAML endmatter.",
  },
  {
    title: "Threaded comments",
    body: "A comment can stand alone, attach to a highlighted span, or reply to another comment by setting `re` to the parent comment id.",
  },
  {
    title: "Reviewable suggestions",
    body: "Insertions, deletions, and substitutions can carry their own ids, then comments can reply to those ids to discuss a proposed edit before accepting it.",
  },
  {
    title: "Literal examples stay literal",
    body: "CriticMarkup inside inline code and fenced code blocks is preserved as example text instead of becoming live review feedback.",
  },
] as const;
export function RoughdraftFlavoredMarkdownPage() {
  useEffect(() => {
    document.title = "Roughdraft Flavored Markdown";
  }, []);

  return (
    <main className="min-h-screen bg-[#FCFCFC] dark:bg-background px-6 py-8 text-slate-950 dark:text-slate-50">
      <div className="mx-auto max-w-5xl">
        <Button
          className="h-9 gap-2 px-3 text-sm"
          nativeButton={false}
          variant="ghost"
          render={
            <a href="/">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to Roughdraft
            </a>
          }
        />

        <section className="mt-12 max-w-3xl">
          <p className="text-xs font-medium tracking-[0.16em] text-stone-500 dark:text-stone-400 uppercase">
            Roughdraft flavored Markdown
          </p>
          <h1 className="mt-3 text-4xl leading-tight font-semibold text-balance text-slate-950 dark:text-slate-50 sm:text-5xl">
            Markdown with review comments and suggested changes
          </h1>
          <p className="mt-5 text-lg leading-8 text-stone-600 dark:text-stone-400">
            Roughdraft Flavored Markdown is regular Markdown plus portable
            review markup. It builds on{" "}
            <a
              className="font-medium text-slate-950 dark:text-slate-50 underline decoration-slate-300 dark:decoration-slate-600 underline-offset-4 hover:decoration-slate-950 dark:hover:decoration-slate-50"
              href="https://criticmarkup.com/"
              target="_blank"
              rel="noreferrer"
            >
              CriticMarkup
            </a>{" "}
            syntax and the text-first model behind{" "}
            <a
              className="font-medium text-slate-950 dark:text-slate-50 underline decoration-slate-300 dark:decoration-slate-600 underline-offset-4 hover:decoration-slate-950 dark:hover:decoration-slate-50"
              href="https://developers.notion.com/guides/data-apis/enhanced-markdown"
              target="_blank"
              rel="noreferrer"
            >
              Notion-flavored Markdown
            </a>
            {", "}
            so a person and a coding agent can review the same file without a
            sidecar database or hosted document format.
          </p>
        </section>

        <section className="mt-10 grid gap-3 md:grid-cols-2">
          {ROUGHDRAFT_MARKDOWN_REFERENCES.map(
            ({ description, href, title }) => (
              <a
                className="group rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.3)] transition hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-[0_14px_34px_rgba(15,23,42,0.08)] dark:hover:shadow-[0_14px_34px_rgba(0,0,0,0.4)]"
                href={href}
                key={title}
                target="_blank"
                rel="noreferrer"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">
                    {title}
                  </h2>
                  <ExternalLink
                    className="size-4 text-stone-400 dark:text-stone-500 transition group-hover:text-stone-700 dark:group-hover:text-stone-300"
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                  {description}
                </p>
              </a>
            ),
          )}
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            {
              title: "Plain text first",
              description:
                "The saved file remains readable in editors, terminals, git diffs, and agent context windows.",
              icon: FileText,
            },
            {
              title: "Threaded review",
              description:
                "Comments carry document-local ids, authors, timestamps, and reply links for back-and-forth discussion.",
              icon: MessageSquare,
            },
            {
              title: "Explicit edits",
              description:
                "Suggestions are represented as insertions, deletions, and substitutions until someone accepts them.",
              icon: PencilLine,
            },
          ].map(({ description, icon: Icon, title }) => (
            <div
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.3)]"
              key={title}
            >
              <div className="flex size-10 items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-stone-700 dark:text-stone-300">
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-slate-950 dark:text-slate-50">
                {title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                {description}
              </p>
            </div>
          ))}
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-stone-500 dark:text-stone-400 uppercase">
              Format contract
            </p>
            <h2 className="mt-3 text-3xl leading-tight font-semibold text-slate-950 dark:text-slate-50">
              Review data lives where agents can inspect it
            </h2>
            <p className="mt-4 text-base leading-7 text-stone-600 dark:text-stone-400">
              Roughdraft treats the Markdown file as the durable source of
              truth. The rich editor can add affordances around the text, but
              the saved representation needs to be readable in a terminal,
              reviewable in git, and understandable to another agent without
              loading Roughdraft.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {ROUGHDRAFT_MARKDOWN_CONTRACT.map(({ description, title }) => (
              <div
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
                key={title}
              >
                <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-50">
                  {title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-stone-500 dark:text-stone-400 uppercase">
              Syntax
            </p>
            <h2 className="mt-3 text-3xl leading-tight font-semibold text-slate-950 dark:text-slate-50">
              The review layer is small on purpose
            </h2>
            <p className="mt-4 text-base leading-7 text-stone-600 dark:text-stone-400">
              Roughdraft uses CriticMarkup-compatible markers for comments,
              highlights, insertions, deletions, and substitutions. Roughdraft
              extends those markers with document-local metadata so review
              threads, authorship, timestamps, and suggested-change discussions
              can survive in the Markdown file itself.
            </p>
          </div>

          <div className="grid gap-3">
            {ROUGHDRAFT_MARKDOWN_SYNTAX.map(
              ({ description, label, syntax }) => (
                <div
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
                  key={label}
                >
                  <div className="flex items-center gap-2">
                    <Braces
                      className="size-4 text-stone-500 dark:text-stone-400"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-50">
                      {label}
                    </h3>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                    {description}
                  </p>
                  <code className="mt-3 block overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700 bg-[#FAFAF8] dark:bg-slate-800 px-3 py-2 text-xs text-stone-700 dark:text-stone-300">
                    {syntax}
                  </code>
                </div>
              ),
            )}
          </div>
        </section>

        <section className="mt-14 grid gap-8 border-t border-slate-200 dark:border-slate-700 pt-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-stone-500 dark:text-stone-400 uppercase">
              Roughdraft extensions
            </p>
            <h2 className="mt-3 text-3xl leading-tight font-semibold text-slate-950 dark:text-slate-50">
              The extra fields make review state portable
            </h2>
            <p className="mt-4 text-base leading-7 text-stone-600 dark:text-stone-400">
              Standard CriticMarkup captures the visible annotation. Roughdraft
              keeps the same readable markers, adds compact inline references,
              and stores review metadata in final YAML endmatter.
            </p>
          </div>

          <div className="grid gap-3">
            {ROUGHDRAFT_MARKDOWN_EXTENSION_DETAILS.map(({ body, title }) => (
              <div
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
                key={title}
              >
                <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-50">
                  {title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 max-w-3xl border-t border-slate-200 dark:border-slate-700 pt-10">
          <h2 className="text-2xl font-semibold text-slate-950 dark:text-slate-50">
            What this is not
          </h2>
          <p className="mt-4 text-base leading-7 text-stone-600 dark:text-stone-400">
            It is not a new replacement for Markdown, and it is not a hidden app
            state format. If Roughdraft adds review information, that
            information should stay visible, portable, and understandable in the
            Markdown file itself.
          </p>
        </section>
      </div>
    </main>
  );
}

function createPreviewPage(): Page {
  return {
    id: "preview",
    title: "Live Preview",
    content: PREVIEW_INITIAL_MARKDOWN,
    version: "memory:initial",
  };
}

export function PreviewPage() {
  const [backend] = useState(() => new PreviewBackend(createPreviewPage()));
  const [sync, setSync] = useState<DocumentSync | null>(null);
  const [editorViewMode, setEditorViewMode] = useState<DocumentEditorViewMode>(
    () => getDocumentEditorViewModeFromLocation("rich-text"),
  );

  useEffect(() => () => backend.dispose(), [backend]);

  // The preview runs through the same sync controller as a real file, with
  // an in-memory backend and no tab channel.
  useEffect(() => {
    const controller = new DocumentSync({
      backend,
      path: PREVIEW_DOCUMENT_PATH,
      tabId: "preview",
      initialPage: backend.getCurrentPage(),
    });
    controller.start();
    setSync(controller);
    return () => controller.dispose();
  }, [backend]);

  useEffect(() => {
    document.title = "Roughdraft Preview";
  }, []);

  return (
    <main className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#FCFCFC] dark:bg-background text-slate-950 dark:text-slate-50">
      <DocumentWorkspace
        sync={sync}
        activeDocumentPath={PREVIEW_DOCUMENT_PATH}
        documentCopyPath={PREVIEW_DOCUMENT_PATH}
        documentFilenameLabel={PREVIEW_DOCUMENT_PATH}
        documentEditorViewMode={editorViewMode}
        onDocumentEditorViewModeChange={setEditorViewMode}
        backend={backend}
      />
    </main>
  );
}

// Start-up retries on its own after 1, 2 and 5 s, then waits for Retry.
export const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000];
// A missing file is checked again every 5 s until it appears.
export const MISSING_FILE_POLL_MS = 5_000;

// The label of the session that opened the document, from the status route.
async function fetchSessionLabel(
  projectPath: string,
  documentPath: string,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ projectPath, path: documentPath });
    const response = await fetch(`/api/review-events/status?${params}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      session?: { label?: unknown } | null;
    };
    return typeof body.session?.label === "string" ? body.session.label : null;
  } catch {
    return null;
  }
}

// How long a tab closed from the open documents list waits for
// window.close() before it shows the notice instead (a tab the browser will
// not let a page close stays open).
export const CLOSE_FALLBACK_MS = 300;

type StartupState =
  | { kind: "loading" }
  | { kind: "not-markdown" }
  | {
      kind: "error";
      message: string;
      retryAt: number | null;
      retrying: boolean;
    }
  | { kind: "missing" }
  | { kind: "ready" };

async function fileExists(backend: StorageBackend, relativePath: string) {
  try {
    return (await backend.getMarkdownFileState(relativePath)).exists;
  } catch (error) {
    if (!(error instanceof UnsupportedRouteError)) throw error;
  }
  // A server without the state route: ask for the page itself.
  try {
    await backend.getMarkdownFile(relativePath);
    return true;
  } catch (error) {
    if (error instanceof MarkdownFileNotFoundError) return false;
    throw error;
  }
}

function describeStartupError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function StartupScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-screen min-w-0 items-center justify-center bg-[#FCFCFC] px-4 text-slate-950 dark:bg-background dark:text-slate-50">
      <div className="w-full max-w-md rounded-[10px] border border-stone-200 bg-white p-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:border-slate-800 dark:bg-card">
        {children}
      </div>
    </main>
  );
}

function StartupErrorScreen({
  name,
  message,
  retryAt,
  retrying,
  onRetry,
}: {
  name: string;
  message: string;
  retryAt: number | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [retryAt]);
  const seconds =
    retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));

  return (
    <StartupScreen>
      <div data-testid="startup-error" className="space-y-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p
            data-testid="startup-error-message"
            className="min-w-0 text-sm leading-6 break-words"
          >
            Could not load {name}: {message}
          </p>
        </div>
        <p
          data-testid="startup-error-retry-status"
          className="text-xs leading-5 text-stone-500 dark:text-slate-400"
        >
          {retrying
            ? "Trying again..."
            : seconds !== null
              ? `Trying again in ${seconds} s.`
              : "Roughdraft stopped retrying on its own."}
        </p>
        <Button
          type="button"
          data-testid="startup-error-retry"
          size="lg"
          className="w-full rounded-[7px] text-sm font-semibold"
          disabled={retrying}
          onClick={onRetry}
        >
          <RefreshCcw className="size-4" />
          Retry
        </Button>
      </div>
    </StartupScreen>
  );
}

function StartupFileMissingScreen({ path }: { path: string }) {
  return (
    <StartupScreen>
      <div data-testid="startup-file-missing" className="space-y-2">
        <div className="flex items-start gap-2.5">
          <FileText
            className="mt-0.5 size-4 shrink-0 text-stone-500 dark:text-slate-400"
            aria-hidden="true"
          />
          <p className="min-w-0 text-sm leading-6 break-words">
            File not found at{" "}
            <span
              data-testid="startup-file-missing-path"
              className="font-mono text-[0.8rem]"
            >
              {path}
            </span>
          </p>
        </div>
        <p className="text-xs leading-5 text-stone-500 dark:text-slate-400">
          Roughdraft checks every few seconds and opens the file when it
          appears.
        </p>
      </div>
    </StartupScreen>
  );
}

function NotMarkdownScreen({ path }: { path: string }) {
  return (
    <StartupScreen>
      <div data-testid="startup-not-markdown" className="space-y-2">
        <p className="text-sm leading-6 break-words">
          Roughdraft now opens one .md file at a time.{" "}
          <span className="font-mono text-[0.8rem]">{path}</span> is not one.
        </p>
        <a
          href="/"
          className="text-xs font-medium text-stone-600 underline underline-offset-4 dark:text-slate-300"
        >
          Open documents
        </a>
      </div>
    </StartupScreen>
  );
}

function ClosedFromListScreen() {
  return (
    <StartupScreen>
      <div data-testid="closed-from-list" className="space-y-2">
        <p className="text-sm leading-6">
          Closed from the open documents list. You can close this tab.
        </p>
        <a
          href="/"
          className="text-xs font-medium text-stone-600 underline underline-offset-4 dark:text-slate-300"
        >
          Open documents
        </a>
      </div>
    </StartupScreen>
  );
}

export function App() {
  const pathname = window.location.pathname;
  if (pathname === ROUGHDRAFT_FLAVORED_MARKDOWN_PATH) {
    return <RoughdraftFlavoredMarkdownPage />;
  }
  if (pathname === PREVIEW_PATH) return <PreviewPage />;
  // The root address with no file is the open documents list.
  if (!getRequestedPathState().rawPath) return <OpenDocumentsPage />;
  return <DocumentApp />;
}

function DocumentApp() {
  const initialRequestedPathState = getRequestedPathState();
  const [requestedPathState] = useState(initialRequestedPathState);
  const [backend, setBackend] = useState<StorageBackend | null>(null);
  const [sync, setSync] = useState<DocumentSync | null>(null);
  const [startup, setStartup] = useState<StartupState>({ kind: "loading" });
  const [startAttempt, setStartAttempt] = useState(0);
  const autoRetriesRef = useRef(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [documentEditorViewMode, setDocumentEditorViewMode] = useState(() =>
    getDocumentEditorViewModeFromLocation("rich-text"),
  );
  const activeDocumentPath = sync?.path ?? null;
  const { documentPath, projectPath, rawPath } = requestedPathState;
  const [closedByList, setClosedByList] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadUpdateStatus = async () => {
      const nextUpdateStatus = await fetchUpdateStatus();
      if (!cancelled) {
        setUpdateStatus(nextUpdateStatus);
      }
    };

    void loadUpdateStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  // Legacy open-requests stream. A batch 2 server delivers open requests
  // on the tab channel instead, so the stream closes at the first hello and
  // stops counting against the browser's six-connection limit.
  useEffect(() => {
    if (sync?.getView().channelSupported) return;
    const tabId = getOrCreateTabId(readSessionStorage());
    const source = new EventSource(buildOpenRequestsUrl(rawPath, tabId));
    const handleOpenRequest = (event: Event) => {
      handleOpenRequestEvent((event as MessageEvent<string>).data, {
        currentHref: window.location.href,
        focus: () => window.focus(),
        acknowledge: (requestId) => void acknowledgeOpenRequest(requestId),
        navigate: (href) => window.location.assign(href),
      });
    };

    source.addEventListener("open-request", handleOpenRequest);
    const stopHello = sync?.onHello(() => {
      source.removeEventListener("open-request", handleOpenRequest);
      source.close();
    });

    return () => {
      stopHello?.();
      source.removeEventListener("open-request", handleOpenRequest);
      source.close();
    };
  }, [rawPath, sync]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: startAttempt is the retry trigger; bumping it runs start-up again
  useEffect(() => {
    let cancelled = false;
    let created: DocumentSync | null = null;
    let retryTimer: number | null = null;

    const initialize = async () => {
      setStartup((current) =>
        current.kind === "error"
          ? { ...current, retrying: true }
          : current.kind === "missing"
            ? current
            : { kind: "loading" },
      );

      try {
        const detectedBackend = await detectBackend({ requireServer: true });
        if (cancelled) return;

        setBackend(detectedBackend);
        if (!rawPath) return;

        syncRequestedPathInUrl(rawPath);

        if (!projectPath || !documentPath) {
          setStartup({ kind: "not-markdown" });
          return;
        }

        if (detectedBackend.canManageProjects) {
          await detectedBackend.openProject(projectPath);
        }
        if (cancelled) return;

        const page = await detectedBackend.getMarkdownFile(documentPath);
        if (cancelled) return;

        const controller: DocumentSync = new DocumentSync({
          backend: detectedBackend,
          path: documentPath,
          tabId: getOrCreateTabId(readSessionStorage()),
          initialPage: page,
          // Unsaved drafts stay in this browser until they reach disk,
          // keyed by the document's absolute path.
          draftStore:
            detectedBackend.info.kind === "local-files"
              ? getDraftStore()
              : null,
          draftKey: joinPath(projectPath, documentPath),
          onOpenRequest: (request) =>
            handleOpenRequestEvent(JSON.stringify(request), {
              currentHref: window.location.href,
              focus: () => window.focus(),
              acknowledge: (requestId) => {
                if (!controller.acknowledgeOpenRequest(requestId)) {
                  void acknowledgeOpenRequest(requestId);
                }
              },
              navigate: (href) => window.location.assign(href),
            }),
        });
        created = controller;
        // A draft kept from an earlier session goes in before the editor
        // mounts, merged onto the file as it is now.
        await controller.restoreDraft();
        if (cancelled) return;
        controller.start();
        autoRetriesRef.current = 0;
        setSync(controller);
        setStartup({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to open markdown file:", error);

        if (error instanceof MarkdownFileNotFoundError) {
          setStartup({ kind: "missing" });
          return;
        }

        const delay = STARTUP_RETRY_DELAYS_MS[autoRetriesRef.current];
        setStartup({
          kind: "error",
          message: describeStartupError(error),
          retryAt: delay === undefined ? null : Date.now() + delay,
          retrying: false,
        });
        if (delay !== undefined) {
          autoRetriesRef.current += 1;
          retryTimer = window.setTimeout(() => {
            setStartAttempt((attempt) => attempt + 1);
          }, delay);
        }
      }
    };

    void initialize();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      created?.dispose();
    };
  }, [documentPath, projectPath, rawPath, startAttempt]);

  // A file that is not there yet: check every 5 s and open it once it is.
  const startupKind = startup.kind;
  useEffect(() => {
    if (startupKind !== "missing" || !backend || !documentPath) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void fileExists(backend, documentPath)
        .then((exists) => {
          if (exists && !cancelled) setStartAttempt((attempt) => attempt + 1);
        })
        .catch(() => {
          // The server is not answering; keep checking.
        });
    }, MISSING_FILE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [backend, documentPath, startupKind]);

  // Window title: "<document title> · <session title>", the document title
  // being the file's first heading, else its name. Follows the file on disk
  // and the session the server reports. A tab that starts hidden opens its
  // channel only when it is shown, so the session is read once up front.
  useEffect(() => {
    const fileName = getPathLeaf(documentPath ?? rawPath) ?? "Roughdraft";
    if (!sync) {
      document.title = fileName;
      return;
    }
    let lastContent: string | null = null;
    let heading: string | null = null;
    let statusLabel: string | null = null;
    let cancelled = false;
    const update = () => {
      const view = sync.getView();
      if (view.base.content !== lastContent) {
        lastContent = view.base.content;
        heading = documentTitleFromMarkdown(lastContent);
      }
      document.title = documentWindowTitle(
        heading ?? fileName,
        view.channelSupported
          ? (view.session?.label ?? null)
          : (view.session?.label ?? statusLabel),
      );
    };
    update();
    if (projectPath && documentPath) {
      void fetchSessionLabel(projectPath, documentPath).then((label) => {
        if (cancelled) return;
        statusLabel = label;
        update();
      });
    }
    const stop = sync.subscribe(update);
    return () => {
      cancelled = true;
      stop();
    };
  }, [documentPath, projectPath, rawPath, sync]);

  // Closed from the open documents list: the window closes itself when the
  // browser lets it, else it says so and stops syncing.
  useEffect(() => {
    if (!sync) return;
    let timer: number | null = null;
    const check = () => {
      if (timer !== null || !sync.getView().closedByList) return;
      window.close();
      timer = window.setTimeout(() => {
        sync.dispose();
        setClosedByList(true);
      }, CLOSE_FALLBACK_MS);
    };
    check();
    const stop = sync.subscribe(check);
    return () => {
      stop();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sync]);

  useEffect(() => {
    if (!closedByList) return;
    document.title = `Closed · ${document.title}`;
  }, [closedByList]);

  useEffect(() => {
    if (!sync) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const view = sync.getView();
      const { saveState, diskState } = getSyncStatus(view);
      if (
        !shouldWarnBeforeUnload({
          activeDocumentPath: sync.path,
          isDirty: view.dirty,
          saveState,
          diskChangeState: diskState,
        })
      ) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sync]);

  const handleDocumentEditorViewModeChange = useCallback(
    (nextMode: DocumentEditorViewMode) => {
      setDocumentEditorViewMode((current) => {
        if (nextMode === current) return current;
        window.history.replaceState(
          null,
          "",
          buildLocationForDocumentEditorViewMode(nextMode),
        );
        return nextMode;
      });
    },
    [],
  );

  const handleStartupRetry = useCallback(() => {
    autoRetriesRef.current = 0;
    setStartAttempt((attempt) => attempt + 1);
  }, []);

  if (startup.kind === "loading") {
    return (
      <div
        className="h-screen bg-[#FCFCFC] dark:bg-background"
        aria-hidden="true"
      />
    );
  }

  if (!rawPath || startup.kind === "not-markdown") {
    return <NotMarkdownScreen path={rawPath ?? ""} />;
  }

  if (closedByList) return <ClosedFromListScreen />;

  const documentAbsolutePath =
    (activeDocumentPath ?? documentPath) && backend?.info.projectPath
      ? joinPath(
          backend.info.projectPath,
          activeDocumentPath ?? documentPath ?? "",
        )
      : rawPath;
  const documentFilenameLabel =
    getPathLeaf(documentAbsolutePath ?? activeDocumentPath) ?? "Untitled.md";

  if (startup.kind === "error") {
    return (
      <StartupErrorScreen
        name={documentFilenameLabel}
        message={startup.message}
        retryAt={startup.retryAt}
        retrying={startup.retrying}
        onRetry={handleStartupRetry}
      />
    );
  }

  if (startup.kind === "missing") {
    return <StartupFileMissingScreen path={documentAbsolutePath ?? rawPath} />;
  }

  return (
    <main className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#FCFCFC] dark:bg-background text-slate-950 dark:text-slate-50">
      {updateStatus ? (
        <div className="pointer-events-none absolute top-4 right-4 z-40 max-w-sm">
          <div className="pointer-events-auto">
            <UpdateNotice updateStatus={updateStatus} />
          </div>
        </div>
      ) : null}
      <DocumentWorkspace
        sync={sync}
        activeDocumentPath={activeDocumentPath}
        documentCopyPath={documentAbsolutePath}
        documentFilenameLabel={documentFilenameLabel}
        documentEditorViewMode={documentEditorViewMode}
        onDocumentEditorViewModeChange={handleDocumentEditorViewModeChange}
        backend={backend}
      />
    </main>
  );
}
