import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import type { UpdateStatus } from "./update-status";

interface UpdateNoticeProps {
  updateStatus: UpdateStatus;
}

export function UpdateNotice({ updateStatus }: UpdateNoticeProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 1600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  const handleUpdate = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(updateStatus.updateCommand);
      setCopied(true);
    } catch {
      window.open(
        `https://www.npmjs.com/package/${encodeURIComponent(updateStatus.packageName)}`,
        "_blank",
        "noopener,noreferrer",
      );
    }
  }, [updateStatus.packageName, updateStatus.updateCommand]);

  return (
    <div
      className="rounded-2xl border border-amber-200 dark:border-amber-700 bg-amber-50/95 dark:bg-amber-950/95 p-4 text-slate-900 dark:text-slate-100 shadow-[0_14px_34px_rgba(120,53,15,0.12)] dark:shadow-[0_14px_34px_rgba(0,0,0,0.4)] backdrop-blur"
      data-testid="update-notice"
    >
      <div className="text-[0.68rem] font-semibold tracking-[0.18em] text-amber-700 dark:text-amber-400 uppercase">
        Update available
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
        You&apos;re on {updateStatus.currentVersion}. The latest version is{" "}
        {updateStatus.latestVersion}.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          data-testid="update-notice-button"
          size="sm"
          className="h-8 rounded-lg bg-slate-950 dark:bg-slate-100 px-3 text-sm font-semibold text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-300"
          onClick={() => void handleUpdate()}
          title={`Copy ${updateStatus.updateCommand}`}
        >
          {copied ? "Copied" : "Update"}
        </Button>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          {copied ? (
            "Copied the npm command"
          ) : (
            <>
              Copies the npm command
              <ArrowUpRight className="size-3" />
            </>
          )}
        </span>
      </div>
    </div>
  );
}
