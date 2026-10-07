import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewEventQueue } from "./review-events";

function eventInput(documentPath = "/tmp/project/draft.md") {
  return {
    documentPath,
    projectPath: path.dirname(documentPath),
    relativePath: path.basename(documentPath),
    version: "v1",
    summary: {
      comments: 1,
      replies: 0,
      suggestions: 1,
      unresolved: 2,
    },
  };
}

describe("ReviewEventQueue", () => {
  it("queues events in creation order", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/a.md"));
    queue.emit(eventInput("/tmp/project/b.md"));

    const result = await queue.wait({ timeoutMs: 0 });

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("resolves a waiting watcher when a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 10,
    });

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("returns overall comments with delivered events", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 0,
    });

    queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Please prioritize the CLI contract.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
    vi.useRealTimers();
  });

  it("keeps events without overall comments unchanged", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/draft.md"));

    const result = await queue.wait();
    expect(result.events[0]).not.toHaveProperty("overallComment");
  });

  it("keeps a watcher active without a timeout until a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(queue.waiterCount()).toBe(1);

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    vi.useRealTimers();
  });

  it("ignores unrelated document paths", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 0,
    });

    const emitted = queue.emit(eventInput("/tmp/project/other.md"));
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({
      timedOut: true,
      events: [],
    });
    expect(emitted.delivered).toBe(false);
    vi.useRealTimers();
  });

  it("batches events during the batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({ timeoutMs: 1_000, batchWindowMs: 50 });

    queue.emit(eventInput("/tmp/project/a.md"));
    await vi.advanceTimersByTimeAsync(25);
    queue.emit(eventInput("/tmp/project/b.md"));
    await vi.advanceTimersByTimeAsync(25);

    const result = await waiting;

    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    vi.useRealTimers();
  });

  it("does not time out after a matching event arrives during a longer batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 200,
    });

    await vi.advanceTimersByTimeAsync(50);
    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("prunes retained events deterministically", async () => {
    const queue = new ReviewEventQueue();

    for (let index = 0; index < 105; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();

    expect(result.events).toHaveLength(100);
    expect(result.events[0]?.sequence).toBe(6);
    expect(result.events.at(-1)?.sequence).toBe(105);
  });

  it("keeps a six hour watch pending past five minutes and resolves at six hours", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    let settled = false;
    const waiting = queue
      .wait({ documentPath: "/tmp/project/draft.md", timeoutMs: 6 * 3_600_000 })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(301_000);
    expect(settled).toBe(false);
    expect(queue.waiterCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    await expect(waiting).resolves.toMatchObject({ timedOut: true });
    vi.useRealTimers();
  });

  it("caps a timeout of 2^31 ms instead of letting setTimeout fire at once", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    let settled = false;
    void queue
      .wait({ documentPath: "/tmp/project/draft.md", timeoutMs: 2 ** 31 })
      .then(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    vi.useRealTimers();
  });

  it("removes an aborted waiter and leaves the others in place", async () => {
    const queue = new ReviewEventQueue();
    const controller = new AbortController();
    const aborted = queue.wait({
      documentPath: "/tmp/project/draft.md",
      signal: controller.signal,
    });
    const other = queue.wait({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
    });
    expect(queue.waiterCount()).toBe(2);

    controller.abort();

    await expect(aborted).resolves.toMatchObject({ events: [] });
    expect(queue.waiterCount()).toBe(1);
    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await expect(other).resolves.toMatchObject({ events: [emitted.event] });
    await expect(emitted.delivery).resolves.toBe(true);
  });

  it("never registers a waiter whose signal is already aborted", async () => {
    const queue = new ReviewEventQueue();
    const controller = new AbortController();
    controller.abort();

    await queue.wait({
      documentPath: "/tmp/project/draft.md",
      signal: controller.signal,
    });

    expect(queue.waiterCount()).toBe(0);
  });

  it("reports no delivery when the only subscriber fails to deliver", async () => {
    const queue = new ReviewEventQueue();
    queue.subscribe({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
      deliver: () => false,
    });

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));

    await expect(emitted.delivery).resolves.toBe(false);
  });

  it("continues sequences from a seeded queue and replays seeded events by key", async () => {
    const seeded = {
      ...eventInput("/private/tmp/project/draft.md"),
      type: "review.completed" as const,
      sequence: 41,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const queue = new ReviewEventQueue({
      nextSequence: 42,
      seed: [{ event: seeded, documentKey: "/private/tmp/project/draft.md" }],
    });

    const replay = await queue.wait({
      documentKey: "/private/tmp/project/draft.md",
      afterSequence: 40,
    });
    const next = queue.emit(eventInput("/tmp/project/draft.md"), {
      documentKey: "/private/tmp/project/draft.md",
    });

    expect(replay.events.map((event) => event.sequence)).toEqual([41]);
    expect(next.event.sequence).toBe(42);
    expect(queue.latestSequence()).toBe(42);
  });
});
