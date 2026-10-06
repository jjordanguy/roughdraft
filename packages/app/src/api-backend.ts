import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type HandoffRecord,
  type HandoffWake,
  type MarkdownFileChangeEvent,
  MarkdownFileConflictError,
  type Page,
  type ReviewWatchStatus,
  type SessionRecord,
  type StorageBackend,
  type StoredAsset,
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

function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  return value as unknown as SessionRecord;
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

  async getMarkdownFile(relativePath: string): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", {
        path: relativePath,
      }),
    );
    if (!res.ok) {
      throw new Error(
        `Failed to get markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", { path: relativePath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          expectedVersion,
          projectPath: this.info.projectPath,
        }),
      },
    );
    if (res.status === 409) {
      const payload = (await res.json()) as { current?: Page };
      if (payload.current) {
        throw new MarkdownFileConflictError(payload.current);
      }
    }
    if (!res.ok) {
      throw new Error(
        `Failed to save markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  watchMarkdownFile(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void {
    const source = new EventSource(
      this.buildUrl("/api/markdown-file/events", { path: relativePath }),
    );

    source.addEventListener("change", (event) => {
      try {
        onChange(JSON.parse((event as MessageEvent<string>).data));
      } catch (error) {
        console.error("Failed to read markdown file change event:", error);
      }
    });

    source.onerror = (error) => {
      console.error("Markdown file event stream failed:", error);
    };

    return () => {
      source.close();
    };
  }

  async completeReview(
    relativePath: string,
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    const overallComment = options.overallComment?.trim();
    const res = await fetch(
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          ...(overallComment ? { overallComment } : {}),
          ...(options.handoffId ? { handoffId: options.handoffId } : {}),
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to complete review ${relativePath}: ${res.status}`,
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

  async getReviewWatchStatus(relativePath: string): Promise<ReviewWatchStatus> {
    const res = await fetch(
      this.buildUrl("/api/review-events/status", { path: relativePath }),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get review watch status ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;
    return {
      watching: payload.watching === true,
      watcherCount:
        typeof payload.watcherCount === "number" ? payload.watcherCount : 0,
      tabs: typeof payload.tabs === "number" ? payload.tabs : undefined,
      handoff: parseHandoffRecord(payload.handoff),
      session: parseSessionRecord(payload.session),
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
