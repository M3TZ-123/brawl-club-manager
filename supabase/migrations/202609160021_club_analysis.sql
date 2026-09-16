-- Read-only, bounded analytics over retained observations. No upstream calls or
-- inferred battle categories, ownership, online time, or missing-battle counts.
BEGIN;

CREATE OR REPLACE FUNCTION public.analysis_team(p_raw jsonb,p_player text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_source jsonb:=p_raw; v_team jsonb; v_player jsonb; v_tag text;
  v_all text[]:='{}';v_tags text[];v_own text[];v_sorted text[];
BEGIN
  IF jsonb_typeof(v_source)='string' THEN
    BEGIN v_source:=(v_source #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
  END IF;
  IF jsonb_typeof(v_source)='object' THEN v_source:=v_source->'teams'; END IF;
  -- Flat solo-player lists are not teams. Never manufacture a partnership.
  IF jsonb_typeof(v_source) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(v_source) NOT BETWEEN 1 AND 20 THEN RETURN NULL; END IF;
  FOR v_team IN SELECT value FROM jsonb_array_elements(v_source) LOOP
    IF jsonb_typeof(v_team) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF jsonb_array_length(v_team) NOT BETWEEN 1 AND 20 THEN RETURN NULL; END IF;
    v_tags:='{}';
    FOR v_player IN SELECT value FROM jsonb_array_elements(v_team) LOOP
      IF jsonb_typeof(v_player) IS DISTINCT FROM 'object' OR jsonb_typeof(v_player->'tag') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
      v_tag:=upper(btrim(v_player->>'tag'));
      IF left(v_tag,1)<>'#' THEN v_tag:='#'||v_tag; END IF;
      IF v_tag !~ '^#[A-Z0-9]{1,20}$' OR v_tag=ANY(v_all) THEN RETURN NULL; END IF;
      v_tags:=array_append(v_tags,v_tag);v_all:=array_append(v_all,v_tag);
      IF cardinality(v_all)>40 THEN RETURN NULL; END IF;
    END LOOP;
    IF p_player=ANY(v_tags) THEN v_own:=v_tags; END IF;
  END LOOP;
  IF v_own IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(tag ORDER BY tag) INTO v_sorted FROM unnest(v_all) tag;
  SELECT array_agg(tag ORDER BY tag) INTO v_own FROM unnest(v_own) tag;
  RETURN jsonb_build_object('own',v_own,'participants',v_sorted);
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_stats(p_total bigint,p_wins bigint,p_losses bigint,p_draws bigint,p_duration bigint,p_duration_count bigint)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT pg_catalog.jsonb_build_object('observations',p_total,'wins',p_wins,'losses',p_losses,'draws',p_draws,
    'unknownResults',p_total-p_wins-p_losses-p_draws,
    'winRate',CASE WHEN p_wins+p_losses>0 THEN pg_catalog.round(p_wins::numeric*100/(p_wins+p_losses),1) ELSE NULL END,
    'durationObservations',p_duration_count,'recordedDurationSeconds',coalesce(p_duration,0),
    'averageDurationSeconds',CASE WHEN p_duration_count>0 THEN pg_catalog.round(p_duration::numeric/p_duration_count,1) ELSE NULL END);
$$;

CREATE OR REPLACE FUNCTION public.club_analysis_read(p_days integer,p_now timestamptz DEFAULT now(),p_context text DEFAULT NULL,p_mode text DEFAULT NULL,p_map text DEFAULT NULL,p_brawler text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET statement_timeout='15s' AS $$
DECLARE v_tags text[];v_club text;v_since timestamptz;v_result jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN(1,3,7,30,90) OR p_now IS NULL OR NOT isfinite(p_now)
    OR (p_context IS NOT NULL AND p_context NOT IN('ladder','ranked','challenge','friendly','mega_pig','tournament','unknown'))
    OR length(p_mode)>100 OR length(p_map)>100 OR length(p_brawler)>50 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_range';
  END IF;
  SELECT coalesce(array_agg(m.player_tag),'{}') INTO v_tags FROM public.members m
    JOIN public.member_history h USING(player_tag) WHERE h.is_current_member;
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_roster'; END IF;
  SELECT upper(regexp_replace(btrim(value),'^%23','#','i')) INTO v_club FROM public.settings WHERE key='club_tag';
  IF left(coalesce(v_club,''),1)<>'#' THEN v_club:='#'||v_club; END IF;
  v_since:=p_now-make_interval(days=>p_days);
  WITH raw AS MATERIALIZED (
    SELECT b.id,b.player_tag,b.battle_time,
      public.battle_feed_mode(coalesce(nullif(b.event_mode,''),nullif(b.battle_mode,''),b.mode),b.event_mode_id) mode,
      public.battle_feed_context(b.battle_type) context,coalesce(nullif(b.map,''),'unknown') map,
      coalesce(nullif(b.brawler_name,''),'unknown') brawler,b.event_id,b.teams_json,
      CASE lower(btrim(b.result)) WHEN 'victory' THEN 'victory' WHEN 'defeat' THEN 'defeat' WHEN 'draw' THEN 'draw' ELSE 'unknown' END result,
      CASE WHEN b.duration_seconds>=0 THEN b.duration_seconds ELSE NULL END duration_seconds
    FROM public.battle_history b WHERE b.player_tag=ANY(v_tags) AND b.battle_time>=v_since AND b.battle_time<=p_now
    ORDER BY b.battle_time DESC,b.id DESC LIMIT 100001
  ), retained AS MATERIALIZED (SELECT * FROM raw ORDER BY battle_time DESC,id DESC LIMIT 100000),
  selected AS MATERIALIZED (
    SELECT * FROM retained WHERE (p_context IS NULL OR context=p_context)
      AND (p_mode IS NULL OR mode=public.battle_feed_mode(p_mode))
      AND (p_map IS NULL OR map=p_map) AND (p_brawler IS NULL OR brawler=p_brawler)
  ), analyzed AS MATERIALIZED (SELECT s.*,public.analysis_team(s.teams_json,s.player_tag) team FROM selected s),
  summary AS (
    SELECT public.analysis_stats(count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),
      count(*) FILTER(WHERE result='draw'),sum(duration_seconds),count(duration_seconds)) data FROM selected
  ), groups AS MATERIALIZED (
    SELECT CASE WHEN grouping(map)=0 THEN 'maps' WHEN grouping(brawler)=0 THEN 'brawlers' ELSE 'modes' END kind,
      context,mode,map,brawler,count(*) n,
      jsonb_build_object('context',context,'mode',mode,'map',map,'brawler',brawler)||
      public.analysis_stats(count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),
        count(*) FILTER(WHERE result='draw'),sum(duration_seconds),count(duration_seconds)) data
    FROM selected GROUP BY GROUPING SETS((context,mode),(context,mode,map),(context,brawler))
  ), facet AS MATERIALIZED (
    SELECT CASE WHEN grouping(context)=0 THEN 'contexts' WHEN grouping(mode)=0 THEN 'modes'
      WHEN grouping(map)=0 THEN 'maps' ELSE 'brawlers' END kind,coalesce(context,mode,map,brawler) key,count(*) n
    FROM retained GROUP BY GROUPING SETS((context),(mode),(map),(brawler))
  ), hours AS (
    SELECT h.hour,public.analysis_stats(count(s.id),count(s.id) FILTER(WHERE s.result='victory'),
      count(s.id) FILTER(WHERE s.result='defeat'),count(s.id) FILTER(WHERE s.result='draw'),sum(s.duration_seconds),count(s.duration_seconds))||jsonb_build_object('hour',h.hour) data
    FROM generate_series(0,23) h(hour) LEFT JOIN selected s ON extract(hour FROM s.battle_time AT TIME ZONE 'UTC')=h.hour GROUP BY h.hour
  ), pair_observations AS MATERIALIZED (
    SELECT s.id,s.context,s.battle_time,s.mode,s.map,s.event_id,s.team->'participants' participants,a.tag tag1,b.tag tag2,s.result
    FROM analyzed s CROSS JOIN LATERAL jsonb_array_elements_text(s.team->'own') a(tag)
      CROSS JOIN LATERAL jsonb_array_elements_text(s.team->'own') b(tag)
    WHERE a.tag<b.tag AND a.tag=ANY(v_tags) AND b.tag=ANY(v_tags)
  ), pair_matches AS (
    -- Optional event IDs/context can be absent in an older member observation.
    -- Complete participant identity does not change when metadata is enriched.
    SELECT CASE WHEN count(DISTINCT context) FILTER(WHERE context<>'unknown')=1
      THEN min(context) FILTER(WHERE context<>'unknown') ELSE 'unknown' END context,
      tag1,tag2,CASE WHEN count(DISTINCT result) FILTER(WHERE result<>'unknown')=1
      THEN min(result) FILTER(WHERE result<>'unknown') ELSE 'unknown' END result
    FROM pair_observations GROUP BY tag1,tag2,battle_time,mode,map,participants
  ), pairs AS MATERIALIZED (
    SELECT p.context,p.tag1,p.tag2,count(*) n,jsonb_build_object('context',p.context,
      'player1',jsonb_build_object('tag',p.tag1,'name',m1.player_name),'player2',jsonb_build_object('tag',p.tag2,'name',m2.player_name),
      'matches',count(*),'wins',count(*) FILTER(WHERE result='victory'),'losses',count(*) FILTER(WHERE result='defeat'),
      'draws',count(*) FILTER(WHERE result='draw'),'unknownResults',count(*) FILTER(WHERE result='unknown'),
      'winRate',CASE WHEN count(*) FILTER(WHERE result IN('victory','defeat'))>0 THEN round(count(*) FILTER(WHERE result='victory')::numeric*100/count(*) FILTER(WHERE result IN('victory','defeat')),1) ELSE NULL END) data
    FROM pair_matches p JOIN public.members m1 ON m1.player_tag=p.tag1 JOIN public.members m2 ON m2.player_tag=p.tag2
    GROUP BY p.context,p.tag1,p.tag2,m1.player_name,m2.player_name
  ), gap AS (
    SELECT count(*) n,count(DISTINCT player_tag) players FROM public.sync_battle_gaps
    WHERE club_tag=v_club AND player_tag=ANY(v_tags) AND detected_at<=p_now AND detected_at>=p_now-interval '28 days'
      AND gap_end_at>=v_since AND gap_start_at<=p_now
  ), coverage AS (
    SELECT count(*) FILTER(WHERE c.baseline_started_at<=c.last_observed_at AND c.last_observed_at<=p_now) monitored,
      count(*) FILTER(WHERE c.baseline_started_at<=v_since AND c.last_observed_at<=p_now AND c.last_observed_at>=p_now-interval '2 hours') full_period,
      count(*) FILTER(WHERE c.last_observed_at IS NULL OR c.last_observed_at>p_now OR c.last_observed_at<p_now-interval '2 hours') stale,
      max(c.baseline_started_at) FILTER(WHERE c.baseline_started_at<=c.last_observed_at AND c.last_observed_at<=p_now) baseline,
      min(c.last_observed_at) FILTER(WHERE c.baseline_started_at<=c.last_observed_at AND c.last_observed_at<=p_now) checked
    FROM unnest(v_tags) tag LEFT JOIN public.sync_battle_coverage c ON c.player_tag=tag AND c.club_tag=v_club
  )
  SELECT jsonb_build_object('summary',(SELECT data FROM summary),
    'modes',coalesce((SELECT jsonb_agg(data ORDER BY n DESC,context,mode) FROM(SELECT * FROM groups WHERE kind='modes' ORDER BY n DESC,context,mode LIMIT 200)q),'[]'::jsonb),
    'maps',coalesce((SELECT jsonb_agg(data ORDER BY n DESC,context,mode,map) FROM(SELECT * FROM groups WHERE kind='maps' ORDER BY n DESC,context,mode,map LIMIT 200)q),'[]'::jsonb),
    'brawlers',coalesce((SELECT jsonb_agg(data ORDER BY n DESC,context,brawler) FROM(SELECT * FROM groups WHERE kind='brawlers' ORDER BY n DESC,context,brawler LIMIT 200)q),'[]'::jsonb),
    'pairs',coalesce((SELECT jsonb_agg(data ORDER BY n DESC,context,tag1,tag2) FROM(SELECT * FROM pairs ORDER BY n DESC,context,tag1,tag2 LIMIT 200)q),'[]'::jsonb),
    'hourly',(SELECT jsonb_agg(data ORDER BY hour) FROM hours),
    'facets',jsonb_build_object(
      'contexts',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'count',n) ORDER BY n DESC,key) FROM facet WHERE kind='contexts'),'[]'::jsonb),
      'modes',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'count',n) ORDER BY n DESC,key) FROM(SELECT * FROM facet WHERE kind='modes' ORDER BY n DESC,key LIMIT 2000)q),'[]'::jsonb),
      'maps',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'count',n) ORDER BY n DESC,key) FROM(SELECT * FROM facet WHERE kind='maps' ORDER BY n DESC,key LIMIT 2000)q),'[]'::jsonb),
      'brawlers',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'count',n) ORDER BY n DESC,key) FROM(SELECT * FROM facet WHERE kind='brawlers' ORDER BY n DESC,key LIMIT 2000)q),'[]'::jsonb)),
    'coverage',jsonb_build_object('status',CASE WHEN gap.n>0 THEN 'possible_gap' WHEN cardinality(v_tags)>0 AND coverage.monitored=cardinality(v_tags) AND coverage.stale=0 THEN 'observed' ELSE 'unknown' END,
      'currentPlayers',cardinality(v_tags),'monitoredPlayers',coverage.monitored,'affectedPlayers',gap.players,
      'baselineAt',coverage.baseline,'lastCheckedAt',coverage.checked,'earliestBattleAt',(SELECT min(battle_time) FROM retained),
      'latestBattleAt',(SELECT max(battle_time) FROM retained),'possibleGapCount',gap.n,'retainedGapWindowDays',28,'requestedDays',p_days,
      'fullPeriodMonitoredPlayers',coverage.full_period,'stalePlayers',coverage.stale,
      'teamObservations',(SELECT count(*) FROM analyzed WHERE jsonb_array_length(team->'own')>1),
      'pairEligibleObservations',(SELECT count(DISTINCT id) FROM pair_observations),'truncated',(SELECT count(*)>100000 FROM raw),'completeHistory',false),
    'limits',jsonb_build_object('observationLimit',100000,'groupLimit',200,'facetLimit',2000,'truncated',(SELECT count(*)>100000 FROM raw),
      'groupCounts',jsonb_build_object('modes',(SELECT count(*) FROM groups WHERE kind='modes'),'maps',(SELECT count(*) FROM groups WHERE kind='maps'),'brawlers',(SELECT count(*) FROM groups WHERE kind='brawlers'),'pairs',(SELECT count(*) FROM pairs)),
      'facetCounts',jsonb_build_object('modes',(SELECT count(*) FROM facet WHERE kind='modes'),'maps',(SELECT count(*) FROM facet WHERE kind='maps'),'brawlers',(SELECT count(*) FROM facet WHERE kind='brawlers'))))
    INTO v_result FROM gap CROSS JOIN coverage;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.club_readiness_read(p_now timestamptz DEFAULT now(),p_brawler integer DEFAULT NULL,p_min_power integer DEFAULT 0,p_search text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET statement_timeout='10s' AS $$
DECLARE v_tags text[];v_result jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) OR (p_brawler IS NOT NULL AND p_brawler<0) OR p_min_power IS NULL OR p_min_power NOT BETWEEN 0 AND 11
    OR length(p_search)>100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_readiness_filter';
  END IF;
  SELECT coalesce(array_agg(m.player_tag),'{}') INTO v_tags FROM public.members m JOIN public.member_history h USING(player_tag) WHERE h.is_current_member;
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_readiness_roster'; END IF;
  IF (SELECT count(*) FROM(SELECT 1 FROM public.player_brawler_details WHERE player_tag=ANY(v_tags) LIMIT 50001)bounded)>50000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_readiness_inventory';
  END IF;
  WITH roster AS MATERIALIZED(SELECT player_tag,player_name FROM public.members WHERE player_tag=ANY(v_tags)),
  inventory AS MATERIALIZED(
    SELECT d.player_tag,m.player_name,d.brawler_id,d.brawler_name,CASE WHEN d.power_level BETWEEN 1 AND 11 THEN d.power_level ELSE NULL END power_level,d.trophies,d.rank,d.highest_trophies,
      d.prestige_level,d.current_win_streak,d.max_win_streak,d.gadgets,d.star_powers,d.gears,d.hyper_charges,d.buffies,d.observed_at,d.field_checked_at
    FROM public.player_brawler_details d JOIN roster m USING(player_tag) WHERE d.observed_at<=p_now
  ), filtered AS MATERIALIZED(
    SELECT * FROM inventory WHERE(p_brawler IS NULL OR brawler_id=p_brawler) AND(p_min_power=0 OR power_level>=p_min_power)
      AND(p_search IS NULL OR strpos(lower(player_name),lower(p_search))>0 OR strpos(lower(brawler_name),lower(p_search))>0)
  ), page AS (
    SELECT * FROM filtered ORDER BY player_name,player_tag,brawler_id LIMIT p_limit OFFSET p_offset
  ), members AS (
    SELECT m.player_tag,m.player_name,count(i.brawler_id) n,count(*) FILTER(WHERE i.power_level>=9) power9,
      count(*) FILTER(WHERE i.power_level>=10) power10,count(*) FILTER(WHERE i.power_level=11) power11,max(i.observed_at) observed
    FROM roster m LEFT JOIN inventory i USING(player_tag) GROUP BY m.player_tag,m.player_name
  ), brawlers AS (
    SELECT brawler_id,min(brawler_name) name,count(*) n FROM inventory GROUP BY brawler_id
  ) SELECT jsonb_build_object('members',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',player_tag,'name',player_name,'brawlersObserved',n,
    'power9Plus',power9,'power10Plus',power10,'power11',power11,'observedAt',observed) ORDER BY player_name,player_tag) FROM members),'[]'::jsonb),
    'brawlers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',brawler_id,'name',name,'playersObserved',n) ORDER BY name,brawler_id) FROM brawlers),'[]'::jsonb),
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('player',jsonb_build_object('tag',player_tag,'name',player_name),
      'brawler',jsonb_build_object('id',brawler_id,'name',brawler_name),'powerLevel',power_level,'trophies',trophies,'highestTrophies',highest_trophies,
      'rank',rank,'prestigeLevel',prestige_level,'currentWinStreak',current_win_streak,'maxWinStreak',max_win_streak,
      'gadgets',gadgets,'starPowers',star_powers,'gears',gears,'hyperCharges',hyper_charges,'buffies',buffies,
      'observedAt',observed_at,'fieldCheckedAt',field_checked_at) ORDER BY player_name,player_tag,brawler_id) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered)) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_team(jsonb,text),public.analysis_stats(bigint,bigint,bigint,bigint,bigint,bigint),
  public.club_analysis_read(integer,timestamptz,text,text,text,text),public.club_readiness_read(timestamptz,integer,integer,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_team(jsonb,text),public.analysis_stats(bigint,bigint,bigint,bigint,bigint,bigint),
  public.club_analysis_read(integer,timestamptz,text,text,text,text),public.club_readiness_read(timestamptz,integer,integer,text,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
