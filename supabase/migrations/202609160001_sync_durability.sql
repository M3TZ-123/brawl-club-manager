-- Apply after schema.sql. All ingestion writes commit in one fenced transaction.
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_tag text NOT NULL,
  source text NOT NULL CHECK (source IN ('cron','manual','member')),
  scope text NOT NULL CHECK (scope IN ('full','member')),
  player_tag text,
  idempotency_key text,
  fence bigint NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','superseded')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_message text,
  result jsonb,
  UNIQUE (club_tag,idempotency_key)
);
CREATE INDEX IF NOT EXISTS sync_runs_recent ON public.sync_runs (club_tag,started_at DESC);
CREATE TABLE IF NOT EXISTS public.sync_leases (
  club_tag text PRIMARY KEY,
  fence bigint NOT NULL DEFAULT 0,
  run_id uuid REFERENCES public.sync_runs(id),
  expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE IF NOT EXISTS public.membership_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.sync_runs(id),
  club_tag text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('initial_seen','join','leave','name_change','promotion','demotion','role_change','data_repair')),
  player_tag text NOT NULL,
  player_name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('recorded','reconstructed','unknown')),
  trigger_source text NOT NULL,
  actor text NOT NULL,
  before_snapshot jsonb,
  after_snapshot jsonb,
  provenance jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(provenance)='object'),
  legacy_event_id bigint UNIQUE,
  UNIQUE (run_id,player_tag,event_type)
);
CREATE INDEX IF NOT EXISTS membership_changes_timeline ON public.membership_change_events (occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS membership_changes_player ON public.membership_change_events (player_tag,occurred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  run_id uuid REFERENCES public.sync_runs(id),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_by uuid,
  locked_until timestamptz,
  delivered_at timestamptz,
  last_http_status integer,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS notification_outbox_ready ON public.notification_outbox(status,available_at);
CREATE TABLE IF NOT EXISTS public.member_activity_state (
  player_tag text PRIMARY KEY,
  last_battle_at timestamptz,
  last_activity_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.player_brawler_state (
  player_tag text NOT NULL,
  brawler_id integer NOT NULL,
  power_level integer NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(player_tag,brawler_id)
);
CREATE INDEX IF NOT EXISTS activity_log_player_time ON public.activity_log(player_tag,recorded_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_player_changed ON public.activity_log(player_tag,recorded_at DESC) WHERE trophy_change <> 0;

-- Seed durable baselines without changing or inventing historical values.
INSERT INTO public.player_brawler_state(player_tag,brawler_id,power_level,observed_at)
SELECT DISTINCT ON (player_tag,brawler_id) player_tag,brawler_id,coalesce(power_level,1),recorded_at
FROM public.brawler_snapshots ORDER BY player_tag,brawler_id,recorded_at DESC,id DESC
ON CONFLICT DO NOTHING;
INSERT INTO public.member_activity_state(player_tag,last_battle_at,last_activity_at)
SELECT m.player_tag,b.last_battle_at,greatest(b.last_battle_at,a.last_activity_at)
FROM public.members m
LEFT JOIN LATERAL (SELECT max(battle_time) last_battle_at FROM public.battle_history WHERE player_tag=m.player_tag AND battle_time <= now()+interval '1 minute') b ON true
LEFT JOIN LATERAL (SELECT max(recorded_at) last_activity_at FROM public.activity_log WHERE player_tag=m.player_tag AND trophy_change <> 0 AND recorded_at <= now()) a ON true
ON CONFLICT DO NOTHING;
INSERT INTO public.membership_change_events(club_tag,event_type,player_tag,player_name,occurred_at,source,trigger_source,actor,legacy_event_id,provenance)
SELECT coalesce((SELECT value FROM public.settings WHERE key='club_tag'),'unknown'),event_type,player_tag,player_name,
       coalesce(event_time,now()),CASE WHEN event_time IS NULL THEN 'unknown' ELSE 'reconstructed' END,'legacy','unknown',id,
       jsonb_build_object('sourceCategory','legacy_club_events','timeMeaning',CASE WHEN event_time IS NULL THEN 'imported_at' ELSE 'previously_recorded_at' END)
FROM public.club_events c WHERE event_type IN ('join','leave') AND NOT EXISTS (
  SELECT 1 FROM public.membership_change_events e WHERE e.player_tag=c.player_tag AND e.event_type=c.event_type AND e.occurred_at=c.event_time AND e.source='recorded'
) ON CONFLICT (legacy_event_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.reject_membership_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'membership audit events are immutable'; END $$;
DROP TRIGGER IF EXISTS membership_events_immutable ON public.membership_change_events;
CREATE TRIGGER membership_events_immutable BEFORE UPDATE OR DELETE ON public.membership_change_events
FOR EACH ROW EXECUTE FUNCTION public.reject_membership_event_mutation();

CREATE OR REPLACE FUNCTION public.acquire_sync_run(p_club_tag text,p_source text,p_scope text,p_player_tag text DEFAULT NULL,p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_lease public.sync_leases%ROWTYPE; v_run public.sync_runs%ROWTYPE; v_id uuid; v_fence bigint;
BEGIN
  IF p_club_tag !~ '^#[A-Z0-9]+$' OR p_source NOT IN ('cron','manual','member') OR p_scope NOT IN ('full','member')
     OR (p_scope='member' AND p_player_tag IS NULL) OR length(p_idempotency_key)>128 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_sync_request';
  END IF;
  INSERT INTO public.sync_leases(club_tag) VALUES(p_club_tag) ON CONFLICT DO NOTHING;
  SELECT * INTO v_lease FROM public.sync_leases WHERE club_tag=p_club_tag FOR UPDATE;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_run FROM public.sync_runs WHERE club_tag=p_club_tag AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
      IF v_run.scope<>p_scope OR v_run.player_tag IS DISTINCT FROM p_player_tag THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='idempotency_scope_mismatch';
      END IF;
      IF v_run.status='running' AND (v_lease.run_id IS DISTINCT FROM v_run.id OR v_lease.expires_at<=clock_timestamp()) THEN
        UPDATE public.sync_runs SET status='superseded',finished_at=clock_timestamp(),error_code='lease_expired',
          error_message='The previous worker did not finish before its lease expired.' WHERE id=v_run.id RETURNING * INTO v_run;
      END IF;
      RETURN jsonb_build_object('acquired',false,'replayed',true,'run_id',v_run.id,'status',v_run.status,'result',v_run.result,'error_code',v_run.error_code);
    END IF;
  END IF;
  IF v_lease.run_id IS NOT NULL AND v_lease.expires_at>clock_timestamp() THEN
    RETURN jsonb_build_object('acquired',false,'busy',true,'run_id',v_lease.run_id,'expires_at',v_lease.expires_at);
  END IF;
  IF v_lease.run_id IS NOT NULL THEN
    UPDATE public.sync_runs SET status='superseded',finished_at=clock_timestamp(),error_code='lease_expired',error_message='The previous worker did not finish before its lease expired.'
      WHERE id=v_lease.run_id AND status='running';
  END IF;
  v_fence := v_lease.fence+1;
  INSERT INTO public.sync_runs(club_tag,source,scope,player_tag,idempotency_key,fence)
    VALUES(p_club_tag,p_source,p_scope,p_player_tag,p_idempotency_key,v_fence) RETURNING id INTO v_id;
  UPDATE public.sync_leases SET fence=v_fence,run_id=v_id,expires_at=clock_timestamp()+interval '90 seconds' WHERE club_tag=p_club_tag;
  RETURN jsonb_build_object('acquired',true,'run_id',v_id,'fence',v_fence);
END $$;

CREATE OR REPLACE FUNCTION public.fail_sync_run(p_run_id uuid,p_fence bigint,p_error_code text,p_error_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.sync_leases WHERE run_id=p_run_id AND fence=p_fence FOR UPDATE;
  UPDATE public.sync_runs SET status='failed',finished_at=clock_timestamp(),error_code=left(p_error_code,60),error_message=left(p_error_message,200)
    WHERE id=p_run_id AND fence=p_fence AND status='running';
  UPDATE public.sync_leases SET run_id=NULL,expires_at='-infinity' WHERE run_id=p_run_id AND fence=p_fence;
END $$;

CREATE OR REPLACE FUNCTION public.sync_public_snapshot(p_snapshot jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(p_snapshot)
  WHERE key=ANY(ARRAY['player_tag','player_name','icon_id','role','trophies','highest_trophies','exp_level','rank_current','rank_highest','win_rate','brawlers_count','solo_victories','duo_victories','trio_victories','is_active','last_updated','first_seen','last_seen','last_left_at','times_joined','times_left','is_current_member','role_at_leave','trophies_at_leave'])
    AND jsonb_typeof(value) IN ('string','number','boolean','null');
$$;

CREATE OR REPLACE FUNCTION public.sync_record_event(p_run_id uuid,p_type text,p_player_tag text,p_name text,p_before jsonb,p_after jsonb,p_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_run public.sync_runs%ROWTYPE; v_id uuid; v_title text; v_message text;
BEGIN
  SELECT * INTO STRICT v_run FROM public.sync_runs WHERE id=p_run_id;
  INSERT INTO public.membership_change_events(run_id,club_tag,event_type,player_tag,player_name,occurred_at,source,trigger_source,actor,before_snapshot,after_snapshot,provenance)
    VALUES(p_run_id,v_run.club_tag,p_type,p_player_tag,p_name,p_at,'recorded',v_run.source,
      CASE WHEN v_run.source='cron' THEN 'scheduler' ELSE 'administrator' END,public.sync_public_snapshot(p_before),public.sync_public_snapshot(p_after),
      jsonb_build_object('sourceCategory',CASE WHEN v_run.scope='full' THEN 'club_roster_snapshot' ELSE 'player_profile' END,
        'timeMeaning','observed_at','firstSeenMeaning',CASE WHEN p_type='initial_seen' THEN 'first_observed' ELSE NULL END))
    ON CONFLICT (run_id,player_tag,event_type) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  IF p_type IN ('join','leave') THEN
    INSERT INTO public.club_events(event_type,player_tag,player_name,event_time) VALUES(p_type,p_player_tag,p_name,p_at);
  END IF;
  IF p_type='initial_seen' OR NOT coalesce((SELECT value='true' FROM public.settings WHERE key='notifications_enabled'),false) THEN RETURN v_id; END IF;
  v_title := CASE p_type WHEN 'join' THEN 'Member Joined' WHEN 'leave' THEN 'Member Left' WHEN 'name_change' THEN 'Name Changed' WHEN 'promotion' THEN 'Member Promoted' WHEN 'demotion' THEN 'Member Demoted' ELSE 'Role Changed' END;
  v_message := p_name || ' (' || p_player_tag || '): ' || replace(p_type,'_',' ') || '.';
  INSERT INTO public.notifications(type,title,message,player_tag,player_name,dedupe_key,created_at)
    VALUES(p_type,v_title,v_message,p_player_tag,p_name,v_id::text,p_at) ON CONFLICT(dedupe_key) DO NOTHING;
  INSERT INTO public.notification_outbox(event_key,run_id,payload)
    VALUES(v_id::text,p_run_id,jsonb_build_object('username','Brawl Club Manager','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
      'embeds',jsonb_build_array(jsonb_build_object('title',v_title,'description',v_message,'timestamp',p_at)))) ON CONFLICT DO NOTHING;
  RETURN v_id;
END $$;

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
  v_initial := NOT EXISTS(SELECT 1 FROM public.member_history) OR coalesce((p_payload->>'initial_setup')::boolean,false);
  SELECT greatest(48,least(168,CASE WHEN value ~ '^[0-9]+$' THEN value::integer ELSE 48 END)) INTO v_threshold FROM public.settings WHERE key='inactivity_threshold';
  v_threshold := coalesce(v_threshold,48);

  INSERT INTO public.battle_history(player_tag,battle_time,mode,map,result,trophy_change,is_star_player,brawler_name,brawler_power,brawler_trophies,teams_json)
  SELECT x.player_tag,x.battle_time,x.mode,x.map,x.result,coalesce(x.trophy_change,0),coalesce(x.is_star_player,false),x.brawler_name,x.brawler_power,x.brawler_trophies,
    CASE WHEN jsonb_typeof(x.teams_json)='string' THEN (x.teams_json #>> '{}')::jsonb ELSE x.teams_json END
  FROM jsonb_to_recordset(p_payload->'battles') AS x(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,brawler_trophies integer,teams_json jsonb)
  WHERE x.battle_time >= v_now-interval '90 days' AND x.battle_time <= v_now+interval '1 minute'
  ON CONFLICT(player_tag,battle_time) DO UPDATE SET mode=excluded.mode,map=excluded.map,result=excluded.result,trophy_change=excluded.trophy_change,
    is_star_player=excluded.is_star_player,brawler_name=excluded.brawler_name,brawler_power=excluded.brawler_power,brawler_trophies=excluded.brawler_trophies,teams_json=excluded.teams_json;

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
      ON CONFLICT(player_tag) DO UPDATE SET last_battle_at=excluded.last_battle_at,last_activity_at=excluded.last_activity_at;
    INSERT INTO public.members(player_tag,player_name,icon_id,role,trophies,highest_trophies,exp_level,rank_current,rank_highest,win_rate,brawlers_count,solo_victories,duo_victories,trio_victories,is_active,last_updated)
    VALUES(v_tag,v_item->>'player_name',coalesce((v_item->>'icon_id')::integer,v_old.icon_id),CASE WHEN v_run.scope='member' THEN v_old.role ELSE v_item->>'role' END,
      (v_item->>'trophies')::integer,(v_item->>'highest_trophies')::integer,(v_item->>'exp_level')::integer,
      coalesce(nullif(v_item->>'rank_current','Unranked'),v_old.rank_current,'Unranked'),coalesce(nullif(v_item->>'rank_highest','Unranked'),v_old.rank_highest,'Unranked'),
      coalesce((v_item->>'win_rate')::integer,v_old.win_rate),(v_item->>'brawlers_count')::integer,(v_item->>'solo_victories')::integer,(v_item->>'duo_victories')::integer,(v_item->>'trio_victories')::integer,v_activity<>'inactive',v_now)
    ON CONFLICT(player_tag) DO UPDATE SET player_name=excluded.player_name,icon_id=excluded.icon_id,role=excluded.role,trophies=excluded.trophies,highest_trophies=excluded.highest_trophies,
      exp_level=excluded.exp_level,rank_current=excluded.rank_current,rank_highest=excluded.rank_highest,win_rate=excluded.win_rate,brawlers_count=excluded.brawlers_count,
      solo_victories=excluded.solo_victories,duo_victories=excluded.duo_victories,trio_victories=excluded.trio_victories,is_active=excluded.is_active,last_updated=excluded.last_updated RETURNING * INTO v_member;
    INSERT INTO public.activity_log(player_tag,trophies,trophy_change,activity_type,recorded_at) VALUES(v_tag,v_member.trophies,v_delta,v_activity,v_now);
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
    ON CONFLICT(player_tag,brawler_id) DO UPDATE SET power_level=excluded.power_level,observed_at=excluded.observed_at;
  DELETE FROM public.brawler_snapshots WHERE player_tag=ANY(v_tags) AND recorded_at>=date_trunc('day',v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND recorded_at<(date_trunc('day',v_now AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC';
  INSERT INTO public.brawler_snapshots(player_tag,brawler_id,brawler_name,power_level,trophies,rank,gadgets_count,star_powers_count,gears_count,recorded_at)
  SELECT x.player_tag,x.brawler_id,x.brawler_name,x.power_level,x.trophies,x.rank,x.gadgets_count,x.star_powers_count,x.gears_count,v_now
  FROM jsonb_to_recordset(p_payload->'brawlers') x(player_tag text,brawler_id integer,brawler_name text,power_level integer,trophies integer,rank integer,gadgets_count integer,star_powers_count integer,gears_count integer);

  INSERT INTO public.daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost)
  SELECT b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date,count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),count(*) FILTER(WHERE is_star_player),
    coalesce(sum(greatest(trophy_change,0)),0),coalesce(sum(greatest(-trophy_change,0)),0)
  FROM public.battle_history b JOIN (
    SELECT DISTINCT x->>'player_tag' tag,((x->>'battle_time')::timestamptz AT TIME ZONE 'UTC')::date battle_date
    FROM jsonb_array_elements(p_payload->'battles') x WHERE (x->>'battle_time')::timestamptz>=v_now-interval '90 days' AND (x->>'battle_time')::timestamptz<=v_now+interval '1 minute'
  ) affected ON b.player_tag=affected.tag AND (b.battle_time AT TIME ZONE 'UTC')::date=affected.battle_date
  GROUP BY b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date
  ON CONFLICT(player_tag,date) DO UPDATE SET battles=excluded.battles,wins=excluded.wins,losses=excluded.losses,star_player=excluded.star_player,trophies_gained=excluded.trophies_gained,trophies_lost=excluded.trophies_lost;
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
    INSERT INTO public.settings(key,value) VALUES('required_trophies',coalesce(p_payload->>'required_trophies','')),('last_sync_time',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  END IF;
  SELECT count(*) INTO v_event_count FROM public.membership_change_events WHERE run_id=p_run_id;
  v_result := jsonb_build_object('success',true,'synced',cardinality(v_tags),'events',v_event_count,'timestamp',v_now,'runId',p_run_id,
    'changes',jsonb_build_object(
      'joins',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='join'),'[]'::jsonb),
      'leaves',coalesce((SELECT jsonb_agg(jsonb_build_object('playerTag',player_tag,'playerName',player_name)) FROM public.membership_change_events WHERE run_id=p_run_id AND event_type='leave'),'[]'::jsonb)));
  IF v_run.scope='member' THEN v_result := v_result || jsonb_build_object('member',(SELECT public.sync_public_snapshot(to_jsonb(m)) FROM public.members m WHERE player_tag=v_run.player_tag)); END IF;
  UPDATE public.sync_runs SET status='succeeded',finished_at=v_now,counts=jsonb_build_object('members',cardinality(v_tags),'battles',jsonb_array_length(p_payload->'battles'),'events',v_event_count),result=v_result WHERE id=p_run_id;
  UPDATE public.sync_leases SET run_id=NULL,expires_at='-infinity' WHERE club_tag=v_run.club_tag AND run_id=p_run_id AND fence=p_fence;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.claim_notification_outbox(p_worker uuid,p_limit integer DEFAULT 10)
RETURNS SETOF public.notification_outbox LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH ready AS (
    SELECT id FROM public.notification_outbox WHERE attempts<8 AND
      ((status='pending' AND available_at<=clock_timestamp()) OR (status='in_flight' AND locked_until<=clock_timestamp()))
    ORDER BY available_at,id LIMIT greatest(1,least(p_limit,20)) FOR UPDATE SKIP LOCKED
  ) UPDATE public.notification_outbox o SET status='in_flight',attempts=o.attempts+1,locked_by=p_worker,locked_until=clock_timestamp()+interval '60 seconds'
    FROM ready WHERE o.id=ready.id RETURNING o.*;
$$;
CREATE OR REPLACE FUNCTION public.complete_notification_outbox(p_id uuid,p_worker uuid,p_success boolean,p_http_status integer DEFAULT NULL,p_error_code text DEFAULT NULL,p_retry_seconds integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.notification_outbox SET status=CASE WHEN p_success THEN 'sent' WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
    delivered_at=CASE WHEN p_success THEN clock_timestamp() END,last_http_status=p_http_status,last_error_code=left(p_error_code,60),
    available_at=clock_timestamp()+make_interval(secs=>least(3600,greatest(1,coalesce(p_retry_seconds,(30*power(2,attempts-1))::integer)))),locked_by=NULL,locked_until=NULL
    WHERE id=p_id AND status='in_flight' AND locked_by=p_worker AND locked_until>clock_timestamp();
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.run_sync_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_battles integer; v_days integer; v_activity integer; v_snapshots integer; v_notifications integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(702946183) THEN RETURN jsonb_build_object('skipped',true); END IF;
  DELETE FROM public.battle_history WHERE battle_time<now()-interval '90 days'; GET DIAGNOSTICS v_battles=ROW_COUNT;
  DELETE FROM public.daily_stats WHERE date<(now() AT TIME ZONE 'UTC')::date-365; GET DIAGNOSTICS v_days=ROW_COUNT;
  DELETE FROM public.activity_log WHERE recorded_at<now()-interval '90 days'; GET DIAGNOSTICS v_activity=ROW_COUNT;
  DELETE FROM public.brawler_snapshots WHERE recorded_at<now()-interval '90 days'; GET DIAGNOSTICS v_snapshots=ROW_COUNT;
  DELETE FROM public.notifications WHERE created_at<now()-interval '90 days'; GET DIAGNOSTICS v_notifications=ROW_COUNT;
  DELETE FROM public.notification_outbox WHERE status='sent' AND delivered_at<now()-interval '90 days';
  UPDATE public.notification_outbox SET status='failed',last_error_code='delivery_lease_expired',locked_by=NULL,locked_until=NULL
    WHERE status='in_flight' AND attempts>=8 AND locked_until<=now();
  RETURN jsonb_build_object('battles',v_battles,'dailyStats',v_days,'activity',v_activity,'snapshots',v_snapshots,'notifications',v_notifications);
END $$;
CREATE OR REPLACE FUNCTION public.cleanup_old_battles() RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN DELETE FROM public.battle_history WHERE battle_time<now()-interval '90 days'; DELETE FROM public.daily_stats WHERE date<(now() AT TIME ZONE 'UTC')::date-365; END $$;
CREATE OR REPLACE FUNCTION public.cleanup_old_activity_logs() RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN DELETE FROM public.activity_log WHERE recorded_at<now()-interval '90 days'; END $$;

CREATE OR REPLACE FUNCTION public.sync_activity_summary(p_player_tags text[],p_now timestamptz DEFAULT now())
RETURNS TABLE(player_tag text,last_battle_at timestamptz,last_activity_at timestamptz,trophies_24h integer,trophies_3d integer,trophies_7d integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT m.player_tag,s.last_battle_at,s.last_activity_at,
    coalesce(m.trophies-a1.trophies,b.t24)::integer,coalesce(m.trophies-a3.trophies,b.t3)::integer,coalesce(m.trophies-a7.trophies,b.t7)::integer
  FROM public.members m LEFT JOIN public.member_activity_state s USING(player_tag)
  LEFT JOIN LATERAL (SELECT a.trophies FROM public.activity_log a WHERE a.player_tag=m.player_tag AND a.recorded_at BETWEEN p_now-interval '36 hours' AND p_now-interval '12 hours' ORDER BY abs(extract(epoch FROM a.recorded_at-(p_now-interval '24 hours'))),a.recorded_at LIMIT 1) a1 ON true
  LEFT JOIN LATERAL (SELECT a.trophies FROM public.activity_log a WHERE a.player_tag=m.player_tag AND a.recorded_at BETWEEN p_now-interval '4 days' AND p_now-interval '2 days' ORDER BY abs(extract(epoch FROM a.recorded_at-(p_now-interval '3 days'))),a.recorded_at LIMIT 1) a3 ON true
  LEFT JOIN LATERAL (SELECT a.trophies FROM public.activity_log a WHERE a.player_tag=m.player_tag AND a.recorded_at BETWEEN p_now-interval '8 days' AND p_now-interval '6 days' ORDER BY abs(extract(epoch FROM a.recorded_at-(p_now-interval '7 days'))),a.recorded_at LIMIT 1) a7 ON true
  LEFT JOIN LATERAL (SELECT sum(trophy_change) FILTER(WHERE battle_time>=p_now-interval '24 hours') t24,sum(trophy_change) FILTER(WHERE battle_time>=p_now-interval '3 days') t3,sum(trophy_change) t7 FROM public.battle_history WHERE player_tag=m.player_tag AND battle_time BETWEEN p_now-interval '7 days' AND p_now) b ON true
  WHERE m.player_tag=ANY(p_player_tags);
$$;

INSERT INTO public.settings(key,value) VALUES('sync_expected_interval_minutes','30') ON CONFLICT DO NOTHING;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_activity_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_brawler_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_runs,public.sync_leases,public.membership_change_events,public.notification_outbox,public.member_activity_state,public.player_brawler_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.sync_runs,public.sync_leases,public.membership_change_events,public.notification_outbox,public.member_activity_state,public.player_brawler_state TO service_role;
REVOKE ALL ON FUNCTION public.acquire_sync_run(text,text,text,text,text),public.fail_sync_run(uuid,bigint,text,text),public.sync_record_event(uuid,text,text,text,jsonb,jsonb,timestamptz),public.commit_sync_snapshot(uuid,bigint,jsonb),public.claim_notification_outbox(uuid,integer),public.complete_notification_outbox(uuid,uuid,boolean,integer,text,integer),public.run_sync_maintenance(),public.sync_activity_summary(text[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sync_run(text,text,text,text,text),public.fail_sync_run(uuid,bigint,text,text),public.commit_sync_snapshot(uuid,bigint,jsonb),public.claim_notification_outbox(uuid,integer),public.complete_notification_outbox(uuid,uuid,boolean,integer,text,integer),public.run_sync_maintenance(),public.sync_activity_summary(text[],timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.sync_public_snapshot(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_public_snapshot(jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
