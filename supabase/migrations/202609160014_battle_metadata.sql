-- Preserve source context without classifying historical rows from guesses.
-- No existing battles are rewritten: fresh overlapping logs can enrich them.
BEGIN;
ALTER TABLE public.battle_history
  ADD COLUMN IF NOT EXISTS trophy_change_reported boolean,
  ADD COLUMN IF NOT EXISTS battle_type text,
  ADD COLUMN IF NOT EXISTS event_id integer,
  ADD COLUMN IF NOT EXISTS event_mode_id integer,
  ADD COLUMN IF NOT EXISTS battle_mode text,
  ADD COLUMN IF NOT EXISTS event_mode text,
  ADD COLUMN IF NOT EXISTS placement_rank integer;
ALTER TABLE public.battle_history ALTER COLUMN trophy_change DROP DEFAULT;

-- Keep this catalog aligned with src/lib/battle-modes.json and battle-catalog.ts.
-- Simple expressions can be inlined during range scans. Qualify all builtins
-- rather than adding a per-row SET search_path call or consulting a table.
CREATE OR REPLACE FUNCTION public.battle_feed_mode(p_raw text,p_mode_id integer DEFAULT NULL) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_mode_id
    WHEN 0 THEN 'gemGrab'
    WHEN 2 THEN 'heist'
    WHEN 3 THEN 'bounty'
    WHEN 5 THEN 'brawlBall'
    WHEN 6 THEN 'soloShowdown'
    WHEN 7 THEN 'bigGame'
    WHEN 8 THEN 'roboRumble'
    WHEN 9 THEN 'duoShowdown'
    WHEN 10 THEN 'bossFight'
    WHEN 11 THEN 'spiritWars'
    WHEN 14 THEN 'takedown'
    WHEN 15 THEN 'loneStar'
    WHEN 16 THEN 'presentPlunder'
    WHEN 17 THEN 'hotZone'
    WHEN 18 THEN 'superCityRampage'
    WHEN 20 THEN 'knockout'
    WHEN 21 THEN 'carryTheGift'
    WHEN 22 THEN 'basketBrawl'
    WHEN 23 THEN 'volleyBrawl'
    WHEN 24 THEN 'duels'
    WHEN 25 THEN 'wipeout'
    WHEN 26 THEN 'payload'
    WHEN 27 THEN 'botDrop'
    WHEN 28 THEN 'hunters'
    WHEN 29 THEN 'lastStand'
    WHEN 31 THEN 'wipeout5v5'
    WHEN 32 THEN 'brawlBall5v5'
    WHEN 33 THEN 'gemGrab5v5'
    WHEN 34 THEN 'trophyEscape'
    WHEN 35 THEN 'knockout5v5'
    WHEN 36 THEN 'godzillaCitySmash'
    WHEN 37 THEN 'paintBrawl'
    WHEN 38 THEN 'trioShowdown'
    WHEN 39 THEN 'drumRoll'
    WHEN 40 THEN 'soulCollector'
    WHEN 41 THEN 'cleaningDuty'
    WHEN 42 THEN 'soloShowdownLimbo'
    WHEN 43 THEN 'knockoutLimbo'
    WHEN 45 THEN 'brawlHockey'
    WHEN 46 THEN 'gemGrab2v2'
    WHEN 47 THEN 'specialDelivery'
    WHEN 48 THEN 'brawlArena'
    WHEN 49 THEN 'brawlBall2v2'
    WHEN 50 THEN 'knockout2v2'
    WHEN 51 THEN 'hotZone2v2'
    WHEN 52 THEN 'basketBrawl2v2'
    WHEN 53 THEN 'brawlHockey2v2'
    WHEN 54 THEN 'specialDelivery2v2'
    WHEN 55 THEN 'tokenRun'
    WHEN 56 THEN 'treasureHunt'
    WHEN 57 THEN 'brawlHockey5v5'
    WHEN 58 THEN 'vipHunt'
    WHEN 60 THEN 'samuraiSmash'
    WHEN 61 THEN 'megaBoss'
    WHEN 63 THEN 'dodgebrawl'
    WHEN 64 THEN 'subwayRun'
    WHEN 65 THEN 'trioGemGrab'
    WHEN 66 THEN 'trioWipeout'
    WHEN 68 THEN 'loveBombing'
    WHEN 69 THEN 'duoMegaBoss'
    WHEN 70 THEN 'safeBlast'
    WHEN 72 THEN 'loadedShowdown'
    WHEN 73 THEN 'shadowSmash'
    WHEN 76 THEN 'superBall'
    WHEN 77 THEN '5PlayerVoidBoss'
    WHEN 78 THEN 'loadedDuoShowdown'
    WHEN 79 THEN 'superHockey'
    WHEN 80 THEN 'foodFight'
    WHEN 81 THEN 'mechaGuard'
    WHEN 82 THEN 'combatCooking'
    WHEN 83 THEN 'hide&Seek'
    WHEN 84 THEN 'megaBossDuo(20Player)'
    ELSE CASE pg_catalog.lower(pg_catalog.btrim(p_raw))
      WHEN 'gemgrab' THEN 'gemGrab'
      WHEN 'heist' THEN 'heist'
      WHEN 'bounty' THEN 'bounty'
      WHEN 'brawlball' THEN 'brawlBall'
      WHEN 'soloshowdown' THEN 'soloShowdown'
      WHEN 'biggame' THEN 'bigGame'
      WHEN 'roborumble' THEN 'roboRumble'
      WHEN 'duoshowdown' THEN 'duoShowdown'
      WHEN 'bossfight' THEN 'bossFight'
      WHEN 'spiritwars' THEN 'spiritWars'
      WHEN 'takedown' THEN 'takedown'
      WHEN 'lonestar' THEN 'loneStar'
      WHEN 'presentplunder' THEN 'presentPlunder'
      WHEN 'hotzone' THEN 'hotZone'
      WHEN 'supercityrampage' THEN 'superCityRampage'
      WHEN 'knockout' THEN 'knockout'
      WHEN 'carrythegift' THEN 'carryTheGift'
      WHEN 'basketbrawl' THEN 'basketBrawl'
      WHEN 'volleybrawl' THEN 'volleyBrawl'
      WHEN 'duels' THEN 'duels'
      WHEN 'wipeout' THEN 'wipeout'
      WHEN 'payload' THEN 'payload'
      WHEN 'botdrop' THEN 'botDrop'
      WHEN 'hunters' THEN 'hunters'
      WHEN 'laststand' THEN 'lastStand'
      WHEN 'wipeout5v5' THEN 'wipeout5v5'
      WHEN 'brawlball5v5' THEN 'brawlBall5v5'
      WHEN 'gemgrab5v5' THEN 'gemGrab5v5'
      WHEN 'trophyescape' THEN 'trophyEscape'
      WHEN 'knockout5v5' THEN 'knockout5v5'
      WHEN 'godzillacitysmash' THEN 'godzillaCitySmash'
      WHEN 'paintbrawl' THEN 'paintBrawl'
      WHEN 'trioshowdown' THEN 'trioShowdown'
      WHEN 'drumroll' THEN 'drumRoll'
      WHEN 'soulcollector' THEN 'soulCollector'
      WHEN 'cleaningduty' THEN 'cleaningDuty'
      WHEN 'soloshowdownlimbo' THEN 'soloShowdownLimbo'
      WHEN 'knockoutlimbo' THEN 'knockoutLimbo'
      WHEN 'brawlhockey' THEN 'brawlHockey'
      WHEN 'brawlhockey5v5' THEN 'brawlHockey5v5'
      WHEN 'megaboss' THEN 'megaBoss'
      WHEN 'gemgrab2v2' THEN 'gemGrab2v2'
      WHEN 'specialdelivery' THEN 'specialDelivery'
      WHEN 'brawlarena' THEN 'brawlArena'
      WHEN 'brawlball2v2' THEN 'brawlBall2v2'
      WHEN 'knockout2v2' THEN 'knockout2v2'
      WHEN 'hotzone2v2' THEN 'hotZone2v2'
      WHEN 'basketbrawl2v2' THEN 'basketBrawl2v2'
      WHEN 'brawlhockey2v2' THEN 'brawlHockey2v2'
      WHEN 'specialdelivery2v2' THEN 'specialDelivery2v2'
      WHEN 'tokenrun' THEN 'tokenRun'
      WHEN 'treasurehunt' THEN 'treasureHunt'
      WHEN 'viphunt' THEN 'vipHunt'
      WHEN 'samuraismash' THEN 'samuraiSmash'
      WHEN 'dodgebrawl' THEN 'dodgebrawl'
      WHEN 'subwayrun' THEN 'subwayRun'
      WHEN 'triogemgrab' THEN 'trioGemGrab'
      WHEN 'triowipeout' THEN 'trioWipeout'
      WHEN 'lovebombing' THEN 'loveBombing'
      WHEN 'duomegaboss' THEN 'duoMegaBoss'
      WHEN 'safeblast' THEN 'safeBlast'
      WHEN 'loadedshowdown' THEN 'loadedShowdown'
      WHEN 'shadowsmash' THEN 'shadowSmash'
      WHEN 'superball' THEN 'superBall'
      WHEN '5playervoidboss' THEN '5PlayerVoidBoss'
      WHEN 'loadedduoshowdown' THEN 'loadedDuoShowdown'
      WHEN 'superhockey' THEN 'superHockey'
      WHEN 'foodfight' THEN 'foodFight'
      WHEN 'mechaguard' THEN 'mechaGuard'
      WHEN 'combatcooking' THEN 'combatCooking'
      WHEN 'hide&seek' THEN 'hide&Seek'
      WHEN 'megabossduo(20player)' THEN 'megaBossDuo(20Player)'
      WHEN 'airhockey' THEN 'brawlHockey'
      WHEN 'deathmatch' THEN 'wipeout'
      WHEN 'tagteam' THEN 'duels'
      WHEN 'airhockey5v5' THEN 'brawlHockey5v5'
      WHEN 'deathmatch5v5' THEN 'wipeout5v5'
      WHEN 'cooking' THEN 'foodFight'
      ELSE coalesce(nullif(pg_catalog.btrim(p_raw),''),'unknown') END END;
