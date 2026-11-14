BEGIN;
-- Mega Pig saved readings: keep only real changes.
-- BrawlTools often returns the same counters with 28-30 members, so "reported
-- battles" flips between e.g. 140/146/152 and every flip was saved as a new
-- reading (101 readings in two months, mostly identical wins).
-- 1. A new reading is stored only when the source, total wins, or any member's
--    wins increase. Otherwise the latest reading's fetch window is extended.
-- 2. Active cycles still receive every fetch's member data (wins and tickets)
--    directly, so cycle tracking is unchanged.
-- 3. The readings list shows one entry per change point; older duplicate rows
--    stay stored and remain reachable by member search.

CREATE OR REPLACE FUNCTION public.mega_pig_archive_apply_payload(p_cycle uuid,p_payload jsonb,p_fetched_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_member jsonb;
BEGIN
  UPDATE public.club_mega_pig_cycle_members SET latest_wins_unknown=true,latest_tickets_unknown=true WHERE cycle_id=p_cycle;
  FOR v_member IN SELECT value FROM jsonb_array_elements(p_payload->'members') LOOP
    INSERT INTO public.club_mega_pig_cycle_members(cycle_id,player_tag,first_player_name,player_name,first_observed_at,last_observed_at,
      wins,tickets_remaining,wins_observed_at,tickets_observed_at,latest_wins_unknown,latest_tickets_unknown)
    VALUES(p_cycle,v_member->>'playerTag',v_member->>'playerName',v_member->>'playerName',p_fetched_at,p_fetched_at,
      (v_member->>'reportedWins')::integer,(v_member->>'reportedTicketsRemaining')::integer,
      CASE WHEN v_member->>'reportedWins' IS NOT NULL THEN p_fetched_at END,
      CASE WHEN v_member->>'reportedTicketsRemaining' IS NOT NULL THEN p_fetched_at END,
      v_member->>'reportedWins' IS NULL,v_member->>'reportedTicketsRemaining' IS NULL)
    ON CONFLICT(cycle_id,player_tag) DO UPDATE SET player_name=excluded.player_name,
      first_observed_at=coalesce(club_mega_pig_cycle_members.first_observed_at,excluded.first_observed_at),
      last_observed_at=coalesce(excluded.last_observed_at,club_mega_pig_cycle_members.last_observed_at),
      wins=coalesce(excluded.wins,club_mega_pig_cycle_members.wins),tickets_remaining=coalesce(excluded.tickets_remaining,club_mega_pig_cycle_members.tickets_remaining),
      wins_observed_at=CASE WHEN excluded.wins IS NOT NULL THEN excluded.wins_observed_at ELSE club_mega_pig_cycle_members.wins_observed_at END,
      tickets_observed_at=CASE WHEN excluded.tickets_remaining IS NOT NULL THEN excluded.tickets_observed_at ELSE club_mega_pig_cycle_members.tickets_observed_at END,
      latest_wins_unknown=excluded.latest_wins_unknown,latest_tickets_unknown=excluded.latest_tickets_unknown;
  END LOOP;
  UPDATE public.club_mega_pig_cycles SET reported_total_wins=(p_payload->>'totalWins')::integer,
    reported_players_played=(p_payload->>'reportedPlayersPlayed')::integer,last_captured_at=p_fetched_at,updated_at=clock_timestamp() WHERE id=p_cycle;
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_apply(p_cycle uuid,p_observation uuid,p_fetched_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb;
BEGIN
  SELECT payload INTO STRICT v_payload FROM public.club_mega_pig_observations WHERE id=p_observation;
  PERFORM public.mega_pig_archive_apply_payload(p_cycle,v_payload,p_fetched_at);
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_is_real_change(p_last jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p_last IS NULL
    OR coalesce(p_last->>'source','BrawlAce') IS DISTINCT FROM p_new->>'source'
    OR p_last->'totalWins' IS DISTINCT FROM p_new->'totalWins'
    -- Members missing from either reading are ignored (the source drops members
    -- intermittently); joins/leaves with wins already move totalWins.
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_new->'members') n
      JOIN LATERAL (SELECT o FROM jsonb_array_elements(p_last->'members') o WHERE o->>'playerTag'=n->>'playerTag' LIMIT 1) prev ON true
      WHERE n->>'reportedWins' IS NOT NULL AND prev.o->>'reportedWins' IS NOT NULL
        AND (n->>'reportedWins')::integer > (prev.o->>'reportedWins')::integer);
$$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_capture(p_club text,p_payload jsonb,p_fetched_at timestamptz,p_origin text DEFAULT 'source_fetch')
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb; v_last public.club_mega_pig_observations; v_id uuid; v_cycle public.club_mega_pig_cycles;
  v_before jsonb; v_anchor_source text; v_pause text; v_reason text;
BEGIN
  IF p_origin NOT IN('source_fetch','cache_seed','legacy_previous') OR p_origin IS NULL
    OR (p_fetched_at IS NOT NULL AND (NOT isfinite(p_fetched_at) OR p_fetched_at>clock_timestamp()))
    OR (p_fetched_at IS NULL AND p_origin='source_fetch') THEN RAISE EXCEPTION 'invalid_archive_time' USING ERRCODE='22023'; END IF;
  v_payload:=public.mega_pig_archive_payload(p_club,p_payload);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3901));
  SELECT * INTO v_last FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND (v_last.last_fetched_at IS NULL)=(p_fetched_at IS NULL)
    AND NOT public.mega_pig_archive_is_real_change(v_last.payload,v_payload) THEN
    v_id:=v_last.id;
    UPDATE public.club_mega_pig_observations SET first_fetched_at=least(first_fetched_at,p_fetched_at),last_fetched_at=greatest(last_fetched_at,p_fetched_at) WHERE id=v_id;
  ELSE
    INSERT INTO public.club_mega_pig_observations(club_tag,payload,first_fetched_at,last_fetched_at,origin)
      VALUES(p_club,v_payload,p_fetched_at,p_fetched_at,p_origin) RETURNING id INTO v_id;
  END IF;
  IF p_fetched_at IS NULL OR p_origin<>'source_fetch' THEN RETURN v_id; END IF;
  FOR v_cycle IN SELECT * FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled AND capture_paused_reason IS NULL
    AND finalized_at IS NULL AND p_fetched_at>=starts_at AND p_fetched_at<=ends_at
    AND (last_captured_at IS NULL OR p_fetched_at>=last_captured_at) FOR UPDATE LOOP
    SELECT coalesce(payload->>'source','BrawlAce') INTO v_anchor_source
      FROM public.club_mega_pig_observations WHERE id=v_cycle.initial_observation_id AND club_tag=p_club;
    v_pause:=NULL; v_reason:=NULL;
    IF v_anchor_source IS DISTINCT FROM v_payload->>'source' THEN
      v_pause:='source_changed';
      v_reason:='Source changed; confirm the new reading belongs to the same cycle before resuming.';
    ELSIF v_cycle.reported_total_wins IS NOT NULL AND (v_payload->>'totalWins')::integer<v_cycle.reported_total_wins THEN
      v_pause:='counters_decreased';
      v_reason:='Reported total decreased; cycle identity requires confirmation.';
    END IF;
    IF v_pause IS NOT NULL THEN
      v_before:=to_jsonb(v_cycle)-'create_payload';
      UPDATE public.club_mega_pig_cycles SET capture_enabled=false,capture_paused_reason=v_pause,version=version+1,updated_at=clock_timestamp()
        WHERE id=v_cycle.id RETURNING * INTO v_cycle;
      INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
        VALUES(v_cycle.id,v_cycle.version,'pause_capture',v_before,to_jsonb(v_cycle)-'create_payload',v_reason);
    ELSE
      -- Use this fetch's own member data even when no new reading was stored.
      PERFORM public.mega_pig_archive_apply_payload(v_cycle.id,v_payload,p_fetched_at);
    END IF;
  END LOOP;
  RETURN v_id;
