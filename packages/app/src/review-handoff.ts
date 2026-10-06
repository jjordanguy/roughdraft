import type { DocumentSaveState } from "./PageCard";
import type {
  CompleteReviewResult,
  HandoffRecord,
  HandoffWake,
} from "./storage";

export type DiskChangeState =
  | "clean"
  // The draft overlaps a change on disk; the banner lists the overlaps.
  | "conflict"
  // The file is missing or unreadable; edits wait in the tab.
  | "unavailable";

// Why the last Done failed: the file moved on disk, the server never
// answered, or it answered with an error.
export type ReviewHandoffErrorKind = "file-changed" | "no-answer" | "failed";

// idle: nothing sent since the last edit; sending: request in flight;
// completed: the server answered 2xx; error: the request failed.
export type ReviewHandoffPhase = "idle" | "sending" | "completed" | "error";

export type ReviewHandoffViewKind =
  | "hidden"
  | "ready-listening"
  | "ready-no-agent"
  | "blocked"
  | "sending"
  | "sent"
  | "saved-for-agent"
  | "not-received"
  | "picked-up"
  | "error";

export interface ReviewHandoffViewInput {
  // True when a local-files document is loaded. The Done button never shows
  // for the in-memory preview or browser storage.
  enabled: boolean;
  watcherCount: number;
  diskState: DiskChangeState;
  // Open overlaps in the conflict banner (diskState "conflict").
  conflictCount?: number;
  saveState: DocumentSaveState;
  phase: ReviewHandoffPhase;
  errorKind?: ReviewHandoffErrorKind | null;
  // The last 2xx answer to Done.
  result: CompleteReviewResult | null;
  // The newest copy of that Done's handoff record, refreshed by the status
  // poll. Null until a record is known.
  handoff: HandoffRecord | null;
  sessionLabel: string | null;
  documentChangedSinceOpen: boolean;
  sentTitle: string;
  formatTime?: (iso: string) => string;
}

export interface ReviewHandoffView {
  kind: ReviewHandoffViewKind;
  buttonLabel: string;
  buttonDisabled: boolean;
  triggerDisabled: boolean;
  dimmed: boolean;
  icon: "spinner" | "alert" | "check" | null;
  watcherState: "listening" | "none";
  agentStatusText: string | null;
  sessionText: string | null;
  blockedReason: string | null;
  title: string | null;
  body: string | null;
  wakeLine: string | null;
  showCopyMessage: boolean;
  showRetry: boolean;
  retryDisabled: boolean;
}

const AGENT_LISTENING_TEXT = "Your agent is waiting";
const NO_AGENT_TEXT =
  "No agent is listening. Roughdraft keeps your Done until it checks in.";

function formatHandoffTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function resolveOverlapsLabel(count: number): string {
  const overlaps = Math.max(1, count);
  return `Resolve ${overlaps} ${overlaps === 1 ? "overlap" : "overlaps"} first`;
}

function getReviewHandoffBlockedReason({
  diskState,
  conflictCount,
  saveState,
}: {
  diskState: DiskChangeState;
  conflictCount?: number;
  saveState: DocumentSaveState;
}): string | null {
  if (diskState === "conflict") {
    return `${resolveOverlapsLabel(conflictCount ?? 1)}: your edit overlaps a change on disk.`;
  }
  if (diskState === "unavailable") {
    return "The file is not available on disk. Roughdraft can finish when it is back.";
  }
  // Transient save states ("saving"/"unsaved") intentionally do not block.
  // Blocking on them dims the control on every keystroke while autosave
  // debounces; Done flushes the pending save instead.
  if (saveState === "error") {
    return "Your last save failed. Roughdraft cannot finish until it saves.";
  }
  return null;
}

function describeWake(
  wake: HandoffWake | null,
  sessionLabel: string | null,
): string | null {
  if (!wake) return null;
  const target = sessionLabel ?? "your agent's session";
  if (wake.state === "sent") return `Sent to ${target}`;
  if (wake.state === "failed") {
    return `Wake failed: ${wake.error ?? "no error message"}`;
  }
  // The server answers Done before the wake route runs, so a route id with
  // state "none" means the wake is still in flight.
  return wake.routeId ? `Waking ${target}` : "No wake route registered";
}

