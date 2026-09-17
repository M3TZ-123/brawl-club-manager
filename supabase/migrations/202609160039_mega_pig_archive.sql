BEGIN;

CREATE TABLE public.club_mega_pig_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
  first_fetched_at timestamptz, last_fetched_at timestamptz,
  origin text NOT NULL CHECK(origin IN('source_fetch','cache_seed','legacy_previous')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((first_fetched_at IS NULL AND last_fetched_at IS NULL) OR
    (first_fetched_at IS NOT NULL AND last_fetched_at IS NOT NULL AND first_fetched_at<=last_fetched_at))
);
CREATE INDEX club_mega_pig_observations_club ON public.club_mega_pig_observations(club_tag,recorded_at DESC,id DESC);
CREATE INDEX club_mega_pig_observations_members ON public.club_mega_pig_observations USING gin((payload->'members') jsonb_path_ops);
CREATE TABLE public.club_mega_pig_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL,
  request_id uuid NOT NULL, create_payload jsonb NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  milestones integer[], notes text NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  initial_observation_id uuid REFERENCES public.club_mega_pig_observations(id),
  capture_enabled boolean NOT NULL DEFAULT false,
  capture_paused_reason text CHECK(capture_paused_reason IN('counters_decreased')),
  last_captured_at timestamptz, reported_total_wins integer, reported_players_played integer,
  final_total_wins integer CHECK(final_total_wins>=0), confirmed_stage integer CHECK(confirmed_stage BETWEEN 0 AND 10),
  reward_status text NOT NULL DEFAULT 'unknown' CHECK(reward_status IN('unknown','received','not_received')),
  finalized_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(club_tag,request_id),
  CHECK(isfinite(starts_at) AND isfinite(ends_at) AND ends_at>starts_at AND ends_at<=starts_at+interval '90 days'),
  CHECK(milestones IS NULL OR cardinality(milestones) BETWEEN 1 AND 10),
  CHECK(NOT capture_enabled OR initial_observation_id IS NOT NULL)
);
CREATE INDEX club_mega_pig_cycles_club ON public.club_mega_pig_cycles(club_tag,starts_at DESC,id DESC);
CREATE TABLE public.club_mega_pig_cycle_members (
  cycle_id uuid NOT NULL REFERENCES public.club_mega_pig_cycles(id), player_tag text NOT NULL,
  first_player_name text NOT NULL, player_name text NOT NULL,
  first_observed_at timestamptz, last_observed_at timestamptz,
  wins integer CHECK(wins>=0), tickets_remaining integer CHECK(tickets_remaining>=0),
  wins_observed_at timestamptz, tickets_observed_at timestamptz,
  latest_wins_unknown boolean NOT NULL DEFAULT true, latest_tickets_unknown boolean NOT NULL DEFAULT true,
  PRIMARY KEY(cycle_id,player_tag)
);
CREATE INDEX club_mega_pig_cycle_members_player ON public.club_mega_pig_cycle_members(player_tag,cycle_id);
CREATE TABLE public.club_mega_pig_cycle_revisions (
  cycle_id uuid NOT NULL REFERENCES public.club_mega_pig_cycles(id), version integer NOT NULL,
  action text NOT NULL CHECK(action IN('save_cycle','finalize_cycle','reopen_cycle','pause_capture')),
  before_snapshot jsonb, after_snapshot jsonb NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=2000), saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(cycle_id,version)
);
ALTER TABLE public.club_mega_pig_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_mega_pig_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_mega_pig_cycle_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_mega_pig_cycle_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_mega_pig_observations,public.club_mega_pig_cycles,public.club_mega_pig_cycle_members,public.club_mega_pig_cycle_revisions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_mega_pig_observations,public.club_mega_pig_cycles,public.club_mega_pig_cycle_members,public.club_mega_pig_cycle_revisions TO service_role;

