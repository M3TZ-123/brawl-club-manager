-- Reserve optional ranked requests before network work, independently of snapshot success.
-- The attempt marker is cadence evidence only; it never claims fresh ranked data.
BEGIN;

CREATE OR REPLACE FUNCTION public.begin_sync_ranked_attempt(p_run_id uuid,p_fence bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run public.sync_runs%ROWTYPE; v_lease public.sync_leases%ROWTYPE;
  v_settings jsonb; v_configured text; v_value text; v_now timestamptz;
  v_attempt_at timestamptz; v_cooldown_until timestamptz; v_minutes double precision := 30;
BEGIN
  SELECT * INTO v_run FROM public.sync_runs WHERE id=p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence'; END IF;
  SELECT * INTO v_lease FROM public.sync_leases WHERE club_tag=v_run.club_tag FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence'; END IF;
  -- Another worker may have finished or superseded this run while we waited.
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  IF v_run.scope IS DISTINCT FROM 'full' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='sync_scope_mismatch';
  END IF;
  IF v_run.status<>'running' OR v_lease.run_id IS DISTINCT FROM p_run_id
     OR v_lease.fence IS DISTINCT FROM p_fence OR v_run.fence IS DISTINCT FROM p_fence
     OR v_lease.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence';
  END IF;

  -- Do not rely on the service's earlier settings read. Lock existing rows in a
  -- deterministic order so a concurrent cooldown/configuration update is seen.
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO v_settings
  FROM (SELECT key,value FROM public.settings
    WHERE key IN ('club_tag','sync_ranked_interval_minutes','sync_ranked_cooldown_until',
      'last_ranked_attempt_time','last_ranked_sync_time') ORDER BY key FOR UPDATE) locked_settings;
  v_now := clock_timestamp();
  IF v_lease.expires_at<=v_now THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence';
  END IF;
  v_configured := upper(regexp_replace(trim(v_settings->>'club_tag'),'^%23','#','i'));
  IF v_configured IS NOT NULL AND v_configured<>''
     AND (CASE WHEN left(v_configured,1)='#' THEN v_configured ELSE '#'||v_configured END)<>v_run.club_tag THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='club_configuration_changed';
  END IF;

  BEGIN
    v_minutes := (v_settings->>'sync_ranked_interval_minutes')::double precision;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_minutes := 30;
  END;
  IF v_minutes IS NULL OR NOT (v_minutes>=10 AND v_minutes<=1440) THEN v_minutes := 30; END IF;
  -- Treat missing/malformed dates as absent, matching the service's Date.parse.
  v_value := coalesce(nullif(v_settings->>'last_ranked_attempt_time',''),nullif(v_settings->>'last_ranked_sync_time',''));
  BEGIN
    v_attempt_at := v_value::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_attempt_at := NULL;
  END;
  IF NOT isfinite(v_attempt_at) THEN v_attempt_at := NULL; END IF;
  BEGIN
    v_cooldown_until := nullif(v_settings->>'sync_ranked_cooldown_until','')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_cooldown_until := NULL;
  END;
  IF NOT isfinite(v_cooldown_until) THEN v_cooldown_until := NULL; END IF;
  IF v_cooldown_until>v_now OR v_attempt_at>v_now-(v_minutes-1)*interval '1 minute' THEN RETURN false; END IF;

  INSERT INTO public.settings(key,value)
    VALUES('last_ranked_attempt_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.begin_sync_ranked_attempt(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_sync_ranked_attempt(uuid,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
