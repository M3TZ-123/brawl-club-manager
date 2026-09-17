-- Local-hour analytics use each observation's timestamp, including fractional
-- offsets and daylight-saving changes. No writes or new game API requests.
BEGIN;

CREATE OR REPLACE FUNCTION public.club_analysis_hours_read(
  p_days integer,p_now timestamptz DEFAULT now(),p_context text DEFAULT NULL,p_mode text DEFAULT NULL,
  p_map text DEFAULT NULL,p_brawler text DEFAULT NULL,p_timezone text DEFAULT 'UTC')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET statement_timeout='15s' AS $$
DECLARE v_tags text[];v_club text;v_since timestamptz;v_result jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN(1,3,7,30,90) OR p_now IS NULL OR NOT isfinite(p_now)
    OR (p_context IS NOT NULL AND p_context NOT IN('ladder','ranked','challenge','friendly','mega_pig','tournament','unknown'))
    OR length(p_mode)>100 OR length(p_map)>100 OR length(p_brawler)>50 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_range';
  END IF;
  IF p_timezone IS NULL OR length(p_timezone)>100
    OR (p_timezone<>'UTC' AND p_timezone!~'^([A-Za-z][A-Za-z0-9._+-]*/)+[A-Za-z][A-Za-z0-9._+-]*$') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_timezone';
  END IF;
  BEGIN
    PERFORM pg_catalog.timezone(p_timezone,p_now);
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_timezone';
  END;
  SELECT coalesce(array_agg(m.player_tag),'{}') INTO v_tags FROM public.members m
    JOIN public.member_history h USING(player_tag) WHERE h.is_current_member;
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_analysis_roster'; END IF;
  SELECT upper(regexp_replace(btrim(value),'^%23','#','i')) INTO v_club FROM public.settings WHERE key='club_tag';
  IF left(coalesce(v_club,''),1)<>'#' THEN v_club:='#'||v_club; END IF;
  -- Hours, rather than calendar-day intervals, keep the rolling window fixed
  -- even if the database session itself uses a zone crossing a DST boundary.
  v_since:=p_now-make_interval(hours=>p_days*24);
  WITH raw AS MATERIALIZED (
    SELECT b.id,b.player_tag,b.battle_time,
      public.battle_feed_mode(coalesce(nullif(b.event_mode,''),nullif(b.battle_mode,''),b.mode),b.event_mode_id) mode,
      public.battle_feed_context(b.battle_type) context,coalesce(nullif(b.map,''),'unknown') map,
      coalesce(nullif(b.brawler_name,''),'unknown') brawler,b.teams_json,
      CASE lower(btrim(b.result)) WHEN 'victory' THEN 'victory' WHEN 'defeat' THEN 'defeat' WHEN 'draw' THEN 'draw' ELSE 'unknown' END result,
      CASE WHEN b.duration_seconds>=0 THEN b.duration_seconds ELSE NULL END duration_seconds
    FROM public.battle_history b WHERE b.player_tag=ANY(v_tags) AND b.battle_time>=v_since AND b.battle_time<=p_now
    ORDER BY b.battle_time DESC,b.id DESC LIMIT 100001
  ), retained AS MATERIALIZED (SELECT * FROM raw ORDER BY battle_time DESC,id DESC LIMIT 100000),
  selected AS MATERIALIZED (
    SELECT *,battle_time AT TIME ZONE p_timezone local_time FROM retained
    WHERE (p_context IS NULL OR context=p_context) AND (p_mode IS NULL OR mode=public.battle_feed_mode(p_mode))
      AND (p_map IS NULL OR map=p_map) AND (p_brawler IS NULL OR brawler=p_brawler)
  ), analyzed AS MATERIALIZED (SELECT s.id,public.analysis_team(s.teams_json,s.player_tag) team FROM selected s),
  summary AS (
    SELECT public.analysis_stats(count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),
      count(*) FILTER(WHERE result='draw'),sum(duration_seconds),count(duration_seconds)) data FROM selected
  ), facet AS MATERIALIZED (
    SELECT CASE WHEN grouping(context)=0 THEN 'contexts' WHEN grouping(mode)=0 THEN 'modes'
      WHEN grouping(map)=0 THEN 'maps' ELSE 'brawlers' END kind,coalesce(context,mode,map,brawler) key,count(*) n
    FROM retained GROUP BY GROUPING SETS((context),(mode),(map),(brawler))
  ), hours AS (
    SELECT h.hour,public.analysis_stats(count(s.id),count(s.id) FILTER(WHERE s.result='victory'),
      count(s.id) FILTER(WHERE s.result='defeat'),count(s.id) FILTER(WHERE s.result='draw'),sum(s.duration_seconds),count(s.duration_seconds))
      ||jsonb_build_object('hour',h.hour,'uniquePlayers',count(DISTINCT s.player_tag),'activeDays',count(DISTINCT s.local_time::date)) data
    FROM generate_series(0,23) h(hour) LEFT JOIN selected s ON extract(hour FROM s.local_time)=h.hour GROUP BY h.hour
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
  SELECT jsonb_build_object('timeZone',p_timezone,'summary',(SELECT data FROM summary),
    'modes','[]'::jsonb,'maps','[]'::jsonb,'brawlers','[]'::jsonb,'pairs','[]'::jsonb,
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
      'pairEligibleObservations',(SELECT count(*) FROM analyzed a WHERE (SELECT count(*) FROM jsonb_array_elements_text(a.team->'own') t(tag) WHERE tag=ANY(v_tags))>1),
      'truncated',(SELECT count(*)>100000 FROM raw),'completeHistory',false),
    'limits',jsonb_build_object('observationLimit',100000,'groupLimit',200,'facetLimit',2000,'truncated',(SELECT count(*)>100000 FROM raw),
      'groupCounts',jsonb_build_object('modes',0,'maps',0,'brawlers',0,'pairs',0),
      'facetCounts',jsonb_build_object('modes',(SELECT count(*) FROM facet WHERE kind='modes'),'maps',(SELECT count(*) FROM facet WHERE kind='maps'),'brawlers',(SELECT count(*) FROM facet WHERE kind='brawlers'))))
    INTO v_result FROM gap CROSS JOIN coverage;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.club_analysis_hours_read(integer,timestamptz,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.club_analysis_hours_read(integer,timestamptz,text,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
