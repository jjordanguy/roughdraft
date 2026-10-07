import { ApiBackend } from "./api-backend";
import { LocalStorageBackend } from "./local-storage-backend";
import {
  ServerResponseError,
  ServerUnreachableError,
  type StorageBackend,
} from "./storage";

interface StatusPayload {
  backend?: string;
  projectDir?: string;
  stateless?: boolean;
}

const STATUS_ROUTE = "GET /api/status";

export async function detectBackend({
  // A page opened for a file needs the server; without one it must say the
  // server did not answer instead of falling back to browser storage.
  requireServer = false,
}: {
  requireServer?: boolean;
} = {}): Promise<StorageBackend> {
  if (import.meta.env.VITE_PREVIEW_WEB === "1") {
    return new LocalStorageBackend();
  }

  let statusPayload: StatusPayload | null = null;
  let failure: Error | null = null;

  try {
    const res = await fetch("/api/status");
    if (res.ok) {
      statusPayload = (await res
        .json()
        .catch(() => null)) as StatusPayload | null;
    } else {
      failure = new ServerResponseError(STATUS_ROUTE, res.status);
    }
  } catch (error) {
    // Network error: no server is available.
    failure = new ServerUnreachableError(STATUS_ROUTE, error);
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

  if (requireServer && failure) throw failure;

  return new LocalStorageBackend();
}