-- Validate and project only the public source counters; NULL remains unknown.
CREATE FUNCTION public.mega_pig_archive_payload(p_club text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v_member jsonb; v_members jsonb:='[]'; v_tags text[]:='{}'; v_tag text; v_name text;
  v_wins integer; v_tickets integer; v_total integer; v_played integer; v_sum bigint:=0; v_unknown boolean:=false;
BEGIN
  IF p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$' OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
    OR octet_length(p_payload::text)>65536 OR p_payload->>'clubTag' IS DISTINCT FROM p_club
    OR jsonb_typeof(p_payload->'members') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payload->'totalWins') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'reportedPlayersPlayed') IS DISTINCT FROM 'number'
    OR (p_payload->>'totalWins')!~'^(0|[1-9][0-9]*)$' OR (p_payload->>'reportedPlayersPlayed')!~'^(0|[1-9][0-9]*)$'
    THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  v_total:=(p_payload->>'totalWins')::integer; v_played:=(p_payload->>'reportedPlayersPlayed')::integer;
  IF jsonb_array_length(p_payload->'members')>30 OR v_played>jsonb_array_length(p_payload->'members') THEN
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
    v_sum:=v_sum+coalesce(v_wins,0); v_unknown:=v_unknown OR v_wins IS NULL; v_tags:=array_append(v_tags,v_tag);
    v_members:=v_members||jsonb_build_array(jsonb_build_object('playerTag',v_tag,'playerName',v_name,'reportedWins',v_wins,'reportedTicketsRemaining',v_tickets));
  END LOOP;
  IF v_sum>v_total OR (NOT v_unknown AND v_sum<>v_total) THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('clubTag',p_club,'totalWins',v_total,'reportedPlayersPlayed',v_played,'members',v_members);
EXCEPTION WHEN numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid_archive_payload' USING ERRCODE='22023';
END $$;

