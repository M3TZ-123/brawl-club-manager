-- Small prospective club observations. No game requests or historical backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS public.club_roster_snapshots (
  club_tag text NOT NULL, snapshot_day date NOT NULL,
  first_observed_at timestamptz NOT NULL, last_observed_at timestamptz NOT NULL,
  first_members jsonb NOT NULL CHECK (jsonb_typeof(first_members)='array' AND jsonb_array_length(first_members)<=100),
  last_members jsonb NOT NULL CHECK (jsonb_typeof(last_members)='array' AND jsonb_array_length(last_members)<=100),
  first_run_id uuid NOT NULL, last_run_id uuid NOT NULL,
  PRIMARY KEY(club_tag,snapshot_day), CHECK(last_observed_at>=first_observed_at)
);
CREATE TABLE IF NOT EXISTS public.club_profiles (
  club_tag text PRIMARY KEY, metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND pg_column_size(metadata)<=8192),
  first_observed_at timestamptz NOT NULL, last_observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.club_profile_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL, run_id uuid NOT NULL UNIQUE,
  observed_at timestamptz NOT NULL, before_metadata jsonb, after_metadata jsonb NOT NULL,
  changed_fields text[] NOT NULL,
  CHECK(jsonb_typeof(after_metadata)='object' AND pg_column_size(after_metadata)<=8192),
  CHECK(before_metadata IS NULL OR (jsonb_typeof(before_metadata)='object' AND pg_column_size(before_metadata)<=8192))
);
CREATE INDEX IF NOT EXISTS club_profile_events_timeline ON public.club_profile_events(club_tag,observed_at DESC,id DESC);
ALTER TABLE public.club_roster_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_profile_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_roster_snapshots,public.club_profiles,public.club_profile_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_roster_snapshots,public.club_profiles,public.club_profile_events TO service_role;

