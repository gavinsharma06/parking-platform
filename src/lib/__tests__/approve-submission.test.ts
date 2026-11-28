import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const db = vi.hoisted(() => ({ rpc: vi.fn(), insert: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/admin-route-guard", () => ({ requireAdmin: db.requireAdmin }));
vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({ rpc: db.rpc, from: () => ({ insert: db.insert }) }),
}));

import { PATCH } from "@/app/api/admin/submissions/[id]/route";

const id = "10000000-0000-0000-0000-000000000001";
const extraction = { raw_text: "PAY ZONE", rules: [{ rule_type: "paid" }] };
const approval = { status: "approved", parking_spot_id: "spot-id", merged: true, image_path: "test.jpg", extracted_data: extraction };

function review(body: string) {
  return PATCH(new NextRequest(`http://localhost/api/admin/submissions/${id}`, { method: "PATCH", body }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.requireAdmin.mockResolvedValue(null);
  db.rpc.mockResolvedValue({ data: approval, error: null });
  db.insert.mockResolvedValue({ error: null });
});

describe("submission review", () => {
  it("blocks unauthenticated reviews before calling the database", async () => {
    db.requireAdmin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await review('{"action":"approve"}')).status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(["{", "null", '{"action":"other"}'])("rejects an invalid body %s", async (body) => {
    expect((await review(body)).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("returns the spot from the transaction and records the training example", async () => {
    const result = await review('{"action":"approve","reviewer_notes":" checked "}');
    expect(db.rpc).toHaveBeenCalledWith("review_sign_submission", {
      p_submission_id: id, p_action: "approve", p_reviewer_notes: "checked",
    });
    expect(await result.json()).toEqual({ ok: true, parking_spot_id: "spot-id", merged: true });
    expect(db.insert).toHaveBeenCalledWith({
      submission_id: id, image_path: "test.jpg", raw_text: "PAY ZONE", approved_extracted_data: extraction,
    });
  });

  it("returns 409 when the submission was already reviewed", async () => {
    db.rpc.mockResolvedValue({ data: null, error: null });
    expect((await review('{"action":"approve"}')).status).toBe(409);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not record a rejected submission or an empty extraction", async () => {
    db.rpc.mockResolvedValueOnce({ data: { status: "rejected" }, error: null });
    db.rpc.mockResolvedValueOnce({ data: { ...approval, extracted_data: null }, error: null });
    expect((await review('{"action":"reject"}')).status).toBe(200);
    expect((await review('{"action":"approve"}')).status).toBe(200);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("logs a failed training write without undoing the review", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.insert.mockResolvedValue({ error: { code: "23505" } });
      expect((await review('{"action":"approve"}')).status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(id), "23505");
    } finally {
      errorLog.mockRestore();
    }
  });
});
