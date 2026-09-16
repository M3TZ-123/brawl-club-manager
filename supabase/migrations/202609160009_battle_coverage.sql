-- Observe finite battle-log windows without claiming complete historical data.
-- Candidate gap bounds describe possible missing coverage, never a lost count.
BEGIN;

CREATE TABLE IF NOT EXISTS public.sync_battle_coverage (
  club_tag text NOT NULL,
  player_tag text NOT NULL,
  baseline_started_at timestamptz,
  last_observed_at timestamptz,
  recent_battle_times timestamptz[] NOT NULL DEFAULT '{}',
  last_attempt_at timestamptz NOT NULL,
  last_observation_status text NOT NULL CHECK (last_observation_status IN ('baseline','observed','possible_gap','failed','empty','regressing')),
  last_run_id uuid NOT NULL REFERENCES public.sync_runs(id),
  PRIMARY KEY(club_tag,player_tag)
);
CREATE TABLE IF NOT EXISTS public.sync_battle_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_tag text NOT NULL,
  player_tag text NOT NULL,
  run_id uuid NOT NULL REFERENCES public.sync_runs(id),
  detected_at timestamptz NOT NULL,
  gap_start_at timestamptz NOT NULL,
  gap_end_at timestamptz NOT NULL,
  previous_observed_at timestamptz NOT NULL,
  window_size integer NOT NULL CHECK (window_size BETWEEN 25 AND 100),
  scope text NOT NULL CHECK (scope IN ('full','member')),
  CHECK (gap_start_at<gap_end_at),
  UNIQUE(run_id,player_tag)
);
COMMENT ON COLUMN public.sync_battle_gaps.gap_start_at IS 'Candidate lower bound: newest battle in the previous accepted window; not proof a battle was lost.';
COMMENT ON COLUMN public.sync_battle_gaps.gap_end_at IS 'Candidate upper bound: oldest battle in the newer full window; no missing-battle count is inferred.';
CREATE INDEX IF NOT EXISTS sync_battle_gaps_player_window ON public.sync_battle_gaps(club_tag,player_tag,gap_end_at DESC,detected_at DESC);
ALTER TABLE public.sync_battle_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_battle_gaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_battle_coverage,public.sync_battle_gaps FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.sync_battle_coverage,public.sync_battle_gaps TO service_role;

