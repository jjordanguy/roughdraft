// The batch 5 sync surfaces: the conflict resolver banner with its
// overwrite confirmation, the loud removed-text notice, the quiet
// "Updated from disk" line and the restored-draft line.

import { diffSequences, type RfmMergeChoice } from "@roughdraft/rfm";
import {
  AlertTriangle,
  Check,
  FileDiff,
  History,
  RefreshCcw,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import type { ConflictHunk, Snapshot, SyncNotice } from "./document-sync";
import { cn } from "./lib/utils";

// How long the quiet lines stay before they go on their own.
export const QUIET_NOTICE_MS = 10_000;

const CHOICE_LABELS: Record<RfmMergeChoice, string> = {
  suggestion: "Keep mine as a suggestion",
  theirs: "Use the disk version",
  ours: "Use mine",
};

// "Keep mine as a suggestion" first (the default) when the engine offers
// it, then the disk version, then mine.
const CHOICE_ORDER: RfmMergeChoice[] = ["suggestion", "theirs", "ours"];

function hunkTitle(hunk: ConflictHunk): string {
  if (hunk.kind === "document") return "The whole document";
  if (hunk.kind === "frontmatter") return "Frontmatter";
  if (hunk.kind === "entry" && hunk.entry) {
    const key = hunk.entry.key ? ` (${hunk.entry.key})` : "";
    return `Review entry ${hunk.entry.id}${key}`;
  }
  if (hunk.lines) return `Line ${hunk.lines.theirs} on disk`;
  return "An overlap";
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "(removed)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function hunkSides(hunk: ConflictHunk): { mine: string; disk: string } | null {
  if (hunk.kind === "entry" && hunk.entry) {
    return {
      mine: showValue(hunk.entry.ours),
      disk: showValue(hunk.entry.theirs),
    };
  }
  if (hunk.ours === null && hunk.theirs === null) return null;
  return { mine: hunk.ours ?? "(removed)", disk: hunk.theirs ?? "(removed)" };
}

export function ConflictResolverBanner({
  hunks,
  theirs,
  draft,
  onResolve,
  onOverwrite,
}: {
  hunks: ConflictHunk[];
  theirs: Snapshot;
  // The draft as it is when the overwrite dialog opens.
  draft: () => string;
  onResolve: (hunkId: string, choice: RfmMergeChoice) => void;
  onOverwrite: (shown: Snapshot) => Promise<void> | void;
}) {
  const [overwrite, setOverwrite] = useState<{
    shown: Snapshot;
    draft: string;
  } | null>(null);
  const count = hunks.length;

  return (
    <div
      data-testid="file-conflict-notice"
      data-workspace-banner="true"
      role="status"
      aria-label="Your edit overlaps a change on disk"
      className="fixed top-3 left-1/2 z-50 flex max-h-[min(24rem,calc(100vh-6rem))] w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-2.5 overflow-y-auto rounded-[8px] border border-amber-300 bg-amber-50 px-3 py-3 text-amber-950 shadow-[0_14px_40px_rgba(120,53,15,0.18)] sm:px-4 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)]"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-5">
            Your edit overlaps a change on disk
          </div>
          <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
            Both versions are kept until you choose.{" "}
            {count === 1
              ? "Pick one for the overlap below."
              : `Pick one for each of the ${count} overlaps below.`}{" "}
            Keep typing anywhere; your draft is kept in this browser.
          </div>
        </div>
      </div>
      <ul className="flex flex-col gap-2" data-testid="file-conflict-hunks">
        {hunks.map((hunk) => {
          const sides = hunkSides(hunk);
          const choices = CHOICE_ORDER.filter((choice) =>
            hunk.choices.includes(choice),
          );
          return (
            <li
              key={hunk.id}
              data-testid={`file-conflict-hunk-${hunk.id}`}
              data-hunk-kind={hunk.kind}
              className="rounded-[7px] border border-amber-200 bg-white/70 px-2.5 py-2 dark:border-amber-800 dark:bg-white/5"
            >
              <div className="text-xs font-semibold leading-5">
                {hunkTitle(hunk)}
              </div>
              <div className="text-xs leading-5 text-amber-900 dark:text-amber-200">
                {hunk.message}
              </div>
              {sides ? (
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  <div className="min-w-0">
                    <div className="text-[0.68rem] font-medium uppercase tracking-wide text-amber-800/80 dark:text-amber-300/80">
                      Mine
                    </div>
                    <pre
                      data-testid={`file-conflict-hunk-${hunk.id}-mine`}
                      className="max-h-24 overflow-auto rounded-[5px] bg-amber-100/60 px-2 py-1 text-[0.72rem] leading-5 whitespace-pre-wrap break-words dark:bg-amber-900/40"
                    >
                      {sides.mine}
                    </pre>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[0.68rem] font-medium uppercase tracking-wide text-amber-800/80 dark:text-amber-300/80">
                      On disk
                    </div>
                    <pre
                      data-testid={`file-conflict-hunk-${hunk.id}-disk`}
                      className="max-h-24 overflow-auto rounded-[5px] bg-amber-100/60 px-2 py-1 text-[0.72rem] leading-5 whitespace-pre-wrap break-words dark:bg-amber-900/40"
                    >
                      {sides.disk}
                    </pre>
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {choices.map((choice, index) => (
                  <Button
                    key={choice}
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`file-conflict-hunk-${hunk.id}-${choice}`}
                    className={cn(
                      "h-8 rounded-[7px] px-2 text-xs",
                      index === 0
                        ? "bg-amber-900 text-white hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500"
                        : "bg-white/70 text-amber-950 hover:bg-white dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/20",
                    )}
                    onClick={() => onResolve(hunk.id, choice)}
                  >
                    {CHOICE_LABELS[choice]}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div
          data-testid="file-conflict-disk-version"
          className="text-[0.68rem] leading-4 text-amber-800/80 dark:text-amber-300/80"
        >
          {formatDiskVersion(theirs)}
        </div>
        <Button
          type="button"
          data-testid="file-conflict-action-overwrite"
          variant="ghost"
          size="sm"
          className="h-8 rounded-[7px] px-2 text-xs text-amber-900 underline-offset-4 hover:bg-white/60 hover:underline dark:text-amber-200 dark:hover:bg-white/10"
          onClick={() => setOverwrite({ shown: theirs, draft: draft() })}
        >
          <FileDiff className="size-3.5" />
          Overwrite the disk file with my draft...
        </Button>
      </div>
      <OverwriteDialog
        request={overwrite}
        onCancel={() => setOverwrite(null)}
        onConfirm={async (shown) => {
          setOverwrite(null);
          await onOverwrite(shown);
        }}
      />
    </div>
  );
}

export function formatDiskVersion(snapshot: Snapshot): string {
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

export interface DiffRow {
  kind: "same" | "removed" | "added" | "gap";
  text: string;
}

// The lines the overwrite would take off disk and the ones it would write,
// with two lines of context around each change.
export function lineDiffRows(disk: string, draft: string): DiffRow[] {
  const a = disk.split("\n");
  const b = draft.split("\n");
  const rows: DiffRow[] = [];
  const context = 2;
  let aIndex = 0;
  for (const hunk of diffSequences(a, b)) {
    const contextStart = Math.max(aIndex, hunk.aStart - context);
    if (contextStart > aIndex) rows.push({ kind: "gap", text: "..." });
    for (let index = contextStart; index < hunk.aStart; index += 1) {
      rows.push({ kind: "same", text: a[index] ?? "" });
    }
    for (let index = hunk.aStart; index < hunk.aEnd; index += 1) {
      rows.push({ kind: "removed", text: a[index] ?? "" });
    }
    for (let index = hunk.bStart; index < hunk.bEnd; index += 1) {
      rows.push({ kind: "added", text: b[index] ?? "" });
    }
    const after = Math.min(a.length, hunk.aEnd + context);
    for (let index = hunk.aEnd; index < after; index += 1) {
      rows.push({ kind: "same", text: a[index] ?? "" });
    }
    aIndex = after;
  }
  if (aIndex < a.length && rows.length > 0) {
    rows.push({ kind: "gap", text: "..." });
  }
  return rows;
}

function OverwriteDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: { shown: Snapshot; draft: string } | null;
  onCancel: () => void;
  onConfirm: (shown: Snapshot) => void;
}) {
  const rows = useMemo(
    () => (request ? lineDiffRows(request.shown.content, request.draft) : []),
    [request],
  );
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        data-testid="overwrite-confirm-dialog"
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Overwrite the disk file?</DialogTitle>
          <DialogDescription>
            Your draft replaces this disk version. Lines marked minus are
            removed from the file, lines marked plus are written.
            {request ? ` ${formatDiskVersion(request.shown)}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre
          data-testid="overwrite-confirm-diff"
          className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-2 text-[0.72rem] leading-5"
        >
          {rows.length === 0 ? (
            <span>No differences.</span>
          ) : (
            rows.map((row, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for one dialog
                key={index}
                data-testid={`overwrite-diff-row-${row.kind}`}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  row.kind === "removed" &&
                    "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
                  row.kind === "added" &&
                    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
                  row.kind === "gap" && "text-muted-foreground",
                )}
              >
                {row.kind === "removed"
                  ? "- "
                  : row.kind === "added"
                    ? "+ "
                    : "  "}
                {row.text}
              </div>
            ))
          )}
        </pre>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="overwrite-confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="overwrite-confirm-submit"
            onClick={() => {
              if (request) onConfirm(request.shown);
            }}
          >
            Overwrite this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemovedTextNotice({
  notice,
  onRestore,
  onDismiss,
}: {
  notice: Extract<SyncNotice, { kind: "removed" }>;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  const preview = notice.removed
    .map((removed) => removed.text.trim())
    .join(" / ");
  return (
    <div
      data-testid="removed-text-notice"
      data-workspace-banner="true"
      role="alert"
      className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-rose-300 bg-rose-50 px-3 py-3 text-rose-950 shadow-[0_14px_40px_rgba(136,19,55,0.16)] sm:flex-row sm:items-center sm:justify-between sm:px-4 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-rose-700 dark:text-rose-400"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-5">
            An outside write removed text you saved. Restore it?
          </div>
          <div
            data-testid="removed-text-preview"
            className="mt-0.5 line-clamp-2 text-xs leading-5 text-rose-900 dark:text-rose-200"
          >
            {preview}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:justify-end">
        <Button
          type="button"
          data-testid="removed-text-dismiss"
          variant="ghost"
          size="sm"
          className="h-8 rounded-[7px] bg-white/70 px-2 text-xs text-rose-950 hover:bg-white dark:bg-white/10 dark:text-rose-100 dark:hover:bg-white/20"
          onClick={onDismiss}
        >
          Leave it out
        </Button>
        <Button
          type="button"
          data-testid="removed-text-restore"
          variant="ghost"
          size="sm"
          className="h-8 rounded-[7px] bg-rose-900 px-2 text-xs text-white hover:bg-rose-800 dark:bg-rose-600 dark:hover:bg-rose-500"
          onClick={onRestore}
        >
          <RotateCcw className="size-3.5" />
          Restore as a suggestion
        </Button>
      </div>
    </div>
  );
}

// The quiet line, shown as a toast: "Updated from disk: <what changed>"
// with "show me", or the restored-draft line. It goes on its own.
export function QuietSyncNotice({
  notice,
  onShow,
  onDismiss,
}: {
  notice: Extract<SyncNotice, { kind: "updated" | "restored" }>;
  onShow?: () => void;
  onDismiss: () => void;
}) {
  const { id } = notice;
  useEffect(() => {
    void id;
    const timer = window.setTimeout(onDismiss, QUIET_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss]);

  const restored = notice.kind === "restored";
  return (
    <Badge
      variant="outline"
      role="status"
      data-testid={restored ? "draft-restored-notice" : "disk-update-notice"}
      className="h-auto max-w-full min-w-0 gap-1.5 border-stone-200 bg-[#FFFDFC] py-0.5 pr-0.5 pl-2 text-[0.7rem] font-normal tracking-normal whitespace-normal text-stone-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      {restored ? (
        <History aria-hidden="true" />
      ) : (
        <RefreshCcw aria-hidden="true" />
      )}
      <span className="min-w-0" data-testid="sync-notice-text">
        {restored
          ? "Restored unsaved edits from your last session"
          : `Updated from disk: ${notice.summary}`}
      </span>
      {!restored && onShow ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="disk-update-show"
          className="h-5 rounded-full px-1.5 text-[0.7rem] font-medium text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950"
          onClick={onShow}
        >
          show me
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="sync-notice-dismiss"
        aria-label="Dismiss"
        className="rounded-full text-stone-500 hover:bg-stone-100 dark:text-slate-400 dark:hover:bg-slate-800"
        onClick={onDismiss}
      >
        {restored ? <Check /> : <X />}
      </Button>
    </Badge>
  );
}
