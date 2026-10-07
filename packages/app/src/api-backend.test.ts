import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiBackend, parseTabServerMessage } from "./api-backend";
import {
  MarkdownFileConflictError,
  MarkdownFileNotFoundError,
  ServerUnreachableError,
  UnsupportedRouteError,
} from "./storage";

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

  it("sends the base version with Done and turns a 409 into a conflict with the server's page", async () => {
    const fetchMock = mockFetch(
      {
        error: "Markdown file changed on disk",
        current: { id: "plan", title: "Plan", content: "New", version: "v9" },
      },
      409,
    );

    const failure = await createBackend()
      .completeReview("plan.md", {
        handoffId: "handoff-1",
        expectedVersion: "v2",
        expectedContentHash: "abc",
      })
      .catch((error: unknown) => error);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      expectedVersion: "v2",
      expectedContentHash: "abc",
    });
    expect(failure).toBeInstanceOf(MarkdownFileConflictError);
    expect((failure as MarkdownFileConflictError).current).toMatchObject({
      content: "New",
      version: "v9",
    });
  });

  it("names the route when the server does not answer", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(
      createBackend().completeReview("plan.md", { handoffId: "handoff-1" }),
    ).rejects.toBeInstanceOf(ServerUnreachableError);
    await expect(createBackend().getMarkdownFile("plan.md")).rejects.toThrow(
      "The Roughdraft server did not answer (GET /api/markdown-file): Failed to fetch",
    );
  });
});

describe("ApiBackend markdown file routes", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the expected content hash and the tab id with a save", async () => {
    const fetchMock = mockFetch({
      id: "plan",
      title: "Plan",
      content: "Body",
      version: "1:4:abc",
      contentHash: "abc",
      seq: 3,
    });

    const page = await createBackend().saveMarkdownFile(
      "plan.md",
      "Body",
      "1:4:old",
      { expectedContentHash: "old", tabId: "tab-1" },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      content: "Body",
      expectedVersion: "1:4:old",
      expectedContentHash: "old",
      tabId: "tab-1",
    });
    expect(page).toMatchObject({ contentHash: "abc", seq: 3 });
  });

  it("reports a missing file as not found", async () => {
    mockFetch({ error: "Markdown file not found" }, 404);

    await expect(
      createBackend().getMarkdownFile("plan.md"),
    ).rejects.toBeInstanceOf(MarkdownFileNotFoundError);
  });

  it("reads the cheap state route", async () => {
    mockFetch({
      exists: false,
      available: true,
      reason: null,
      version: null,
      contentHash: null,
      seq: 4,
      instanceId: "i1",
      tabs: 2,
    });

    await expect(
      createBackend().getMarkdownFileState("plan.md"),
    ).resolves.toEqual({
      exists: false,
      available: true,
      reason: null,
      version: null,
      contentHash: null,
      seq: 4,
      instanceId: "i1",
      tabs: 2,
    });
  });

  it("says the state route is unsupported when an older server answers with the app page", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("<!doctype html><title>Roughdraft</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      createBackend().getMarkdownFileState("plan.md"),
    ).rejects.toBeInstanceOf(UnsupportedRouteError);
  });
});

describe("parseTabServerMessage", () => {
  it("reads hello, change, watchers, handoff, open-request and ping", () => {
    expect(
      parseTabServerMessage({
        type: "hello",
        instanceId: "i1",
        document: {
          seq: 2,
          exists: true,
          available: true,
          reason: null,
          contentHash: "abc",
          version: "1:3:abc",
          stat: { ino: 1 },
        },
        tabs: 1,
        watchers: 2,
        session: null,
        handoff: handoffRecord,
        latestSequence: 3,
      }),
    ).toMatchObject({
      type: "hello",
      watchers: 2,
      document: { contentHash: "abc", seq: 2 },
      handoff: { handoffId: "handoff-1" },
      latestSequence: 3,
    });
    expect(
      parseTabServerMessage({
        type: "change",
        seq: 5,
        exists: true,
        available: true,
        version: "v",
        contentHash: "h",
        origin: "tab",
        tabId: "tab-1",
      }),
    ).toMatchObject({ type: "change", origin: "tab", tabId: "tab-1", seq: 5 });
    expect(parseTabServerMessage({ type: "watchers", count: 1 })).toEqual({
      type: "watchers",
      count: 1,
    });
    expect(
      parseTabServerMessage({ type: "handoff", handoff: handoffRecord }),
    ).toMatchObject({ type: "handoff" });
    expect(
      parseTabServerMessage({ type: "open-request", requestId: "r", url: "/" }),
    ).toEqual({ type: "open-request", requestId: "r", url: "/" });
    expect(parseTabServerMessage({ type: "ping", seq: 9 })).toEqual({
      type: "ping",
      seq: 9,
    });
  });

  it("drops unknown and malformed messages", () => {
    expect(parseTabServerMessage({ type: "future-thing" })).toBeNull();
    expect(parseTabServerMessage({ type: "watchers" })).toBeNull();
    expect(parseTabServerMessage("hello")).toBeNull();
  });
});