CREATE OR REPLACE FUNCTION public.sync_battle_coverage_summary(p_club_tag text,p_player_tags text[],p_now timestamptz DEFAULT now())
RETURNS TABLE(player_tag text,baseline_started_at timestamptz,last_observed_at timestamptz,last_attempt_at timestamptz,
  last_observation_status text,possible_gap boolean,last_gap_detected_at timestamptz,gap_start_at timestamptz,gap_end_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT requested.tag,c.baseline_started_at,c.last_observed_at,c.last_attempt_at,
    coalesce(c.last_observation_status,'unknown'),g.detected_at IS NOT NULL,g.detected_at,g.gap_start_at,g.gap_end_at
  FROM (SELECT DISTINCT tag FROM unnest(p_player_tags) tag WHERE tag IS NOT NULL) requested
  LEFT JOIN public.sync_battle_coverage c ON c.club_tag=p_club_tag AND c.player_tag=requested.tag
  LEFT JOIN LATERAL (
    SELECT detected_at,gap_start_at,gap_end_at FROM public.sync_battle_gaps
    WHERE club_tag=p_club_tag AND player_tag=requested.tag
      AND gap_end_at>=p_now-interval '28 days' AND gap_start_at<=p_now AND detected_at<=p_now
    ORDER BY detected_at DESC,id DESC LIMIT 1
  ) g ON true;
$$;
REVOKE ALL ON FUNCTION public.sync_battle_coverage_summary(text,text[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_battle_coverage_summary(text,text[],timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_record_battle_observations(p_run_id uuid,p_observations jsonb,p_member_tags text[],p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run public.sync_runs%ROWTYPE; v_previous public.sync_battle_coverage%ROWTYPE;
  v_item jsonb; v_times timestamptz[]; v_tag text; v_status text; v_accept boolean;
  v_gap_count integer; v_alert_key text; v_message text;
BEGIN
  -- Older application versions supply no observation metadata; do not invent it
  -- from whatever battle rows happen to be stored already.
  IF p_observations IS NULL THEN RETURN; END IF;
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  IF v_run.scope NOT IN ('full','member') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='sync_scope_mismatch'; END IF;
  IF jsonb_typeof(p_observations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_observations';
  END IF;
  IF jsonb_array_length(p_observations)<>cardinality(p_member_tags)
     OR jsonb_array_length(p_observations)>100
     OR (SELECT count(DISTINCT x->>'player_tag') FROM jsonb_array_elements(p_observations) x)<>cardinality(p_member_tags)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_observations) x
       WHERE NOT coalesce((x->>'player_tag')=ANY(p_member_tags),false)
         OR jsonb_typeof(x->'success') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(x->'battle_times') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_observations';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_observations) LOOP
    v_tag := v_item->>'player_tag';
    IF jsonb_array_length(v_item->'battle_times')>100
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_item->'battle_times') t WHERE jsonb_typeof(t) IS DISTINCT FROM 'string')
       OR (v_item->'success'='false'::jsonb AND jsonb_array_length(v_item->'battle_times')<>0) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_observations';
    END IF;
    BEGIN
      SELECT coalesce(array_agg(t ORDER BY t DESC),'{}') INTO v_times
      FROM (SELECT DISTINCT value::timestamptz t FROM jsonb_array_elements_text(v_item->'battle_times')) normalized;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_observations';
    END;
    IF EXISTS(SELECT 1 FROM unnest(v_times) t WHERE NOT isfinite(t) OR t>p_at+interval '1 minute') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_observations';
    END IF;
    SELECT * INTO v_previous FROM public.sync_battle_coverage WHERE club_tag=v_run.club_tag AND player_tag=v_tag FOR UPDATE;
    v_accept := false;
    IF v_item->'success'='false'::jsonb THEN v_status := 'failed';
    ELSIF cardinality(v_times)=0 THEN v_status := 'empty';
    ELSIF cardinality(v_previous.recent_battle_times)>0 AND v_times[1]<v_previous.recent_battle_times[1] THEN v_status := 'regressing';
    ELSE
      v_accept := true;
      v_status := CASE WHEN v_previous.baseline_started_at IS NULL THEN 'baseline' ELSE 'observed' END;
      IF cardinality(v_previous.recent_battle_times)>0 AND cardinality(v_times)>=25
         AND NOT (v_times && v_previous.recent_battle_times)
         AND v_times[cardinality(v_times)]>v_previous.recent_battle_times[1] THEN
        INSERT INTO public.sync_battle_gaps(club_tag,player_tag,run_id,detected_at,gap_start_at,gap_end_at,previous_observed_at,window_size,scope)
          VALUES(v_run.club_tag,v_tag,p_run_id,p_at,v_previous.recent_battle_times[1],v_times[cardinality(v_times)],v_previous.last_observed_at,cardinality(v_times),v_run.scope)
          ON CONFLICT(run_id,player_tag) DO NOTHING;
        v_status := 'possible_gap';
      END IF;
    END IF;
    INSERT INTO public.sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,recent_battle_times,last_attempt_at,last_observation_status,last_run_id)
      VALUES(v_run.club_tag,v_tag,CASE WHEN v_accept THEN coalesce(v_previous.baseline_started_at,p_at) ELSE v_previous.baseline_started_at END,
        CASE WHEN v_accept THEN p_at ELSE v_previous.last_observed_at END,
        CASE WHEN v_accept THEN v_times ELSE coalesce(v_previous.recent_battle_times,'{}') END,p_at,v_status,p_run_id)
      ON CONFLICT(club_tag,player_tag) DO UPDATE SET baseline_started_at=excluded.baseline_started_at,last_observed_at=excluded.last_observed_at,
        recent_battle_times=excluded.recent_battle_times,last_attempt_at=excluded.last_attempt_at,last_observation_status=excluded.last_observation_status,last_run_id=excluded.last_run_id;
  END LOOP;
  SELECT count(*) INTO v_gap_count FROM public.sync_battle_gaps WHERE run_id=p_run_id;
  IF v_gap_count>0 AND coalesce((SELECT value='true' FROM public.settings WHERE key='notifications_enabled'),false)
     AND NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE event_key LIKE 'battle-gap:'||v_run.club_tag||':%' AND created_at>p_at-interval '24 hours') THEN
    v_alert_key := 'battle-gap:'||v_run.club_tag||':'||p_run_id;
    v_message := 'قد توجد فجوة في سجل معارك '||v_gap_count||' من أعضاء النادي؛ تعذر تأكيد اكتمال التاريخ بعد تغير نافذة المصدر. هذا احتمال ولا يعني غياب الأعضاء عن اللعب.';
    INSERT INTO public.notifications(type,title,message,dedupe_key,created_at)
      VALUES('battle_gap','فجوة محتملة في سجل المعارك',v_message,md5(v_alert_key),p_at) ON CONFLICT DO NOTHING;
    INSERT INTO public.notification_outbox(event_key,run_id,payload,created_at)
      VALUES(v_alert_key,p_run_id,jsonb_build_object('username','Brawl Club Manager','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
        'embeds',jsonb_build_array(jsonb_build_object('title','فجوة محتملة في سجل المعارك','description',v_message,'timestamp',p_at))),p_at)
      ON CONFLICT DO NOTHING;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.sync_record_battle_observations(uuid,jsonb,text[],timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sync_safe_warnings(p_warnings jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(code ORDER BY first_seen),'[]'::jsonb) FROM (
    SELECT value AS code,min(position) AS first_seen
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_warnings)='array' THEN p_warnings ELSE '[]'::jsonb END) WITH ORDINALITY item(value,position)
    WHERE value IN ('battle_logs_incomplete','ranked_unavailable','ranked_rate_limited','battle_logs_rate_limited','battle_history_gap')
    GROUP BY value ORDER BY min(position) LIMIT 10
  ) safe;