CREATE OR REPLACE FUNCTION public.capture_club_intelligence(p_run_id uuid,p_payload jsonb,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_run public.sync_runs;v_members jsonb;v_metadata jsonb;v_before jsonb;v_field text;v_value jsonb;v_changes text[];
BEGIN
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  -- Existing clients and single-member refreshes cannot manufacture a club baseline.
  IF v_run.scope NOT IN('full','roster') OR v_run.status<>'running' OR NOT(p_payload ? 'club_snapshot') THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sync_leases WHERE club_tag=v_run.club_tag AND run_id=p_run_id AND fence=v_run.fence) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='stale_club_snapshot';
  END IF;
  v_members:=p_payload->'club_snapshot'->'members';
  IF jsonb_typeof(v_members) IS DISTINCT FROM 'array' OR jsonb_array_length(v_members)>100 THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE jsonb_typeof(m)<>'object'
    OR jsonb_typeof(m->'tag') IS DISTINCT FROM 'string' OR coalesce(m->>'tag','')!~'^#[A-Z0-9]{2,20}$'
    OR jsonb_typeof(m->'name') IS DISTINCT FROM 'string' OR length(coalesce(m->>'name','')) NOT BETWEEN 1 AND 160
    OR jsonb_typeof(m->'role') IS DISTINCT FROM 'string' OR length(coalesce(m->>'role','')) NOT BETWEEN 1 AND 160
    OR jsonb_typeof(m->'trophies') IS DISTINCT FROM 'number' OR coalesce(m->>'trophies','')!~'^[0-9]{1,10}$') THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE (m->>'trophies')::bigint>2147483647)
    OR (SELECT count(*)<>count(DISTINCT m->>'tag') FROM jsonb_array_elements(v_members)m)
    OR (SELECT array_agg(m->>'tag' ORDER BY m->>'tag') FROM jsonb_array_elements(v_members)m)
      IS DISTINCT FROM (SELECT array_agg(m->>'player_tag' ORDER BY m->>'player_tag') FROM jsonb_array_elements(p_payload->'members')m) THEN RETURN; END IF;
  -- Project again in SQL: neither future payload fields nor private IDs enter history.
  SELECT coalesce(jsonb_agg(jsonb_build_object('tag',m->>'tag','name',m->>'name','role',m->>'role','trophies',(m->>'trophies')::integer) ORDER BY m->>'tag'),'[]') INTO v_members FROM jsonb_array_elements(v_members)m;
  INSERT INTO public.club_roster_snapshots(club_tag,snapshot_day,first_observed_at,last_observed_at,first_members,last_members,first_run_id,last_run_id)
    VALUES(v_run.club_tag,(p_at AT TIME ZONE 'UTC')::date,p_at,p_at,v_members,v_members,p_run_id,p_run_id)
    ON CONFLICT(club_tag,snapshot_day) DO UPDATE SET last_observed_at=excluded.last_observed_at,last_members=excluded.last_members,last_run_id=excluded.last_run_id
      WHERE excluded.last_observed_at>=club_roster_snapshots.last_observed_at;
  SELECT metadata INTO v_before FROM public.club_profiles WHERE club_tag=v_run.club_tag;
  v_metadata:=coalesce(v_before,'{}');
  FOREACH v_field IN ARRAY ARRAY['name','description','type','badgeId','requiredTrophies'] LOOP
    v_value:=p_payload->'club_snapshot'->'metadata'->v_field;
    IF v_field IN('name','description','type') THEN
      IF jsonb_typeof(v_value)='string' AND length(v_value#>>'{}')<=(CASE WHEN v_field='description' THEN 1000 ELSE 160 END)
        AND (v_field='description' OR length(btrim(v_value#>>'{}'))>0) THEN v_metadata:=v_metadata||jsonb_build_object(v_field,v_value); END IF;
    ELSIF jsonb_typeof(v_value)='number' AND v_value::text~'^[0-9]{1,10}$' THEN
      IF v_value::text::bigint<=2147483647 THEN v_metadata:=v_metadata||jsonb_build_object(v_field,v_value); END IF;
    END IF;
  END LOOP;
  INSERT INTO public.club_profiles(club_tag,metadata,first_observed_at,last_observed_at) VALUES(v_run.club_tag,v_metadata,p_at,p_at)
    ON CONFLICT(club_tag) DO UPDATE SET metadata=excluded.metadata,last_observed_at=excluded.last_observed_at;
  IF v_metadata IS DISTINCT FROM v_before AND v_metadata<>'{}'::jsonb THEN
    SELECT array_agg(key ORDER BY key) INTO v_changes FROM jsonb_each(v_metadata) WHERE value IS DISTINCT FROM v_before->key;
    INSERT INTO public.club_profile_events(club_tag,run_id,observed_at,before_metadata,after_metadata,changed_fields)
      VALUES(v_run.club_tag,p_run_id,p_at,v_before,v_metadata,coalesce(v_changes,'{}')) ON CONFLICT(run_id) DO NOTHING;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.capture_club_intelligence(uuid,jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.club_intelligence_read(p_days integer DEFAULT 7,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET statement_timeout='8s' AS $$
DECLARE v_club text;v_tags text[];v_from date;v_result jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN(7,30,90) OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_club_intelligence_range'; END IF;
  SELECT upper(regexp_replace(btrim(value),'^%23','#','i')) INTO v_club FROM public.settings WHERE key='club_tag';
  IF left(coalesce(v_club,''),1)<>'#' THEN v_club:='#'||coalesce(v_club,''); END IF;
  -- Changing the configured club clears these server-owned markers. Until its
  -- first accepted roster, global member rows still describe the previous club.
  SELECT coalesce(array_agg(m.player_tag),'{}') INTO v_tags FROM public.members m JOIN public.member_history h USING(player_tag) WHERE h.is_current_member
    AND EXISTS(SELECT 1 FROM public.settings WHERE key IN('last_sync_time','last_roster_sync_time') AND nullif(btrim(value),'') IS NOT NULL);
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_club_intelligence_roster'; END IF;
  v_from:=(p_now AT TIME ZONE 'UTC')::date-p_days+1;
  WITH inventory AS MATERIALIZED (
    SELECT player_tag,count(*) n,count(*) FILTER(WHERE power_level NOT BETWEEN 1 AND 11 OR power_level IS NULL) unknown,
      count(*) FILTER(WHERE power_level>=9 AND power_level<=11) p9,count(*) FILTER(WHERE power_level>=10 AND power_level<=11) p10,
      count(*) FILTER(WHERE power_level=11) p11 FROM public.player_brawler_details WHERE player_tag=ANY(v_tags) AND observed_at<=p_now GROUP BY player_tag
  ), events AS MATERIALIZED (
    SELECT id,player_tag,player_name,event_type,occurred_at,source FROM public.membership_change_events
    WHERE club_tag=v_club AND event_type IN('join','leave','initial_seen') AND occurred_at>=p_now-interval '120 days' AND occurred_at<=p_now
    ORDER BY occurred_at,id LIMIT 20001
  ) SELECT jsonb_build_object('clubTag',v_club,
    'profile',(SELECT jsonb_build_object('metadata',metadata,'observedAt',last_observed_at) FROM public.club_profiles WHERE club_tag=v_club),
    'members',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',m.player_tag,'name',m.player_name,'role',m.role,'trophies',m.trophies,
      'rank',m.rank_current,'updatedAt',m.last_updated,'inventory',coalesce(i.n,0),'unknownPower',coalesce(i.unknown,0),
      'power9',coalesce(i.p9,0),'power10',coalesce(i.p10,0),'power11',coalesce(i.p11,0)) ORDER BY m.player_name,m.player_tag)
      FROM public.members m LEFT JOIN inventory i USING(player_tag) WHERE m.player_tag=ANY(v_tags)),'[]'),
    'daily',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',player_tag,'day',date,'battles',battles,'wins',wins) ORDER BY date,player_tag)
      FROM public.daily_stats WHERE player_tag=ANY(v_tags) AND date>=v_from AND date<=(p_now AT TIME ZONE 'UTC')::date),'[]'),
    'coverage',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',player_tag,'baselineAt',baseline_started_at,'checkedAt',last_observed_at))
      FROM public.sync_battle_coverage WHERE club_tag=v_club AND player_tag=ANY(v_tags)),'[]'),
    'gaps',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',player_tag,'start',gap_start_at,'end',gap_end_at))
      FROM public.sync_battle_gaps WHERE club_tag=v_club AND player_tag=ANY(v_tags) AND detected_at>=p_now-interval '28 days' AND detected_at<=p_now),'[]'),
    'snapshots',coalesce((SELECT jsonb_agg(jsonb_build_object('firstAt',first_observed_at,'lastAt',last_observed_at,'first',first_members,'last',last_members) ORDER BY snapshot_day)
      FROM public.club_roster_snapshots WHERE club_tag=v_club AND snapshot_day>=(p_now AT TIME ZONE 'UTC')::date-91 AND snapshot_day<=(p_now AT TIME ZONE 'UTC')::date),'[]'),
    'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'tag',player_tag,'name',player_name,'type',event_type,'at',occurred_at,'source',source) ORDER BY occurred_at,id) FROM events),'[]'),
    'eventsTruncated',(SELECT count(*)>20000 FROM events),
    'metadataHistory',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'at',observed_at,'before',before_metadata,'after',after_metadata,'fields',changed_fields) ORDER BY observed_at DESC,id DESC)
      FROM(SELECT * FROM public.club_profile_events WHERE club_tag=v_club AND observed_at<=p_now ORDER BY observed_at DESC,id DESC LIMIT 50) e),'[]')) INTO v_result;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.club_intelligence_read(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.club_intelligence_read(integer,timestamptz) TO service_role;

-- Canonical commit replacements below retain their existing work and add one
-- capture immediately before successful completion. A rollback includes it.

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

  -- Missing source metadata cannot erase a previous observation. Existing legacy
  -- zero trophy changes remain untouched unless a new explicit value is reported.
  INSERT INTO public.battle_history(player_tag,battle_time,mode,map,result,trophy_change,is_star_player,brawler_name,brawler_power,brawler_trophies,teams_json,battle_type,event_id,battle_mode,event_mode,placement_rank,trophy_change_reported,event_mode_id,duration_seconds)
  SELECT x.player_tag,x.battle_time,x.mode,x.map,x.result,x.trophy_change,coalesce(x.is_star_player,false),x.brawler_name,x.brawler_power,x.brawler_trophies,
    CASE WHEN jsonb_typeof(x.teams_json)='string' THEN (x.teams_json #>> '{}')::jsonb ELSE x.teams_json END,
    nullif(x.battle_type,''),x.event_id,nullif(x.battle_mode,''),nullif(x.event_mode,''),x.placement_rank,CASE WHEN x.trophy_change_reported IS NULL THEN NULL ELSE x.trophy_change_reported AND x.trophy_change IS NOT NULL END,x.event_mode_id,public.sync_progress_integer(x.duration_seconds)
  FROM jsonb_to_recordset(p_payload->'battles') AS x(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,brawler_trophies integer,teams_json jsonb,battle_type text,event_id integer,battle_mode text,event_mode text,placement_rank integer,trophy_change_reported boolean,event_mode_id integer,duration_seconds jsonb)
  WHERE x.battle_time >= v_now-interval '90 days' AND x.battle_time <= v_now+interval '1 minute'
  ON CONFLICT(player_tag,battle_time) DO UPDATE SET
    mode=excluded.mode,
    map=excluded.map,
    result=excluded.result,
    trophy_change=CASE WHEN excluded.trophy_change_reported THEN excluded.trophy_change WHEN battle_history.trophy_change_reported THEN battle_history.trophy_change ELSE coalesce(excluded.trophy_change,battle_history.trophy_change) END,
    is_star_player=excluded.is_star_player,
    brawler_name=excluded.brawler_name,
    brawler_power=excluded.brawler_power,
    brawler_trophies=excluded.brawler_trophies,
    teams_json=excluded.teams_json,
    battle_type=coalesce(excluded.battle_type,battle_history.battle_type),
    event_id=coalesce(excluded.event_id,battle_history.event_id),
    battle_mode=coalesce(excluded.battle_mode,battle_history.battle_mode),
    event_mode=coalesce(excluded.event_mode,battle_history.event_mode),
    placement_rank=coalesce(excluded.placement_rank,battle_history.placement_rank),
    trophy_change_reported=CASE WHEN battle_history.trophy_change_reported OR excluded.trophy_change_reported THEN true ELSE coalesce(excluded.trophy_change_reported,battle_history.trophy_change_reported) END,
    event_mode_id=coalesce(excluded.event_mode_id,battle_history.event_mode_id),
    duration_seconds=coalesce(excluded.duration_seconds,battle_history.duration_seconds)
    WHERE ROW(battle_history.mode,battle_history.map,battle_history.result,battle_history.trophy_change,battle_history.is_star_player,battle_history.brawler_name,battle_history.brawler_power,battle_history.brawler_trophies,battle_history.teams_json,battle_history.battle_type,battle_history.event_id,battle_history.battle_mode,battle_history.event_mode,battle_history.placement_rank,battle_history.trophy_change_reported,battle_history.event_mode_id,battle_history.duration_seconds)
      IS DISTINCT FROM ROW(excluded.mode,excluded.map,excluded.result,CASE WHEN excluded.trophy_change_reported THEN excluded.trophy_change WHEN battle_history.trophy_change_reported THEN battle_history.trophy_change ELSE coalesce(excluded.trophy_change,battle_history.trophy_change) END,excluded.is_star_player,excluded.brawler_name,excluded.brawler_power,excluded.brawler_trophies,excluded.teams_json,coalesce(excluded.battle_type,battle_history.battle_type),coalesce(excluded.event_id,battle_history.event_id),coalesce(excluded.battle_mode,battle_history.battle_mode),coalesce(excluded.event_mode,battle_history.event_mode),coalesce(excluded.placement_rank,battle_history.placement_rank),CASE WHEN battle_history.trophy_change_reported OR excluded.trophy_change_reported THEN true ELSE coalesce(excluded.trophy_change_reported,battle_history.trophy_change_reported) END,coalesce(excluded.event_mode_id,battle_history.event_mode_id),coalesce(excluded.duration_seconds,battle_history.duration_seconds));

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
      CASE WHEN v_item->>'ranked_profile_version'='1' THEN coalesce(v_item->>'rank_current',v_old.rank_current)
        WHEN v_item->'rank_available'='true'::jsonb THEN coalesce(v_item->>'rank_current',v_old.rank_current,'Unranked')
        WHEN v_item->'rank_available'='false'::jsonb THEN coalesce(v_old.rank_current,'Unranked')
        ELSE coalesce(nullif(v_item->>'rank_current','Unranked'),v_old.rank_current,'Unranked') END,
      CASE WHEN v_item->>'ranked_profile_version'='1' THEN coalesce(v_item->>'rank_highest',v_old.rank_highest)
        WHEN v_item->'rank_available'='true'::jsonb THEN coalesce(v_item->>'rank_highest',v_old.rank_highest,'Unranked')
        WHEN v_item->'rank_available'='false'::jsonb THEN coalesce(v_old.rank_highest,'Unranked')
        ELSE coalesce(nullif(v_item->>'rank_highest','Unranked'),v_old.rank_highest,'Unranked') END,
      coalesce((v_item->>'win_rate')::integer,v_old.win_rate),(v_item->>'brawlers_count')::integer,(v_item->>'solo_victories')::integer,(v_item->>'duo_victories')::integer,(v_item->>'trio_victories')::integer,v_activity<>'inactive',v_now)
    ON CONFLICT(player_tag) DO UPDATE SET player_name=excluded.player_name,icon_id=excluded.icon_id,role=excluded.role,trophies=excluded.trophies,highest_trophies=excluded.highest_trophies,
      exp_level=excluded.exp_level,rank_current=excluded.rank_current,rank_highest=excluded.rank_highest,win_rate=excluded.win_rate,brawlers_count=excluded.brawlers_count,
      solo_victories=excluded.solo_victories,duo_victories=excluded.duo_victories,trio_victories=excluded.trio_victories,is_active=excluded.is_active,last_updated=excluded.last_updated RETURNING * INTO v_member;
    IF v_item->>'ranked_profile_version'='1' THEN
      UPDATE public.members SET
        ranked_points=coalesce((v_item->>'ranked_points')::integer,ranked_points),
        ranked_all_time_best_points=coalesce((v_item->>'ranked_all_time_best_points')::integer,ranked_all_time_best_points),
        ranked_season_id=coalesce((v_item->>'ranked_season_id')::integer,ranked_season_id),
        ranked_season_best=CASE WHEN v_item ? 'ranked_season_id' AND (v_item->>'ranked_season_id')::integer IS DISTINCT FROM ranked_season_id
          THEN v_item->>'ranked_season_best' ELSE coalesce(v_item->>'ranked_season_best',ranked_season_best) END,
        ranked_season_best_points=CASE WHEN v_item ? 'ranked_season_id' AND (v_item->>'ranked_season_id')::integer IS DISTINCT FROM ranked_season_id
          THEN (v_item->>'ranked_season_best_points')::integer ELSE coalesce((v_item->>'ranked_season_best_points')::integer,ranked_season_best_points) END,
        ranked_checked_at=coalesce((v_item->>'ranked_checked_at')::timestamptz,ranked_checked_at),
        ranked_source=CASE WHEN v_item->>'ranked_source' IN ('profile','rnt','mixed') THEN v_item->>'ranked_source' ELSE ranked_source END,
        ranked_provenance=(coalesce(ranked_provenance,'{}') - CASE WHEN v_item ? 'ranked_season_id' AND (v_item->>'ranked_season_id')::integer IS DISTINCT FROM ranked_season_id
          THEN ARRAY['ranked_season_best','ranked_season_best_points'] ELSE ARRAY[]::text[] END) || public.sync_ranked_provenance(v_item->'ranked_provenance')
      WHERE player_tag=v_tag RETURNING * INTO v_member;
    END IF;

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
  -- Prior daily observations remain history even if a later profile omits a
  -- brawler. Only player_brawler_details represents the latest collection.
  -- The club lease serializes every full/member writer. Use the UTC day
  -- predicate directly so both expression-index and trigger-maintained
  -- recorded_day schemas work without replacing or duplicating indexes.
  UPDATE public.brawler_snapshots s SET brawler_name=x.brawler_name,power_level=x.power_level,trophies=x.trophies,rank=x.rank,
    gadgets_count=coalesce(x.gadgets_count,s.gadgets_count),star_powers_count=coalesce(x.star_powers_count,s.star_powers_count),gears_count=coalesce(x.gears_count,s.gears_count),recorded_at=v_now
  FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,brawler_name text,power_level integer,trophies integer,rank integer,gadgets_count integer,star_powers_count integer,gears_count integer)
  WHERE s.player_tag=x.player_tag AND s.brawler_id=x.brawler_id AND (s.recorded_at AT TIME ZONE 'UTC')::date=(v_now AT TIME ZONE 'UTC')::date
    AND ROW(s.brawler_name,s.power_level,s.trophies,s.rank,s.gadgets_count,s.star_powers_count,s.gears_count)
      IS DISTINCT FROM ROW(x.brawler_name,x.power_level,x.trophies,x.rank,coalesce(x.gadgets_count,s.gadgets_count),coalesce(x.star_powers_count,s.star_powers_count),coalesce(x.gears_count,s.gears_count));
  INSERT INTO public.brawler_snapshots(player_tag,brawler_id,brawler_name,power_level,trophies,rank,gadgets_count,star_powers_count,gears_count,recorded_at)
  SELECT x.player_tag,x.brawler_id,x.brawler_name,x.power_level,x.trophies,x.rank,
    coalesce(x.gadgets_count,jsonb_array_length(d.gadgets)),coalesce(x.star_powers_count,jsonb_array_length(d.star_powers)),coalesce(x.gears_count,jsonb_array_length(d.gears)),v_now
  FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,brawler_name text,power_level integer,trophies integer,rank integer,gadgets_count integer,star_powers_count integer,gears_count integer)
  LEFT JOIN public.player_brawler_details d ON d.player_tag=x.player_tag AND d.brawler_id=x.brawler_id
  WHERE NOT EXISTS(SELECT 1 FROM public.brawler_snapshots s WHERE s.player_tag=x.player_tag AND s.brawler_id=x.brawler_id
    AND (s.recorded_at AT TIME ZONE 'UTC')::date=(v_now AT TIME ZONE 'UTC')::date);

  INSERT INTO public.daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost)
  SELECT b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date,count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),count(*) FILTER(WHERE is_star_player),
    coalesce(sum(greatest(trophy_change,0)) FILTER(WHERE nullif(trim(b.battle_type),'') IS NULL OR public.battle_feed_context(b.battle_type)='ladder'),0),
    coalesce(sum(greatest(-trophy_change,0)) FILTER(WHERE nullif(trim(b.battle_type),'') IS NULL OR public.battle_feed_context(b.battle_type)='ladder'),0)
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
    IF p_payload->'ranked_attempted'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'members') m WHERE m->>'ranked_profile_version'='1') THEN
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
  PERFORM public.sync_apply_player_progress(p_run_id,p_payload,v_now);
  PERFORM public.capture_club_intelligence(p_run_id,p_payload,v_now);
  UPDATE public.sync_runs SET status='succeeded',finished_at=v_now,counts=jsonb_build_object('members',cardinality(v_tags),'battles',jsonb_array_length(p_payload->'battles'),'events',v_event_count),result=v_result WHERE id=p_run_id;
  UPDATE public.sync_leases SET run_id=NULL,expires_at='-infinity' WHERE club_tag=v_run.club_tag AND run_id=p_run_id AND fence=p_fence;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.commit_roster_snapshot(p_run_id uuid,p_fence bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_run public.sync_runs%ROWTYPE; v_lease public.sync_leases%ROWTYPE; v_member public.members%ROWTYPE; v_old public.members%ROWTYPE;
  v_history public.member_history%ROWTYPE; v_item jsonb; v_tags text[]; v_tag text; v_now timestamptz := clock_timestamp();
  v_delta integer; v_last_activity timestamptz; v_activity text; v_threshold integer; v_event_count integer;
  v_before jsonb; v_after jsonb; v_had_member boolean; v_had_history boolean; v_initial boolean; v_role_type text; v_result jsonb; v_configured text;
BEGIN
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  SELECT * INTO STRICT v_lease FROM public.sync_leases WHERE club_tag=v_run.club_tag FOR UPDATE;
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  IF v_run.scope<>'roster' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='sync_scope_mismatch'; END IF;
  IF v_run.status='succeeded' THEN RETURN v_run.result; END IF;
  IF v_run.status<>'running' OR v_lease.run_id IS DISTINCT FROM p_run_id OR v_lease.fence<>p_fence OR v_run.fence<>p_fence OR v_lease.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='stale_sync_fence';
  END IF;
  SELECT upper(regexp_replace(trim(value),'^%23','#','i')) INTO v_configured FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_configured IS NOT NULL AND v_configured<>'' AND (CASE WHEN left(v_configured,1)='#' THEN v_configured ELSE '#'||v_configured END) <> v_run.club_tag THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='club_configuration_changed';
  END IF;
  IF jsonb_typeof(p_payload->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'members')>100 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_snapshot';
  END IF;
  SELECT coalesce(array_agg(x->>'player_tag'),'{}') INTO v_tags FROM jsonb_array_elements(p_payload->'members') x;
  IF cardinality(v_tags)<>(SELECT count(DISTINCT tag) FROM unnest(v_tags) tag)
     OR EXISTS(SELECT 1 FROM unnest(v_tags) tag WHERE tag IS NULL OR tag !~ '^#[A-Z0-9]+$')
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'members') x WHERE jsonb_typeof(x->'player_name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'trophies') IS DISTINCT FROM 'number' OR (x->>'trophies') !~ '^[0-9]+$') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_snapshot_members';
  END IF;
  v_initial := NOT EXISTS(SELECT 1 FROM public.member_history) OR coalesce((p_payload->>'initial_setup')::boolean,false);
  SELECT greatest(48,least(168,CASE WHEN value ~ '^[0-9]+$' THEN value::integer ELSE 48 END)) INTO v_threshold FROM public.settings WHERE key='inactivity_threshold';
  v_threshold := coalesce(v_threshold,48);
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'members') LOOP
    v_tag := v_item->>'player_tag';
    SELECT * INTO v_old FROM public.members WHERE player_tag=v_tag FOR UPDATE; v_had_member := FOUND;
    SELECT * INTO v_history FROM public.member_history WHERE player_tag=v_tag FOR UPDATE; v_had_history := FOUND;
    v_delta := CASE WHEN v_had_member AND v_old.trophies IS NOT NULL THEN (v_item->>'trophies')::integer-v_old.trophies ELSE 0 END;
    SELECT greatest(s.last_activity_at,s.last_battle_at,CASE WHEN v_delta<>0 THEN v_now END) INTO v_last_activity
      FROM (SELECT 1) singleton LEFT JOIN public.member_activity_state s ON s.player_tag=v_tag;
    v_activity := CASE WHEN v_last_activity>=v_now-interval '24 hours' THEN 'active' WHEN v_last_activity>=v_now-make_interval(hours=>v_threshold) THEN 'minimal' ELSE 'inactive' END;
    INSERT INTO public.member_activity_state(player_tag,last_activity_at) VALUES(v_tag,v_last_activity)
      ON CONFLICT(player_tag) DO UPDATE SET last_activity_at=excluded.last_activity_at
        WHERE member_activity_state.last_activity_at IS DISTINCT FROM excluded.last_activity_at;
    -- This transaction owns only fields supplied by the club roster. Existing
    -- profile, ranked, battle, brawler, and tracking data remain intact.
    INSERT INTO public.members(player_tag,player_name,icon_id,role,trophies,is_active,last_updated)
      VALUES(v_tag,v_item->>'player_name',coalesce((v_item->>'icon_id')::integer,v_old.icon_id),coalesce(v_item->>'role',v_old.role),
        (v_item->>'trophies')::integer,v_activity<>'inactive',v_now)
      ON CONFLICT(player_tag) DO UPDATE SET player_name=excluded.player_name,icon_id=excluded.icon_id,role=excluded.role,trophies=excluded.trophies,
        is_active=excluded.is_active,last_updated=excluded.last_updated RETURNING * INTO v_member;
    PERFORM public.sync_record_activity_sample(v_tag,v_member.trophies,v_delta,v_activity,v_now);
    v_before := CASE WHEN v_had_member THEN public.sync_public_snapshot(to_jsonb(v_old)) ELSE NULL END; v_after := public.sync_public_snapshot(to_jsonb(v_member));
    IF v_run.scope='roster' THEN
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

  END LOOP;
  FOR v_history IN SELECT * FROM public.member_history WHERE is_current_member AND NOT(player_tag=ANY(v_tags)) FOR UPDATE LOOP
    SELECT * INTO v_old FROM public.members WHERE player_tag=v_history.player_tag;
    UPDATE public.member_history SET is_current_member=false,last_seen=v_now,last_left_at=v_now,times_left=coalesce(times_left,0)+1,
      role_at_leave=v_old.role,trophies_at_leave=v_old.trophies WHERE player_tag=v_history.player_tag;
    UPDATE public.members SET is_active=false WHERE player_tag=v_history.player_tag;
    PERFORM public.sync_record_event(p_run_id,'leave',v_history.player_tag,v_history.player_name,public.sync_public_snapshot(to_jsonb(v_old)),NULL,v_now);
  END LOOP;
  IF p_payload ? 'required_trophies' AND jsonb_typeof(p_payload->'required_trophies')='number' THEN
    INSERT INTO public.settings(key,value) VALUES('required_trophies',p_payload->>'required_trophies') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  END IF;
  INSERT INTO public.settings(key,value) VALUES('last_roster_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  SELECT count(*) INTO v_event_count FROM public.membership_change_events WHERE run_id=p_run_id;
  v_result := jsonb_build_object('success',true,'synced',cardinality(v_tags),'events',v_event_count,'timestamp',v_now,'runId',p_run_id,'scope','roster',
    'warnings',public.sync_safe_warnings(p_payload->'warnings'),'changes',jsonb_build_object(
      'joins',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='join'),'[]'::jsonb),
      'leaves',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='leave'),'[]'::jsonb)));
  PERFORM public.capture_club_intelligence(p_run_id,p_payload,v_now);
  UPDATE public.sync_runs SET status='succeeded',finished_at=v_now,counts=jsonb_build_object('members',cardinality(v_tags),'battles',0,'events',v_event_count),result=v_result WHERE id=p_run_id;
  UPDATE public.sync_leases SET run_id=NULL,expires_at='-infinity' WHERE club_tag=v_run.club_tag AND run_id=p_run_id AND fence=p_fence;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.run_sync_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_battles integer; v_days integer; v_activity integer; v_snapshots integer; v_notifications integer; v_ranked integer; v_compacted integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(702946183) THEN RETURN jsonb_build_object('skipped',true); END IF;
  DELETE FROM public.club_roster_snapshots WHERE snapshot_day<(now() AT TIME ZONE 'UTC')::date-91;
  DELETE FROM public.battle_history WHERE battle_time<now()-interval '90 days'; GET DIAGNOSTICS v_battles=ROW_COUNT;
  DELETE FROM public.daily_stats WHERE date<(now() AT TIME ZONE 'UTC')::date-365; GET DIAGNOSTICS v_days=ROW_COUNT;
  DELETE FROM public.activity_log WHERE recorded_at<now()-interval '91 days'; GET DIAGNOSTICS v_activity=ROW_COUNT;
  DELETE FROM public.brawler_snapshots WHERE recorded_at<now()-interval '90 days'; GET DIAGNOSTICS v_snapshots=ROW_COUNT;
  DELETE FROM public.notifications WHERE created_at<now()-interval '90 days'; GET DIAGNOSTICS v_notifications=ROW_COUNT;
  DELETE FROM public.notification_outbox WHERE status='sent' AND delivered_at<now()-interval '90 days';
  UPDATE public.notification_outbox SET status='failed',last_error_code='delivery_lease_expired',locked_by=NULL,locked_until=NULL
    WHERE status='in_flight' AND attempts>=8 AND locked_until<=now();
  -- Daily compaction bounds storage while preserving real timestamps and season boundaries.
  DELETE FROM public.player_ranked_history WHERE observed_at<now()-interval '90 days';
  GET DIAGNOSTICS v_ranked=ROW_COUNT;
  WITH older AS (
    SELECT id,row_number() OVER(PARTITION BY player_tag,(observed_at AT TIME ZONE 'UTC')::date,season_id ORDER BY observed_at DESC,id DESC) position
    FROM public.player_ranked_history WHERE observed_at<now()-interval '7 days'
  ) DELETE FROM public.player_ranked_history h USING older o WHERE h.id=o.id AND o.position>1;
  GET DIAGNOSTICS v_compacted=ROW_COUNT;
  v_ranked:=v_ranked+v_compacted;
  RETURN jsonb_build_object('rankedHistory',v_ranked,'battles',v_battles,'dailyStats',v_days,'activity',v_activity,'snapshots',v_snapshots,'notifications',v_notifications);
END $$;
REVOKE ALL ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb),public.commit_roster_snapshot(uuid,bigint,jsonb),public.run_sync_maintenance() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb),public.commit_roster_snapshot(uuid,bigint,jsonb),public.run_sync_maintenance() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
