import type { StorageBackend } from "./storage";
import { ApiBackend } from "./api-backend";
import { LocalStorageBackend } from "./local-storage-backend";

interface StatusPayload {
  backend?: string;
  projectDir?: string;
  stateless?: boolean;
}

export async function detectBackend(): Promise<StorageBackend> {
  if (import.meta.env.VITE_PREVIEW_WEB === "1") {
    return new LocalStorageBackend();
  }

  let statusPayload: StatusPayload | null = null;

  try {
    const res = await fetch("/api/status");
    if (res.ok) {
      statusPayload = (await res.json()) as StatusPayload;
    }
  } catch {
    // Network error: no server is available.
  }

  if (statusPayload?.backend === "local-files") {
    return new ApiBackend({
      kind: "local-files",
      label: "Local files",
      detail: statusPayload.stateless
        ? "Open a markdown file"
        : "Markdown file on disk",
      projectPath: statusPayload.projectDir,
    });
  }

  return new LocalStorageBackend();
}
