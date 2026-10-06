import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type {
  DocumentChange,
  DocumentState,
  DocumentWatcher,
} from "./document-watcher.js";
import type {
  DocumentIdentity,
  HandoffRecord,
  ReviewLog,
} from "./handoff-log.js";
import type { DocumentRegistry } from "./registry.js";

/**
 * One WebSocket per tab: `GET /api/tab?projectPath=&path=&tabId=`.
 *
 * WebSockets sit outside Chrome's six-connections-per-host pool, so any
 * number of review windows can stay connected. Messages are JSON objects
 * `{ type, ... }`. The first message on every connection is `hello` with the
 * current document state, so a tab catches up after any gap by reconnecting.
 */

export const TAB_CHANNEL_PATH = "/api/tab";
export const TAB_PING_MS = 15_000;
/** Protocol pings a socket may miss before it is terminated. */
const MISSED_PINGS_ALLOWED = 2;

export interface TabTarget {
  absolutePath: string;
  identity: DocumentIdentity;
}

export type TargetResult =
  | { ok: true; target: TabTarget }
  | { ok: false; status: number; error: string };

export interface TabChannelOptions {
  watcher: DocumentWatcher;
  registry: DocumentRegistry;
  log: ReviewLog;
  instanceId: string;
  latestSequence: () => number;
  /** Validates `projectPath` and `path`; a missing file is allowed. */
  resolveTarget: (url: URL) => TargetResult;
  /** Token check for gated servers. */
  authorize: (req: IncomingMessage, url: URL) => boolean;
  acknowledgeOpenRequest: (requestId: string) => void;
  pingMs?: number;
}

