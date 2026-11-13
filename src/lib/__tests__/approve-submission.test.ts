import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { mergeRules, rulesEqual } from "../parking-rules";
import type { ParkingRule } from "../parking-rules";

// ─── In-memory stand-in for the Supabase client ───────────────────────────────
// Supports only the query shapes the approve route uses. Filters are applied
// for real, so the conditional "claim" UPDATE behaves like it does in Postgres.

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  failInsertInto: null as string | null,
  failUpdateOf: null as string | null,
  nextId: 1,
}));

class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: ((row: Row) => boolean)[] = [];
  private op: "select" | "update" | "insert" = "select";
  private payload: Row = {};
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(private table: string) {}

  select() { if (this.op !== "select") this.returning = true; return this; }
  update(values: Row) { this.op = "update"; this.payload = values; return this; }
  insert(values: Row) { this.op = "insert"; this.payload = values; return this; }
  eq(col: string, value: unknown) { this.filters.push((r) => r[col] === value); return this; }
  gte(col: string, value: number) { this.filters.push((r) => (r[col] as number) >= value); return this; }
  lte(col: string, value: number) { this.filters.push((r) => (r[col] as number) <= value); return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  private run(): { data: unknown; error: { message: string } | null } {
    const rows = (db.tables[this.table] ??= []);

    if (this.op === "insert") {
      if (db.failInsertInto === this.table) return { data: null, error: { message: `insert into ${this.table} failed` } };
      // Column defaults the real table applies
      const defaults: Row = this.table === "parking_spots" ? { is_active: true } : {};
      const row = { id: `${this.table}-${db.nextId++}`, ...defaults, ...this.payload };
      rows.push(row);
      return { data: this.mode === "many" ? [row] : row, error: null };
    }

    const matched = rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "update") {
      if (db.failUpdateOf === this.table) return { data: null, error: { message: `update of ${this.table} failed` } };
      for (const row of matched) Object.assign(row, this.payload);
    }

    if (this.mode === "many") return { data: this.op === "select" || this.returning ? matched : null, error: null };
    if (matched.length === 0) {
      return this.mode === "maybeSingle"
        ? { data: null, error: null }
        : { data: null, error: { message: "no rows" } };
    }
    return { data: matched[0], error: null };
  }

  then<A, B>(
    onFulfilled?: (value: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>,
    onRejected?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: (table: string) => new Query(table) }),
}));

vi.mock("@/lib/admin-route-guard", () => ({
  requireAdmin: async () => null,
}));

import { PATCH } from "@/app/api/admin/submissions/[id]/route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function rule(overrides: Partial<ParkingRule> = {}): ParkingRule {
  return {
    rule_type: "paid",
    is_prohibited: false,
    days: [1, 2, 3, 4, 5],
    time_window: { start: "08:00", end: "18:00" },
    time_limit_minutes: 120,
    cost_per_hour: 2,
    permit_zone: null,
    tow_away: false,
    direction: null,
    raw_text: "PAY ZONE 8AM-6PM MON-FRI",
    ...overrides,
  };
}

const NO_STOPPING = rule({
  rule_type: "no_stopping",
  is_prohibited: true,
  time_window: { start: "07:00", end: "09:00" },
  time_limit_minutes: null,
  cost_per_hour: null,
  raw_text: "NO STOPPING 7AM-9AM",
});

const LAT = 44.6476;
const LNG = -63.5788;

function submission(id: string, rules: ParkingRule[], overrides: Row = {}): Row {
  return {
    id,
    status: "pending_review",
    image_path: `submissions/${id}.jpg`,
    latitude: LAT,
    longitude: LNG,
    reviewer_notes: null,
    parking_spot_id: null,
    extracted_data: { rules, raw_text: "PAY ZONE 8AM-6PM MON-FRI", confidence: 0.9 },
    ...overrides,
  };
}

