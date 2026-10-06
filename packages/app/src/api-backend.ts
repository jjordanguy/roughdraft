import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type HandoffRecord,
  type RoundFlag,
  type HandoffWake,
  MarkdownFileConflictError,
  MarkdownFileNotFoundError,
  type MarkdownFileState,
  type Page,
  type SaveMarkdownFileOptions,
  ServerResponseError,
  ServerUnreachableError,
  type SessionRecord,
  type StorageBackend,
  type StoredAsset,
  type TabChannel,
  type TabChannelHandlers,
  type TabServerMessage,
  UnsupportedRouteError,
} from "./storage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandoffWake(value: unknown): HandoffWake | null {
  if (!isRecord(value)) return null;
  if (
    value.state !== "none" &&
    value.state !== "sent" &&
    value.state !== "failed"
  ) {
    return null;
  }
  return {
    routeId: typeof value.routeId === "string" ? value.routeId : null,
    state: value.state,
    at: typeof value.at === "string" ? value.at : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

// The server is the source of truth for these records; the app only checks
// the fields it reads so a malformed answer degrades to "no record".
function parseHandoffRecord(value: unknown): HandoffRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.handoffId !== "string" || typeof value.state !== "string") {
    return null;
  }
  return value as unknown as HandoffRecord;
}

export function parseRoundFlag(value: unknown): RoundFlag | null {
  if (!isRecord(value) || typeof value.roundId !== "string") return null;
  if (
    value.state !== "open" &&
    value.state !== "stalled" &&
    value.state !== "closed"
  ) {
    return null;
  }
  return {
    roundId: value.roundId,
    state: value.state,
    openedAt: optionalString(value.openedAt) ?? "",
    updatedAt: optionalString(value.updatedAt),
    stalledAt: optionalString(value.stalledAt),
    closedAt: optionalString(value.closedAt),
  };
}

function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  return value as unknown as SessionRecord;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMarkdownFileState(
  value: unknown,
): MarkdownFileState | null {
  if (!isRecord(value) || typeof value.exists !== "boolean") return null;
  return {
    exists: value.exists,
    available: value.available !== false,
    reason: optionalString(value.reason),
    version: optionalString(value.version),
    contentHash: optionalString(value.contentHash),
    seq: optionalNumber(value.seq) ?? 0,
    ...(typeof value.instanceId === "string"
      ? { instanceId: value.instanceId }
      : {}),
    ...(typeof value.tabs === "number" ? { tabs: value.tabs } : {}),
  };
}

// One JSON object per message. Unknown or malformed messages become null so
// a newer server cannot break an older tab.
export function parseTabServerMessage(value: unknown): TabServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "hello": {
      const document = parseMarkdownFileState(value.document);
      if (!document) return null;
      return {
        type: "hello",
        instanceId: optionalString(value.instanceId) ?? "",
        document,
        tabs: optionalNumber(value.tabs) ?? 0,
        watchers: optionalNumber(value.watchers) ?? 0,
        session: parseSessionRecord(value.session),
        handoff: parseHandoffRecord(value.handoff),
        latestSequence: optionalNumber(value.latestSequence),
        round: parseRoundFlag(value.round),
      };
    }
    case "change": {
      const state = parseMarkdownFileState(value);
      if (!state) return null;
      const origin =
        value.origin === "tab" || value.origin === "outside"
          ? value.origin
          : "unknown";
      return {
        type: "change",
        seq: state.seq,
        exists: state.exists,
        available: state.available,
        reason: state.reason ?? null,
        version: state.version,
        contentHash: state.contentHash,
        origin,
        ...(typeof value.tabId === "string" ? { tabId: value.tabId } : {}),
      };
    }
    case "watchers": {
      const count = optionalNumber(value.count);
      return count === null ? null : { type: "watchers", count };
    }
    case "handoff": {
      const handoff = parseHandoffRecord(value.handoff);
      return handoff ? { type: "handoff", handoff } : null;
    }
    case "round": {
      const round = parseRoundFlag(value.round);
      return round ? { type: "round", round } : null;
    }
    case "open-request": {
      if (typeof value.url !== "string") return null;
      return {
        type: "open-request",
        requestId: optionalString(value.requestId) ?? "",
        url: value.url,
      };
    }
    case "ping":
      return { type: "ping", seq: optionalNumber(value.seq) ?? 0 };
    default:
      return null;
  }
}

function parsePage(value: unknown, fallbackId: string): Page {
  const record = isRecord(value) ? value : {};
  return {
    id: typeof record.id === "string" ? record.id : fallbackId,
    title: typeof record.title === "string" ? record.title : fallbackId,
    content: typeof record.content === "string" ? record.content : "",
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.contentHash === "string"
      ? { contentHash: record.contentHash }
      : {}),
    ...(typeof record.seq === "number" ? { seq: record.seq } : {}),
    ...(typeof record.instanceId === "string"
      ? { instanceId: record.instanceId }
      : {}),
  };
}

async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const payload = (await res.clone().json()) as unknown;
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

export class ApiBackend implements StorageBackend {
  info: BackendInfo;
  canManageProjects = true;

  constructor(info: BackendInfo) {
    this.info = info;
  }

  private updateProjectInfo(projectPath?: string): void {
    this.info = {
      ...this.info,
      detail: projectPath || "Markdown file on disk",
      projectPath,
    };
  }

