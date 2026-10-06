import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RfmReviewIndex } from "../src/index";

export const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/spec/fixtures",
);

export interface Fixture {
  name: string;
  markdown: string;
  expectedPath: string;
}

/** Every `docs/spec/fixtures/*.md`, sorted by name. */
export function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({
      name: file.replace(/\.md$/, ""),
      markdown: fs.readFileSync(path.join(fixturesDir, file), "utf8"),
      expectedPath: path.join(
        fixturesDir,
        file.replace(/\.md$/, ".expected.json"),
      ),
    }));
}

/** New-format fixtures: written exactly as the canonical writer writes them. */
export function isCanonical(fixture: Fixture): boolean {
  return fixture.name.startsWith("canonical-");
}

export interface ExpectedItem {
  id: string;
  kind: string;
  scope: string;
  parent: string | null;
  text: string;
  status: string | null;
  anchors: string[];
}

/** The part of the review index every reader must agree on (the conformance shape). */
export function conformanceItems(index: RfmReviewIndex): ExpectedItem[] {
  return index.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    parent: item.parentId,
    text: item.text,
    status: item.status,
    anchors: item.anchors.map((anchor) => anchor.text),
  }));
}
