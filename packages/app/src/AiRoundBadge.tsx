import { Bot, Clock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import type { RoundFlag } from "./storage";

export type AiRoundBadgeView =
  | { kind: "hidden" }
  | { kind: "open"; elapsed: string }
  | { kind: "stalled" };

/** "0:07", "12:30", "1:05:00": time since the round opened. */
export function formatRoundElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

// D5: a badge only, never a lock. Open shows "AI editing..." with the time
// since the round opened, stalled says so until dismissed, closed shows
// nothing (batch 5's quiet notice takes over when the round wrote).
export function getAiRoundBadgeView(
  round: RoundFlag | null,
  now: number,
  dismissedRoundKey: string | null = null,
): AiRoundBadgeView {
  if (!round) return { kind: "hidden" };
  if (round.state === "open") {
    const openedAt = Date.parse(round.openedAt);
    return {
      kind: "open",
      elapsed: formatRoundElapsed(Number.isNaN(openedAt) ? 0 : now - openedAt),
    };
  }
  if (round.state === "stalled") {
    return dismissedRoundKey === roundKey(round)
      ? { kind: "hidden" }
      : { kind: "stalled" };
  }
  return { kind: "hidden" };
}

function roundKey(round: RoundFlag) {
  return `${round.roundId}:${round.openedAt}`;
}

export function AiRoundBadge({ round }: { round: RoundFlag | null }) {
  const [dismissedRoundKey, setDismissedRoundKey] = useState<string | null>(
    null,
  );
  const ticking = round?.state === "open";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [ticking]);

  const view = getAiRoundBadgeView(round, now, dismissedRoundKey);
  if (view.kind === "hidden") return null;

  if (view.kind === "open") {
    return (
      <Badge
        variant="outline"
        role="status"
        data-testid="ai-round-badge"
        data-round-state="open"
        className="gap-1.5 border-sky-200 bg-sky-50 px-2 text-[0.7rem] tracking-normal text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
      >
        <Bot aria-hidden="true" />
        <span>AI editing...</span>
        <span
          data-testid="ai-round-elapsed"
          className="font-normal tabular-nums text-sky-700/80 dark:text-sky-300/80"
        >
          {view.elapsed}
        </span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      role="status"
      data-testid="ai-round-badge"
      data-round-state="stalled"
      className="gap-1 border-amber-200 bg-amber-50 pr-0.5 pl-2 text-[0.7rem] tracking-normal text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <Clock aria-hidden="true" />
      <span>AI round stalled</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="ai-round-badge-dismiss"
        aria-label="Dismiss"
        className="rounded-full text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900"
        onClick={() => {
          if (round) setDismissedRoundKey(roundKey(round));
        }}
      >
        <X />
      </Button>
    </Badge>
  );
}