  private buildUrl(route: string, params?: Record<string, string>): string {
    const url = new URL(route, window.location.origin);
    const projectPath = this.info.projectPath?.trim();

    if (projectPath) {
      url.searchParams.set("projectPath", projectPath);
    }

    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return `${url.pathname}${url.search}`;
  }

  // fetch rejects only when no answer arrived; name the route in the error so
  // the start-up screen and the handoff can say what failed.
  private async request(
    route: string,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new ServerUnreachableError(route, error);
    }
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    const route = "GET /api/markdown-file";
    const res = await this.request(
      route,
      this.buildUrl("/api/markdown-file", { path: relativePath }),
    );
    if (res.status === 404) {
      throw new MarkdownFileNotFoundError(
        relativePath,
        (await readErrorDetail(res)) ?? `File not found: ${relativePath}`,
      );
    }
    if (!res.ok) {
      throw new ServerResponseError(
        route,
        res.status,
        await readErrorDetail(res),
      );
    }
    return parsePage(await res.json(), relativePath);
  }

  async getMarkdownFileState(relativePath: string): Promise<MarkdownFileState> {
    const route = "GET /api/markdown-file/state";
    const res = await this.request(
      route,
      this.buildUrl("/api/markdown-file/state", { path: relativePath }),
    );
    let payload: unknown = null;
    try {
      payload = await res.clone().json();
    } catch {
      // A server without this route answers with the app's HTML or a 404.
    }
    const state = parseMarkdownFileState(payload);
    if (res.ok && state) return state;
    if (!state && (res.ok || res.status === 404)) {
      throw new UnsupportedRouteError(route);
    }
    throw new ServerResponseError(
      route,
      res.status,
      await readErrorDetail(res),
    );
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
    options: SaveMarkdownFileOptions = {},
  ): Promise<Page> {
    const route = "PUT /api/markdown-file";
    const res = await this.request(
      route,
      this.buildUrl("/api/markdown-file", { path: relativePath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          expectedVersion,
          ...(options.expectedContentHash
            ? { expectedContentHash: options.expectedContentHash }
            : {}),
          ...(options.tabId ? { tabId: options.tabId } : {}),
          projectPath: this.info.projectPath,
        }),
      },
    );
    if (res.status === 409) {
      const payload = (await res.json().catch(() => ({}))) as {
        current?: unknown;
      };
      if (payload.current) {
        throw new MarkdownFileConflictError(
          parsePage(payload.current, relativePath),
        );
      }
    }
    if (res.status === 404) {
      throw new MarkdownFileNotFoundError(
        relativePath,
        (await readErrorDetail(res)) ?? `File not found: ${relativePath}`,
      );
    }
    if (!res.ok) {
      throw new ServerResponseError(
        route,
        res.status,
        await readErrorDetail(res),
      );
    }
    return parsePage(await res.json(), relativePath);
  }

  openTabChannel(
    relativePath: string,
    tabId: string,
    handlers: TabChannelHandlers,
  ): TabChannel {
    const url = new URL(
      this.buildUrl("/api/tab", { path: relativePath, tabId }),
      window.location.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(url.toString());
    } catch (error) {
      console.error("Could not open the Roughdraft tab channel:", error);
      queueMicrotask(() => handlers.onClose());
    }

    if (socket) {
      socket.onopen = () => handlers.onOpen();
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        for (const line of event.data.split("\n")) {
          if (!line.trim()) continue;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            continue;
          }
          const message = parseTabServerMessage(raw);
          if (message) handlers.onMessage(message);
        }
      };
      // An error is always followed by close, which drives the reconnect.
      socket.onerror = () => {};
      socket.onclose = () => handlers.onClose();
    }

    return {
      send(message) {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      close() {
        if (!socket) return;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        socket = null;
      },
    };
  }

  async completeReview(
    relativePath: string,
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    const route = "POST /api/review-events";
    const overallComment = options.overallComment?.trim();
    const res = await this.request(
      route,
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          ...(overallComment ? { overallComment } : {}),
          ...(options.handoffId ? { handoffId: options.handoffId } : {}),
          ...(options.expectedVersion
            ? { expectedVersion: options.expectedVersion }
            : {}),
          ...(options.expectedContentHash
            ? { expectedContentHash: options.expectedContentHash }
            : {}),
        }),
      },
    );

    if (res.status === 409) {
      const payload = (await res.json().catch(() => ({}))) as {
        current?: unknown;
      };
      if (payload.current) {
        throw new MarkdownFileConflictError(
          parsePage(payload.current, relativePath),
        );
      }
    }

    if (!res.ok) {
      throw new ServerResponseError(
        route,
        res.status,
        await readErrorDetail(res),
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const handoff = parseHandoffRecord(payload.handoff);
    return {
      delivered: payload.delivered === true,
      pending: payload.pending === true,
      handoff,
      wake: parseHandoffWake(payload.wake) ?? handoff?.wake ?? null,
    };
  }

  async saveAsset(file: File): Promise<StoredAsset> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) continue;
      binary += String.fromCharCode(byte);
    }

    const res = await fetch(this.buildUrl("/api/assets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: btoa(binary),
        projectPath: this.info.projectPath,
      }),
    });

    if (!res.ok) throw new Error(`Failed to save asset: ${res.status}`);
    return res.json();
  }

  resolveFileUrl(path: string): string | null {
    const normalized = path.replace(/^\.?\//, "");
    return this.buildUrl("/api/files", { path: normalized });
  }

  async openProject(path: string): Promise<void> {
    this.updateProjectInfo(path);
  }
}