END $$;

-- Readings list: one entry per change point in source or total wins.
DO $$ DECLARE v_definition text; v_needle text; v_replacement text; BEGIN
  v_definition:=replace(pg_get_functiondef('public.mega_pig_archive_read(text,text,uuid,text,integer)'::regprocedure),chr(13),'');
  v_needle:='WITH page AS MATERIALIZED(SELECT id,recorded_at FROM public.club_mega_pig_observations WHERE club_tag=p_club ORDER BY recorded_at DESC,id DESC OFFSET p_offset LIMIT 21)';
  v_replacement:='WITH page AS MATERIALIZED(SELECT id,recorded_at FROM (SELECT id,recorded_at,payload->''totalWins'' w,coalesce(payload->>''source'',''BrawlAce'') s,'
    ||'lag(payload->''totalWins'') OVER w0 pw,lag(coalesce(payload->>''source'',''BrawlAce'')) OVER w0 ps,row_number() OVER w0 rn '
    ||'FROM public.club_mega_pig_observations WHERE club_tag=p_club WINDOW w0 AS (ORDER BY recorded_at,id)) changes '
    ||'WHERE rn=1 OR w IS DISTINCT FROM pw OR s IS DISTINCT FROM ps ORDER BY recorded_at DESC,id DESC OFFSET p_offset LIMIT 21)';
  IF length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) THEN RAISE EXCEPTION 'archive_read_patch_mismatch'; END IF;
  EXECUTE replace(v_definition,v_needle,v_replacement);
END $$;

REVOKE ALL ON FUNCTION public.mega_pig_archive_apply_payload(uuid,jsonb,timestamptz),public.mega_pig_archive_apply(uuid,uuid,timestamptz),
  public.mega_pig_archive_is_real_change(jsonb,jsonb),public.mega_pig_archive_capture(text,jsonb,timestamptz,text),
  public.mega_pig_archive_read(text,text,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mega_pig_archive_read(text,text,uuid,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