interface TabClient {
  socket: WebSocket;
  tabId: string;
  key: string;
  absolutePath: string;
  visible: boolean;
  connectedAt: number;
  /** True once `hello` went out. */
  ready: boolean;
  lastWatchers: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A browser on another site can open a WebSocket to localhost (CORS does not
 * apply). Allow no Origin (CLI, tests), any loopback origin (the app itself,
 * a Vite dev server on another port), or the same host as the request.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (LOOPBACK_HOSTS.has(url.hostname)) return true;
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export class TabChannel {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<string, Set<TabClient>>();
  private readonly options: TabChannelOptions;
  private readonly pingMs: number;
  private readonly servers = new WeakSet<Server>();

  constructor(options: TabChannelOptions) {
    this.options = options;
    this.pingMs = options.pingMs ?? TAB_PING_MS;
    options.registry.onChange((key, change) => {
      if (change === "watchers") this.sendWatchers(key);
    });
  }

  attach(server: Server): void {
    if (this.servers.has(server)) return;
    this.servers.add(server);
    server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head),
    );
  }

  /** Live tab ids on the channel for one document. */
  tabIds(key: string): string[] {
    return [...(this.clients.get(key) ?? [])]
      .filter((client) => client.ready)
      .map((client) => client.tabId);
  }

  broadcastHandoff(key: string, handoff: HandoffRecord): void {
    for (const client of this.clients.get(key) ?? []) {
      if (client.ready) this.send(client, { type: "handoff", handoff });
    }
  }

  /**
   * Sends an open request to one tab on the document, preferring a visible
   * one, then the most recently connected. Returns false when no tab is on
   * the channel.
   */
  sendOpenRequest(
    key: string,
    request: { requestId: string; url: string; path: string },
  ): boolean {
    const candidates = [...(this.clients.get(key) ?? [])]
      .filter((client) => client.ready && client.socket.readyState === 1)
      .sort(
        (a, b) =>
          Number(b.visible) - Number(a.visible) ||
          b.connectedAt - a.connectedAt,
      );
    const client = candidates[0];
    if (!client) return false;
    this.send(client, { type: "open-request", ...request });
    return true;
  }

  close(): void {
    for (const set of this.clients.values()) {
      for (const client of set) client.socket.terminate();
    }
    this.wss.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== TAB_CHANNEL_PATH) {
      reject(socket, 404, "Not found");
      return;
    }
    if (!this.options.authorize(req, url)) {
      reject(socket, 401, "This Roughdraft server requires a token.");
      return;
    }
    if (!originAllowed(req)) {
      reject(socket, 403, "Cross-origin tab connections are not allowed.");
      return;
    }
    const resolved = this.options.resolveTarget(url);
    if (!resolved.ok) {
      reject(socket, resolved.status, resolved.error);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.connect(ws, resolved.target, url);
    });
  }

  private async connect(
    socket: WebSocket,
    target: TabTarget,
    url: URL,
  ): Promise<void> {
    const { registry, watcher, log } = this.options;
    const key = target.identity.key;
    const tabId =
      url.searchParams.get("tabId")?.trim() ||
      `tab_${crypto.randomUUID().slice(0, 12)}`;
    const client: TabClient = {
      socket,
      tabId,
      key,
      absolutePath: target.absolutePath,
      visible: url.searchParams.get("visible") !== "false",
      connectedAt: Date.now(),
      ready: false,
      lastWatchers: registry.watcherCount(key),
    };
    let set = this.clients.get(key);
    if (!set) {
      set = new Set();
      this.clients.set(key, set);
    }
    set.add(client);
    const disconnectTab = registry.connectTab(target.identity, {
      tabId,
      visible: client.visible,
    });

    let unsubscribe: (() => void) | null = null;
    let missedPings = 0;
    let pingTimer: NodeJS.Timeout | null = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      unsubscribe?.();
      set.delete(client);
      if (set.size === 0 && this.clients.get(key) === set) {
        this.clients.delete(key);
      }
      disconnectTab();
    };
    socket.on("close", cleanup);
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => {
      missedPings = 0;
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.handleMessage(client, String(data));
    });

    const opened = await watcher.open(target.absolutePath, (change) =>
      this.sendChange(client, change),
    );
    unsubscribe = opened.unsubscribe;
    if (closed) {
      unsubscribe();
      return;
    }
    client.lastWatchers = registry.watcherCount(key);
    this.send(client, {
      type: "hello",
      instanceId: this.options.instanceId,
      tabId,
      document: opened.state,
      tabs: registry.tabCount(key),
      tabsDirty: registry.tabsDirty(key),
      watchers: client.lastWatchers,
      session: log.get(key)?.session ?? null,
      handoff: log.latestHandoff(key),
      latestSequence: this.options.latestSequence(),
    });
    client.ready = true;
    opened.start();

    pingTimer = setInterval(() => {
      if (missedPings >= MISSED_PINGS_ALLOWED) {
        socket.terminate();
        return;
      }
      missedPings += 1;
      try {
        socket.ping();
      } catch {}
      this.send(client, { type: "ping", seq: this.currentSeq(client) });
    }, this.pingMs);
    pingTimer.unref?.();
  }

  private currentSeq(client: TabClient): number {
    const state: DocumentState | null = this.options.watcher.current(
      client.absolutePath,
    );
    return state?.seq ?? 0;
  }

  private handleMessage(client: TabClient, raw: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const { registry } = this.options;
    switch (message.type) {
      case "presence": {
        const visible = optionalBoolean(message.visible);
        if (visible !== undefined) client.visible = visible;
        const baseHash =
          typeof message.baseHash === "string" || message.baseHash === null
            ? message.baseHash
            : undefined;
        registry.updateTab(client.key, client.tabId, {
          visible,
          dirty: optionalBoolean(message.dirty),
          conflict: optionalBoolean(message.conflict),
          baseHash,
        });
        return;
      }
      case "open-request-ack": {
        if (typeof message.requestId === "string") {
          this.options.acknowledgeOpenRequest(message.requestId);
        }
        return;
      }
      case "pong": {
        registry.updateTab(client.key, client.tabId, {});
        return;
      }
      default:
        return;
    }
  }

  private sendChange(client: TabClient, change: DocumentChange): void {
    this.send(client, { type: "change", ...change });
  }

  private sendWatchers(key: string): void {
    const count = this.options.registry.watcherCount(key);
    for (const client of this.clients.get(key) ?? []) {
      if (!client.ready || client.lastWatchers === count) continue;
      client.lastWatchers = count;
      this.send(client, { type: "watchers", count });
    }
  }

  private send(client: TabClient, message: Record<string, unknown>): void {
    if (client.socket.readyState !== 1) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {}
  }
}