function review(id: string, body: unknown) {
  const request = new NextRequest(`http://localhost/api/admin/submissions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ id }) });
}

const spots = () => db.tables.parking_spots ?? [];
const spotRules = (index = 0) => (spots()[index].schedule as { rules: ParkingRule[] }).rules;
const sub = (id: string) => db.tables.sign_submissions.find((r) => r.id === id)!;

beforeEach(() => {
  db.tables = { sign_submissions: [], parking_spots: [], training_examples: [] };
  db.failInsertInto = null;
  db.failUpdateOf = null;
  db.nextId = 1;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── mergeRules / rulesEqual ──────────────────────────────────────────────────

describe("rulesEqual", () => {
  it("treats rules that differ only in raw_text as equal", () => {
    expect(rulesEqual(rule(), rule({ raw_text: "PAYZONE 8AM 6PM" }))).toBe(true);
  });

  it("ignores the order of days", () => {
    expect(rulesEqual(rule({ days: [5, 1, 3, 2, 4] }), rule())).toBe(true);
  });

  it.each([
    ["rule_type", { rule_type: "free" as const }],
    ["days", { days: [1, 2, 3, 4, 5, 6] }],
    ["time_window", { time_window: { start: "09:00", end: "18:00" } }],
    ["direction", { direction: "left" as const }],
    ["time_limit_minutes", { time_limit_minutes: 60 }],
    ["cost_per_hour", { cost_per_hour: 3 }],
    ["permit_zone", { permit_zone: "A" }],
    ["tow_away", { tow_away: true }],
  ])("treats rules with a different %s as different", (_field, change) => {
    expect(rulesEqual(rule(), rule(change))).toBe(false);
  });
});

describe("mergeRules", () => {
  it("adds only the rules that are not already present", () => {
    expect(mergeRules([rule()], [rule(), NO_STOPPING])).toEqual([rule(), NO_STOPPING]);
  });

  it("keeps existing rules first and in order", () => {
    expect(mergeRules([NO_STOPPING, rule()], [rule({ permit_zone: "B" })])[0]).toEqual(NO_STOPPING);
  });

  it("drops duplicates within the incoming list", () => {
    expect(mergeRules([], [rule(), rule({ raw_text: "again" })])).toHaveLength(1);
  });

  it("does not modify its inputs", () => {
    const existing = [rule()];
    mergeRules(existing, [NO_STOPPING]);
    expect(existing).toHaveLength(1);
  });
});

// ─── PATCH /api/admin/submissions/[id] ────────────────────────────────────────

describe("approve", () => {
  it("creates a spot, links the submission and records a training example", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));

    const res = await review("s1", { action: "approve", reviewer_notes: "  looks right  " });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, merged: false });
    expect(spots()).toHaveLength(1);
    expect(spots()[0]).toMatchObject({ parking_type: "paid", confidence_score: 0.9, notes: "looks right" });
    expect(sub("s1")).toMatchObject({ status: "approved", parking_spot_id: body.parking_spot_id });
    expect(db.tables.training_examples).toHaveLength(1);
  });

  it("leaves one copy of each rule when two submissions for the same pole are approved", async () => {
    db.tables.sign_submissions.push(
      submission("s1", [rule(), NO_STOPPING]),
      submission("s2", [rule({ raw_text: "different OCR of the same sign" }), NO_STOPPING]),
    );

    await review("s1", { action: "approve" });
    const second = await review("s2", { action: "approve" });

    expect((await second.json()).merged).toBe(true);
    expect(spots()).toHaveLength(1);
    expect(spotRules()).toHaveLength(2);
  });

  it("adds a genuinely new rule from a second photo", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]), submission("s2", [NO_STOPPING]));

    await review("s1", { action: "approve" });
    await review("s2", { action: "approve" });

    expect(spotRules().map((r) => r.rule_type)).toEqual(["paid", "no_stopping"]);
  });

  it("keeps the higher confidence when merging", async () => {
    db.tables.sign_submissions.push(
      submission("s1", [rule()]),
      submission("s2", [NO_STOPPING], {
        extracted_data: { rules: [NO_STOPPING], raw_text: "NO STOPPING", confidence: 0.4 },
      }),
    );

    await review("s1", { action: "approve" });
    await review("s2", { action: "approve" });

    expect(spots()).toHaveLength(1);
    expect(spots()[0].confidence_score).toBe(0.9);
  });

  it("creates a separate spot for a sign more than 15 m away", async () => {
    db.tables.sign_submissions.push(
      submission("s1", [rule()]),
      submission("s2", [rule()], { latitude: LAT + 0.001 }), // about 111 m north
    );

    await review("s1", { action: "approve" });
    const second = await review("s2", { action: "approve" });

    expect((await second.json()).merged).toBe(false);
    expect(spots()).toHaveLength(2);
  });

  it("returns 409 and changes nothing when the submission is already approved", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));
    await review("s1", { action: "approve" });

    const again = await review("s1", { action: "approve" });

    expect(again.status).toBe(409);
    expect(spots()).toHaveLength(1);
    expect(spotRules()).toHaveLength(1);
    expect(db.tables.training_examples).toHaveLength(1);
  });

  it("lets only one of two simultaneous approvals through", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));

    const results = await Promise.all([
      review("s1", { action: "approve" }),
      review("s1", { action: "approve" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(spots()).toHaveLength(1);
  });

  it("returns 409 when approving a rejected submission", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()], { status: "rejected" }));

    const res = await review("s1", { action: "approve" });

    expect(res.status).toBe(409);
    expect(spots()).toHaveLength(0);
    expect(sub("s1").status).toBe("rejected");
  });

  it("returns 409 for a submission that does not exist", async () => {
    expect((await review("missing", { action: "approve" })).status).toBe(409);
  });

  it("puts the submission back in the queue when the spot cannot be created", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));
    db.failInsertInto = "parking_spots";

    const res = await review("s1", { action: "approve" });

    expect(res.status).toBe(500);
    expect(sub("s1")).toMatchObject({ status: "pending_review", parking_spot_id: null });
    expect(db.tables.training_examples).toHaveLength(0);
  });

  it("still approves, and logs, when the training example cannot be saved", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));
    db.failInsertInto = "training_examples";

    const res = await review("s1", { action: "approve" });

    expect(res.status).toBe(200);
    expect(sub("s1").status).toBe("approved");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("training example"),
      expect.stringContaining("training_examples"),
    );
  });

  it("does not record a training example for a submission with no extracted data", async () => {
    db.tables.sign_submissions.push(submission("s1", [], { extracted_data: null }));

    const res = await review("s1", { action: "approve" });

    expect(res.status).toBe(200);
    expect(spots()[0].parking_type).toBe("unknown");
    expect(db.tables.training_examples).toHaveLength(0);
  });
});

describe("reject", () => {
  it("marks the submission rejected without touching the map", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));

    const res = await review("s1", { action: "reject", reviewer_notes: "blurry" });

    expect(res.status).toBe(200);
    expect(sub("s1")).toMatchObject({ status: "rejected", reviewer_notes: "blurry" });
    expect(spots()).toHaveLength(0);
  });

  it("returns 409 when the submission was already approved", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));
    await review("s1", { action: "approve" });

    const res = await review("s1", { action: "reject" });

    expect(res.status).toBe(409);
    expect(sub("s1").status).toBe("approved");
  });
});

describe("request validation", () => {
  it("returns 400 for an unknown action", async () => {
    db.tables.sign_submissions.push(submission("s1", [rule()]));

    expect((await review("s1", { action: "delete" })).status).toBe(400);
    expect(sub("s1").status).toBe("pending_review");
  });

  it("returns 400 for malformed JSON", async () => {
    expect((await review("s1", "{not json")).status).toBe(400);
  });
});