function handoffErrorBody(kind: ReviewHandoffErrorKind | null): string {
  if (kind === "file-changed") {
    return "Your edit overlaps a change on disk, so Roughdraft did not record your Done. Choose a version for each overlap, then retry.";
  }
  if (kind === "no-answer") {
    return "The Roughdraft server did not answer, so your Done was not recorded. Retry when it is back.";
  }
  return "Roughdraft could not record your Done. Your saved edits are on disk.";
}

export function getReviewHandoffView(
  input: ReviewHandoffViewInput,
): ReviewHandoffView {
  const formatTime = input.formatTime ?? formatHandoffTime;
  const watcherState = input.watcherCount > 0 ? "listening" : "none";
  const readyLabel = input.documentChangedSinceOpen ? "I'm done" : "Approve";
  const blockedReason = getReviewHandoffBlockedReason(input);
  const sessionText = input.sessionLabel
    ? `Opened by ${input.sessionLabel}`
    : null;

  const base: ReviewHandoffView = {
    kind: "hidden",
    buttonLabel: readyLabel,
    buttonDisabled: false,
    triggerDisabled: true,
    dimmed: true,
    icon: null,
    watcherState,
    agentStatusText: null,
    sessionText,
    blockedReason: null,
    title: null,
    body: null,
    wakeLine: null,
    showCopyMessage: false,
    showRetry: false,
    retryDisabled: false,
  };

  if (!input.enabled) {
    return { ...base, buttonDisabled: true };
  }

  if (input.phase === "sending") {
    return {
      ...base,
      kind: "sending",
      buttonLabel: "Sending",
      buttonDisabled: true,
      icon: "spinner",
      title: "Sending your review",
    };
  }

  if (input.phase === "error") {
    return {
      ...base,
      kind: "error",
      buttonLabel: "Not sent",
      icon: "alert",
      title: "Done not recorded",
      body: handoffErrorBody(input.errorKind ?? null),
      showCopyMessage: true,
      showRetry: true,
      retryDisabled: blockedReason !== null,
      blockedReason,
    };
  }

  if (input.phase === "completed" && input.result) {
    const handoff = input.handoff ?? input.result.handoff ?? null;

    if (handoff?.state === "acknowledged") {
      return {
        ...base,
        kind: "picked-up",
        buttonLabel: "Picked up",
        icon: "check",
        title: `Your agent picked this up at ${formatTime(
          handoff.ackedAt ?? handoff.createdAt,
        )}.`,
      };
    }

    if (input.result.delivered) {
      return {
        ...base,
        kind: "sent",
        buttonLabel: "Sent",
        title: input.sentTitle,
        showCopyMessage: true,
      };
    }

    if (input.result.pending) {
      return {
        ...base,
        kind: "saved-for-agent",
        buttonLabel: "Done, waiting",
        icon: "check",
        title: "Saved for your agent",
        body: "Your agent is not listening right now. Tell it you're done, or copy this message.",
        wakeLine: describeWake(
          handoff?.wake ?? input.result.wake ?? null,
          input.sessionLabel,
        ),
        showCopyMessage: true,
      };
    }

    // A server without the handoff log neither delivered nor kept the Done.
    return {
      ...base,
      kind: "not-received",
      buttonLabel: "Not sent",
      icon: "alert",
      title: "No agent received this",
      body: "Your edits are saved in the file. Copy this message and send it to your agent.",
      showCopyMessage: true,
    };
  }

  if (blockedReason) {
    return {
      ...base,
      kind: "blocked",
      buttonLabel:
        input.diskState === "conflict"
          ? resolveOverlapsLabel(input.conflictCount ?? 1)
          : base.buttonLabel,
      buttonDisabled: true,
      blockedReason,
    };
  }

  return {
    ...base,
    kind: watcherState === "listening" ? "ready-listening" : "ready-no-agent",
    triggerDisabled: false,
    dimmed: false,
    agentStatusText:
      watcherState === "listening" ? AGENT_LISTENING_TEXT : NO_AGENT_TEXT,
  };
}

function formatUuid(bytes: Uint8Array): string {
  // RFC 4122 version 4 layout.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

// crypto.randomUUID exists only in secure contexts. A Roughdraft link on a
// Tailscale address over plain http is not one, so fall back to
// getRandomValues, which every context has.
export function createClientId(
  cryptoSource: Crypto | undefined = globalThis.crypto,
): string {
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return formatUuid(bytes);
}
