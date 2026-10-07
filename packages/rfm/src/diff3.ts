// Myers diff and a three-way merge over sequences of strings (lines or
// tokens). Plain TypeScript so the package stays browser-safe.

/** One changed range: `a[aStart, aEnd)` became `b[bStart, bEnd)`. */
export interface DiffHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Beyond this many differences (after the common prefix and suffix are cut)
 * the middle is reported as one replaced range instead of searching on: the
 * search costs O(D²) memory, and a merge over a rewrite that large is a
 * conflict either way.
 */
const MAX_EDIT_DISTANCE = 4_000;

function intern(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (list: string[]) => {
    const out = new Int32Array(list.length);
    list.forEach((item, index) => {
      let id = ids.get(item);
      if (id === undefined) {
        id = ids.size;
        ids.set(item, id);
      }
      out[index] = id;
    });
    return out;
  };
  return [map(a), map(b)];
}

/** The changed ranges between `a` and `b`, in order (Myers' O(ND) diff). */
export function diffSequences(a: string[], b: string[]): DiffHunk[] {
  const [xa, xb] = intern(a, b);
  let start = 0;
  while (start < xa.length && start < xb.length && xa[start] === xb[start])
    start += 1;
  let endA = xa.length;
  let endB = xb.length;
  while (endA > start && endB > start && xa[endA - 1] === xb[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  }
  const A = xa.subarray(start, endA);
  const B = xb.subarray(start, endB);
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-d, d] before step d+1 runs (after step d).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDIT_DISTANCE) break;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (
        k === -d ||
        (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      ) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) {
    return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  }

  // Walk back to an edit script: per position, equal or not.
  const ops: Array<"=" | "-" | "+"> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1] as Int32Array;
    const at = (k: number) => previous[k + (d - 1)] ?? 0;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push("+");
      y -= 1;
    } else {
      ops.push("-");
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x -= 1;
    y -= 1;
  }
  ops.reverse();

  const hunks: DiffHunk[] = [];
  let ia = start;
  let ib = start;
  let open: DiffHunk | null = null;
  for (const op of ops) {
    if (op === "=") {
      if (open) {
        hunks.push(open);
        open = null;
      }
      ia += 1;
      ib += 1;
      continue;
    }
    if (!open) open = { aStart: ia, aEnd: ia, bStart: ib, bEnd: ib };
    if (op === "-") {
      ia += 1;
      open.aEnd = ia;
    } else {
      ib += 1;
      open.bEnd = ib;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

export type Diff3Region =
  | { stable: true; lines: string[] }
  | {
      stable: false;
      /** Range in `base`. */
      baseStart: number;
      baseEnd: number;
      oursStart: number;
      oursEnd: number;
      theirsStart: number;
      theirsEnd: number;
      base: string[];
      ours: string[];
      theirs: string[];
    };

interface SideHunk extends DiffHunk {
  side: "ours" | "theirs";
}

/**
 * Three-way merge of sequences. A change made on one side only, or the same
 * change made on both, is taken; ranges both sides changed differently come
 * back as an unstable region. Two hunks collide when their base ranges
 * overlap, or when one of them is an insertion at the other's start (the
 * order would be a guess). Changes on adjacent but distinct ranges merge.
 */
export function diff3Merge(
  base: string[],
  ours: string[],
  theirs: string[],
): Diff3Region[] {
  const hunks: SideHunk[] = [
    ...diffSequences(base, ours).map((hunk) => ({
      ...hunk,
      side: "ours" as const,
    })),
    ...diffSequences(base, theirs).map((hunk) => ({
      ...hunk,
      side: "theirs" as const,
    })),
  ].sort((a, b) => a.aStart - b.aStart || a.aEnd - b.aEnd);

  const regions: Diff3Region[] = [];
  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = regions.at(-1);
    if (last?.stable) last.lines.push(...lines);
    else regions.push({ stable: true, lines: [...lines] });
  };

  let cursor = 0;
  let index = 0;
  while (index < hunks.length) {
    const first = hunks[index] as SideHunk;
    const group: SideHunk[] = [first];
    let groupStart = first.aStart;
    let groupEnd = first.aEnd;
    index += 1;
    while (index < hunks.length) {
      const next = hunks[index] as SideHunk;
      // Sorted by start (insertions first on a tie), so an insertion at the
      // group's start is caught by the overlap test, and an insertion group
      // collides with anything starting at its point.
      const collides =
        next.aStart < groupEnd ||
        (next.aStart === groupEnd && groupStart === groupEnd);
      if (!collides) break;
      group.push(next);
      groupStart = Math.min(groupStart, next.aStart);
      groupEnd = Math.max(groupEnd, next.aEnd);
      index += 1;
    }
    pushStable(base.slice(cursor, groupStart));
    cursor = groupEnd;

    const rangeOf = (side: "ours" | "theirs") => {
      const own = group.filter((hunk) => hunk.side === side);
      if (own.length === 0) {
        return { start: groupStart, end: groupEnd, changed: false };
      }
      const firstHunk = own[0] as SideHunk;
      const lastHunk = own[own.length - 1] as SideHunk;
      return {
        start: groupStart - (firstHunk.aStart - firstHunk.bStart),
        end: groupEnd + (lastHunk.bEnd - lastHunk.aEnd),
        changed: true,
      };
    };
    const o = rangeOf("ours");
    const t = rangeOf("theirs");
    const oursLines = o.changed
      ? ours.slice(o.start, o.end)
      : base.slice(groupStart, groupEnd);
    const theirsLines = t.changed
      ? theirs.slice(t.start, t.end)
      : base.slice(groupStart, groupEnd);
    if (!o.changed) {
      pushStable(theirsLines);
      continue;
    }
    if (!t.changed) {
      pushStable(oursLines);
      continue;
    }
    if (
      oursLines.length === theirsLines.length &&
      oursLines.every((line, i) => line === theirsLines[i])
    ) {
      pushStable(oursLines);
      continue;
    }
    regions.push({
      stable: false,
      baseStart: groupStart,
      baseEnd: groupEnd,
      oursStart: o.start,
      oursEnd: o.end,
      theirsStart: t.start,
      theirsEnd: t.end,
      base: base.slice(groupStart, groupEnd),
      ours: oursLines,
      theirs: theirsLines,
    });
  }
  pushStable(base.slice(cursor));
  return regions;
}
