// The render-hazard rules of the OpenMike harness's `rd-lint.mjs`
// (~/Documents/OpenMike-ops/skills/roughdraft-review/scripts/rd-lint.mjs),
// ported rule for rule so apply can run them as a gate without a subprocess.
// Messages match the script's so a failure reads the same in both places.

export interface RfmLintResult {
  /** Hazards the script exits 1 on. */
  fails: string[];
  /** Hazards the script only warns about. */
  warnings: string[];
}

const clip = (text: string) =>
  JSON.stringify(text.length > 70 ? `${text.slice(0, 70)}...` : text);

/** Run the rd-lint rules over a document's text. */
export function lintRoughdraftMarkdown(raw: string): RfmLintResult {
  // CriticMarkup inside fenced code blocks is literal example text.
  const md = raw.replace(
    /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm,
    "",
  );
  const fails: string[] = [];
  const warnings: string[] = [];

  // 1. Newline inside any span.
  const spanPatterns = [
    /\{>>[\s\S]*?<<\}/g,
    /\{\+\+[\s\S]*?\+\+\}/g,
    /\{--[\s\S]*?--\}/g,
    /\{~~[\s\S]*?~~\}/g,
    /\{==[\s\S]*?==\}/g,
  ];
  for (const pattern of spanPatterns) {
    for (const match of md.match(pattern) ?? []) {
      if (match.includes("\n"))
        fails.push(`newline inside span: ${clip(match)}`);
    }
  }

  // 2. Inline attribute tails alongside a YAML review block.
  const hasInlineAttr = /\{id="/.test(md);
  const blockIndex = md.lastIndexOf("\n---");
  const hasEndmatter =
    blockIndex !== -1 && /^(comments|suggestions):/m.test(md.slice(blockIndex));
  if (hasInlineAttr && hasEndmatter) {
    fails.push(
      'mixed regimes: inline-attribute roots ({id="...stuff"}) coexist with YAML endmatter; the renderer drops the endmatter and everything in it',
    );
  }

  // 3. Compact refs alongside inline attribute roots.
  if (hasInlineAttr && /\{#[cs]\d/.test(md)) {
    fails.push(
      "mixed anchors: {#cN}/{#sN} compact refs alongside inline-attribute roots",
    );
  }

  // 3b. Replicated attribute ids.
  const counts = new Map<string, number>();
  for (const match of md.match(/\{id="([^"]+)"[^}]*\}/g) ?? []) {
    const id = match.match(/\{id="([^"]+)"/)?.[1] ?? "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      warnings.push(
        `id "${id}" appears ${count} times: cross-block replicas; consolidate to one span (cross-block section) before replying`,
      );
    }
  }

  // 4. A train inside a heading line (cosmetic).
  for (const line of md.split("\n")) {
    if (/^#{1,6}\s/.test(line) && /\{(?:>>|==|\+\+|--|~~|id=")/.test(line)) {
      warnings.push(
        `comment train inside a heading (renders fine; cosmetic only): ${clip(line)}`,
      );
    }
  }

  return { fails, warnings };
}
