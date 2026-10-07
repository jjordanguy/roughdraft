#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const testFilePattern =
  /(?:^|\/)(?:test|e2e)\/.*\.(?:test|spec)\.tsx?$|\.e2e\/.*\.spec\.tsx?$|\.test\.tsx?$|\.spec\.tsx?$/;
const ignoredDirs = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".context",
]);

const forbiddenApiPatterns = [
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.get(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/,
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.query(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/,
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.find(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/,
];

const selectorApiPatterns = [
  /\bquerySelector(?:All)?\s*\(\s*([`'"])(.*?)\1/,
  /\blocator\s*\(\s*([`'"])(.*?)\1/,
  /\b\$\$?\s*\(\s*([`'"])(.*?)\1/,
];

const allowedSelectorPatterns = [
  /\[data-testid=/,
  /^\[data-testid=/,
  /^title$/,
  /^meta\[/,
  /^link\[/,
  /^a\[href=/,
  /^a\[data-markdown-src=/,
  /^img\[data-markdown-src=/,
  /^input\[type="checkbox"\]$/,
  /^img\[alt=/,
  /^\.cm-(content|editor|gutters)$/,
  /^\.ProseMirror$/,
  /^\.comment-anchor\[data-comment-ids\]$/,
  /^\.critic-change(?:-[a-z-]+)?(?:\[data-critic-change-id\])?$/,
  /^\[data-critic-change-id=/,
  /^\[data-comment-thread-root-id\]/,
  /^\[data-suggestion-thread-container="true"\]$/,
  /^\[data-comment-thread-container="true"\]$/,
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (testFilePattern.test(path.relative(repoRoot, fullPath))) {
      files.push(fullPath);
    }
  }

  return files;
}

function isAllowedSelector(selector) {
  return allowedSelectorPatterns.some((pattern) => pattern.test(selector));
}

const violations = [];

for (const file of walk(repoRoot)) {
  const relativePath = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");

  lines.forEach((line, index) => {
    if (line.includes("selector-check-ignore")) return;

    for (const pattern of forbiddenApiPatterns) {
      if (pattern.test(line)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          reason:
            "Use getByTestId/query by data-testid instead of text, role, label, placeholder, alt, or title selectors.",
          source: line.trim(),
        });
      }
    }

    for (const pattern of selectorApiPatterns) {
      const match = line.match(pattern);
      if (!match) continue;

      const selector = match[2];
      if (!isAllowedSelector(selector)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          reason: `Selector "${selector}" is not data-testid-based or explicitly allowlisted.`,
          source: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Test selector convention violations found:\n");
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: ${violation.reason}\n  ${violation.source}`,
    );
  }
  process.exit(1);
}

console.log("Test selectors use data-testid or an explicit stable exception.");
