BEGIN;
-- Restores battles captured by the GitHub battle safety-net archive after an
-- outage. Insert-only: existing battle rows are never changed. Daily stats are
-- rebuilt for the affected player/day pairs with the same rules as
-- commit_sync_snapshot; the next full sync refreshes 28-day tracking totals.
CREATE OR REPLACE FUNCTION public.import_archived_battles(p_battles jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET work_mem='32MB' AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_inserted integer; v_days integer;
BEGIN
  IF jsonb_typeof(p_battles) IS DISTINCT FROM 'array' OR jsonb_array_length(p_battles)>5000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_archive_batch';
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.archive_new(player_tag text,battle_time timestamptz) ON COMMIT DROP;
  TRUNCATE pg_temp.archive_new;
  WITH ins AS (
    INSERT INTO battle_history(player_tag,battle_time,mode,map,result,trophy_change,is_star_player,brawler_name,brawler_power,brawler_trophies,teams_json,battle_type,event_id,battle_mode,event_mode,placement_rank,trophy_change_reported,event_mode_id,duration_seconds)
    SELECT x.player_tag,x.battle_time,x.mode,x.map,x.result,x.trophy_change,coalesce(x.is_star_player,false),x.brawler_name,x.brawler_power,x.brawler_trophies,
      CASE WHEN jsonb_typeof(x.teams_json)='string' THEN (x.teams_json #>> '{}')::jsonb ELSE x.teams_json END,
      nullif(x.battle_type,''),x.event_id,nullif(x.battle_mode,''),nullif(x.event_mode,''),x.placement_rank,
      CASE WHEN x.trophy_change_reported IS NULL THEN NULL ELSE x.trophy_change_reported AND x.trophy_change IS NOT NULL END,
      x.event_mode_id,public.sync_progress_integer(x.duration_seconds)
    FROM jsonb_to_recordset(p_battles) AS x(player_tag text,battle_time timestamptz,mode text,map text,result text,trophy_change integer,is_star_player boolean,brawler_name text,brawler_power integer,brawler_trophies integer,teams_json jsonb,battle_type text,event_id integer,battle_mode text,event_mode text,placement_rank integer,trophy_change_reported boolean,event_mode_id integer,duration_seconds jsonb)
    WHERE x.player_tag ~ '^#[0-9A-Z]+$' AND x.battle_time >= v_now-interval '90 days' AND x.battle_time <= v_now+interval '1 minute'
      AND EXISTS (SELECT 1 FROM members m WHERE m.player_tag=x.player_tag)
    ON CONFLICT(player_tag,battle_time) DO NOTHING
    RETURNING player_tag,battle_time
  ) INSERT INTO pg_temp.archive_new SELECT * FROM ins;
  SELECT count(*) INTO v_inserted FROM pg_temp.archive_new;

  INSERT INTO daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost)
  SELECT b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date,count(*),count(*) FILTER(WHERE result='victory'),count(*) FILTER(WHERE result='defeat'),count(*) FILTER(WHERE is_star_player),
    coalesce(sum(greatest(trophy_change,0)) FILTER(WHERE nullif(trim(b.battle_type),'') IS NULL OR public.battle_feed_context(b.battle_type)='ladder'),0),
    coalesce(sum(greatest(-trophy_change,0)) FILTER(WHERE nullif(trim(b.battle_type),'') IS NULL OR public.battle_feed_context(b.battle_type)='ladder'),0)
  FROM battle_history b JOIN (
    SELECT DISTINCT player_tag tag,(battle_time AT TIME ZONE 'UTC')::date battle_date FROM pg_temp.archive_new
  ) affected ON b.player_tag=affected.tag AND (b.battle_time AT TIME ZONE 'UTC')::date=affected.battle_date
  GROUP BY b.player_tag,(b.battle_time AT TIME ZONE 'UTC')::date
  ON CONFLICT(player_tag,date) DO UPDATE SET battles=excluded.battles,wins=excluded.wins,losses=excluded.losses,star_player=excluded.star_player,trophies_gained=excluded.trophies_gained,trophies_lost=excluded.trophies_lost;
  GET DIAGNOSTICS v_days=ROW_COUNT;

  UPDATE member_activity_state s SET last_battle_at=n.latest,last_activity_at=greatest(s.last_activity_at,n.latest)
  FROM (SELECT player_tag,max(battle_time) latest FROM pg_temp.archive_new GROUP BY player_tag) n
  WHERE s.player_tag=n.player_tag AND (s.last_battle_at IS NULL OR s.last_battle_at<n.latest);

  RETURN jsonb_build_object('received',jsonb_array_length(p_battles),'inserted',v_inserted,'daysRebuilt',v_days);
END $$;
REVOKE ALL ON FUNCTION public.import_archived_battles(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_archived_battles(jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
