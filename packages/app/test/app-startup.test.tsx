import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { TooltipProvider } from "../src/components/ui/tooltip";

// Start-up: the first requests a document page makes, and what the page
// shows when they fail (sync review finding on the stuck start page).

type Route = (url: URL) => Response | Promise<Response>;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class EventSourceStub {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

// A server older than batch 2: the socket never opens.
class WebSocketStub {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

let container: HTMLDivElement;
let root: Root;
let routes: Record<string, Route>;
let requests: string[];

function mountRoutes(next: Record<string, Route>) {
  routes = next;
}

async function renderApp() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    );
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

function testId(id: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

const page = {
  id: "plan",
  title: "Plan",
  content: "# Plan\n\nBody.\n",
  version: `1:15:${"a".repeat(64)}`,
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/?path=/work/plan.md&editor=code");
  requests = [];
  vi.stubGlobal("EventSource", EventSourceStub);
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      requests.push(url.pathname);
      const route = routes[url.pathname];
      if (!route) return json({ error: "not found" }, 404);
      return route(url);
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const status: Route = () =>
  json({ backend: "local-files", projectDir: "/work" });

describe("document start-up", () => {
  it("shows which request failed with a Retry button, and Retry recovers", async () => {
    let serverUp = false;
    mountRoutes({
      "/api/status": status,
      "/api/markdown-file": () => {
        if (!serverUp) throw new TypeError("Failed to fetch");
        return json(page);
      },
    });

    await renderApp();
    await flush();

    expect(testId("startup-error-message")?.textContent).toBe(
      "Could not load plan.md: The Roughdraft server did not answer (GET /api/markdown-file): Failed to fetch",
    );
    expect(container.textContent).not.toContain(
      "Could not open that markdown file",
    );

    serverUp = true;
    await act(async () => {
      testId("startup-error-retry")?.click();
    });
    await flush();

    expect(testId("startup-error")).toBeNull();
    expect(testId("document-page-header")?.textContent).toContain("plan.md");
  });

  it("reports a server that is down at start instead of falling back to browser storage", async () => {
    mountRoutes({
      "/api/status": () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await renderApp();
    await flush();

    expect(testId("startup-error-message")?.textContent).toBe(
      "Could not load plan.md: The Roughdraft server did not answer (GET /api/status): Failed to fetch",
    );
  });

  it("retries on its own after 1, 2 and 5 s, then waits for Retry", async () => {
    vi.useFakeTimers();
    mountRoutes({
      "/api/status": status,
      "/api/markdown-file": () => json({ error: "boom" }, 500),
    });
    const attempts = () =>
      requests.filter((path) => path === "/api/markdown-file").length;

    await renderApp();
    await flush();
    expect(attempts()).toBe(1);
    expect(testId("startup-error-message")?.textContent).toContain(
      "The Roughdraft server answered 500 (GET /api/markdown-file): boom",
    );

    for (const [index, delay] of [1_000, 2_000, 5_000].entries()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 10);
      });
      expect(attempts()).toBe(index + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await flush();
      expect(attempts()).toBe(index + 2);
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(attempts()).toBe(4);
    expect(testId("startup-error-retry-status")?.textContent).toBe(
      "Roughdraft stopped retrying on its own.",
    );
    expect(testId("startup-error-retry")).not.toBeNull();
  });

  it("shows File not found for a missing file and opens it once it appears", async () => {
    vi.useFakeTimers();
    let exists = false;
    mountRoutes({
      "/api/status": status,
      "/api/markdown-file": () =>
        exists ? json(page) : json({ error: "Markdown file not found" }, 404),
      "/api/markdown-file/state": () =>
        json({
          exists,
          available: true,
          reason: null,
          version: exists ? page.version : null,
          contentHash: exists ? "a".repeat(64) : null,
          seq: 1,
        }),
    });

    await renderApp();
    await flush();

    expect(testId("startup-file-missing-path")?.textContent).toBe(
      "/work/plan.md",
    );
    expect(testId("startup-file-missing")?.textContent).toContain(
      "File not found at",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();
    expect(testId("startup-file-missing")).not.toBeNull();

    exists = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();

    expect(testId("startup-file-missing")).toBeNull();
    expect(testId("document-page-header")?.textContent).toContain("plan.md");
  });
});
