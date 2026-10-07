import { describe, expect, it } from "vitest";
import {
  createClientId,
  getReviewHandoffView,
  type ReviewHandoffViewInput,
} from "./review-handoff";
import type { HandoffRecord, HandoffWake } from "./storage";

const formatTime = (iso: string) => `time(${iso})`;

function wake(overrides: Partial<HandoffWake> = {}): HandoffWake {
  return { routeId: null, state: "none", at: null, error: null, ...overrides };
}

function handoff(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    sequence: 7,
    handoffId: "handoff-1",
    createdAt: "2026-10-05T15:42:00.000Z",
    version: "v2",
    summary: { comments: 2, replies: 0, suggestions: 1, unresolved: 3 },
    overallComment: null,
    state: "pending",
    deliveredTo: [],
    ackedAt: null,
    ackedBy: null,
    wake: wake(),
    ...overrides,
  };
}

function input(
  overrides: Partial<ReviewHandoffViewInput> = {},
): ReviewHandoffViewInput {
  return {
    enabled: true,
    watcherCount: 0,
    diskState: "clean",
    saveState: "saved",
    phase: "idle",
    result: null,
    handoff: null,
    sessionLabel: null,
    documentChangedSinceOpen: false,
    sentTitle: "Nice one!",
    formatTime,
    ...overrides,
  };
}

