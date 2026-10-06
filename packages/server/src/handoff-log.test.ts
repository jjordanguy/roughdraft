import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DocumentIdentity,
  HANDOFF_RETENTION,
  type NewHandoff,
  REVIEW_LOG_FILE,
  ReviewLog,
} from "./handoff-log";

const DAY_MS = 24 * 60 * 60 * 1000;

function identity(name = "plan.md"): DocumentIdentity {
  return {
    key: `/docs/${name}`,
    documentPath: `/docs/${name}`,
    projectPath: "/docs",
    relativePath: name,
  };
}

function handoff(handoffId: string): NewHandoff {
  return {
    handoffId,
    version: `v-${handoffId}`,
    summary: { comments: 2, replies: 0, suggestions: 1, unresolved: 3 },
    overallComment: null,
    wakeRouteId: null,
  };
}

describe("ReviewLog", () => {
  let stateDir: string;
  let clock: number;
  const now = () => new Date(clock);

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-log-"));
    clock = Date.parse("2026-10-05T12:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists handoffs and continues sequences after a reload", () => {
    const first = new ReviewLog({ stateDir, now });
    first.recordHandoff(identity(), handoff("h1"));
    first.recordHandoff(identity("other.md"), handoff("h2"));

    const second = new ReviewLog({ stateDir, now });
    const next = second.recordHandoff(identity(), handoff("h3"));

    expect(second.logId).toBe(first.logId);
    expect(next.sequence).toBe(3);
    expect(second.findHandoff({ handoffId: "h2" })?.handoff.sequence).toBe(2);
  });

  it("keeps the sequence monotonic even when every handoff was pruned", () => {
    const first = new ReviewLog({ stateDir, now });
    first.acknowledge(first.recordHandoff(identity(), handoff("h1")), "agent");
    clock += 3 * DAY_MS;
    first.save();

    const second = new ReviewLog({ stateDir, now });

    expect(second.findHandoff({ handoffId: "h1" })).toBeNull();
    expect(second.recordHandoff(identity(), handoff("h2")).sequence).toBe(2);
  });

  it("moves a corrupt log aside, starts fresh and reports a warning", () => {
    const filePath = path.join(stateDir, REVIEW_LOG_FILE);
    fs.writeFileSync(filePath, "{ not json");

    const log = new ReviewLog({ stateDir, now });

    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain("Moved it to");
    const aside = fs
      .readdirSync(stateDir)
      .filter((name) => name.startsWith(`${REVIEW_LOG_FILE}.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(log.recordHandoff(identity(), handoff("h1")).sequence).toBe(1);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("supersedes older unacknowledged handoffs for the same document only", () => {
    const log = new ReviewLog({ stateDir, now });
    const first = log.recordHandoff(identity(), handoff("h1"));
    log.markDelivered(first.sequence, "w1");
    const elsewhere = log.recordHandoff(identity("other.md"), handoff("h2"));

    const latest = log.recordHandoff(identity(), handoff("h3"));

    expect(first.state).toBe("superseded");
    expect(elsewhere.state).toBe("pending");
    expect(log.unacknowledged(identity().key)).toEqual([latest]);
  });

  it("acknowledges once and keeps the first ack", () => {
    const log = new ReviewLog({ stateDir, now });
    const record = log.recordHandoff(identity(), handoff("h1"));

    log.acknowledge(record, "cli watch");
    clock += 1_000;
    log.acknowledge(record, "mcp");

    expect(record).toMatchObject({
      state: "acknowledged",
      ackedBy: "cli watch",
      ackedAt: "2026-10-05T12:00:00.000Z",
    });
  });

  it("prunes acknowledged handoffs after two days and pending ones after fourteen", () => {
    const log = new ReviewLog({ stateDir, now });
    const acked = log.recordHandoff(identity("a.md"), handoff("acked"));
    log.acknowledge(acked, "agent");
    log.recordHandoff(identity("b.md"), handoff("pending"));

    clock += 2 * DAY_MS + 1;
    log.save();
    expect(log.findHandoff({ handoffId: "acked" })).toBeNull();
    expect(log.findHandoff({ handoffId: "pending" })).not.toBeNull();

    clock += 12 * DAY_MS;
    log.save();
    expect(log.findHandoff({ handoffId: "pending" })).toBeNull();
  });

  it("keeps at most fifty handoffs per document and five hundred overall", () => {
    const log = new ReviewLog({ stateDir, now });
    for (let index = 0; index < HANDOFF_RETENTION.perDocument + 5; index += 1) {
      log.recordHandoff(identity("busy.md"), handoff(`busy-${index}`));
    }
    expect(log.get("/docs/busy.md")?.handoffs).toHaveLength(
      HANDOFF_RETENTION.perDocument,
    );
    expect(log.findHandoff({ handoffId: "busy-4" })).toBeNull();
    expect(log.findHandoff({ handoffId: "busy-5" })).not.toBeNull();
    for (let index = 0; index < HANDOFF_RETENTION.overall; index += 1) {
      log.recordHandoff(
        identity(`doc-${index % 20}.md`),
        handoff(`n-${index}`),
      );
    }

    const all = log.all().flatMap((document) => document.handoffs);
    expect(all).toHaveLength(HANDOFF_RETENTION.overall);
    expect(Math.min(...all.map((record) => record.sequence))).toBe(
      HANDOFF_RETENTION.perDocument + 5 + 1,
    );
  });

  it("seeds replay events only from unacknowledged handoffs", () => {
    const log = new ReviewLog({ stateDir, now });
    const acked = log.recordHandoff(identity("a.md"), handoff("a"));
    log.acknowledge(acked, "agent");
    log.recordHandoff(identity("b.md"), {
      ...handoff("b"),
      overallComment: "Tighten the intro.",
    });

    const seeded = new ReviewLog({ stateDir, now }).unacknowledgedEvents();

    expect(seeded).toEqual([
      {
        documentKey: "/docs/b.md",
        event: expect.objectContaining({
          type: "review.completed",
          sequence: 2,
          relativePath: "b.md",
          overallComment: "Tighten the intro.",
        }),
      },
    ]);
  });

  it("does not write documents that have neither a session nor a handoff", () => {
    const log = new ReviewLog({ stateDir, now });
    log.upsert(identity("seen-only.md"));
    log.recordHandoff(identity(), handoff("h1"));

    const saved = JSON.parse(
      fs.readFileSync(path.join(stateDir, REVIEW_LOG_FILE), "utf8"),
    );

    expect(Object.keys(saved.documents)).toEqual(["/docs/plan.md"]);
    expect(saved).toMatchObject({ schemaVersion: 1, nextSequence: 2 });
  });

  it("keeps everything in memory when no state directory is given", () => {
    const log = new ReviewLog({ now });
    log.recordHandoff(identity(), handoff("h1"));

    expect(log.filePath).toBeNull();
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});
