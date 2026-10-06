// Three-way merge of review block entries: union by id, key by key.
import type { RfmEndmatterEntry } from "./split.js";

type Section<T> = Map<string, T> | Record<string, T>;

export interface RfmEntriesInput {
  comments?: Section<RfmEndmatterEntry>;
  suggestions?: Section<RfmEndmatterEntry>;
  /** Other top-level keys of the review block. */
  extra?: Section<unknown>;
}

export interface RfmMergedEntries {
  comments: Map<string, RfmEndmatterEntry>;
  suggestions: Map<string, RfmEndmatterEntry>;
  extra: Map<string, unknown>;
}

export interface RfmMergeConflict {
  section: "comments" | "suggestions" | "extra";
  id: string;
  /** The entry key both sides changed; null when one side removed the entry the other changed. */
  key: string | null;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface RfmMergeResult {
  /** The merge; on a conflict it keeps `ours` (or the side that kept the entry). */
  entries: RfmMergedEntries;
  conflicts: RfmMergeConflict[];
}

function toMap<T>(section: Section<T> | undefined): Map<string, T> {
  if (!section) return new Map();
  return section instanceof Map
    ? new Map(section)
    : new Map(Object.entries(section));
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function mergeEntry(
  section: RfmMergeConflict["section"],
  id: string,
  base: RfmEndmatterEntry,
  ours: RfmEndmatterEntry,
  theirs: RfmEndmatterEntry,
  conflicts: RfmMergeConflict[],
): RfmEndmatterEntry {
  const merged: RfmEndmatterEntry = {};
  const keys = [
    ...new Set([
      ...Object.keys(ours),
      ...Object.keys(theirs),
      ...Object.keys(base),
    ]),
  ];
  for (const key of keys) {
    const b = base[key];
    const o = ours[key];
    const t = theirs[key];
    let value: unknown;
    if (same(o, t)) value = o;
    else if (same(o, b)) value = t;
    else if (same(t, b)) value = o;
    else {
      conflicts.push({ section, id, key, base: b, ours: o, theirs: t });
      value = o;
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeSection<T>(
  section: RfmMergeConflict["section"],
  base: Map<string, T>,
  ours: Map<string, T>,
  theirs: Map<string, T>,
  conflicts: RfmMergeConflict[],
  entryLevel: boolean,
): Map<string, T> {
  const out = new Map<string, T>();
  const ids = [...new Set([...ours.keys(), ...theirs.keys()])];
  for (const id of ids) {
    const b = base.get(id);
    const o = ours.get(id);
    const t = theirs.get(id);
    const hasB = base.has(id);
    const hasO = ours.has(id);
    const hasT = theirs.has(id);
    if (!hasO && !hasT) continue;
    if (!hasB) {
      if (hasO && hasT && !same(o, t)) {
        if (entryLevel) {
          out.set(
            id,
            mergeEntry(
              section,
              id,
              {},
              o as RfmEndmatterEntry,
              t as RfmEndmatterEntry,
              conflicts,
            ) as T,
          );
        } else {
          conflicts.push({
            section,
            id,
            key: null,
            base: undefined,
            ours: o,
            theirs: t,
          });
          out.set(id, o as T);
        }
        continue;
      }
      out.set(id, (hasO ? o : t) as T);
      continue;
    }
    if (!hasO) {
      if (!same(t, b)) {
        conflicts.push({
          section,
          id,
          key: null,
          base: b,
          ours: undefined,
          theirs: t,
        });
        out.set(id, t as T);
      }
      continue;
    }
    if (!hasT) {
      if (!same(o, b)) {
        conflicts.push({
          section,
          id,
          key: null,
          base: b,
          ours: o,
          theirs: undefined,
        });
        out.set(id, o as T);
      }
      continue;
    }
    if (entryLevel) {
      out.set(
        id,
        mergeEntry(
          section,
          id,
          b as RfmEndmatterEntry,
          o as RfmEndmatterEntry,
          t as RfmEndmatterEntry,
          conflicts,
        ) as T,
      );
    } else if (same(o, t) || same(t, b)) {
      out.set(id, o as T);
    } else if (same(o, b)) {
      out.set(id, t as T);
    } else {
      conflicts.push({ section, id, key: null, base: b, ours: o, theirs: t });
      out.set(id, o as T);
    }
  }
  return out;
}

/**
 * Merge two versions of a review block's entries that both started from
 * `base`: entries are unioned by id (ours first, then ids only theirs has, so
 * new entries keep creation order), each entry is merged key by key, and a
 * key both sides changed to different values is a conflict (ours is kept and
 * the conflict listed). Removing an entry on one side while the other changed
 * it is a conflict too.
 */
export function mergeReviewEntries(
  base: RfmEntriesInput,
  ours: RfmEntriesInput,
  theirs: RfmEntriesInput,
): RfmMergeResult {
  const conflicts: RfmMergeConflict[] = [];
  const entries: RfmMergedEntries = {
    comments: mergeSection(
      "comments",
      toMap(base.comments),
      toMap(ours.comments),
      toMap(theirs.comments),
      conflicts,
      true,
    ),
    suggestions: mergeSection(
      "suggestions",
      toMap(base.suggestions),
      toMap(ours.suggestions),
      toMap(theirs.suggestions),
      conflicts,
      true,
    ),
    extra: mergeSection(
      "extra",
      toMap(base.extra),
      toMap(ours.extra),
      toMap(theirs.extra),
      conflicts,
      false,
    ),
  };
  return { entries, conflicts };
}
