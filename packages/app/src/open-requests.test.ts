import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeOpenRequest,
  buildOpenRequestsUrl,
  getOrCreateTabId,
  handleOpenRequestEvent,
  OPEN_REQUEST_TAB_ID_KEY,
} from "./open-requests";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("getOrCreateTabId", () => {
  it("keeps one tab id per tab across reloads", () => {
    const storage = memoryStorage();

    const first = getOrCreateTabId(storage);
    const second = getOrCreateTabId(storage);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(storage.getItem(OPEN_REQUEST_TAB_ID_KEY)).toBe(first);
  });

  it("still returns an id when session storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(getOrCreateTabId(storage)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("buildOpenRequestsUrl", () => {
  it("sends the document path and the tab id", () => {
    expect(buildOpenRequestsUrl("/work/plan one.md", "tab-1")).toBe(
      "/api/open-requests?path=%2Fwork%2Fplan+one.md&tabId=tab-1",
    );
    expect(buildOpenRequestsUrl(null, "tab-1")).toBe(
      "/api/open-requests?tabId=tab-1",
    );
  });
});

describe("handleOpenRequestEvent", () => {
  function deps(currentHref = "http://127.0.0.1:7373/?path=%2Fwork%2Fplan.md") {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        currentHref,
        focus: () => calls.push("focus"),
        acknowledge: (requestId: string) => calls.push(`ack:${requestId}`),
        navigate: (href: string) => calls.push(`navigate:${href}`),
      },
    };
  }

  it("focuses and acknowledges without navigating when the URL matches", () => {
    const { calls, deps: handlers } = deps();

    handleOpenRequestEvent(
      JSON.stringify({
        requestId: "req-1",
        path: "/work/plan.md",
        url: "http://127.0.0.1:7373/?path=%2Fwork%2Fplan.md",
      }),
      handlers,
    );

    expect(calls).toEqual(["focus", "ack:req-1"]);
  });

  it("acknowledges before navigating so the ack is not cancelled by the unload", () => {
    const { calls, deps: handlers } = deps();

    handleOpenRequestEvent(
      JSON.stringify({
        requestId: "req-2",
        url: "http://127.0.0.1:7373/?path=%2Fwork%2Fplan.md&editor=code",
      }),
      handlers,
    );

    expect(calls).toEqual([
      "focus",
      "ack:req-2",
      "navigate:http://127.0.0.1:7373/?path=%2Fwork%2Fplan.md&editor=code",
    ]);
  });

  it("still focuses for an older server that sends no request id", () => {
    const { calls, deps: handlers } = deps();

    handleOpenRequestEvent(
      JSON.stringify({ url: "http://127.0.0.1:7373/?path=%2Fwork%2Fplan.md" }),
      handlers,
    );

    expect(calls).toEqual(["focus"]);
  });

  it("ignores events without a URL", () => {
    const { calls, deps: handlers } = deps();

    handleOpenRequestEvent(JSON.stringify({ requestId: "req-3" }), handlers);
    handleOpenRequestEvent("not json", handlers);

    expect(calls).toEqual([]);
  });
});

describe("acknowledgeOpenRequest", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the request id with keepalive", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await acknowledgeOpenRequest("req-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/open-request/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1" }),
      keepalive: true,
    });
  });

  it("swallows a failed ack", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await expect(acknowledgeOpenRequest("req-1")).resolves.toBeUndefined();
  });
});
