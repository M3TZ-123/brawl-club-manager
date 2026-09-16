-- Read-only RPCs replace network waterfalls with one consistent statement snapshot.
-- No tables, historical data, cadence or retention are changed. Public HTTP
-- responses remain uncached, so a completed sync/club change cannot reuse stale data.
BEGIN;
CREATE OR REPLACE FUNCTION public.report_dashboard_read(p_days integer,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_tags text[]; v_start timestamptz; v_members jsonb; v_events jsonb; v_counts jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN (1,3,7,30,90) OR p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'Invalid reporting range' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(h.player_tag ORDER BY h.player_tag),'{}') INTO v_tags
    FROM public.member_history h WHERE h.is_current_member=true;
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION 'Invalid reporting roster' USING ERRCODE='22023'; END IF;
  v_start:=(((p_now AT TIME ZONE 'UTC')::date-(p_days-1))::timestamp AT TIME ZONE 'UTC');
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'player_tag',m.player_tag,
    'player_name',m.player_name,
    'icon_id',m.icon_id,
    'role',m.role,
    'trophies',m.trophies,
    'highest_trophies',m.highest_trophies,
    'exp_level',m.exp_level,
    'rank_current',m.rank_current,
    'rank_highest',m.rank_highest,
    'win_rate',m.win_rate,
    'brawlers_count',m.brawlers_count,
    'solo_victories',m.solo_victories,
    'duo_victories',m.duo_victories,
    'trio_victories',m.trio_victories,
    'is_active',m.is_active,
    'last_updated',m.last_updated,
    'trophies_24h',a.trophies_24h,'trophies_3d',a.trophies_3d,'trophies_7d',a.trophies_7d,
    'trophies_30d',a.trophies_30d,'trophies_90d',a.trophies_90d,'trophy_baselines',a.trophy_baselines,
    'last_battle_at',a.last_battle_at,'last_activity_at',a.last_activity_at
  ) ORDER BY m.trophies DESC NULLS LAST,m.player_tag),'[]') INTO v_members
  FROM public.members m LEFT JOIN public.sync_activity_summary_v2(v_tags,p_now) a ON a.player_tag=m.player_tag
  WHERE m.player_tag=ANY(v_tags);

  SELECT jsonb_build_object('joins',count(*) FILTER(WHERE e.event_type='join'),'leaves',count(*) FILTER(WHERE e.event_type='leave')) INTO v_counts
    FROM public.club_events e WHERE e.event_time BETWEEN v_start AND p_now;
  SELECT v_counts || jsonb_build_object('nameChanges',count(*) FILTER(WHERE n.type='name_change'),
    'roleChanges',count(*) FILTER(WHERE n.type IN ('promotion','demotion','role_change'))) INTO v_counts
    FROM public.notifications n WHERE n.created_at BETWEEN v_start AND p_now AND n.type IN ('name_change','promotion','demotion','role_change');
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'event_type',e.event_type,'player_tag',e.player_tag,
    'player_name',e.player_name,'event_time',e.event_time) ORDER BY e.event_time DESC,e.id DESC),'[]') INTO v_events
  FROM (SELECT id,event_type,player_tag,player_name,event_time FROM public.club_events
    WHERE event_time BETWEEN v_start AND p_now ORDER BY event_time DESC,id DESC LIMIT 5) e;

  RETURN jsonb_build_object('members',v_members,'recentEvents',v_events,'changeCounts',v_counts,
    'inactivityThreshold',(SELECT value FROM public.settings WHERE key='inactivity_threshold'),
    'lastSyncTime',(SELECT value FROM public.settings WHERE key='last_sync_time'));
END $$;

CREATE OR REPLACE FUNCTION public.report_leaderboard_read(p_days integer,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_tags text[]; v_start date; v_end date; v_members jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN (1,3,7,30,90) OR p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'Invalid reporting range' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(h.player_tag ORDER BY h.player_tag),'{}') INTO v_tags
    FROM public.member_history h WHERE h.is_current_member=true;
  IF cardinality(v_tags)>100 THEN RAISE EXCEPTION 'Invalid reporting roster' USING ERRCODE='22023'; END IF;
  v_end:=(p_now AT TIME ZONE 'UTC')::date;
  v_start:=v_end-(p_days-1);
  -- Only selected UTC dates contribute. Nothing is labelled all-time, and no
  -- streak is inferred from a truncated period or old player_tracking counters.
  WITH period_stats AS (
    SELECT d.player_tag,sum(d.battles) battles,sum(d.wins) wins,sum(d.losses) losses,
      sum(d.star_player) stars,count(*) FILTER(WHERE d.battles>0) active_days
    FROM public.daily_stats d WHERE d.player_tag=ANY(v_tags) AND d.date BETWEEN v_start AND v_end GROUP BY d.player_tag
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'player_tag',m.player_tag,'player_name',m.player_name,'role',m.role,'trophies',m.trophies,
    'highest_trophies',m.highest_trophies,'brawlers_count',m.brawlers_count,
    'last_battle_at',s.last_battle_at,'last_activity_at',s.last_activity_at,
    'trophyChange',m.trophies-a.trophies,
    'battles',coalesce(d.battles,0),'wins',coalesce(d.wins,0),'losses',coalesce(d.losses,0),
    'starPlayer',coalesce(d.stars,0),'activeDays',coalesce(d.active_days,0)
  ) ORDER BY m.player_tag),'[]') INTO v_members
  FROM public.members m LEFT JOIN period_stats d ON d.player_tag=m.player_tag
  LEFT JOIN public.member_activity_state s ON s.player_tag=m.player_tag
  -- Exactly the same baseline rule as sync_activity_summary_v2; one range only.
  LEFT JOIN LATERAL (
    SELECT l.trophies FROM public.activity_log l WHERE l.player_tag=m.player_tag AND l.trophies IS NOT NULL
      AND l.recorded_at BETWEEN p_now-make_interval(days=>p_days+1) AND p_now-make_interval(days=>p_days)
    ORDER BY l.recorded_at DESC,l.id DESC LIMIT 1
  ) a ON true WHERE m.player_tag=ANY(v_tags);
  RETURN jsonb_build_object('members',v_members,
    'inactivityThreshold',(SELECT value FROM public.settings WHERE key='inactivity_threshold'),
    'lastSyncTime',(SELECT value FROM public.settings WHERE key='last_sync_time'));
END $$;
REVOKE ALL ON FUNCTION public.report_dashboard_read(integer,timestamptz),public.report_leaderboard_read(integer,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_dashboard_read(integer,timestamptz),public.report_leaderboard_read(integer,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
