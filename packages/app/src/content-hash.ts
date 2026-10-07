import type { Page } from "./storage";

// A synchronous content identity for backends that do not hash on the
// server (preview, browser storage, a server older than batch 2 that sends
// no version). It only ever answers "same text or not" inside one tab.
export function localContentHash(content: string): string {
  // cyrb53: two 32-bit lanes, 53 bits of output.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `local:${content.length}:${hash.toString(16)}`;
}

const LEGACY_VERSION = /^[^:]+:\d+:([0-9a-f]{64})$/;

// The hash segment of a legacy `mtimeMs:size:sha256` version, which the
// batch 2 server treats as the content hash when `expectedContentHash` is
// absent.
export function hashFromVersion(version: string | null | undefined) {
  if (!version) return null;
  return LEGACY_VERSION.exec(version)?.[1] ?? null;
}

export function contentHashForPage(page: Page): string {
  return (
    page.contentHash ??
    hashFromVersion(page.version) ??
    localContentHash(page.content)
  );
}