CREATE FUNCTION public.mega_pig_archive_ready(p_club text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE v_club text; v_value text; v_ready boolean:=false;
BEGIN
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club FROM public.settings WHERE key='club_tag';
  IF v_club IS DISTINCT FROM p_club THEN RETURN false; END IF;
  FOR v_value IN SELECT value FROM public.settings WHERE key IN('last_roster_sync_time','last_sync_time') LOOP
    BEGIN
      IF nullif(btrim(v_value),'') IS NOT NULL AND isfinite(v_value::timestamptz) AND v_value::timestamptz<=statement_timestamp() THEN v_ready:=true; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN NULL; END;
  END LOOP;
  RETURN v_ready;
END $$;

-- The caller already holds the per-club archive lock. A missing current source
-- counter never erases an older known value or its actual fetched timestamp.
CREATE FUNCTION public.mega_pig_archive_apply(p_cycle uuid,p_observation uuid,p_fetched_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb; v_member jsonb;
BEGIN
  SELECT payload INTO STRICT v_payload FROM public.club_mega_pig_observations WHERE id=p_observation;
  UPDATE public.club_mega_pig_cycle_members SET latest_wins_unknown=true,latest_tickets_unknown=true WHERE cycle_id=p_cycle;
  FOR v_member IN SELECT value FROM jsonb_array_elements(v_payload->'members') LOOP
    INSERT INTO public.club_mega_pig_cycle_members(cycle_id,player_tag,first_player_name,player_name,first_observed_at,last_observed_at,
      wins,tickets_remaining,wins_observed_at,tickets_observed_at,latest_wins_unknown,latest_tickets_unknown)
    VALUES(p_cycle,v_member->>'playerTag',v_member->>'playerName',v_member->>'playerName',p_fetched_at,p_fetched_at,
      (v_member->>'reportedWins')::integer,(v_member->>'reportedTicketsRemaining')::integer,
      CASE WHEN v_member->>'reportedWins' IS NOT NULL THEN p_fetched_at END,
      CASE WHEN v_member->>'reportedTicketsRemaining' IS NOT NULL THEN p_fetched_at END,
      v_member->>'reportedWins' IS NULL,v_member->>'reportedTicketsRemaining' IS NULL)
    ON CONFLICT(cycle_id,player_tag) DO UPDATE SET player_name=excluded.player_name,
      first_observed_at=coalesce(club_mega_pig_cycle_members.first_observed_at,excluded.first_observed_at),
      last_observed_at=coalesce(excluded.last_observed_at,club_mega_pig_cycle_members.last_observed_at),
      wins=coalesce(excluded.wins,club_mega_pig_cycle_members.wins),tickets_remaining=coalesce(excluded.tickets_remaining,club_mega_pig_cycle_members.tickets_remaining),
      wins_observed_at=CASE WHEN excluded.wins IS NOT NULL THEN excluded.wins_observed_at ELSE club_mega_pig_cycle_members.wins_observed_at END,
      tickets_observed_at=CASE WHEN excluded.tickets_remaining IS NOT NULL THEN excluded.tickets_observed_at ELSE club_mega_pig_cycle_members.tickets_observed_at END,
      latest_wins_unknown=excluded.latest_wins_unknown,latest_tickets_unknown=excluded.latest_tickets_unknown;
  END LOOP;
  UPDATE public.club_mega_pig_cycles SET reported_total_wins=(v_payload->>'totalWins')::integer,
    reported_players_played=(v_payload->>'reportedPlayersPlayed')::integer,last_captured_at=p_fetched_at,updated_at=clock_timestamp() WHERE id=p_cycle;
END $$;

CREATE FUNCTION public.mega_pig_archive_capture(p_club text,p_payload jsonb,p_fetched_at timestamptz,p_origin text DEFAULT 'source_fetch')
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb; v_last public.club_mega_pig_observations; v_id uuid; v_cycle public.club_mega_pig_cycles; v_before jsonb;
BEGIN
  IF p_origin NOT IN('source_fetch','cache_seed','legacy_previous') OR p_origin IS NULL
    OR (p_fetched_at IS NOT NULL AND (NOT isfinite(p_fetched_at) OR p_fetched_at>clock_timestamp()))
    OR (p_fetched_at IS NULL AND p_origin='source_fetch') THEN RAISE EXCEPTION 'invalid_archive_time' USING ERRCODE='22023'; END IF;
  v_payload:=public.mega_pig_archive_payload(p_club,p_payload);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3901));
  SELECT * INTO v_last FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND v_last.payload=v_payload AND (v_last.last_fetched_at IS NULL)=(p_fetched_at IS NULL) THEN
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
    IF v_cycle.reported_total_wins IS NOT NULL AND (v_payload->>'totalWins')::integer<v_cycle.reported_total_wins THEN
      v_before:=to_jsonb(v_cycle)-'create_payload';
      UPDATE public.club_mega_pig_cycles SET capture_enabled=false,capture_paused_reason='counters_decreased',version=version+1,updated_at=clock_timestamp()
        WHERE id=v_cycle.id RETURNING * INTO v_cycle;
      INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
        VALUES(v_cycle.id,v_cycle.version,'pause_capture',v_before,to_jsonb(v_cycle)-'create_payload','Reported total decreased; cycle identity requires confirmation.');
    ELSE
      PERFORM public.mega_pig_archive_apply(v_cycle.id,v_id,p_fetched_at);
    END IF;
  END LOOP;
  RETURN v_id;
END $$;

