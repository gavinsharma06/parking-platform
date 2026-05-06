-- ═══════════════════════════════════════════════════════════════════════════════
-- Park Off — Complete Database Schema
-- Run in Supabase: Dashboard → SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Extensions ───────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS postgis;


-- ─── Types ────────────────────────────────────────────────────────────────────

CREATE TYPE parking_type      AS ENUM ('free', 'paid', 'permit', 'unknown', 'accessible');
CREATE TYPE submission_status AS ENUM ('pending_review', 'approved', 'rejected');


-- ═══════════════════════════════════════════════════════════════════════════════
-- parking_spots
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE parking_spots (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Location
  latitude            DOUBLE PRECISION NOT NULL,
  longitude           DOUBLE PRECISION NOT NULL,
  location            GEOGRAPHY(POINT, 4326),         -- populated by trigger
  street_name         TEXT,

  -- Core
  parking_type        parking_type     NOT NULL DEFAULT 'unknown',
  time_limit_minutes  INTEGER          CHECK (time_limit_minutes > 0),
  cost_per_hour       NUMERIC(8, 2)    CHECK (cost_per_hour >= 0),

  -- Provenance
  source_type         TEXT             NOT NULL DEFAULT 'manual'
                        CHECK (source_type IN ('manual', 'user', 'osm', 'inferred', 'hrm_arcgis')),
  confidence_score    NUMERIC(3, 2)    NOT NULL DEFAULT 0.5
                        CHECK (confidence_score BETWEEN 0 AND 1),

  -- HRM / external data import
  from_street         TEXT,
  to_street           TEXT,
  external_id         TEXT,
  raw_data            JSONB,

  -- Future-proofing
  notes               TEXT,
  schedule            JSONB,
  is_active           BOOLEAN          NOT NULL DEFAULT TRUE,

  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION sync_parking_spot()
RETURNS TRIGGER AS $$
BEGIN
  NEW.location   := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER parking_spots_before_upsert
  BEFORE INSERT OR UPDATE ON parking_spots
  FOR EACH ROW EXECUTE FUNCTION sync_parking_spot();

CREATE INDEX parking_spots_location_idx    ON parking_spots USING GIST (location);
CREATE INDEX parking_spots_type_active_idx ON parking_spots (parking_type, is_active);
CREATE INDEX parking_spots_confidence_idx  ON parking_spots (confidence_score);
CREATE INDEX parking_spots_active_partial  ON parking_spots (id) WHERE is_active = TRUE;
CREATE UNIQUE INDEX parking_spots_external_id_idx    ON parking_spots (external_id)              WHERE external_id IS NOT NULL;
-- Composite index required for the import script's onConflict: "source_type,external_id" upsert
CREATE UNIQUE INDEX parking_spots_source_external_idx ON parking_spots (source_type, external_id) WHERE external_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- parking_spot_history  (audit log — automatic, never written by app code)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE parking_spot_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id     UUID        NOT NULL REFERENCES parking_spots (id) ON DELETE CASCADE,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_type TEXT        NOT NULL CHECK (change_type IN ('insert', 'update', 'delete')),
  old_data    JSONB,
  new_data    JSONB
);

CREATE INDEX history_spot_time_idx ON parking_spot_history (spot_id, changed_at DESC);

CREATE OR REPLACE FUNCTION log_parking_spot_change()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO parking_spot_history (spot_id, change_type, old_data, new_data)
  VALUES (
    COALESCE(NEW.id, OLD.id),
    LOWER(TG_OP),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER parking_spots_audit
  AFTER INSERT OR UPDATE OR DELETE ON parking_spots
  FOR EACH ROW EXECUTE FUNCTION log_parking_spot_change();


-- ═══════════════════════════════════════════════════════════════════════════════
-- reports  (user-flagged corrections on existing spots)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id     UUID        NOT NULL REFERENCES parking_spots (id) ON DELETE CASCADE,
  report_type TEXT        NOT NULL
                CHECK (report_type IN ('wrong_type', 'wrong_hours', 'spot_gone', 'other')),
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX reports_spot_idx   ON reports (spot_id);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- sign_submissions  (user photo evidence — reviewed before going live)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE sign_submissions (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Evidence
  image_path      TEXT              NOT NULL,
  latitude        DOUBLE PRECISION  NOT NULL,
  longitude       DOUBLE PRECISION  NOT NULL,
  location        GEOGRAPHY(POINT, 4326),
  device_metadata JSONB,
  extracted_data  JSONB,            -- populated by OCR if user ran analysis before submitting

  -- Review workflow
  status          submission_status NOT NULL DEFAULT 'pending_review',
  reviewer_notes  TEXT,
  parking_spot_id UUID              REFERENCES parking_spots (id) ON DELETE SET NULL,

  submitted_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION sync_sign_submission()
RETURNS TRIGGER AS $$
BEGIN
  NEW.location   := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sign_submissions_before_upsert
  BEFORE INSERT OR UPDATE ON sign_submissions
  FOR EACH ROW EXECUTE FUNCTION sync_sign_submission();

CREATE INDEX sign_submissions_status_idx   ON sign_submissions (status, submitted_at DESC);
CREATE INDEX sign_submissions_location_idx ON sign_submissions USING GIST (location);


-- ═══════════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE parking_spots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE parking_spot_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_submissions     ENABLE ROW LEVEL SECURITY;

-- Parking spots: public read only
CREATE POLICY "public read parking spots"
  ON parking_spots FOR SELECT USING (true);

-- Reports: anyone can file, no public read
CREATE POLICY "anyone can file a report"
  ON reports FOR INSERT WITH CHECK (true);

-- Sign submissions: anyone can submit, no public read
CREATE POLICY "anyone can submit a sign"
  ON sign_submissions FOR INSERT WITH CHECK (true);


-- ═══════════════════════════════════════════════════════════════════════════════
-- Storage bucket
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'parking-signs',
  'parking-signs',
  false,
  10485760,   -- 10 MB per file
  ARRAY['image/jpeg', 'image/png', 'image/webp']
);

-- Anonymous users can upload; no public reads (admin only via service role)
CREATE POLICY "anyone can upload parking signs"
  ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'parking-signs');
