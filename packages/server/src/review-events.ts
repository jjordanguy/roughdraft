import fs from "node:fs";
import path from "node:path";

export interface ReviewCompletedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment?: string;
}

export interface ReviewCompletedEvent extends ReviewCompletedEventInput {
  type: "review.completed";
  sequence: number;
  createdAt: string;
}

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  documentKey?: string;
  afterSequence?: number;
  timeoutMs?: number;
  batchWindowMs?: number;
  signal?: AbortSignal;
}

export interface WaitForReviewEventsResult {
  events: ReviewCompletedEvent[];
  timedOut: boolean;
  nextSequence: number;
}

/**
 * Called with the batch of matching events. Resolves true only when the
 * events actually reached a live client.
 */
export type DeliverEvents = (
  events: ReviewCompletedEvent[],
) => boolean | Promise<boolean>;

export interface SubscribeOptions {
  documentPath?: string;
  documentKey?: string;
  afterSequence?: number;
  batchWindowMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  deliver: DeliverEvents;
  onMatch?: () => void;
}

export interface Subscription {
  close: () => void;
}

export interface EmitOptions {
  documentKey?: string;
  sequence?: number;
  createdAt?: string;
}

export interface EmitResult {
  /** True when at least one subscriber matched. Not proof of delivery. */
  delivered: boolean;
  event: ReviewCompletedEvent;
  /** Resolves true once any matching subscriber confirmed a real delivery. */
  delivery: Promise<boolean>;
}

export interface SeededEvent {
  event: ReviewCompletedEvent;
  documentKey: string;
}

interface StoredEvent {
  event: ReviewCompletedEvent;
  key: string;
}

interface Subscriber {
  key: string | null;
  afterSequence: number;
  batchWindowMs: number;
  once: boolean;
  deliver: DeliverEvents;
  onMatch: () => void;
  batchTimer: NodeJS.Timeout | null;
  pendingConfirmations: Array<(delivered: boolean) => void>;
  detachAbort: () => void;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
const MAX_RETAINED_EVENTS = 100;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export class ReviewEventQueue {
  private events: StoredEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private nextSequence: number;

  constructor(options: { nextSequence?: number; seed?: SeededEvent[] } = {}) {
    this.nextSequence = Math.max(1, options.nextSequence ?? 1);
    for (const { event, documentKey } of options.seed ?? []) {
      this.store({ event, key: documentKey });
    }
  }

  emit(
    input: ReviewCompletedEventInput,
    options: EmitOptions = {},
  ): EmitResult {
    const sequence = options.sequence ?? this.nextSequence;
    const event: ReviewCompletedEvent = {
      ...input,
      type: "review.completed",
      sequence,
      createdAt: options.createdAt ?? new Date().toISOString(),
    };
    const key = options.documentKey ?? path.resolve(input.documentPath);
    this.store({ event, key });

    appendSlog("review-events.emit", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.subscribers.size,
      hasOverallComment: typeof event.overallComment === "string",
      overallCommentLength: event.overallComment?.length ?? 0,
    });

    const confirmations: Promise<boolean>[] = [];
    for (const subscriber of [...this.subscribers]) {
      if (matches({ event, key }, subscriber)) {
        confirmations.push(this.scheduleDelivery(subscriber));
      }
    }

    return {
      delivered: confirmations.length > 0,
      event,
      delivery: anyTrue(confirmations),
    };
  }