$$;
REVOKE ALL ON FUNCTION public.sync_safe_warnings(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- The canonical full/member commit follows below. It retains007's portable
-- brawler writes; coverage and its warnings are in the same fenced transaction.

CREATE OR REPLACE FUNCTION public.commit_sync_snapshot(p_run_id uuid,p_fence bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run public.sync_runs%ROWTYPE; v_lease public.sync_leases%ROWTYPE; v_member public.members%ROWTYPE; v_old public.members%ROWTYPE;
  v_history public.member_history%ROWTYPE; v_item jsonb; v_tags text[]; v_tag text; v_now timestamptz := clock_timestamp();
  v_delta integer; v_last_battle timestamptz; v_last_activity timestamptz; v_activity text; v_threshold integer;
  v_before jsonb; v_after jsonb; v_had_member boolean; v_had_history boolean; v_initial boolean; v_role_type text;
  v_power_ups integer; v_unlocks integer; v_has_baseline boolean; v_event_count integer; v_result jsonb; v_configured text;
  v_inactive_names text; v_alert_key text; v_alert_title text; v_inactive_count integer;
BEGIN
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  SELECT * INTO STRICT v_lease FROM public.sync_leases WHERE club_tag=v_run.club_tag FOR UPDATE;
  -- A concurrent caller may have committed while this call waited for the lease.
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  IF v_run.scope NOT IN ('full','member') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='sync_scope_mismatch'; END IF;
  IF v_run.status='succeeded' THEN RETURN v_run.result; END IF;
  IF v_run.status<>'running' OR v_lease.run_id IS DISTINCT FROM p_run_id OR v_lease.fence<>p_fence OR v_run.fence<>p_fence OR v_lease.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence';
  END IF;
  SELECT upper(regexp_replace(trim(value),'^%23','#','i')) INTO v_configured FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_configured IS NOT NULL AND v_configured<>'' AND (CASE WHEN left(v_configured,1)='#' THEN v_configured ELSE '#'||v_configured END) <> v_run.club_tag THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='club_configuration_changed';
  END IF;
  IF jsonb_typeof(p_payload->'members') IS DISTINCT FROM 'array' OR jsonb_typeof(p_payload->'battles') IS DISTINCT FROM 'array' OR jsonb_typeof(p_payload->'brawlers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'members')>100 OR jsonb_array_length(p_payload->'battles')>5000 OR jsonb_array_length(p_payload->'brawlers')>50000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_snapshot';
  END IF;
  SELECT coalesce(array_agg(x->>'player_tag'),'{}') INTO v_tags FROM jsonb_array_elements(p_payload->'members') x;
  IF cardinality(v_tags)<>(SELECT count(DISTINCT tag) FROM unnest(v_tags) tag) OR EXISTS(SELECT 1 FROM unnest(v_tags) tag WHERE tag IS NULL OR tag !~ '^#[A-Z0-9]+$')
     OR (v_run.scope='member' AND (cardinality(v_tags)<>1 OR v_tags[1]<>v_run.player_tag))
     OR EXISTS(SELECT 1 FROM jsonb_array_elements((p_payload->'battles')||(p_payload->'brawlers')) x WHERE NOT coalesce((x->>'player_tag')=ANY(v_tags),false)) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_snapshot_members';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'brawlers') b GROUP BY b->>'player_tag',b->>'brawler_id' HAVING count(*)>1) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_snapshot_brawlers';
  END IF;
  v_initial := NOT EXISTS(SELECT 1 FROM public.member_history) OR coalesce((p_payload->>'initial_setup')::boolean,false);
  SELECT greatest(48,least(168,CASE WHEN value ~ '^[0-9]+$' THEN value::integer ELSE 48 END)) INTO v_threshold FROM public.settings WHERE key='inactivity_threshold';
  v_threshold := coalesce(v_threshold,48);

  PERFORM public.sync_record_battle_observations(p_run_id,p_payload->'battle_observations',v_tags,v_now);

  INSERT INTO public.battle_history(player_tag,battle_time,mode,map,result,trophy_change,is_star_player,brawler_name,brawler_power,brawler_trophies,teams_json)
  SELECT x.player_tag,x.battle_time,x.mode,x.map,x.result,coalesce(x.trophy_change,0),coalesce(x.is_star_player,false),x.brawler_name,x.brawler_power,x.brawler_trophies,
    CASE WHEN jsonb_typeof(x.teams_json)='string' THEN (x.teams_json #>> '{}')::jsonb ELSE x.teams_json END
  FROM jsonb_to_recordset(p_payload->'battles') AS x(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,brawler_trophies integer,teams_json jsonb)
  WHERE x.battle_time >= v_now-interval '90 days' AND x.battle_time <= v_now+interval '1 minute'
  ON CONFLICT(player_tag,battle_time) DO UPDATE SET mode=excluded.mode,map=excluded.map,result=excluded.result,trophy_change=excluded.trophy_change,
    is_star_player=excluded.is_star_player,brawler_name=excluded.brawler_name,brawler_power=excluded.brawler_power,brawler_trophies=excluded.brawler_trophies,teams_json=excluded.teams_json
    WHERE ROW(battle_history.mode,battle_history.map,battle_history.result,battle_history.trophy_change,battle_history.is_star_player,battle_history.brawler_name,battle_history.brawler_power,battle_history.brawler_trophies,battle_history.teams_json)
      IS DISTINCT FROM ROW(excluded.mode,excluded.map,excluded.result,excluded.trophy_change,excluded.is_star_player,excluded.brawler_name,excluded.brawler_power,excluded.brawler_trophies,excluded.teams_json);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'members') LOOP
    v_tag := v_item->>'player_tag';
    SELECT * INTO v_old FROM public.members WHERE player_tag=v_tag FOR UPDATE; v_had_member := FOUND;
    IF v_run.scope='member' AND NOT v_had_member THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member_not_found'; END IF;
    SELECT * INTO v_history FROM public.member_history WHERE player_tag=v_tag FOR UPDATE; v_had_history := FOUND;
    v_delta := CASE WHEN v_had_member AND v_old.trophies IS NOT NULL THEN (v_item->>'trophies')::integer-v_old.trophies ELSE 0 END;
    SELECT greatest(s.last_battle_at,(SELECT max((b->>'battle_time')::timestamptz) FROM jsonb_array_elements(p_payload->'battles') b WHERE b->>'player_tag'=v_tag AND (b->>'battle_time')::timestamptz<=v_now+interval '1 minute')),
      s.last_activity_at INTO v_last_battle,v_last_activity FROM (SELECT 1) singleton LEFT JOIN public.member_activity_state s ON s.player_tag=v_tag;
    v_last_activity := greatest(v_last_activity,v_last_battle,CASE WHEN v_delta<>0 THEN v_now END);
    v_activity := CASE WHEN v_last_activity>=v_now-interval '24 hours' THEN 'active' WHEN v_last_activity>=v_now-make_interval(hours=>v_threshold) THEN 'minimal' ELSE 'inactive' END;
    INSERT INTO public.member_activity_state VALUES(v_tag,v_last_battle,v_last_activity)
      ON CONFLICT(player_tag) DO UPDATE SET last_battle_at=excluded.last_battle_at,last_activity_at=excluded.last_activity_at
      WHERE ROW(member_activity_state.last_battle_at,member_activity_state.last_activity_at) IS DISTINCT FROM ROW(excluded.last_battle_at,excluded.last_activity_at);
    INSERT INTO public.members(player_tag,player_name,icon_id,role,trophies,highest_trophies,exp_level,rank_current,rank_highest,win_rate,brawlers_count,solo_victories,duo_victories,trio_victories,is_active,last_updated)
    VALUES(v_tag,v_item->>'player_name',coalesce((v_item->>'icon_id')::integer,v_old.icon_id),CASE WHEN v_run.scope='member' THEN v_old.role ELSE v_item->>'role' END,
      (v_item->>'trophies')::integer,(v_item->>'highest_trophies')::integer,(v_item->>'exp_level')::integer,
      CASE WHEN v_item->'rank_available'='true'::jsonb THEN coalesce(v_item->>'rank_current',v_old.rank_current,'Unranked')
        WHEN v_item->'rank_available'='false'::jsonb THEN coalesce(v_old.rank_current,'Unranked')
        ELSE coalesce(nullif(v_item->>'rank_current','Unranked'),v_old.rank_current,'Unranked') END,
      CASE WHEN v_item->'rank_available'='true'::jsonb THEN coalesce(v_item->>'rank_highest',v_old.rank_highest,'Unranked')
        WHEN v_item->'rank_available'='false'::jsonb THEN coalesce(v_old.rank_highest,'Unranked')
        ELSE coalesce(nullif(v_item->>'rank_highest','Unranked'),v_old.rank_highest,'Unranked') END,
      coalesce((v_item->>'win_rate')::integer,v_old.win_rate),(v_item->>'brawlers_count')::integer,(v_item->>'solo_victories')::integer,(v_item->>'duo_victories')::integer,(v_item->>'trio_victories')::integer,v_activity<>'inactive',v_now)
    ON CONFLICT(player_tag) DO UPDATE SET player_name=excluded.player_name,icon_id=excluded.icon_id,role=excluded.role,trophies=excluded.trophies,highest_trophies=excluded.highest_trophies,
      exp_level=excluded.exp_level,rank_current=excluded.rank_current,rank_highest=excluded.rank_highest,win_rate=excluded.win_rate,brawlers_count=excluded.brawlers_count,
      solo_victories=excluded.solo_victories,duo_victories=excluded.duo_victories,trio_victories=excluded.trio_victories,is_active=excluded.is_active,last_updated=excluded.last_updated RETURNING * INTO v_member;
    PERFORM public.sync_record_activity_sample(v_tag,v_member.trophies,v_delta,v_activity,v_now);
    v_before := CASE WHEN v_had_member THEN public.sync_public_snapshot(to_jsonb(v_old)) ELSE NULL END; v_after := public.sync_public_snapshot(to_jsonb(v_member));
    IF v_run.scope='full' THEN
      IF NOT v_had_history THEN
        INSERT INTO public.member_history(player_tag,player_name,first_seen,last_seen,times_joined,times_left,is_current_member)
          VALUES(v_tag,v_member.player_name,v_now,v_now,1,0,true);
        PERFORM public.sync_record_event(p_run_id,CASE WHEN v_initial THEN 'initial_seen' ELSE 'join' END,v_tag,v_member.player_name,v_before,v_after,v_now);
      ELSIF NOT coalesce(v_history.is_current_member,false) THEN
        UPDATE public.member_history SET player_name=v_member.player_name,last_seen=v_now,times_joined=coalesce(times_joined,0)+1,is_current_member=true WHERE player_tag=v_tag;
        PERFORM public.sync_record_event(p_run_id,'join',v_tag,v_member.player_name,v_before,v_after,v_now);
      ELSE
        UPDATE public.member_history SET player_name=v_member.player_name,last_seen=v_now WHERE player_tag=v_tag;
      END IF;
    END IF;
    IF v_had_member AND v_old.player_name IS DISTINCT FROM v_member.player_name THEN
      PERFORM public.sync_record_event(p_run_id,'name_change',v_tag,v_member.player_name,v_before,v_after,v_now);
    END IF;
    IF v_had_member AND v_old.role IS DISTINCT FROM v_member.role THEN
      SELECT CASE WHEN n.r<0 OR o.r<0 THEN 'role_change' WHEN n.r>o.r THEN 'promotion' WHEN n.r<o.r THEN 'demotion' ELSE 'role_change' END INTO v_role_type
      FROM (SELECT CASE lower(replace(coalesce(v_old.role,''),' ','')) WHEN 'member' THEN 0 WHEN 'senior' THEN 1 WHEN 'vicepresident' THEN 2 WHEN 'president' THEN 3 ELSE -1 END r) o,
           (SELECT CASE lower(replace(coalesce(v_member.role,''),' ','')) WHEN 'member' THEN 0 WHEN 'senior' THEN 1 WHEN 'vicepresident' THEN 2 WHEN 'president' THEN 3 ELSE -1 END r) n;
      PERFORM public.sync_record_event(p_run_id,v_role_type,v_tag,v_member.player_name,v_before,v_after,v_now);
    END IF;

    SELECT EXISTS(SELECT 1 FROM public.player_brawler_state WHERE player_tag=v_tag) INTO v_has_baseline;
    SELECT coalesce(sum(greatest((b->>'power_level')::integer-s.power_level,0)),0),count(*) FILTER(WHERE s.brawler_id IS NULL AND v_has_baseline)
      INTO v_power_ups,v_unlocks FROM jsonb_array_elements(p_payload->'brawlers') b
      LEFT JOIN public.player_brawler_state s ON s.player_tag=v_tag AND s.brawler_id=(b->>'brawler_id')::integer WHERE b->>'player_tag'=v_tag;
    INSERT INTO public.player_tracking(player_tag,power_ups,unlocks,last_battle_date,last_updated) VALUES(v_tag,v_power_ups,v_unlocks,(v_last_battle AT TIME ZONE 'UTC')::date,v_now)
      ON CONFLICT(player_tag) DO UPDATE SET power_ups=coalesce(player_tracking.power_ups,0)+excluded.power_ups,unlocks=coalesce(player_tracking.unlocks,0)+excluded.unlocks,
        last_battle_date=greatest(player_tracking.last_battle_date,excluded.last_battle_date),last_updated=v_now;
  END LOOP;

  IF v_run.scope='full' THEN
    FOR v_history IN SELECT * FROM public.member_history WHERE is_current_member AND NOT(player_tag=ANY(v_tags)) FOR UPDATE LOOP
      SELECT * INTO v_old FROM public.members WHERE player_tag=v_history.player_tag;
      UPDATE public.member_history SET is_current_member=false,last_seen=v_now,last_left_at=v_now,times_left=coalesce(times_left,0)+1,role_at_leave=v_old.role,trophies_at_leave=v_old.trophies WHERE player_tag=v_history.player_tag;
      UPDATE public.members SET is_active=false WHERE player_tag=v_history.player_tag;
      PERFORM public.sync_record_event(p_run_id,'leave',v_history.player_tag,v_history.player_name,public.sync_public_snapshot(to_jsonb(v_old)),NULL,v_now);
    END LOOP;
  END IF;

  INSERT INTO public.player_brawler_state(player_tag,brawler_id,power_level,observed_at)
  SELECT x.player_tag,x.brawler_id,x.power_level,v_now FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,power_level integer)
    ON CONFLICT(player_tag,brawler_id) DO UPDATE SET power_level=excluded.power_level,observed_at=excluded.observed_at
      WHERE player_brawler_state.power_level IS DISTINCT FROM excluded.power_level;
  -- Remove only brawlers absent from this authoritative full profile; unchanged
  -- daily rows retain their identity, timestamp, and physical storage.
  DELETE FROM public.brawler_snapshots s WHERE s.player_tag=ANY(v_tags)
    AND (s.recorded_at AT TIME ZONE 'UTC')::date=(v_now AT TIME ZONE 'UTC')::date
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'brawlers') b WHERE b->>'player_tag'=s.player_tag AND (b->>'brawler_id')::integer=s.brawler_id);
  -- The club lease serializes every full/member writer. Use the UTC day
  -- predicate directly so both expression-index and trigger-maintained
  -- recorded_day schemas work without replacing or duplicating indexes.
  UPDATE public.brawler_snapshots s SET brawler_name=x.brawler_name,power_level=x.power_level,trophies=x.trophies,rank=x.rank,
    gadgets_count=x.gadgets_count,star_powers_count=x.star_powers_count,gears_count=x.gears_count,recorded_at=v_now
  FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,brawler_name text,power_level integer,trophies integer,rank integer,gadgets_count integer,star_powers_count integer,gears_count integer)
  WHERE s.player_tag=x.player_tag AND s.brawler_id=x.brawler_id AND (s.recorded_at AT TIME ZONE 'UTC')::date=(v_now AT TIME ZONE 'UTC')::date
    AND ROW(s.brawler_name,s.power_level,s.trophies,s.rank,s.gadgets_count,s.star_powers_count,s.gears_count)
      IS DISTINCT FROM ROW(x.brawler_name,x.power_level,x.trophies,x.rank,x.gadgets_count,x.star_powers_count,x.gears_count);
  INSERT INTO public.brawler_snapshots(player_tag,brawler_id,brawler_name,power_level,trophies,rank,gadgets_count,star_powers_count,gears_count,recorded_at)
  SELECT x.player_tag,x.brawler_id,x.brawler_name,x.power_level,x.trophies,x.rank,x.gadgets_count,x.star_powers_count,x.gears_count,v_now
  FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,brawler_name text,power_level integer,trophies integer,rank integer,gadgets_count integer,star_powers_count integer,gears_count integer)
  WHERE NOT EXISTS(SELECT 1 FROM public.brawler_snapshots s WHERE s.player_tag=x.player_tag AND s.brawler_id=x.brawler_id
    AND (s.recorded_at AT TIME ZONE 'UTC')::date=(v_now AT TIME ZONE 'UTC')::date);

  INSERT INTO public.daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost)
  SELECT b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date,count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),count(*) FILTER(WHERE is_star_player),
    coalesce(sum(greatest(trophy_change,0)),0),coalesce(sum(greatest(-trophy_change,0)),0)
  FROM public.battle_history b JOIN (
    SELECT DISTINCT x->>'player_tag' tag,((x->>'battle_time')::timestamptz AT TIME ZONE 'UTC')::date battle_date
    FROM jsonb_array_elements(p_payload->'battles') x WHERE (x->>'battle_time')::timestamptz>=v_now-interval '90 days' AND (x->>'battle_time')::timestamptz<=v_now+interval '1 minute'
  ) affected ON b.player_tag=affected.tag AND (b.battle_time AT TIME ZONE 'UTC')::date=affected.battle_date
  GROUP BY b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date
  ON CONFLICT(player_tag,date) DO UPDATE SET battles=excluded.battles,wins=excluded.wins,losses=excluded.losses,star_player=excluded.star_player,trophies_gained=excluded.trophies_gained,trophies_lost=excluded.trophies_lost
    WHERE ROW(daily_stats.battles,daily_stats.wins,daily_stats.losses,daily_stats.star_player,daily_stats.trophies_gained,daily_stats.trophies_lost)
      IS DISTINCT FROM ROW(excluded.battles,excluded.wins,excluded.losses,excluded.star_player,excluded.trophies_gained,excluded.trophies_lost);
  WITH active AS (
    SELECT player_tag,date,date-(row_number() OVER(PARTITION BY player_tag ORDER BY date))::integer grp FROM public.daily_stats
    WHERE player_tag=ANY(v_tags) AND battles>0 AND date>=(v_now AT TIME ZONE 'UTC')::date-27
  ), streaks AS (
    SELECT player_tag,count(*) length,max(date) last_day FROM active GROUP BY player_tag,grp
  ), totals AS (
    SELECT t.tag,coalesce(sum(d.battles),0) battles,coalesce(sum(d.wins),0) wins,coalesce(sum(d.losses),0) losses,coalesce(sum(d.star_player),0) stars,
      coalesce(sum(d.trophies_gained),0) gained,coalesce(sum(d.trophies_lost),0) lost,count(*) FILTER(WHERE d.battles>0) days,coalesce(max(d.battles),0) peak
    FROM unnest(v_tags) t(tag) LEFT JOIN public.daily_stats d ON d.player_tag=t.tag AND d.date>=(v_now AT TIME ZONE 'UTC')::date-27 GROUP BY t.tag
  ) UPDATE public.player_tracking p SET total_battles=t.battles,total_wins=t.wins,total_losses=t.losses,star_player_count=t.stars,trophies_gained=t.gained,trophies_lost=t.lost,
    active_days=t.days,peak_day_battles=t.peak,best_streak=coalesce((SELECT max(length) FROM streaks s WHERE s.player_tag=t.tag),0),
    current_streak=coalesce((SELECT max(length) FROM streaks s WHERE s.player_tag=t.tag AND last_day>=(v_now AT TIME ZONE 'UTC')::date-1),0),last_updated=v_now
    FROM totals t WHERE p.player_tag=t.tag;

  IF v_run.scope='full' THEN
    IF coalesce((SELECT value='true' FROM public.settings WHERE key='notifications_enabled'),false)
       AND NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE event_key LIKE 'inactive:'||v_run.club_tag||':%' AND created_at>v_now-interval '24 hours') THEN
      SELECT count(*),string_agg(player_name||' ('||player_tag||')',', ' ORDER BY player_tag) INTO v_inactive_count,v_inactive_names
        FROM public.members WHERE player_tag=ANY(v_tags) AND NOT is_active;
      IF v_inactive_count>0 THEN
        v_alert_key := 'inactive:'||v_run.club_tag||':'||p_run_id;
        v_alert_title := v_inactive_count||' Inactive Member(s)';
        v_inactive_names := left(v_inactive_names,3500)||' — inactive for '||v_threshold||'+ hours.';
        INSERT INTO public.notifications(type,title,message,dedupe_key,created_at)
          VALUES('inactive',v_alert_title,v_inactive_names,md5(v_alert_key),v_now) ON CONFLICT DO NOTHING;
        INSERT INTO public.notification_outbox(event_key,run_id,payload) VALUES(v_alert_key,p_run_id,
          jsonb_build_object('username','Brawl Club Manager','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
            'embeds',jsonb_build_array(jsonb_build_object('title',v_alert_title,'description',v_inactive_names,'timestamp',v_now)))) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
    INSERT INTO public.settings(key,value) VALUES('required_trophies',coalesce(p_payload->>'required_trophies','')),('last_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      ('last_full_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      ('last_roster_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    IF NOT (p_payload ? 'battle_logs_complete') OR p_payload->'battle_logs_complete'='true'::jsonb THEN
      INSERT INTO public.settings(key,value) VALUES('last_battle_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    END IF;
    IF p_payload->'ranked_attempted'='true'::jsonb THEN
      INSERT INTO public.settings(key,value) VALUES('last_ranked_attempt_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    END IF;
    IF p_payload->'ranked_complete'='true'::jsonb THEN
      INSERT INTO public.settings(key,value) VALUES('last_ranked_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    END IF;
  END IF;
  SELECT count(*) INTO v_event_count FROM public.membership_change_events WHERE run_id=p_run_id;
  v_result := jsonb_build_object('success',true,'synced',cardinality(v_tags),'events',v_event_count,'timestamp',v_now,'runId',p_run_id,'scope',v_run.scope,'warnings',public.sync_safe_warnings(public.sync_safe_warnings(p_payload->'warnings') || CASE WHEN EXISTS(SELECT 1 FROM public.sync_battle_coverage_summary(v_run.club_tag,v_tags,v_now) WHERE possible_gap) THEN '["battle_history_gap"]'::jsonb ELSE '[]'::jsonb END),
    'changes',jsonb_build_object(
      'joins',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='join'),'[]'::jsonb),
      'leaves',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='leave'),'[]'::jsonb)));
  IF v_run.scope='member' THEN v_result := v_result || jsonb_build_object('member',(SELECT public.sync_public_snapshot(to_jsonb(m)) FROM public.members m WHERE player_tag=v_run.player_tag)); END IF;
  UPDATE public.sync_runs SET status='succeeded',finished_at=v_now,counts=jsonb_build_object('members',cardinality(v_tags),'battles',jsonb_array_length(p_payload->'battles'),'events',v_event_count),result=v_result WHERE id=p_run_id;
  UPDATE public.sync_leases SET run_id=NULL,expires_at='-infinity' WHERE club_tag=v_run.club_tag AND run_id=p_run_id AND fence=p_fence;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