CREATE FUNCTION public.mega_pig_archive_write(p_club text,p_action text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='5s' AS $$
DECLARE v_cycle public.club_mega_pig_cycles; v_old public.club_mega_pig_cycles; v_input jsonb; v_request uuid; v_id uuid;
  v_version integer; v_title text; v_notes text; v_start timestamptz; v_end timestamptz; v_milestones integer[]; v_item jsonb;
  v_enabled boolean; v_initial uuid; v_observation public.club_mega_pig_observations; v_reanchor boolean:=false;
  v_total integer; v_stage integer; v_reward text; v_reason text:=''; v_count integer; v_before jsonb; v_now timestamptz;
BEGIN
  IF p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$' OR p_action IS NULL OR p_action NOT IN('save_cycle','finalize_cycle','reopen_cycle')
    OR p_body IS NULL OR jsonb_typeof(p_body)<>'object' OR octet_length(p_body::text)>16384
    OR jsonb_typeof(p_body->'version') IS DISTINCT FROM 'number' OR (p_body->>'version')!~'^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'invalid_archive_action' USING ERRCODE='22023'; END IF;
  v_id:=(p_body->>'id')::uuid; v_version:=(p_body->>'version')::integer;
  -- Same ordering as source finish: configuration first, archive second. Never
  -- acquire the source cache row lock from an administrative action.
  PERFORM 1 FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF NOT public.mega_pig_archive_ready(p_club) THEN RAISE EXCEPTION 'archive_roster_not_ready' USING ERRCODE='55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3901));
  v_now:=clock_timestamp();
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.club_mega_pig_cycles WHERE id=v_id AND club_tag=p_club FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'archive_cycle_not_found' USING ERRCODE='P0002'; END IF;
    IF v_old.version<>v_version THEN RAISE EXCEPTION 'archive_version_changed' USING ERRCODE='40001'; END IF;
    v_before:=to_jsonb(v_old)-'create_payload';
  END IF;
  IF p_action='save_cycle' THEN
    v_request:=(p_body->>'requestId')::uuid; v_input:=p_body->'cycle';
    IF v_request IS NULL OR jsonb_typeof(v_input) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_input->'title') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_input->'startsAt') IS DISTINCT FROM 'string' OR jsonb_typeof(v_input->'endsAt') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_input->'captureEnabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_input->'notes') IS DISTINCT FROM 'string'
      OR NOT(v_input?'milestones') THEN RAISE EXCEPTION 'invalid_archive_cycle' USING ERRCODE='22023'; END IF;
    v_title:=btrim(v_input->>'title'); v_notes:=v_input->>'notes'; v_start:=(v_input->>'startsAt')::timestamptz; v_end:=(v_input->>'endsAt')::timestamptz;
    v_enabled:=(v_input->>'captureEnabled')::boolean; v_initial:=(v_input->>'initialObservationId')::uuid;
    IF v_title='' OR length(v_title)>100 OR length(v_notes)>2000 OR NOT isfinite(v_start) OR NOT isfinite(v_end)
      OR v_end<=v_start OR v_end>v_start+interval '90 days' THEN RAISE EXCEPTION 'invalid_archive_cycle' USING ERRCODE='22023'; END IF;
    IF v_input->'milestones'<>'null'::jsonb THEN
      IF jsonb_typeof(v_input->'milestones')<>'array' THEN RAISE EXCEPTION 'invalid_archive_milestones' USING ERRCODE='22023'; END IF;
      v_milestones:='{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(v_input->'milestones') LOOP
        IF jsonb_typeof(v_item)<>'number' OR v_item::text!~'^[1-9][0-9]*$'
          OR (cardinality(v_milestones)>0 AND v_item::text::integer<=v_milestones[cardinality(v_milestones)]) THEN
          RAISE EXCEPTION 'invalid_archive_milestones' USING ERRCODE='22023'; END IF;
        v_milestones:=array_append(v_milestones,v_item::text::integer);
      END LOOP;
      IF cardinality(v_milestones) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'invalid_archive_milestones' USING ERRCODE='22023'; END IF;
    END IF;
    IF v_id IS NULL THEN
      IF v_version<>0 THEN RAISE EXCEPTION 'invalid_archive_version' USING ERRCODE='22023'; END IF;
      SELECT * INTO v_cycle FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND request_id=v_request;
      IF FOUND THEN
        IF v_cycle.create_payload IS DISTINCT FROM v_input THEN RAISE EXCEPTION 'archive_request_changed' USING ERRCODE='40001'; END IF;
        RETURN jsonb_build_object('cycle_id',v_cycle.id,'version',v_cycle.version,'replayed',true);
      END IF;
    ELSE
      IF v_old.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'archive_cycle_finalized' USING ERRCODE='55000'; END IF;
      IF v_old.initial_observation_id IS NOT NULL AND (v_start,v_end) IS DISTINCT FROM (v_old.starts_at,v_old.ends_at) THEN
        RAISE EXCEPTION 'archive_dates_locked' USING ERRCODE='55000'; END IF;
      v_initial:=coalesce(v_initial,v_old.initial_observation_id);
      v_reanchor:=v_old.initial_observation_id IS NOT NULL AND v_initial IS DISTINCT FROM v_old.initial_observation_id;
      IF v_reanchor AND (v_old.capture_paused_reason IS NULL OR btrim(v_notes)='') THEN
        RAISE EXCEPTION 'archive_reconfirmation_required' USING ERRCODE='22023'; END IF;
      IF v_old.capture_paused_reason IS NOT NULL AND v_enabled AND NOT v_reanchor THEN
        RAISE EXCEPTION 'archive_reconfirmation_required' USING ERRCODE='22023'; END IF;
    END IF;
    IF v_enabled AND v_initial IS NULL THEN RAISE EXCEPTION 'archive_confirmation_required' USING ERRCODE='22023'; END IF;
    IF v_initial IS NOT NULL THEN
      SELECT * INTO v_observation FROM public.club_mega_pig_observations WHERE id=v_initial AND club_tag=p_club;
      IF NOT FOUND THEN RAISE EXCEPTION 'archive_reading_not_found' USING ERRCODE='P0002'; END IF;
    END IF;
    IF v_enabled AND EXISTS(SELECT 1 FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND id IS DISTINCT FROM v_id
      AND capture_enabled AND finalized_at IS NULL AND tstzrange(starts_at,ends_at,'[]') && tstzrange(v_start,v_end,'[]')) THEN
      RAISE EXCEPTION 'archive_capture_overlap' USING ERRCODE='40001'; END IF;
    IF v_id IS NULL THEN
      INSERT INTO public.club_mega_pig_cycles(club_tag,request_id,create_payload,title,starts_at,ends_at,milestones,notes,initial_observation_id,capture_enabled)
        VALUES(p_club,v_request,v_input,v_title,v_start,v_end,v_milestones,v_notes,v_initial,v_enabled) RETURNING * INTO v_cycle;
      SELECT count(*) INTO v_count FROM public.member_history WHERE is_current_member;
      IF v_count>30 THEN RAISE EXCEPTION 'archive_roster_limit' USING ERRCODE='54000'; END IF;
      INSERT INTO public.club_mega_pig_cycle_members(cycle_id,player_tag,first_player_name,player_name)
        SELECT v_cycle.id,player_tag,player_name,player_name FROM public.member_history WHERE is_current_member;
    ELSE
      UPDATE public.club_mega_pig_cycles SET title=v_title,milestones=v_milestones,notes=v_notes,starts_at=v_start,ends_at=v_end,
        initial_observation_id=v_initial,capture_enabled=v_enabled,
        capture_paused_reason=CASE WHEN v_reanchor THEN NULL ELSE capture_paused_reason END,
        version=version+1,updated_at=v_now WHERE id=v_id RETURNING * INTO v_cycle;
    END IF;
    -- An administrator may explicitly attach a reading fetched outside the
    -- chosen window. Its original timestamp remains visible and unmodified.
    IF v_initial IS NOT NULL AND (v_old.initial_observation_id IS NULL OR v_reanchor) THEN
      PERFORM public.mega_pig_archive_apply(v_cycle.id,v_initial,v_observation.last_fetched_at);
      SELECT * INTO v_cycle FROM public.club_mega_pig_cycles WHERE id=v_cycle.id;
    END IF;
  ELSIF p_action='finalize_cycle' THEN
    IF v_id IS NULL THEN RAISE EXCEPTION 'invalid_archive_cycle' USING ERRCODE='22023'; END IF;
    IF v_old.finalized_at IS NOT NULL OR v_now<v_old.ends_at THEN RAISE EXCEPTION 'archive_not_ended' USING ERRCODE='55000'; END IF;
    IF NOT(p_body?'finalTotalWins') OR NOT(p_body?'confirmedStage')
      OR (p_body->'finalTotalWins'<>'null'::jsonb AND (jsonb_typeof(p_body->'finalTotalWins')<>'number' OR (p_body->>'finalTotalWins')!~'^(0|[1-9][0-9]*)$'))
      OR (p_body->'confirmedStage'<>'null'::jsonb AND (jsonb_typeof(p_body->'confirmedStage')<>'number' OR (p_body->>'confirmedStage')!~'^(0|[1-9][0-9]*)$'))
      OR jsonb_typeof(p_body->'notes') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid_archive_final' USING ERRCODE='22023'; END IF;
    v_total:=(p_body->>'finalTotalWins')::integer; v_stage:=(p_body->>'confirmedStage')::integer;
    v_reward:=p_body->>'rewardStatus'; v_notes:=p_body->>'notes';
    IF v_reward IS NULL OR v_reward NOT IN('unknown','received','not_received') OR length(v_notes)>2000
      OR v_stage>coalesce(cardinality(v_old.milestones),5) THEN RAISE EXCEPTION 'invalid_archive_final' USING ERRCODE='22023'; END IF;
    IF v_total IS NOT NULL AND v_stage IS NOT NULL AND v_old.milestones IS NOT NULL THEN
      SELECT count(*) INTO v_count FROM unnest(v_old.milestones) threshold WHERE threshold<=v_total;
      IF v_count<>v_stage THEN RAISE EXCEPTION 'archive_final_conflict' USING ERRCODE='22023'; END IF;
    END IF;
    UPDATE public.club_mega_pig_cycles SET final_total_wins=v_total,confirmed_stage=v_stage,reward_status=v_reward,
      finalized_at=v_now,capture_enabled=false,notes=v_notes,version=version+1,updated_at=v_now WHERE id=v_id RETURNING * INTO v_cycle;
  ELSE
    v_reason:=btrim(p_body->>'reason');
    IF v_id IS NULL OR v_reason IS NULL OR v_reason='' OR length(v_reason)>2000 THEN RAISE EXCEPTION 'invalid_archive_reopen' USING ERRCODE='22023'; END IF;
    IF v_old.finalized_at IS NULL THEN RAISE EXCEPTION 'archive_not_finalized' USING ERRCODE='55000'; END IF;
    UPDATE public.club_mega_pig_cycles SET finalized_at=NULL,final_total_wins=NULL,confirmed_stage=NULL,reward_status='unknown',capture_enabled=false,
      version=version+1,updated_at=v_now WHERE id=v_id RETURNING * INTO v_cycle;
  END IF;
  INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
    VALUES(v_cycle.id,v_cycle.version,p_action,v_before,to_jsonb(v_cycle)-'create_payload',v_reason);
  RETURN jsonb_build_object('cycle_id',v_cycle.id,'version',v_cycle.version,'replayed',false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'invalid_archive_action' USING ERRCODE='22023';
END $$;

CREATE FUNCTION public.mega_pig_archive_observation_summary(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',o.id,'first_fetched_at',o.first_fetched_at,'last_fetched_at',o.last_fetched_at,
    'total_wins',(o.payload->>'totalWins')::integer,'reported_players_played',(o.payload->>'reportedPlayersPlayed')::integer,
    'source_members',jsonb_array_length(o.payload->'members'),
    'unknown_members',(SELECT count(*) FROM jsonb_array_elements(o.payload->'members') m WHERE m->>'reportedWins' IS NULL OR m->>'reportedTicketsRemaining' IS NULL))
  FROM public.club_mega_pig_observations o WHERE o.id=p_id;
$$;

CREATE FUNCTION public.mega_pig_archive_read(p_club text,p_mode text,p_id uuid DEFAULT NULL,p_player text DEFAULT NULL,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='5s' AS $$
DECLARE v_cycle public.club_mega_pig_cycles; v_observation public.club_mega_pig_observations; v_rows jsonb; v_next integer; v_count bigint; v_latest jsonb;
  v_player_readings jsonb; v_reading_next integer;
BEGIN
  IF p_club IS NULL OR p_club!~'^#[A-Z0-9]{1,20}$' OR p_mode IS NULL OR p_mode NOT IN('cycles','readings','cycle','reading','player')
    OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'invalid_archive_read' USING ERRCODE='22023'; END IF;
  IF NOT public.mega_pig_archive_ready(p_club) THEN RAISE EXCEPTION 'archive_roster_not_ready' USING ERRCODE='55000'; END IF;
  IF p_mode='cycles' THEN
    WITH page AS MATERIALIZED(SELECT * FROM public.club_mega_pig_cycles WHERE club_tag=p_club ORDER BY starts_at DESC,id DESC OFFSET p_offset LIMIT 21)
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(c)-'create_payload'-'request_id' ORDER BY starts_at DESC,id DESC) FROM (SELECT * FROM page ORDER BY starts_at DESC,id DESC LIMIT 20)c),'[]'::jsonb),
      CASE WHEN count(*)>20 THEN p_offset+20 END INTO v_rows,v_next FROM page;
    SELECT count(*) INTO v_count FROM public.club_mega_pig_observations WHERE club_tag=p_club;
    SELECT public.mega_pig_archive_observation_summary(id) INTO v_latest FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC LIMIT 1;
    RETURN jsonb_build_object('cycles',v_rows,'next_offset',v_next,'observation_count',v_count,'latest_observation',v_latest);
  ELSIF p_mode='readings' THEN
    WITH page AS MATERIALIZED(SELECT id,recorded_at FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC OFFSET p_offset LIMIT 21)
    SELECT coalesce((SELECT jsonb_agg(public.mega_pig_archive_observation_summary(id) ORDER BY recorded_at DESC,id DESC) FROM (SELECT * FROM page ORDER BY recorded_at DESC,id DESC LIMIT 20)p),'[]'::jsonb),
      CASE WHEN count(*)>20 THEN p_offset+20 END INTO v_rows,v_next FROM page;
    RETURN jsonb_build_object('observations',v_rows,'next_offset',v_next);
  ELSIF p_mode='cycle' THEN
    SELECT * INTO v_cycle FROM public.club_mega_pig_cycles WHERE id=p_id AND club_tag=p_club;
    IF NOT FOUND THEN RAISE EXCEPTION 'archive_cycle_not_found' USING ERRCODE='P0002'; END IF;
    WITH page AS MATERIALIZED(SELECT m.*,EXISTS(SELECT 1 FROM public.member_history h WHERE h.player_tag=m.player_tag AND h.is_current_member) is_current_member
      FROM public.club_mega_pig_cycle_members m WHERE cycle_id=p_id ORDER BY player_tag OFFSET p_offset LIMIT 51)
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY player_tag) FROM (SELECT * FROM page ORDER BY player_tag LIMIT 50)m),'[]'::jsonb),
      CASE WHEN count(*)>50 THEN p_offset+50 END INTO v_rows,v_next FROM page;
    SELECT public.mega_pig_archive_observation_summary(id) INTO v_latest FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC LIMIT 1;
    RETURN jsonb_build_object('cycle',to_jsonb(v_cycle)-'create_payload'-'request_id','members',v_rows,'next_offset',v_next,'latest_observation',v_latest);
  ELSIF p_mode='reading' THEN
    SELECT * INTO v_observation FROM public.club_mega_pig_observations WHERE id=p_id AND club_tag=p_club;
    IF NOT FOUND THEN RAISE EXCEPTION 'archive_reading_not_found' USING ERRCODE='P0002'; END IF;
    RETURN jsonb_build_object('observation',to_jsonb(v_observation)||public.mega_pig_archive_observation_summary(v_observation.id));
  ELSE
    IF p_player IS NULL OR p_player!~'^#[A-Z0-9]{1,20}$' THEN RAISE EXCEPTION 'invalid_archive_player' USING ERRCODE='22023'; END IF;
    WITH page AS MATERIALIZED(SELECT c.starts_at,c.id,jsonb_build_object('cycle',to_jsonb(c)-'create_payload'-'request_id',
      'member',to_jsonb(m)||jsonb_build_object('is_current_member',EXISTS(SELECT 1 FROM public.member_history h WHERE h.player_tag=m.player_tag AND h.is_current_member))) value
      FROM public.club_mega_pig_cycle_members m JOIN public.club_mega_pig_cycles c ON c.id=m.cycle_id
      WHERE c.club_tag=p_club AND m.player_tag=p_player ORDER BY c.starts_at DESC,c.id DESC OFFSET p_offset LIMIT 21)
    SELECT coalesce((SELECT jsonb_agg(value ORDER BY starts_at DESC,id DESC) FROM (SELECT * FROM page ORDER BY starts_at DESC,id DESC LIMIT 20)p),'[]'::jsonb),
      CASE WHEN count(*)>20 THEN p_offset+20 END INTO v_rows,v_next FROM page;
    WITH page AS MATERIALIZED(SELECT o.id,o.recorded_at,o.payload FROM public.club_mega_pig_observations o
      WHERE o.club_tag=p_club AND (o.payload->'members') @> jsonb_build_array(jsonb_build_object('playerTag',p_player))
      ORDER BY o.recorded_at DESC,o.id DESC OFFSET p_offset LIMIT 21)
    SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('observation',public.mega_pig_archive_observation_summary(id),
      'member',(SELECT m FROM jsonb_array_elements(payload->'members') m WHERE m->>'playerTag'=p_player)) ORDER BY recorded_at DESC,id DESC)
      FROM (SELECT * FROM page ORDER BY recorded_at DESC,id DESC LIMIT 20)p),'[]'::jsonb),
      CASE WHEN count(*)>20 THEN p_offset+20 END INTO v_player_readings,v_reading_next FROM page;
    RETURN jsonb_build_object('player_tag',p_player,'history',v_rows,'player_readings',v_player_readings,'next_offset',coalesce(v_next,v_reading_next));
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mega_pig_archive_payload(text,jsonb),public.mega_pig_archive_ready(text),public.mega_pig_archive_apply(uuid,uuid,timestamptz),
  public.mega_pig_archive_capture(text,jsonb,timestamptz,text),public.mega_pig_archive_observation_summary(uuid),
  public.mega_pig_archive_write(text,text,jsonb),public.mega_pig_archive_read(text,text,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mega_pig_archive_write(text,text,jsonb),public.mega_pig_archive_read(text,text,uuid,text,integer) TO service_role;

-- Extend the existing successful finish transaction without changing its lease,
-- cadence, error handling, or any of the official sync persistence functions.
DO $$ DECLARE v_definition text; v_needle text; v_updated text; BEGIN
  v_definition:=replace(pg_get_functiondef('public.finish_mega_pig_source_cache(text,uuid,jsonb,text,integer)'::regprocedure),chr(13),'');
  v_needle:='payload=p_payload,fetched_at=v_now,next_check_at=v_now+v_interval,error_code=NULL,consecutive_failures=0,lease_token=NULL,lease_expires_at=NULL'||chr(10)||
    '      WHERE club_tag=p_club RETURNING * INTO v_row;';
  IF length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) THEN RAISE EXCEPTION 'archive_finish_patch_mismatch'; END IF;
  v_updated:=replace(v_definition,v_needle,v_needle||chr(10)||'    PERFORM public.mega_pig_archive_capture(p_club,v_row.payload,v_row.fetched_at,''source_fetch'');');
  EXECUTE v_updated;
