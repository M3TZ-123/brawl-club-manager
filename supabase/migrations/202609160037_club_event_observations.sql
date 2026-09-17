BEGIN;

-- Evidence only: no attendance/counter writes, no external calls, no map/type
-- heuristics. A recorded player battle does not prove an official club credit.
CREATE FUNCTION public.club_event_observations_read(p_club text,p_event uuid,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET timezone='UTC' SET statement_timeout='5s' AS $$
DECLARE v_club text; v_event public.club_planned_events; v_until timestamptz;
  v_roster timestamptz; v_full timestamptz; v_battle timestamptz; v_value timestamptz;
  v_setting record; v_members jsonb;
BEGIN
  IF p_club IS NULL OR p_club !~ '^#[A-Z0-9]{1,20}$' OR p_event IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'invalid_event_observation_query' USING ERRCODE='22023';
  END IF;
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club
    FROM public.settings WHERE key='club_tag';
  -- The HTTP caller validates the configured environment fallback first.
  v_club:=coalesce(v_club,p_club);
  FOR v_setting IN SELECT key,value FROM public.settings
    WHERE key IN('last_roster_sync_time','last_sync_time','last_full_sync_time','last_battle_sync_time') LOOP
    BEGIN v_value:=nullif(btrim(v_setting.value),'')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_value:=NULL; END;
    IF v_value IS NOT NULL AND (NOT isfinite(v_value) OR v_value>p_now) THEN v_value:=NULL; END IF;
    IF v_setting.key='last_roster_sync_time' THEN v_roster:=v_value;
    ELSIF v_setting.key='last_battle_sync_time' THEN v_battle:=v_value;
    ELSE v_full:=greatest(v_full,v_value); END IF;
  END LOOP;
  IF v_club IS DISTINCT FROM p_club OR greatest(v_roster,v_full) IS NULL THEN
    RAISE EXCEPTION 'event_roster_unavailable' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_event FROM public.club_planned_events WHERE id=p_event AND club_tag=v_club AND kind='mega_pig';
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING ERRCODE='P0002'; END IF;
  IF NOT isfinite(v_event.starts_at) OR NOT isfinite(v_event.ends_at) OR v_event.ends_at<=v_event.starts_at
    OR v_event.ends_at>v_event.starts_at+interval '31 days' OR v_event.version<1 THEN
    RAISE EXCEPTION 'invalid_saved_event' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM public.club_event_entries WHERE event_id=p_event)>30 THEN
    RAISE EXCEPTION 'event_member_limit' USING ERRCODE='54000';
  END IF;
  v_until:=least(v_event.ends_at,p_now);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'playerTag',entry.player_tag,'playerName',entry.player_name,
    'observedBattles',observed.total,'lastObservedBattleAt',observed.last_at,
    'explicitMegaPigBattles',observed.tagged,'lastExplicitMegaPigBattleAt',observed.tagged_last_at,
    'authoritativeWins',NULL,'ticketsRemaining',NULL,
    'coverage',jsonb_build_object(
      'baselineAt',CASE WHEN isfinite(coverage.baseline_started_at) AND coverage.baseline_started_at<=p_now THEN coverage.baseline_started_at END,
      'checkedAt',CASE WHEN isfinite(coverage.last_observed_at) AND coverage.last_observed_at<=p_now THEN coverage.last_observed_at END,
      'status',CASE WHEN isfinite(coverage.last_attempt_at) AND coverage.last_attempt_at<=p_now THEN coverage.last_observation_status ELSE 'unknown' END,
      'possibleGap',EXISTS(SELECT 1 FROM public.sync_battle_gaps gap WHERE gap.club_tag=v_club AND gap.player_tag=entry.player_tag
        AND gap.gap_start_at<v_until AND gap.gap_end_at>v_event.starts_at AND gap.detected_at<=p_now))
    ) ORDER BY entry.player_tag),'[]') INTO v_members
  FROM public.club_event_entries entry
  LEFT JOIN public.sync_battle_coverage coverage ON coverage.club_tag=v_club AND coverage.player_tag=entry.player_tag
  CROSS JOIN LATERAL (
    SELECT count(*) total,max(b.battle_time) last_at,
      count(*) FILTER(WHERE lower(btrim(b.battle_type))='megapig') tagged,
      max(b.battle_time) FILTER(WHERE lower(btrim(b.battle_type))='megapig') tagged_last_at
    FROM public.battle_history b WHERE b.player_tag=entry.player_tag AND b.battle_time>=v_event.starts_at AND b.battle_time<v_until
    -- The existing UNIQUE(player_tag,battle_time) prevents duplicate observations.
  ) observed
  WHERE entry.event_id=p_event;
  RETURN jsonb_build_object('clubTag',v_club,'eventId',v_event.id,'eventVersion',v_event.version,'status',v_event.status,
    'startsAt',v_event.starts_at,'endsAt',v_event.ends_at,'observedUntil',v_until,'generatedAt',p_now,'hasStarted',p_now>v_event.starts_at,
    'historyLimited',true,'classification','explicit_battle_type_only',
    'sync',jsonb_build_object('lastFullSyncAt',v_full,'lastBattleSyncAt',v_battle,'stale',v_battle IS NULL OR v_battle<p_now-interval '35 minutes'),
    'members',v_members);
END $$;
REVOKE ALL ON FUNCTION public.club_event_observations_read(text,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.club_event_observations_read(text,uuid,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
