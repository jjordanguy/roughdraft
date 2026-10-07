import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { detectBackend } from "./detect-backend";
import { LocalStorageBackend } from "./local-storage-backend";

describe("detectBackend", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("uses the local files backend when the server reports one", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ backend: "local-files", projectDir: "/work" }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(ApiBackend);
    expect(backend.info).toMatchObject({
      kind: "local-files",
      projectPath: "/work",
    });
  });

  it("ignores a leftover remote session link and opens local files", async () => {
    // Links from the removed remote mode carried ?session=&token=. They must
    // not break the page now that the remote backend is gone.
    window.history.replaceState(null, "", "/?session=session-1&token=secret");
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            backend: "local-files",
            projectDir: "/work",
            capabilities: { remoteDocuments: true },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(ApiBackend);
    expect(backend.info.kind).toBe("local-files");
  });

  it("uses local storage when no server is available", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(LocalStorageBackend);
  });
});