END $$;

-- Preserve the only known original timestamps. Previous-cache payloads did not
-- store a fetched time, so their archive timestamps deliberately remain NULL.
DO $$ DECLARE c public.club_mega_pig_source_cache; BEGIN
  FOR c IN SELECT * FROM public.club_mega_pig_source_cache ORDER BY club_tag LOOP
    IF c.previous_payload IS NOT NULL THEN PERFORM public.mega_pig_archive_capture(c.club_tag,c.previous_payload,NULL,'legacy_previous'); END IF;
    IF c.payload IS NOT NULL THEN PERFORM public.mega_pig_archive_capture(c.club_tag,c.payload,c.fetched_at,'cache_seed'); END IF;
  END LOOP;
END $$;

DO $$ DECLARE v_definition text; v_updated text; BEGIN
  v_definition:=pg_get_functiondef('public.create_backup_snapshot(uuid)'::regprocedure);
  v_updated:=replace(v_definition,'v_allowed text[] := ARRAY[',
    'v_allowed text[] := ARRAY[''club_mega_pig_observations'',''club_mega_pig_cycles'',''club_mega_pig_cycle_members'',''club_mega_pig_cycle_revisions'',');
  IF v_updated=v_definition OR length(v_definition)-length(replace(v_definition,'v_allowed text[] := ARRAY[',''))<>length('v_allowed text[] := ARRAY[') THEN
    RAISE EXCEPTION 'archive_backup_patch_mismatch'; END IF;
  EXECUTE v_updated;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
