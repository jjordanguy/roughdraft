import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";

const handoffRecord = {
  sequence: 3,
  handoffId: "handoff-1",
  createdAt: "2026-10-05T15:42:00.000Z",
  version: "v2",
  summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
  overallComment: "Tighten the intro.",
  state: "pending",
  deliveredTo: [],
  ackedAt: null,
  ackedBy: null,
  wake: { routeId: null, state: "none", at: null, error: null },
};

function createBackend() {
  return new ApiBackend({
    kind: "local-files",
    label: "Local files",
    detail: "/work",
    projectPath: "/work",
  });
}

function mockFetch(payload: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), { status }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("ApiBackend review handoff", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the client handoff id and returns the handoff fields", async () => {
    const fetchMock = mockFetch(
      {
        delivered: false,
        pending: true,
        event: {},
        handoff: handoffRecord,
        wake: handoffRecord.wake,
        instanceId: "instance-1",
      },
      201,
    );

    const result = await createBackend().completeReview("plan.md", {
      overallComment: "  Tighten the intro.  ",
      handoffId: "handoff-1",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      projectPath: "/work",
      path: "plan.md",
      overallComment: "Tighten the intro.",
      handoffId: "handoff-1",
    });
    expect(result).toEqual({
      delivered: false,
      pending: true,
      handoff: handoffRecord,
      wake: handoffRecord.wake,
    });
  });

  it("treats an older server's answer as neither delivered nor pending", async () => {
    mockFetch({ delivered: false, event: {} }, 201);

    await expect(
      createBackend().completeReview("plan.md", { handoffId: "handoff-1" }),
    ).resolves.toEqual({
      delivered: false,
      pending: false,
      handoff: null,
      wake: null,
    });
  });

  it("throws on a non-2xx answer so the caller keeps its handoff id", async () => {
    mockFetch({ error: "boom" }, 500);

    await expect(
      createBackend().completeReview("plan.md", { handoffId: "handoff-1" }),
    ).rejects.toThrow(/500/);
  });

  it("reads the latest handoff and the registered session from the status poll", async () => {
    const session = {
      harness: "claude-code",
      label: "Plan review chat",
      link: null,
      sessionId: "abc",
      routeId: "claude-code",
      registeredAt: "2026-10-05T15:00:00.000Z",
    };
    mockFetch({
      watching: false,
      watcherCount: 0,
      tabs: 1,
      handoff: { ...handoffRecord, state: "acknowledged" },
      session,
      instanceId: "instance-1",
    });

    await expect(
      createBackend().getReviewWatchStatus("plan.md"),
    ).resolves.toEqual({
      watching: false,
      watcherCount: 0,
      tabs: 1,
      handoff: { ...handoffRecord, state: "acknowledged" },
      session,
    });
  });

  it("ignores malformed handoff and session fields", async () => {
    mockFetch({
      watching: true,
      watcherCount: 1,
      handoff: { handoffId: 4 },
      session: "nope",
    });

    await expect(
      createBackend().getReviewWatchStatus("plan.md"),
    ).resolves.toEqual({
      watching: true,
      watcherCount: 1,
      tabs: undefined,
      handoff: null,
      session: null,
    });
  });
});
