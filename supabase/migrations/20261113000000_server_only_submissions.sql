-- ═══════════════════════════════════════════════════════════════════════════════
-- Sign submissions are written by the server only
--
-- Photos and submission rows are now created by /api/submissions and
-- /api/can-i-park using the service role, after rate limiting and validation.
-- Anonymous clients no longer need (or get) direct write access, so the public
-- anon key cannot be used to fill the bucket or the table with junk.
--
-- Deploy the application code that uses /api/submissions BEFORE running this,
-- otherwise an older client that still uploads from the browser will fail.
-- ═══════════════════════════════════════════════════════════════════════════════

-- No anonymous uploads to the sign photo bucket
DROP POLICY IF EXISTS "anyone can upload parking signs" ON storage.objects;

-- No anonymous inserts into sign_submissions. RLS stays enabled with no
-- policies, so only the service role (which bypasses RLS) can read or write.
DROP POLICY IF EXISTS "anyone can submit a sign" ON sign_submissions;

-- The app only ever stores JPEGs, capped well below the old 10 MB limit.
-- Keep this at or above AI_MAX_IMAGE_BYTES (default 3 MB) in the app config.
UPDATE storage.buckets
SET file_size_limit    = 4194304,           -- 4 MB per file
    allowed_mime_types = ARRAY['image/jpeg']
WHERE id = 'parking-signs';
