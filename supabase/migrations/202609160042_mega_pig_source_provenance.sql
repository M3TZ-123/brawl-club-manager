BEGIN;

-- Provider cadence belongs to the provider being contacted. Switching to the
-- independent documented API keeps the old provider's evidence and cooldown.
ALTER TABLE public.club_mega_pig_source_cache
  ADD COLUMN source_provider text NOT NULL DEFAULT 'BrawlAce' CHECK(source_provider IN('BrawlAce','BrawlTools')),
  ADD COLUMN previous_provider_state jsonb CHECK(previous_provider_state IS NULL OR
    (jsonb_typeof(previous_provider_state)='object' AND octet_length(previous_provider_state::text)<=2048));

CREATE FUNCTION public.claim_mega_pig_provider_cache(p_club text,p_token uuid,p_provider text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_club text; v_row public.club_mega_pig_source_cache; v_now timestamptz; v_interval interval; v_due timestamptz;
BEGIN
  IF p_token IS NULL OR p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$'
    OR p_provider IS NULL OR p_provider NOT IN('BrawlAce','BrawlTools') THEN
    RAISE EXCEPTION 'invalid_source_claim' USING ERRCODE='22023'; END IF;
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club
    FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_club IS DISTINCT FROM p_club THEN RAISE EXCEPTION 'source_club_changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.club_mega_pig_source_cache(club_tag) VALUES(p_club) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_row FROM public.club_mega_pig_source_cache WHERE club_tag=p_club FOR UPDATE;
  v_now:=clock_timestamp();
  IF v_row.source_provider IS DISTINCT FROM p_provider THEN
    -- Old deployments may finish their existing lease, but cannot switch back
    -- or acquire a new BrawlAce attempt on the BrawlTools schedule.
    IF p_provider<>'BrawlTools' OR v_row.source_provider<>'BrawlAce' OR v_row.lease_expires_at>v_now THEN
      RETURN jsonb_build_object('acquired',false,'entry',to_jsonb(v_row)-'lease_token');
    END IF;
    UPDATE public.club_mega_pig_source_cache SET previous_provider_state=jsonb_build_object(
        'source_provider',source_provider,'transitioned_at',v_now,'last_attempt_at',last_attempt_at,
        'next_check_at',next_check_at,'error_code',error_code,'consecutive_failures',consecutive_failures,
        'lease_expires_at',lease_expires_at),
      source_provider='BrawlTools',last_attempt_at=NULL,next_check_at=NULL,error_code=NULL,consecutive_failures=0,
      lease_token=NULL,lease_expires_at=NULL
      WHERE club_tag=p_club RETURNING * INTO v_row;
  END IF;
  v_interval:=CASE WHEN EXISTS(SELECT 1 FROM public.club_planned_events WHERE club_tag=p_club AND kind='mega_pig'
    AND status IN('planned','completed') AND starts_at<=v_now AND ends_at+interval '6 hours'>=v_now) THEN interval '10 minutes' ELSE interval '20 minutes' END;
  v_due:=v_row.next_check_at;
  IF v_row.error_code IS NULL AND v_row.fetched_at IS NOT NULL AND v_row.last_attempt_at<=v_row.fetched_at THEN
    v_due:=least(v_due,v_row.fetched_at+v_interval);
  END IF;
  IF v_row.lease_expires_at>v_now OR v_due>v_now THEN
    RETURN jsonb_build_object('acquired',false,'entry',(to_jsonb(v_row)-'lease_token')||jsonb_build_object('next_check_at',v_due));
  END IF;
  UPDATE public.club_mega_pig_source_cache SET lease_token=p_token,lease_expires_at=v_now+interval '15 seconds',last_attempt_at=v_now,
    next_check_at=v_now+make_interval(secs=>least(21600,1800*power(2,least(consecutive_failures,4)))::integer)
    WHERE club_tag=p_club RETURNING * INTO v_row;
  RETURN jsonb_build_object('acquired',true,'entry',to_jsonb(v_row)-'lease_token');
END $$;

CREATE OR REPLACE FUNCTION public.claim_mega_pig_source_cache(p_club text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='1500ms' AS $$
BEGIN RETURN public.claim_mega_pig_provider_cache(p_club,p_token,'BrawlAce'); END $$;

CREATE FUNCTION public.claim_mega_pig_brawltools_cache(p_club text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='1500ms' AS $$
BEGIN RETURN public.claim_mega_pig_provider_cache(p_club,p_token,'BrawlTools'); END $$;

-- Keep the existing atomic finish/archive operation and add a provider fence.
DO $$ DECLARE v_definition text; v_needle text; v_updated text; BEGIN
  v_definition:=replace(pg_get_functiondef('public.finish_mega_pig_source_cache(text,uuid,jsonb,text,integer)'::regprocedure),chr(13),'');
  v_needle:='  IF p_payload IS NOT NULL THEN';
  IF length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) THEN
    RAISE EXCEPTION 'source_finish_provider_patch_mismatch'; END IF;
  v_updated:=replace(v_definition,v_needle,
    '  IF p_payload IS NOT NULL AND coalesce(p_payload->>''source'',''BrawlAce'') IS DISTINCT FROM v_row.source_provider THEN'||chr(10)||
    '    RAISE EXCEPTION ''invalid_source_finish'' USING ERRCODE=''22023''; END IF;'||chr(10)||v_needle);
  EXECUTE v_updated;
END $$;

REVOKE ALL ON FUNCTION public.claim_mega_pig_provider_cache(text,uuid,text),
  public.claim_mega_pig_source_cache(text,uuid),public.claim_mega_pig_brawltools_cache(text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_mega_pig_source_cache(text,uuid),public.claim_mega_pig_brawltools_cache(text,uuid) TO service_role;

-- Keep the provider with each observation. Existing BrawlAce payloads remain
-- untouched; missing source metadata is interpreted as BrawlAce when read.
ALTER TABLE public.club_mega_pig_cycles
  DROP CONSTRAINT club_mega_pig_cycles_capture_paused_reason_check;
ALTER TABLE public.club_mega_pig_cycles
  ADD CONSTRAINT club_mega_pig_cycles_capture_paused_reason_check
  CHECK(capture_paused_reason IN('counters_decreased','source_changed'));

CREATE OR REPLACE FUNCTION public.mega_pig_archive_payload(p_club text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v_member jsonb; v_members jsonb:='[]'; v_tags text[]:='{}'; v_tag text; v_name text;
  v_wins integer; v_tickets integer; v_total integer; v_played integer; v_battles integer;
  v_source text; v_sum bigint:=0; v_unknown boolean:=false;
BEGIN
  IF p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$' OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
    OR octet_length(p_payload::text)>65536 OR p_payload->>'clubTag' IS DISTINCT FROM p_club
    OR jsonb_typeof(p_payload->'members') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payload->'totalWins') IS DISTINCT FROM 'number'
    OR (p_payload->>'totalWins')!~'^(0|[1-9][0-9]*)$'
    THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  v_source:=CASE WHEN p_payload?'source' THEN p_payload->>'source' ELSE 'BrawlAce' END;
  IF v_source IS NULL OR v_source NOT IN('BrawlAce','BrawlTools')
    OR (p_payload?'source' AND jsonb_typeof(p_payload->'source') IS DISTINCT FROM 'string')
    OR NOT(p_payload?'reportedPlayersPlayed') THEN
    RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  IF v_source='BrawlAce' THEN
    IF jsonb_typeof(p_payload->'reportedPlayersPlayed') IS DISTINCT FROM 'number'
      OR (p_payload->>'reportedPlayersPlayed')!~'^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  ELSIF p_payload->'reportedPlayersPlayed' IS DISTINCT FROM 'null'::jsonb THEN
    -- BrawlTools totalPlayed describes matches, not the number of members.
    RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023';
  END IF;
  IF p_payload?'reportedBattlesPlayed' AND p_payload->'reportedBattlesPlayed'<>'null'::jsonb THEN
    IF v_source<>'BrawlTools' OR jsonb_typeof(p_payload->'reportedBattlesPlayed') IS DISTINCT FROM 'number'
      OR (p_payload->>'reportedBattlesPlayed')!~'^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  END IF;
  v_total:=(p_payload->>'totalWins')::integer;
  v_played:=(p_payload->>'reportedPlayersPlayed')::integer;
  v_battles:=(p_payload->>'reportedBattlesPlayed')::integer;
  IF jsonb_array_length(p_payload->'members')>30 OR v_total>30000
    OR v_played>jsonb_array_length(p_payload->'members') OR v_battles>30000 OR v_battles<v_total THEN
    RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  FOR v_member IN SELECT value FROM jsonb_array_elements(p_payload->'members') ORDER BY value->>'playerTag' LOOP
    v_tag:=v_member->>'playerTag'; v_name:=v_member->>'playerName';
    IF jsonb_typeof(v_member)<>'object' OR v_tag IS NULL OR v_tag!~'^#[A-Z0-9]{1,20}$' OR v_tag=ANY(v_tags)
      OR jsonb_typeof(v_member->'playerName') IS DISTINCT FROM 'string' OR btrim(v_name)='' OR length(v_name)>160
      OR NOT(v_member?'reportedWins') OR NOT(v_member?'reportedTicketsRemaining') THEN
      RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
    IF (v_member->'reportedWins'<>'null'::jsonb AND (jsonb_typeof(v_member->'reportedWins')<>'number' OR (v_member->>'reportedWins')!~'^(0|[1-9][0-9]*)$'))
      OR (v_member->'reportedTicketsRemaining'<>'null'::jsonb AND (jsonb_typeof(v_member->'reportedTicketsRemaining')<>'number' OR (v_member->>'reportedTicketsRemaining')!~'^(0|[1-9][0-9]*)$')) THEN
      RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
    v_wins:=(v_member->>'reportedWins')::integer; v_tickets:=(v_member->>'reportedTicketsRemaining')::integer;
    IF v_wins>1000 OR v_tickets>1000 THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
    v_sum:=v_sum+coalesce(v_wins,0); v_unknown:=v_unknown OR v_wins IS NULL; v_tags:=array_append(v_tags,v_tag);
    v_members:=v_members||jsonb_build_array(jsonb_build_object('playerTag',v_tag,'playerName',v_name,'reportedWins',v_wins,'reportedTicketsRemaining',v_tickets));
  END LOOP;
  IF v_sum>v_total OR (NOT v_unknown AND v_sum<>v_total) THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('clubTag',p_club,'source',v_source,'totalWins',v_total,
    'reportedPlayersPlayed',v_played,'reportedBattlesPlayed',v_battles,'members',v_members);
EXCEPTION WHEN numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023';
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_capture(p_club text,p_payload jsonb,p_fetched_at timestamptz,p_origin text DEFAULT 'source_fetch')
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb; v_last public.club_mega_pig_observations; v_id uuid; v_cycle public.club_mega_pig_cycles;
  v_before jsonb; v_anchor_source text; v_pause text; v_reason text;
BEGIN
  IF p_origin NOT IN('source_fetch','cache_seed','legacy_previous') OR p_origin IS NULL
    OR (p_fetched_at IS NOT NULL AND (NOT isfinite(p_fetched_at) OR p_fetched_at>clock_timestamp()))
    OR (p_fetched_at IS NULL AND p_origin='source_fetch') THEN RAISE EXCEPTION 'invalid_archive_time' USING ERRCODE='22023'; END IF;
  v_payload:=public.mega_pig_archive_payload(p_club,p_payload);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3901));
  SELECT * INTO v_last FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC LIMIT 1;
  -- Normalize only the comparison, without replacing the preserved payload.
  IF v_last.id IS NOT NULL AND (v_last.payload||jsonb_build_object(
      'source',coalesce(v_last.payload->>'source','BrawlAce'),
      'reportedBattlesPlayed',v_last.payload->'reportedBattlesPlayed'))=v_payload
    AND (v_last.last_fetched_at IS NULL)=(p_fetched_at IS NULL) THEN
    v_id:=v_last.id;
    UPDATE public.club_mega_pig_observations SET first_fetched_at=least(first_fetched_at,p_fetched_at),last_fetched_at=greatest(last_fetched_at,p_fetched_at) WHERE id=v_id;
  ELSE
    INSERT INTO public.club_mega_pig_observations(club_tag,payload,first_fetched_at,last_fetched_at,origin)
      VALUES(p_club,v_payload,p_fetched_at,p_fetched_at,p_origin) RETURNING id INTO v_id;
  END IF;
  IF p_fetched_at IS NULL OR p_origin<>'source_fetch' THEN RETURN v_id; END IF;
  FOR v_cycle IN SELECT * FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled AND capture_paused_reason IS NULL
    AND finalized_at IS NULL AND p_fetched_at>=starts_at AND p_fetched_at<=ends_at
    AND (last_captured_at IS NULL OR p_fetched_at>=last_captured_at) FOR UPDATE LOOP
    SELECT coalesce(payload->>'source','BrawlAce') INTO v_anchor_source
      FROM public.club_mega_pig_observations WHERE id=v_cycle.initial_observation_id AND club_tag=p_club;
    v_pause:=NULL; v_reason:=NULL;
    IF v_anchor_source IS DISTINCT FROM v_payload->>'source' THEN
      v_pause:='source_changed';
      v_reason:='Source changed; confirm the new reading belongs to the same cycle before resuming.';
    ELSIF v_cycle.reported_total_wins IS NOT NULL AND (v_payload->>'totalWins')::integer<v_cycle.reported_total_wins THEN
      v_pause:='counters_decreased';
      v_reason:='Reported total decreased; cycle identity requires confirmation.';
    END IF;
    IF v_pause IS NOT NULL THEN
      v_before:=to_jsonb(v_cycle)-'create_payload';
      UPDATE public.club_mega_pig_cycles SET capture_enabled=false,capture_paused_reason=v_pause,version=version+1,updated_at=clock_timestamp()
        WHERE id=v_cycle.id RETURNING * INTO v_cycle;
      INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
        VALUES(v_cycle.id,v_cycle.version,'pause_capture',v_before,to_jsonb(v_cycle)-'create_payload',v_reason);
    ELSE
      PERFORM public.mega_pig_archive_apply(v_cycle.id,v_id,p_fetched_at);
    END IF;
  END LOOP;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_observation_summary(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',o.id,'first_fetched_at',o.first_fetched_at,'last_fetched_at',o.last_fetched_at,
    'source',coalesce(o.payload->>'source','BrawlAce'),
    'total_wins',(o.payload->>'totalWins')::integer,'reported_players_played',(o.payload->>'reportedPlayersPlayed')::integer,
    'reported_battles_played',(o.payload->>'reportedBattlesPlayed')::integer,
    'source_members',jsonb_array_length(o.payload->'members'),
    'unknown_members',(SELECT count(*) FROM jsonb_array_elements(o.payload->'members') m WHERE m->>'reportedWins' IS NULL OR m->>'reportedTicketsRemaining' IS NULL))
  FROM public.club_mega_pig_observations o WHERE o.id=p_id;
$$;

REVOKE ALL ON FUNCTION public.mega_pig_archive_payload(text,jsonb),
  public.mega_pig_archive_capture(text,jsonb,timestamptz,text),public.mega_pig_archive_observation_summary(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
