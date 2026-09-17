BEGIN;
CREATE TABLE public.club_mega_pig_source_cache (
  club_tag text PRIMARY KEY CHECK(club_tag ~ '^#[A-Z0-9]{1,20}$'),
  payload jsonb, previous_payload jsonb, fetched_at timestamptz, changed_at timestamptz,
  last_attempt_at timestamptz, next_check_at timestamptz,
  lease_token uuid, lease_expires_at timestamptz,
  error_code text CHECK(error_code IN('rate_limited','unavailable','invalid')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 12),
  CHECK(payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536 AND payload->>'clubTag'=club_tag)),
  CHECK(previous_payload IS NULL OR (jsonb_typeof(previous_payload)='object' AND octet_length(previous_payload::text)<=65536 AND previous_payload->>'clubTag'=club_tag))
);
ALTER TABLE public.club_mega_pig_source_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_mega_pig_source_cache FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_mega_pig_source_cache TO service_role;

CREATE FUNCTION public.claim_mega_pig_source_cache(p_club text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='1500ms' AS $$
DECLARE v_club text; v_row public.club_mega_pig_source_cache; v_now timestamptz; v_interval interval; v_due timestamptz;
BEGIN
  IF p_token IS NULL OR p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$' THEN RAISE EXCEPTION 'invalid_source_claim' USING ERRCODE='22023'; END IF;
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club
    FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_club IS DISTINCT FROM p_club THEN RAISE EXCEPTION 'source_club_changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.club_mega_pig_source_cache(club_tag) VALUES(p_club) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_row FROM public.club_mega_pig_source_cache WHERE club_tag=p_club FOR UPDATE;
  v_now:=clock_timestamp();
  v_interval:=CASE WHEN EXISTS(SELECT 1 FROM public.club_planned_events WHERE club_tag=p_club AND kind='mega_pig'
    AND status IN('planned','completed') AND starts_at<=v_now AND ends_at+interval '6 hours'>=v_now) THEN interval '10 minutes' ELSE interval '20 minutes' END;
  -- A newly planned event may shorten a successful cache interval. It cannot
  -- override a provider cooldown or an unfinished/crashed refresh reservation.
  v_due:=v_row.next_check_at;
  IF v_row.error_code IS NULL AND v_row.fetched_at IS NOT NULL AND v_row.last_attempt_at<=v_row.fetched_at THEN
    v_due:=least(v_due,v_row.fetched_at+v_interval);
  END IF;
  IF v_row.lease_expires_at>v_now OR v_due>v_now THEN
    RETURN jsonb_build_object('acquired',false,'entry',(to_jsonb(v_row)-'lease_token')||jsonb_build_object('next_check_at',v_due));
  END IF;
  -- If this worker disappears, another worker still waits at least30 minutes.
  UPDATE public.club_mega_pig_source_cache SET lease_token=p_token,lease_expires_at=v_now+interval '15 seconds',last_attempt_at=v_now,
    next_check_at=v_now+make_interval(secs=>least(21600,1800*power(2,least(consecutive_failures,4)))::integer)
    WHERE club_tag=p_club RETURNING * INTO v_row;
  RETURN jsonb_build_object('acquired',true,'entry',to_jsonb(v_row)-'lease_token');
END $$;

CREATE FUNCTION public.finish_mega_pig_source_cache(p_club text,p_token uuid,p_payload jsonb DEFAULT NULL,p_error_code text DEFAULT NULL,p_retry_after_seconds integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='1500ms' AS $$
DECLARE v_club text; v_row public.club_mega_pig_source_cache; v_now timestamptz; v_interval interval; v_delay integer;
BEGIN
  IF p_token IS NULL OR p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$'
    OR (p_payload IS NULL AND coalesce(p_error_code,'') NOT IN('rate_limited','unavailable','invalid'))
    OR (p_payload IS NOT NULL AND (p_error_code IS NOT NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
      OR octet_length(p_payload::text)>65536 OR p_payload->>'clubTag' IS DISTINCT FROM p_club
      OR jsonb_typeof(p_payload->'members') IS DISTINCT FROM 'array'))
    OR (p_retry_after_seconds IS NOT NULL AND p_retry_after_seconds<0) THEN RAISE EXCEPTION 'invalid_source_finish' USING ERRCODE='22023'; END IF;
  IF p_payload IS NOT NULL AND jsonb_array_length(p_payload->'members')>30 THEN RAISE EXCEPTION 'invalid_source_finish' USING ERRCODE='22023'; END IF;
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club
    FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_club IS DISTINCT FROM p_club THEN RAISE EXCEPTION 'source_club_changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO v_row FROM public.club_mega_pig_source_cache WHERE club_tag=p_club FOR UPDATE;
  v_now:=clock_timestamp();
  IF NOT FOUND OR v_row.lease_token IS DISTINCT FROM p_token OR v_row.lease_expires_at IS NULL OR v_row.lease_expires_at<=v_now THEN
    RETURN jsonb_build_object('accepted',false,'entry',CASE WHEN v_row.club_tag IS NOT NULL THEN to_jsonb(v_row)-'lease_token' END);
  END IF;
  IF p_payload IS NOT NULL THEN
    v_interval:=CASE WHEN EXISTS(SELECT 1 FROM public.club_planned_events WHERE club_tag=p_club AND kind='mega_pig'
      AND status IN('planned','completed') AND starts_at<=v_now AND ends_at+interval '6 hours'>=v_now) THEN interval '10 minutes' ELSE interval '20 minutes' END;
    UPDATE public.club_mega_pig_source_cache SET
      previous_payload=CASE WHEN payload IS DISTINCT FROM p_payload THEN payload ELSE previous_payload END,
      changed_at=CASE WHEN payload IS DISTINCT FROM p_payload THEN v_now ELSE changed_at END,
      payload=p_payload,fetched_at=v_now,next_check_at=v_now+v_interval,error_code=NULL,consecutive_failures=0,lease_token=NULL,lease_expires_at=NULL
      WHERE club_tag=p_club RETURNING * INTO v_row;
  ELSE
    v_delay:=least(21600,1800*power(2,least(v_row.consecutive_failures,4)))::integer;
    -- Respect longer explicit source deadlines, bounded to seven days.
    IF p_error_code='rate_limited' THEN v_delay:=greatest(v_delay,least(604800,coalesce(p_retry_after_seconds,0))); END IF;
    UPDATE public.club_mega_pig_source_cache SET error_code=p_error_code,consecutive_failures=least(consecutive_failures+1,12),
      next_check_at=v_now+make_interval(secs=>v_delay),lease_token=NULL,lease_expires_at=NULL
      WHERE club_tag=p_club RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('accepted',true,'entry',to_jsonb(v_row)-'lease_token');
END $$;
REVOKE ALL ON FUNCTION public.claim_mega_pig_source_cache(text,uuid),public.finish_mega_pig_source_cache(text,uuid,jsonb,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_mega_pig_source_cache(text,uuid),public.finish_mega_pig_source_cache(text,uuid,jsonb,text,integer) TO service_role;

-- Preserve the current capture implementation and extend only its explicit list.
DO $$ DECLARE v_definition text; v_updated text; BEGIN
  v_definition:=pg_get_functiondef('public.create_backup_snapshot(uuid)'::regprocedure);
  IF strpos(v_definition,'''club_mega_pig_source_cache''')=0 THEN
    v_updated:=replace(v_definition,'v_allowed text[] := ARRAY[','v_allowed text[] := ARRAY[''club_mega_pig_source_cache'',');
    IF v_updated=v_definition OR length(v_definition)-length(replace(v_definition,'v_allowed text[] := ARRAY[',''))<>length('v_allowed text[] := ARRAY[') THEN
      RAISE EXCEPTION 'backup_allowlist_patch_mismatch';
    END IF;
    EXECUTE v_updated;
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