describe("getReviewHandoffView", () => {
  it.each([
    {
      row: "hidden when no local-files document is loaded",
      given: input({ enabled: false, watcherCount: 1 }),
      expected: { kind: "hidden" },
    },
    {
      row: "ready with an agent listening",
      given: input({ watcherCount: 1 }),
      expected: {
        kind: "ready-listening",
        buttonLabel: "Approve",
        buttonDisabled: false,
        triggerDisabled: false,
        watcherState: "listening",
        agentStatusText: "Your agent is waiting",
        blockedReason: null,
      },
    },
    {
      row: "ready with no agent",
      given: input({ watcherCount: 0, documentChangedSinceOpen: true }),
      expected: {
        kind: "ready-no-agent",
        buttonLabel: "I'm done",
        buttonDisabled: false,
        triggerDisabled: false,
        watcherState: "none",
        agentStatusText:
          "No agent is listening. Roughdraft keeps your Done until it checks in.",
      },
    },
    {
      row: "ready while a debounced save is pending",
      given: input({ watcherCount: 1, saveState: "unsaved" }),
      expected: { kind: "ready-listening", buttonDisabled: false },
    },
    {
      row: "blocked by one overlap with disk",
      given: input({
        watcherCount: 1,
        diskState: "conflict",
        conflictCount: 1,
      }),
      expected: {
        kind: "blocked",
        buttonLabel: "Resolve 1 overlap first",
        buttonDisabled: true,
        triggerDisabled: true,
        dimmed: true,
        blockedReason:
          "Resolve 1 overlap first: your edit overlaps a change on disk.",
      },
    },
    {
      row: "blocked by several overlaps with disk",
      given: input({ diskState: "conflict", conflictCount: 3 }),
      expected: {
        kind: "blocked",
        buttonLabel: "Resolve 3 overlaps first",
        buttonDisabled: true,
      },
    },
    {
      row: "blocked while the file is unavailable",
      given: input({ diskState: "unavailable" }),
      expected: {
        kind: "blocked",
        buttonDisabled: true,
        blockedReason:
          "The file is not available on disk. Roughdraft can finish when it is back.",
      },
    },
    {
      row: "blocked by a save error",
      given: input({ saveState: "error" }),
      expected: {
        kind: "blocked",
        buttonDisabled: true,
        blockedReason:
          "Your last save failed. Roughdraft cannot finish until it saves.",
      },
    },
    {
      row: "sending",
      given: input({ phase: "sending", watcherCount: 1 }),
      expected: {
        kind: "sending",
        buttonLabel: "Sending",
        buttonDisabled: true,
        triggerDisabled: true,
        icon: "spinner",
        title: "Sending your review",
        showCopyMessage: false,
        showRetry: false,
      },
    },
    {
      row: "sent to a live watcher",
      given: input({
        phase: "completed",
        result: {
          delivered: true,
          pending: false,
          handoff: handoff({ state: "delivered" }),
          wake: wake(),
        },
        handoff: handoff({ state: "delivered" }),
      }),
      expected: {
        kind: "sent",
        buttonLabel: "Sent",
        buttonDisabled: false,
        triggerDisabled: true,
        dimmed: true,
        title: "Nice one!",
        showCopyMessage: true,
        showRetry: false,
      },
    },
    {
      row: "saved for agent with no wake route",
      given: input({
        phase: "completed",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff(),
          wake: wake(),
        },
        handoff: handoff(),
      }),
      expected: {
        kind: "saved-for-agent",
        buttonLabel: "Done, waiting",
        buttonDisabled: false,
        icon: "check",
        title: "Saved for your agent",
        body: "Your agent is not listening right now. Tell it you're done, or copy this message.",
        wakeLine: "No wake route registered",
        showCopyMessage: true,
        showRetry: false,
      },
    },
    {
      row: "saved for agent while the wake route runs",
      given: input({
        phase: "completed",
        sessionLabel: "Plan review chat",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff({ wake: wake({ routeId: "claude-code" }) }),
          wake: wake({ routeId: "claude-code" }),
        },
        handoff: handoff({ wake: wake({ routeId: "claude-code" }) }),
      }),
      expected: {
        kind: "saved-for-agent",
        wakeLine: "Waking Plan review chat",
      },
    },
    {
      row: "saved for agent after the wake route sent",
      given: input({
        phase: "completed",
        sessionLabel: "Plan review chat",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff({ wake: wake({ routeId: "claude-code" }) }),
          wake: wake({ routeId: "claude-code" }),
        },
        handoff: handoff({
          wake: wake({
            routeId: "claude-code",
            state: "sent",
            at: "2026-10-05T15:42:01.000Z",
          }),
        }),
      }),
      expected: {
        kind: "sent",
        buttonLabel: "Sent",
        icon: "check",
        title: "Sent to Plan review chat",
        body: "Your agent will start a round on your comments; the AI editing badge shows when it does.",
        wakeLine: "Sent to Plan review chat",
        showCopyMessage: false,
      },
    },
    {
      row: "saved for agent with no session label after the wake route sent",
      given: input({
        phase: "completed",
        result: {
          delivered: false,
          pending: true,
          handoff: null,
          wake: wake({ routeId: "claude-code", state: "sent" }),
        },
        handoff: null,
      }),
      expected: {
        kind: "sent",
        title: "Sent to your agent's session",
        wakeLine: "Sent to your agent's session",
      },
    },
    {
      row: "saved for agent after the wake route failed",
      given: input({
        phase: "completed",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff(),
          wake: wake(),
        },
        handoff: handoff({
          wake: wake({
            routeId: "claude-code",
            state: "failed",
            error: "exit code 1",
          }),
        }),
      }),
      expected: {
        kind: "saved-for-agent",
        wakeLine: "Wake failed: exit code 1",
        showCopyMessage: true,
      },
    },
    {
      row: "not received by a server that keeps no handoff log",
      given: input({
        phase: "completed",
        result: { delivered: false, pending: false, handoff: null, wake: null },
      }),
      expected: {
        kind: "not-received",
        buttonLabel: "Not sent",
        icon: "alert",
        title: "No agent received this",
        wakeLine: null,
        showCopyMessage: true,
      },
    },
    {
      row: "picked up after the agent acknowledged a saved Done",
      given: input({
        phase: "completed",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff(),
          wake: wake(),
        },
        handoff: handoff({
          state: "acknowledged",
          ackedAt: "2026-10-05T15:45:00.000Z",
        }),
      }),
      expected: {
        kind: "picked-up",
        buttonLabel: "Picked up",
        buttonDisabled: false,
        icon: "check",
        title: "Your agent picked this up at time(2026-10-05T15:45:00.000Z).",
        showCopyMessage: false,
      },
    },
    {
      row: "picked up after the agent acknowledged a delivered Done",
      given: input({
        phase: "completed",
        result: {
          delivered: true,
          pending: false,
          handoff: handoff({ state: "delivered" }),
          wake: wake(),
        },
        handoff: handoff({
          state: "acknowledged",
          ackedAt: "2026-10-05T15:45:00.000Z",
        }),
      }),
      expected: { kind: "picked-up", buttonLabel: "Picked up" },
    },
    {
      row: "dropped from the open documents list",
      given: input({
        phase: "completed",
        result: {
          delivered: false,
          pending: true,
          handoff: handoff(),
          wake: wake(),
        },
        handoff: handoff({
          state: "dropped",
          droppedAt: "2026-10-05T15:50:00.000Z",
        }),
      }),
      expected: {
        kind: "picked-up",
        buttonLabel: "Dropped",
        title: "You dropped this Done from the open documents list.",
        showCopyMessage: false,
      },
    },
    {
      row: "error",
      given: input({ phase: "error", watcherCount: 1 }),
      expected: {
        kind: "error",
        buttonLabel: "Not sent",
        buttonDisabled: false,
        triggerDisabled: true,
        icon: "alert",
        title: "Done not recorded",
        body: "Roughdraft could not record your Done. Your saved edits are on disk.",
        showCopyMessage: true,
        showRetry: true,
        retryDisabled: false,
      },
    },
    {
      row: "error while the file is blocked keeps Retry disabled",
      given: input({ phase: "error", diskState: "conflict" }),
      expected: { kind: "error", showRetry: true, retryDisabled: true },
    },
  ])("$row", ({ given, expected }) => {
    expect(getReviewHandoffView(given)).toMatchObject(expected);
  });

  it("shows the session label in ready states when a session is registered", () => {
    expect(
      getReviewHandoffView(input({ sessionLabel: "Plan review chat" })),
    ).toMatchObject({ sessionText: "Opened by Plan review chat" });
    expect(getReviewHandoffView(input())).toMatchObject({ sessionText: null });
  });
});

describe("createClientId", () => {
  it("returns distinct UUID-shaped ids", () => {
    const first = createClientId();
    const second = createClientId();

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });

  it("works without crypto.randomUUID, which insecure origins lack", () => {
    const cryptoWithoutUuid = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T) =>
        globalThis.crypto.getRandomValues(array as Uint8Array) as T,
    } as Crypto;

    expect(createClientId(cryptoWithoutUuid)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