  subscribe(options: SubscribeOptions): Subscription | null {
    if (options.signal?.aborted) return null;

    const subscriber: Subscriber = {
      key: keyFor(options),
      afterSequence: Math.max(0, options.afterSequence ?? 0),
      batchWindowMs: clamp(
        options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
        0,
        10_000,
      ),
      once: options.once ?? false,
      deliver: options.deliver,
      onMatch: options.onMatch ?? (() => {}),
      batchTimer: null,
      pendingConfirmations: [],
      detachAbort: () => {},
    };

    const close = () => this.remove(subscriber, false);
    if (options.signal) {
      const signal = options.signal;
      signal.addEventListener("abort", close, { once: true });
      subscriber.detachAbort = () => signal.removeEventListener("abort", close);
    }
    this.subscribers.add(subscriber);
    return { close };
  }

  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult> {
    const afterSequence = Math.max(0, options.afterSequence ?? 0);
    const existing = this.eventsAfter({ ...options, afterSequence });
    if (existing.length > 0) {
      return Promise.resolve(this.result(existing, false));
    }

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (events: ReviewCompletedEvent[], timedOut: boolean) => {
        if (timer) clearTimeout(timer);
        resolve(this.result(events, timedOut));
      };

      const subscription = this.subscribe({
        ...options,
        afterSequence,
        once: true,
        onMatch: () => {
          if (timer) clearTimeout(timer);
        },
        deliver: (events) => {
          finish(events, false);
          return true;
        },
      });
      if (!subscription) {
        finish([], true);
        return;
      }

      options.signal?.addEventListener("abort", () => finish([], true), {
        once: true,
      });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          subscription.close();
          finish([], true);
        }, normalizeTimeoutMs(options.timeoutMs));
      }
      appendSlog("review-events.wait", {
        documentPath: options.documentPath ?? null,
        afterSequence,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  eventsAfter(options: {
    documentPath?: string;
    documentKey?: string;
    afterSequence?: number;
  }): ReviewCompletedEvent[] {
    const probe = {
      key: keyFor(options),
      afterSequence: Math.max(0, options.afterSequence ?? 0),
    };
    return this.events
      .filter((stored) => matches(stored, probe))
      .map((stored) => stored.event);
  }

  waiterCount(): number {
    return this.subscribers.size;
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  peekNextSequence(): number {
    return this.nextSequence;
  }

  private store(stored: StoredEvent): void {
    this.events.push(stored);
    this.events.sort((a, b) => a.event.sequence - b.event.sequence);
    this.events = this.events.slice(-MAX_RETAINED_EVENTS);
    this.nextSequence = Math.max(this.nextSequence, stored.event.sequence + 1);
  }

  private scheduleDelivery(subscriber: Subscriber): Promise<boolean> {
    const confirmation = new Promise<boolean>((resolve) => {
      subscriber.pendingConfirmations.push(resolve);
    });
    if (!subscriber.batchTimer) {
      subscriber.onMatch();
      subscriber.batchTimer = setTimeout(() => {
        void this.deliver(subscriber);
      }, subscriber.batchWindowMs);
    }
    return confirmation;
  }

  private async deliver(subscriber: Subscriber): Promise<void> {
    subscriber.batchTimer = null;
    const confirmations = subscriber.pendingConfirmations.splice(0);
    if (!this.subscribers.has(subscriber)) {
      for (const confirm of confirmations) confirm(false);
      return;
    }

    const events = this.eventsAfter({
      documentKey: subscriber.key ?? undefined,
      afterSequence: subscriber.afterSequence,
    });
    if (subscriber.once) this.remove(subscriber, true);
    const last = events.at(-1);
    if (last) subscriber.afterSequence = last.sequence;

    let delivered = false;
    try {
      delivered = events.length > 0 && (await subscriber.deliver(events));
    } catch {
      delivered = false;
    }
    for (const confirm of confirmations) confirm(delivered);
  }

  private remove(subscriber: Subscriber, keepConfirmations: boolean): void {
    if (!this.subscribers.delete(subscriber)) return;
    subscriber.detachAbort();
    if (keepConfirmations) return;
    if (subscriber.batchTimer) clearTimeout(subscriber.batchTimer);
    subscriber.batchTimer = null;
    for (const confirm of subscriber.pendingConfirmations.splice(0)) {
      confirm(false);
    }
  }

  private result(
    events: ReviewCompletedEvent[],
    timedOut: boolean,
  ): WaitForReviewEventsResult {
    return { events, timedOut, nextSequence: this.nextSequence };
  }
}

export function normalizeTimeoutMs(value: number): number {
  return clamp(value, 0, MAX_TIMEOUT_MS);
}

function keyFor(options: {
  documentPath?: string;
  documentKey?: string;
}): string | null {
  if (options.documentKey) return options.documentKey;
  return options.documentPath ? path.resolve(options.documentPath) : null;
}

function matches(
  stored: StoredEvent,
  subscriber: { key: string | null; afterSequence: number },
): boolean {
  if (stored.event.sequence <= subscriber.afterSequence) return false;
  return subscriber.key === null || subscriber.key === stored.key;
}

async function anyTrue(confirmations: Promise<boolean>[]): Promise<boolean> {
  if (confirmations.length === 0) return false;
  return new Promise((resolve) => {
    let remaining = confirmations.length;
    for (const confirmation of confirmations) {
      void confirmation.then((delivered) => {
        remaining -= 1;
        if (delivered) resolve(true);
        else if (remaining === 0) resolve(false);
      });
    }
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/review-events.ts",
      event,
      data,
    })}\n`,
  );
}
