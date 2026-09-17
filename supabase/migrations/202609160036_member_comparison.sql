BEGIN;

-- An administrator-only read. STABLE keeps every SELECT on the same statement
-- snapshot; it never calls ingestion, refreshes a provider or changes a review.
CREATE OR REPLACE FUNCTION public.member_comparison_read(p_club text,p_days integer,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET timezone='UTC' SET statement_timeout='5s' AS $$
DECLARE v_club text; v_roster timestamptz; v_full timestamptz; v_start date; v_end date;
  v_tags text[]; v_members jsonb; v_candidates jsonb; v_grace integer;
BEGIN
  IF p_club IS NULL OR p_club !~ '^#[A-Z0-9]{1,20}$' OR p_days IS NULL OR p_days NOT IN(7,30,90)
    OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'invalid_comparison' USING ERRCODE='22023'; END IF;
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_club
    FROM public.settings WHERE key='club_tag';
  -- The server validates the environment fallback before supplying p_club.
  v_club:=coalesce(v_club,p_club);
  BEGIN
    SELECT nullif(btrim(value),'')::timestamptz INTO v_roster FROM public.settings WHERE key='last_roster_sync_time';
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_roster:=NULL; END;
  BEGIN
    SELECT nullif(btrim(value),'')::timestamptz INTO v_full FROM public.settings WHERE key='last_sync_time';
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_full:=NULL; END;
  IF v_roster IS NOT NULL AND (NOT isfinite(v_roster) OR v_roster>p_now) THEN v_roster:=NULL; END IF;
  IF v_full IS NOT NULL AND (NOT isfinite(v_full) OR v_full>p_now) THEN v_full:=NULL; END IF;
  IF v_club IS DISTINCT FROM p_club OR greatest(v_roster,v_full) IS NULL THEN
    RAISE EXCEPTION 'comparison_roster_unavailable' USING ERRCODE='40001';
  END IF;
  v_end:=(p_now AT TIME ZONE 'UTC')::date; v_start:=v_end-p_days;
  SELECT coalesce(array_agg(player_tag ORDER BY player_tag),'{}') INTO v_tags FROM public.member_history WHERE is_current_member;
  IF cardinality(v_tags)>30 THEN RAISE EXCEPTION 'comparison_roster_limit' USING ERRCODE='54000'; END IF;
  IF (SELECT count(*) FROM public.recruitment_candidates)>100 THEN RAISE EXCEPTION 'comparison_candidate_limit' USING ERRCODE='54000'; END IF;
  SELECT coalesce(grace_hours,0) INTO v_grace FROM public.club_administration_settings WHERE club_tag=v_club;
  v_grace:=coalesce(v_grace,0);

  -- Inspect the retained first/last observations once for the entire club, not
  -- once per member. These are observed membership dates, never invented joins.
  WITH snapshot_rows AS MATERIALIZED (
    SELECT snapshot_day,first_observed_at,last_observed_at,first_members,last_members
    FROM public.club_roster_snapshots WHERE club_tag=v_club AND snapshot_day BETWEEN v_end-91 AND v_end
    ORDER BY snapshot_day DESC LIMIT 92
  ), observations AS MATERIALIZED (
    SELECT CASE WHEN isfinite(o.at) AND o.at<=p_now THEN o.at ELSE p_now END observed_at,
      isfinite(o.at) AND o.at<=p_now AND (o.at AT TIME ZONE 'UTC')::date=s.snapshot_day
        AND CASE WHEN jsonb_typeof(o.members)='array' THEN jsonb_array_length(o.members)<=30 ELSE false END
        AND checked.valid AND checked.total=cardinality(checked.tags) valid,
      checked.tags
    FROM snapshot_rows s CROSS JOIN LATERAL (VALUES(s.first_observed_at,s.first_members),(s.last_observed_at,s.last_members)) o(at,members)
    CROSS JOIN LATERAL (
      SELECT count(*) total,coalesce(bool_and(coalesce(jsonb_typeof(m)='object'
        AND jsonb_typeof(m->'tag')='string' AND coalesce(m->>'tag','')~'^#[A-Z0-9]{2,20}$'
        AND jsonb_typeof(m->'name')='string' AND length(coalesce(m->>'name','')) BETWEEN 1 AND 160
        AND jsonb_typeof(m->'role')='string' AND length(coalesce(m->>'role','')) BETWEEN 1 AND 160
        AND jsonb_typeof(m->'trophies')='number' AND coalesce(m->>'trophies','')~'^[0-9]{1,10}$'
        AND CASE WHEN coalesce(m->>'trophies','')~'^[0-9]{1,10}$' THEN (m->>'trophies')::bigint<=2147483647 ELSE false END,false)),true) valid,
        coalesce(array_agg(DISTINCT m->>'tag') FILTER(WHERE m->>'tag' IS NOT NULL),'{}') tags
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.members)='array' THEN
        CASE WHEN jsonb_array_length(o.members)<=30 THEN o.members ELSE '[]'::jsonb END ELSE '[]'::jsonb END)m
    ) checked
  ), latest_observation AS MATERIALIZED (
    SELECT max(observed_at) observed_at FROM observations
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tag',h.player_tag,'name',coalesce(m.player_name,h.player_name),'role',m.role,
    'profile',jsonb_build_object('trophies',m.trophies,'trophiesCheckedAt',m.last_updated,
      'power11',CASE WHEN profile.observed_at<=p_now AND m.brawlers_count BETWEEN 0 AND 300 AND inventory.total=m.brawlers_count AND inventory.valid=inventory.total THEN inventory.power11 END,
      'profileCheckedAt',profile.observed_at,
      'rank',CASE WHEN m.ranked_provenance->'rank_current'->>'checked_at' IS NOT NULL
        AND m.ranked_provenance->'rank_current'->>'checked_at'=m.ranked_provenance->'ranked_points'->>'checked_at' THEN m.rank_current END,
      'rankedPoints',m.ranked_points,
      'rankedSeasonId',CASE WHEN m.ranked_provenance->'ranked_season_id'->>'checked_at' IS NOT NULL
        AND m.ranked_provenance->'ranked_season_id'->>'checked_at'=m.ranked_provenance->'ranked_points'->>'checked_at' THEN m.ranked_season_id END,
      'rankedCheckedAt',m.ranked_provenance->'ranked_points'->>'checked_at'),
    'lastActivityAt',activity.last_activity_at,'lastBattleAt',activity.last_battle_at,
    'spell',jsonb_build_object('startedAt',CASE WHEN membership.event_type IN('join','initial_seen') THEN membership.occurred_at END,
      'source',coalesce(membership.source,'unknown'),'kind',CASE WHEN membership.event_type IN('join','initial_seen') THEN membership.event_type ELSE 'unknown' END,
      'uncertain',membership.event_type IS NULL OR membership.event_type NOT IN('join','initial_seen') OR membership.source<>'recorded'
        OR coalesce(continuity.boundary_at>=membership.occurred_at,false)),
    'graceUntil',CASE WHEN membership.event_type IN('join','initial_seen') AND membership.source='recorded' AND v_grace>0
      THEN membership.occurred_at+make_interval(hours=>v_grace) END,
    'membershipObservation',jsonb_build_object('observedSince',observation.started_at,'checkedAt',observation.checked_at,
      'source',observation.source,'graceUntil',CASE WHEN observation.started_at IS NOT NULL AND v_grace>0
        THEN observation.started_at+make_interval(hours=>v_grace) END),
    'absence',absence.value,
    'coverage',jsonb_build_object('baselineAt',coverage.baseline_started_at,'checkedAt',coverage.last_observed_at,
      'lastStatus',coalesce(coverage.last_observation_status,'unknown'),
      'trailing48hGap',EXISTS(SELECT 1 FROM public.sync_battle_gaps g WHERE g.club_tag=v_club AND g.player_tag=h.player_tag
        AND g.gap_start_at<p_now AND g.gap_end_at>p_now-interval '48 hours' AND g.detected_at<=p_now),
      'trailing48hExcused',EXISTS(SELECT 1 FROM public.member_absences a WHERE a.club_tag=v_club AND a.player_tag=h.player_tag
        AND a.starts_at<p_now AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>p_now-interval '48 hours'
        AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>a.starts_at)
        OR coalesce(observation.started_at IS NOT NULL AND v_grace>0
          AND observation.started_at+make_interval(hours=>v_grace)>p_now-interval '48 hours',false)),
    'days',days.value,'events',events.value,'eventsTruncated',coalesce(events.total,0)>100
  ) ORDER BY h.player_tag),'[]') INTO v_members
  FROM public.member_history h
  LEFT JOIN public.members m ON m.player_tag=h.player_tag
  LEFT JOIN public.player_profile_details profile ON profile.player_tag=h.player_tag
  LEFT JOIN public.member_activity_state activity ON activity.player_tag=h.player_tag
  LEFT JOIN public.sync_battle_coverage coverage ON coverage.club_tag=v_club AND coverage.player_tag=h.player_tag
  LEFT JOIN LATERAL (
    SELECT count(*) total,count(*) FILTER(WHERE power_level BETWEEN 1 AND 11) valid,count(*) FILTER(WHERE power_level=11) power11
    FROM (SELECT power_level FROM public.player_brawler_details WHERE player_tag=h.player_tag LIMIT 301) bounded
  ) inventory ON true
  LEFT JOIN LATERAL (
    SELECT e.event_type,e.occurred_at,e.source FROM public.membership_change_events e
    WHERE e.club_tag=v_club AND e.player_tag=h.player_tag AND e.event_type IN('join','initial_seen','leave') AND e.occurred_at<=p_now
    ORDER BY e.occurred_at DESC,(e.event_type='leave') DESC,e.id DESC LIMIT 1
  ) membership ON true
  LEFT JOIN LATERAL (
    -- A malformed whole roster is uncertainty for every member. Do not drop
    -- only the malformed entry and mistake the remainder for complete proof.
    SELECT max(o.observed_at) FILTER(WHERE o.valid IS NOT TRUE OR NOT(h.player_tag=ANY(o.tags))) boundary_at,
      bool_and(o.valid IS TRUE AND h.player_tag=ANY(o.tags)) FILTER(WHERE o.observed_at=latest.observed_at) current_included,
      latest.observed_at checked_at
    FROM observations o CROSS JOIN latest_observation latest GROUP BY latest.observed_at
  ) continuity ON true
  LEFT JOIN LATERAL (
    SELECT min(o.observed_at) started_at FROM observations o
    WHERE o.valid IS TRUE AND h.player_tag=ANY(o.tags)
      AND (greatest(membership.occurred_at,continuity.boundary_at) IS NULL
        OR o.observed_at>greatest(membership.occurred_at,continuity.boundary_at))
  ) included ON true
  CROSS JOIN LATERAL (
    SELECT membership.event_type IN('join','initial_seen') AND membership.source='recorded'
      AND (continuity.boundary_at IS NULL OR membership.occurred_at>continuity.boundary_at) recorded,
      continuity.current_included IS TRUE AND continuity.checked_at>=p_now-interval '2 hours'
        AND included.started_at IS NOT NULL observed
  ) accepted
  CROSS JOIN LATERAL (
    SELECT CASE WHEN accepted.recorded THEN membership.occurred_at WHEN accepted.observed THEN included.started_at END started_at,
      CASE WHEN accepted.recorded THEN greatest(v_roster,v_full) WHEN accepted.observed THEN continuity.checked_at END checked_at,
      CASE WHEN accepted.recorded THEN 'recorded_event' WHEN accepted.observed THEN 'roster_snapshot' END source
  ) observation
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('startsAt',min(a.starts_at),'endsAt',max(a.ends_at)) value
    FROM public.member_absences a WHERE a.club_tag=v_club AND a.player_tag=h.player_tag
      AND a.cancelled_at IS NULL AND a.starts_at<=p_now AND a.ends_at>p_now HAVING count(*)>0
  ) absence ON true
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('date',day::date,'battles',d.battles,
      'possibleGap',EXISTS(SELECT 1 FROM public.sync_battle_gaps g WHERE g.club_tag=v_club AND g.player_tag=h.player_tag
        AND g.gap_start_at<day+interval '1 day' AND g.gap_end_at>day AND g.detected_at<=p_now),
      'absenceOverlap',EXISTS(SELECT 1 FROM public.member_absences a WHERE a.club_tag=v_club AND a.player_tag=h.player_tag
        AND a.starts_at<day+interval '1 day' AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>day
        AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>a.starts_at)) ORDER BY day) value
    FROM generate_series(v_start::timestamp AT TIME ZONE 'UTC',(v_end-1)::timestamp AT TIME ZONE 'UTC',interval '1 day') day
    LEFT JOIN public.daily_stats d ON d.player_tag=h.player_tag AND d.date=(day AT TIME ZONE 'UTC')::date
  ) days
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'version',e.version,'title',e.title,'kind',e.kind,'startsAt',e.starts_at,'endsAt',e.ends_at,
      'status',e.status,'attendance',e.attendance,'observedAt',e.observed_at,
      'absenceOverlap',EXISTS(SELECT 1 FROM public.member_absences a WHERE a.club_tag=v_club AND a.player_tag=h.player_tag
        AND a.starts_at<e.ends_at AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>e.starts_at
        AND least(a.ends_at,coalesce(a.cancelled_at,a.ends_at))>a.starts_at)
    ) ORDER BY e.ends_at,e.id) FILTER(WHERE e.ordinal<=100),'[]') value,max(e.ordinal) total
    FROM (
      SELECT p.id,p.version,p.title,p.kind,p.starts_at,p.ends_at,p.status,entry.attendance,entry.observed_at,
        row_number() OVER(ORDER BY p.ends_at,p.id) ordinal
      FROM public.club_planned_events p JOIN public.club_event_entries entry ON entry.event_id=p.id AND entry.player_tag=h.player_tag
      WHERE p.club_tag=v_club AND p.ends_at>=v_start::timestamp AT TIME ZONE 'UTC' AND p.starts_at<v_end::timestamp AT TIME ZONE 'UTC'
      ORDER BY p.ends_at,p.id LIMIT 101
    ) e
  ) events
  WHERE h.player_tag=ANY(v_tags);

  -- Watchlist profiles are global saved candidates, not current-club attendance.
  -- Existing members and explicitly archived/joined candidates are not replacements.
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind','candidate','tag',c.player_tag,
    'name',coalesce(c.profile->>'name',c.player_tag),'status',c.status,'commitment','unknown',
    'profile',jsonb_build_object('trophies',c.profile->'trophies','trophiesCheckedAt',CASE WHEN jsonb_typeof(c.profile)='object' THEN c.profile_checked_at END,
      'power11',c.profile->'power11','profileCheckedAt',CASE WHEN jsonb_typeof(c.profile)='object' THEN c.profile_checked_at END,'rank',c.profile->'rank',
      'rankedPoints',c.profile->'rankedPoints','rankedSeasonId',NULL,'rankedCheckedAt',CASE WHEN jsonb_typeof(c.profile)='object' THEN c.profile_checked_at END)
  ) ORDER BY c.player_tag),'[]') INTO v_candidates FROM public.recruitment_candidates c
  WHERE NOT(c.player_tag=ANY(v_tags)) AND c.status NOT IN('archived','joined');

  RETURN jsonb_build_object('clubTag',v_club,'generatedAt',p_now,'range',p_days::text||'d',
    'rosterCheckedAt',greatest(v_roster,v_full),'members',v_members,'candidates',v_candidates);
END $$;
REVOKE ALL ON FUNCTION public.member_comparison_read(text,integer,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_comparison_read(text,integer,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
