CREATE FUNCTION public.review_sign_submission(
  p_submission_id uuid,
  p_action text,
  p_reviewer_notes text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, extensions, public
AS $$
DECLARE
  submission public.sign_submissions%ROWTYPE;
  spot public.parking_spots%ROWTYPE;
  rules jsonb;
  selected_type public.parking_type;
  confidence numeric;
  merged boolean;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid review action' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO submission
    FROM public.sign_submissions
    WHERE id = p_submission_id AND status = 'pending_review'
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.sign_submissions
      SET status = 'rejected', reviewer_notes = p_reviewer_notes
      WHERE id = submission.id;
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  -- Serialize the nearby-spot lookup and write, including when no spot exists to lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('parkoff.review_sign_submission', 0));

  SELECT candidate.* INTO spot
    FROM public.parking_spots AS candidate
    WHERE candidate.is_active
      AND ST_DWithin(candidate.location, submission.location, 15, false)
    ORDER BY ST_Distance(candidate.location, submission.location, false), candidate.id
    LIMIT 1
    FOR UPDATE;

  merged := FOUND;

  -- Ignore OCR wording and day order when comparing rules. Keep the first copy.
  WITH combined AS (
    SELECT rule, position
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(spot.schedule->'rules') = 'array'
        THEN spot.schedule->'rules' ELSE '[]'::jsonb END
      ||
      CASE WHEN jsonb_typeof(submission.extracted_data->'rules') = 'array'
        THEN submission.extracted_data->'rules' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS entry(rule, position)
    WHERE jsonb_typeof(rule) = 'object'
  ), keyed AS (
    SELECT rule, position, jsonb_build_array(
      rule->'rule_type', rule->'is_prohibited', rule->'tow_away',
      CASE WHEN jsonb_typeof(rule->'days') = 'array' THEN
        (SELECT COALESCE(jsonb_agg(day ORDER BY day), '[]'::jsonb)
          FROM jsonb_array_elements(rule->'days') AS days(day))
      END,
      CASE WHEN jsonb_typeof(rule->'time_window') = 'object' THEN
        jsonb_build_array(rule->'time_window'->'start', rule->'time_window'->'end')
      END,
      rule->'direction', rule->'time_limit_minutes', rule->'cost_per_hour', rule->'permit_zone'
    ) AS identity
    FROM combined
  ), deduplicated AS (
    SELECT DISTINCT ON (identity) rule, position FROM keyed ORDER BY identity, position
  )
  SELECT COALESCE(jsonb_agg(rule ORDER BY position), '[]'::jsonb) INTO rules FROM deduplicated;

  selected_type := CASE
    WHEN rules @> '[{"rule_type":"accessible"}]'::jsonb THEN 'accessible'
    WHEN rules @> '[{"rule_type":"permit_only"}]'::jsonb THEN 'permit'
    WHEN rules @> '[{"rule_type":"paid"}]'::jsonb THEN 'paid'
    WHEN jsonb_array_length(rules) > 0 THEN 'free'
    ELSE 'unknown'
  END;
  confidence := CASE WHEN jsonb_typeof(submission.extracted_data->'confidence') = 'number'
    THEN LEAST(1, GREATEST(0, (submission.extracted_data->>'confidence')::numeric))
    ELSE 0.7
  END;

  IF merged THEN
    UPDATE public.parking_spots
      SET schedule = jsonb_build_object('rules', rules),
          parking_type = selected_type,
          confidence_score = GREATEST(spot.confidence_score, confidence)
      WHERE id = spot.id;
  ELSE
    INSERT INTO public.parking_spots (
      latitude, longitude, parking_type, time_limit_minutes, cost_per_hour,
      schedule, source_type, confidence_score, notes
    ) VALUES (
      submission.latitude, submission.longitude, selected_type,
      (submission.extracted_data->>'time_limit_minutes')::integer,
      (submission.extracted_data->>'cost_per_hour')::numeric,
      jsonb_build_object('rules', rules), 'user', confidence, p_reviewer_notes
    ) RETURNING id INTO spot.id;
  END IF;

  UPDATE public.sign_submissions
    SET status = 'approved', reviewer_notes = p_reviewer_notes, parking_spot_id = spot.id
    WHERE id = submission.id;

  RETURN jsonb_build_object(
    'status', 'approved', 'parking_spot_id', spot.id, 'merged', merged,
    'image_path', submission.image_path, 'extracted_data', submission.extracted_data
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.review_sign_submission(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_sign_submission(uuid, text, text) TO service_role;