$$;
CREATE OR REPLACE FUNCTION public.battle_feed_context(p_type text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE pg_catalog.lower(pg_catalog.btrim(p_type))
    WHEN 'ranked' THEN 'ladder' WHEN 'soloranked' THEN 'ranked' WHEN 'teamranked' THEN 'ranked'
    WHEN 'challenge' THEN 'challenge' WHEN 'championshipchallenge' THEN 'challenge'
    WHEN 'friendly' THEN 'friendly' WHEN 'megapig' THEN 'mega_pig' WHEN 'tournament' THEN 'tournament'
    ELSE 'unknown' END;
$$;
REVOKE ALL ON FUNCTION public.battle_feed_mode(text,integer),public.battle_feed_context(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.battle_feed_mode(text,integer),public.battle_feed_context(text) TO service_role;

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
  INSERT INTO public.battle_history(player_tag,battle_time,mode,map,result,trophy_change,is_star_player,brawler_name,brawler_power,brawler_trophies,teams_json,battle_type,event_id,battle_mode,event_mode,placement_rank,trophy_change_reported,event_mode_id)
  SELECT x.player_tag,x.battle_time,x.mode,x.map,x.result,x.trophy_change,coalesce(x.is_star_player,false),x.brawler_name,x.brawler_power,x.brawler_trophies,
    CASE WHEN jsonb_typeof(x.teams_json)='string' THEN (x.teams_json #>> '{}')::jsonb ELSE x.teams_json END,
    nullif(x.battle_type,''),x.event_id,nullif(x.battle_mode,''),nullif(x.event_mode,''),x.placement_rank,CASE WHEN x.trophy_change_reported IS NULL THEN NULL ELSE x.trophy_change_reported AND x.trophy_change IS NOT NULL END,x.event_mode_id
  FROM jsonb_to_recordset(p_payload->'battles') AS x(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,brawler_trophies integer,teams_json jsonb,battle_type text,event_id integer,battle_mode text,event_mode text,placement_rank integer,trophy_change_reported boolean,event_mode_id integer)
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
    event_mode_id=coalesce(excluded.event_mode_id,battle_history.event_mode_id)
    WHERE ROW(battle_history.mode,battle_history.map,battle_history.result,battle_history.trophy_change,battle_history.is_star_player,battle_history.brawler_name,battle_history.brawler_power,battle_history.brawler_trophies,battle_history.teams_json,battle_history.battle_type,battle_history.event_id,battle_history.battle_mode,battle_history.event_mode,battle_history.placement_rank,battle_history.trophy_change_reported,battle_history.event_mode_id)
      IS DISTINCT FROM ROW(excluded.mode,excluded.map,excluded.result,CASE WHEN excluded.trophy_change_reported THEN excluded.trophy_change WHEN battle_history.trophy_change_reported THEN battle_history.trophy_change ELSE coalesce(excluded.trophy_change,battle_history.trophy_change) END,excluded.is_star_player,excluded.brawler_name,excluded.brawler_power,excluded.brawler_trophies,excluded.teams_json,coalesce(excluded.battle_type,battle_history.battle_type),coalesce(excluded.event_id,battle_history.event_id),coalesce(excluded.battle_mode,battle_history.battle_mode),coalesce(excluded.event_mode,battle_history.event_mode),coalesce(excluded.placement_rank,battle_history.placement_rank),CASE WHEN battle_history.trophy_change_reported OR excluded.trophy_change_reported THEN true ELSE coalesce(excluded.trophy_change_reported,battle_history.trophy_change_reported) END,coalesce(excluded.event_mode_id,battle_history.event_mode_id));

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

-- RPCs keep complete facets in the database rather than downloading a truncated
-- latest-page sample. Only the server may call them; rows use a fixed allowlist.
CREATE OR REPLACE FUNCTION public.battle_feed_page(p_player_tags text[],p_since timestamptz,p_until timestamptz,p_player text DEFAULT NULL,p_mode text DEFAULT NULL,p_context text DEFAULT NULL,p_at timestamptz DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS TABLE(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,teams_json jsonb,battle_type text,event_id integer,battle_mode text,event_mode text,placement_rank integer,trophy_change_reported boolean,event_mode_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_player_tags IS NULL OR cardinality(p_player_tags)>100 OR p_since IS NULL OR p_until IS NULL
     OR p_until-p_since>interval '90 days 1 minute'
     OR (p_context IS NOT NULL AND p_context NOT IN ('ladder','ranked','challenge','friendly','mega_pig','tournament','unknown')) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_feed_filter';
  END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_feed_page';
  END IF;
  RETURN QUERY SELECT b.player_tag::text,b.battle_time,public.battle_feed_mode(coalesce(b.event_mode,b.battle_mode,b.mode),b.event_mode_id),b.map::text,b.result::text,
    b.trophy_change,b.is_star_player,b.brawler_name::text,b.brawler_power,b.teams_json,b.battle_type,b.event_id,b.battle_mode,b.event_mode,b.placement_rank,b.trophy_change_reported,b.event_mode_id
    FROM public.battle_history b WHERE b.player_tag=ANY(p_player_tags) AND (p_player IS NULL OR b.player_tag=p_player)
      AND b.battle_time>=p_since AND b.battle_time<=least(p_until,clock_timestamp()+interval '1 minute')
      AND (p_at IS NULL OR b.battle_time=p_at)
      AND (p_mode IS NULL OR public.battle_feed_mode(coalesce(b.event_mode,b.battle_mode,b.mode),b.event_mode_id)=public.battle_feed_mode(p_mode))
      AND (p_context IS NULL OR public.battle_feed_context(b.battle_type)=p_context)
    ORDER BY b.battle_time DESC,b.player_tag ASC OFFSET p_offset LIMIT p_limit;
END $$;
CREATE OR REPLACE FUNCTION public.battle_feed_facets(p_player_tags text[],p_since timestamptz,p_until timestamptz,p_player text DEFAULT NULL,p_mode text DEFAULT NULL,p_context text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_player_tags IS NULL OR cardinality(p_player_tags)>100 OR p_since IS NULL OR p_until IS NULL
     OR p_until-p_since>interval '90 days 1 minute'
     OR (p_context IS NOT NULL AND p_context NOT IN ('ladder','ranked','challenge','friendly','mega_pig','tournament','unknown')) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_battle_feed_filter';
  END IF;
  WITH scope AS MATERIALIZED (
    SELECT public.battle_feed_mode(coalesce(b.event_mode,b.battle_mode,b.mode),b.event_mode_id) AS mode,public.battle_feed_context(b.battle_type) AS context
    FROM public.battle_history b WHERE b.player_tag=ANY(p_player_tags) AND (p_player IS NULL OR b.player_tag=p_player)
      AND b.battle_time>=p_since AND b.battle_time<=least(p_until,clock_timestamp()+interval '1 minute')
  ) SELECT jsonb_build_object(
    'modes',coalesce((SELECT jsonb_agg(jsonb_build_object('key',mode,'count',n) ORDER BY mode) FROM (SELECT mode,count(*) n FROM scope GROUP BY mode) m),'[]'::jsonb),
    'contexts',coalesce((SELECT jsonb_agg(jsonb_build_object('key',context,'count',n) ORDER BY context) FROM (SELECT context,count(*) n FROM scope WHERE p_mode IS NULL OR mode=public.battle_feed_mode(p_mode) GROUP BY context) c),'[]'::jsonb),
    'total',(SELECT count(*) FROM scope WHERE (p_mode IS NULL OR mode=public.battle_feed_mode(p_mode)) AND (p_context IS NULL OR context=p_context)),
    'observationCount',(SELECT count(*) FROM scope)
  ) INTO v_result;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.battle_feed_page(text[],timestamptz,timestamptz,text,text,text,timestamptz,integer,integer),public.battle_feed_facets(text[],timestamptz,timestamptz,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.battle_feed_page(text[],timestamptz,timestamptz,text,text,text,timestamptz,integer,integer),public.battle_feed_facets(text[],timestamptz,timestamptz,text,text,text) TO service_role;
-- New fields are server-read; retain the existing restricted direct/realtime
-- column grants, including the private legacy owner_user_id exclusion.
NOTIFY pgrst,'reload schema';
COMMIT;
