import { createClientId } from "./review-handoff";

export const OPEN_REQUEST_TAB_ID_KEY = "roughdraft.tabId";

interface TabIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readSessionStorage(): TabIdStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    // Accessing sessionStorage throws when the browser blocks storage.
    return undefined;
  }
}

// sessionStorage survives reloads and same-tab navigation but not a new tab,
// which is exactly the identity the server needs to address one window.
export function getOrCreateTabId(storage: TabIdStorage | undefined): string {
  try {
    const existing = storage?.getItem(OPEN_REQUEST_TAB_ID_KEY);
    if (existing) return existing;
  } catch {
    // Storage can throw when the browser blocks it; fall through.
  }

  const tabId = createClientId();
  try {
    storage?.setItem(OPEN_REQUEST_TAB_ID_KEY, tabId);
  } catch {
    // An unsaved id still works for this page load.
  }
  return tabId;
}

export function buildOpenRequestsUrl(
  rawPath: string | null,
  tabId: string,
): string {
  const params = new URLSearchParams();
  if (rawPath) params.set("path", rawPath);
  params.set("tabId", tabId);
  return `/api/open-requests?${params.toString()}`;
}

export async function acknowledgeOpenRequest(requestId: string): Promise<void> {
  try {
    await fetch("/api/open-request/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      // The tab may navigate right after this; keepalive lets the ack finish.
      keepalive: true,
    });
  } catch (error) {
    console.error("Failed to acknowledge Roughdraft open request:", error);
  }
}

export function handleOpenRequestEvent(
  data: string,
  {
    currentHref,
    focus,
    acknowledge,
    navigate,
  }: {
    currentHref: string;
    focus: () => void;
    acknowledge: (requestId: string) => void;
    navigate: (href: string) => void;
  },
): void {
  let payload: { url?: unknown; requestId?: unknown };
  try {
    payload = JSON.parse(data) as { url?: unknown; requestId?: unknown };
  } catch (error) {
    console.error("Failed to read Roughdraft open request:", error);
    return;
  }

  if (typeof payload.url !== "string" || !payload.url.trim()) return;

  const nextUrl = new URL(payload.url, currentHref);
  focus();
  // Acknowledge before navigating: the server waits up to a second for this
  // tab to confirm before it opens a new window instead.
  if (typeof payload.requestId === "string" && payload.requestId) {
    acknowledge(payload.requestId);
  }
  if (nextUrl.href !== new URL(currentHref).href) {
    navigate(nextUrl.href);
  }
}
