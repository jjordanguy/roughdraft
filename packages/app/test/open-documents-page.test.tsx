import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { TooltipProvider } from "../src/components/ui/tooltip";

// The root address renders the open documents list from /api/documents and
// /api/status. The e2e suite drives it against a real server; this covers
// what the e2e server does not set up: the peer link and a server that is
// down.

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let container: HTMLDivElement;
let root: Root;
let documentsAnswer: () => Response;

const documents = [
  {
    key: "/work/plan.md",
    documentPath: "/work/plan.md",
    projectPath: "/work",
    relativePath: "plan.md",
    title: "Fork plan",
    tabs: 1,
    tabsDirty: 1,
    session: {
      harness: "claude-code",
      label: "Fork Roughdraft",
      link: "https://claude.ai/code/session_1",
      sessionId: "s1",
      routeId: null,
      registeredAt: "2026-10-06T08:00:00.000Z",
    },
    lastSession: null,
    sessionState: "live",
    closedAt: null,
    sweptAt: null,
    handoffs: [],
    latestHandoff: null,
    lastActivityAt: "2026-10-06T09:00:00.000Z",
    firstSeenAt: "2026-10-06T08:00:00.000Z",
  },
];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

function testId(id: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/");
  documentsAnswer = () => json({ documents });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/status") {
        return json({
          backend: "local-files",
          peerUrl: "http://100.101.102.103:7373/",
        });
      }
      if (url.pathname === "/api/documents") return documentsAnswer();
      return json({ error: "not found" }, 404);
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderApp() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    );
  });
  await flush();
}

describe("open documents page", () => {
  it("lists the documents by session with the peer link, and keeps a dirty one open", async () => {
    await renderApp();

    expect(document.title).toBe("Open documents");
    expect(testId("open-documents-count")?.textContent).toBe(
      "1 session, 1 window",
    );
    const peer = testId("open-documents-peer-link");
    expect(peer?.textContent).toContain(
      "Open documents on 100.101.102.103:7373",
    );
    expect(peer?.getAttribute("href")).toBe("http://100.101.102.103:7373/");

    const group = testId("open-documents-group");
    expect(group?.getAttribute("aria-label")).toBe(
      "Claude Code session: Fork Roughdraft",
    );
    expect(
      group?.querySelector('a[href="https://claude.ai/code/session_1"]')
        ?.textContent,
    ).toBe("Fork Roughdraft");
    const row = testId("open-document-row");
    expect(row?.getAttribute("aria-label")).toBe("Fork plan, plan.md · /work");
    expect(testId("open-document-status")?.textContent).toContain(
      "unsaved text in a window",
    );
    const close = testId("open-document-close") as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.getAttribute("aria-label")).toBe("Close Fork plan");
  });

  it("says when the server does not answer", async () => {
    documentsAnswer = () => json({ error: "down" }, 503);
    await renderApp();
    expect(testId("open-documents-error")?.textContent).toContain(
      "Could not reach the Roughdraft server",
    );
  });
});
