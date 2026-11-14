BEGIN;
-- Automatic Mega Pig cycles.
-- Until now a cycle (per-member wins/tickets for one Mega Pig event) existed
-- only if an admin created it, and readings were fetched only while an admin
-- had the page open. No cycle was ever created, and the Nov 2026 event has a
-- single reading. This makes tracking fully automatic:
--   * A new event is detected when at least 3 members, and at least half of the
--     members with wins in the previous reading, drop at once (real resets in
--     the history: 22/22 and 15/20; BrawlTools noise: at most 1).
--   * On a reset any open automatic cycle is finalized and a new one opens,
--     anchored on the reset reading, running for 4 days.
--   * Within a cycle a member's wins never decrease and tickets never increase,
--     so an incomplete source reading cannot erase progress. Members who leave
--     keep their cycle row (shown as "Former member").
--   * Automatic cycles ignore small total decreases (members missing from the
--     source) instead of pausing, and are finalized with their PEAK total once
--     they end (totals later shrink as members leave). Admins can still edit,
--     reopen or finalize them manually.
--   * Past events are backfilled from the stored readings.
--   * A pg_cron job triggers the fetch every 10 minutes; the existing source
--     cadence (10-20 minutes) decides whether BrawlTools is actually called.

ALTER TABLE public.club_mega_pig_cycles ADD COLUMN IF NOT EXISTS auto_managed boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_is_reset(p_last jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce((
    SELECT count(*) FILTER (WHERE (n->>'reportedWins')::integer<(prev.o->>'reportedWins')::integer)>=3
       AND count(*) FILTER (WHERE (n->>'reportedWins')::integer<(prev.o->>'reportedWins')::integer)*2>=count(*)
    FROM jsonb_array_elements(p_new->'members') n
    JOIN LATERAL (SELECT o FROM jsonb_array_elements(p_last->'members') o WHERE o->>'playerTag'=n->>'playerTag' LIMIT 1) prev ON true
    WHERE n->>'reportedWins' IS NOT NULL AND (prev.o->>'reportedWins')::integer>0),false);
$$;

-- Within one cycle wins only grow and tickets only shrink; keep the peak total.
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
      wins=greatest(excluded.wins,club_mega_pig_cycle_members.wins),
      tickets_remaining=least(excluded.tickets_remaining,club_mega_pig_cycle_members.tickets_remaining),
      wins_observed_at=CASE WHEN excluded.wins IS NOT NULL THEN excluded.wins_observed_at ELSE club_mega_pig_cycle_members.wins_observed_at END,
      tickets_observed_at=CASE WHEN excluded.tickets_remaining IS NOT NULL THEN excluded.tickets_observed_at ELSE club_mega_pig_cycle_members.tickets_observed_at END,
      latest_wins_unknown=excluded.latest_wins_unknown,latest_tickets_unknown=excluded.latest_tickets_unknown;
  END LOOP;
  UPDATE public.club_mega_pig_cycles SET reported_total_wins=greatest(reported_total_wins,(p_payload->>'totalWins')::integer),
    reported_players_played=(p_payload->>'reportedPlayersPlayed')::integer,last_captured_at=greatest(last_captured_at,p_fetched_at),updated_at=clock_timestamp() WHERE id=p_cycle;
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_auto_finalize(p_club text,p_now timestamptz,p_all boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_cycle public.club_mega_pig_cycles; v_before jsonb; v_count integer:=0;
BEGIN
  FOR v_cycle IN SELECT * FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND auto_managed AND finalized_at IS NULL
    AND (p_all OR ends_at<=p_now) FOR UPDATE LOOP
    v_before:=to_jsonb(v_cycle)-'create_payload';
    UPDATE public.club_mega_pig_cycles SET final_total_wins=reported_total_wins,finalized_at=p_now,capture_enabled=false,
      ends_at=CASE WHEN ends_at>p_now AND p_now>starts_at THEN p_now ELSE ends_at END,
      notes=left(CASE WHEN notes='' THEN '' ELSE notes||E'\n' END||'Finalized automatically with the peak reported total. Stage and reward are unconfirmed; reopen to correct.',2000),
      version=version+1,updated_at=clock_timestamp() WHERE id=v_cycle.id RETURNING * INTO v_cycle;
    INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
      VALUES(v_cycle.id,v_cycle.version,'finalize_cycle',v_before,to_jsonb(v_cycle)-'create_payload','Automatic finalize');
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_auto_start(p_club text,p_observation uuid,p_previous_fetched_at timestamptz,p_fetched_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_cycle public.club_mega_pig_cycles; v_start timestamptz;
BEGIN
  PERFORM public.mega_pig_auto_finalize(p_club,p_fetched_at,true);
  -- The event began between the last pre-reset fetch and this reading.
  v_start:=CASE WHEN p_previous_fetched_at IS NOT NULL AND p_previous_fetched_at<p_fetched_at
    AND p_previous_fetched_at>p_fetched_at-interval '4 days' THEN p_previous_fetched_at ELSE p_fetched_at-interval '1 minute' END;
  -- Never compete with an administrator's own capturing cycle.
  IF EXISTS(SELECT 1 FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled AND finalized_at IS NULL
    AND tstzrange(starts_at,ends_at,'[]') && tstzrange(v_start,p_fetched_at+interval '4 days','[]')) THEN RETURN NULL; END IF;
  INSERT INTO public.club_mega_pig_cycles(club_tag,request_id,create_payload,title,starts_at,ends_at,notes,initial_observation_id,capture_enabled,auto_managed)
    VALUES(p_club,gen_random_uuid(),jsonb_build_object('auto',true,'observation',p_observation),
      'Mega Pig · '||to_char(p_fetched_at AT TIME ZONE 'UTC','DD Mon YYYY'),v_start,p_fetched_at+interval '4 days',
      'Created automatically when the club''s Mega Pig wins reset.',p_observation,true,true)
    RETURNING * INTO v_cycle;
  INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason)
    VALUES(v_cycle.id,v_cycle.version,'save_cycle',NULL,to_jsonb(v_cycle)-'create_payload','Automatic start');
  RETURN v_cycle.id;
END $$;

CREATE OR REPLACE FUNCTION public.mega_pig_archive_capture(p_club text,p_payload jsonb,p_fetched_at timestamptz,p_origin text DEFAULT 'source_fetch')
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_payload jsonb; v_last public.club_mega_pig_observations; v_id uuid; v_cycle public.club_mega_pig_cycles;
  v_before jsonb; v_anchor_source text; v_pause text; v_reason text; v_inserted boolean:=false;
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
    v_inserted:=true;
  END IF;
  IF p_fetched_at IS NULL OR p_origin<>'source_fetch' THEN RETURN v_id; END IF;
  PERFORM public.mega_pig_auto_finalize(p_club,p_fetched_at);
  IF v_inserted AND v_last.id IS NOT NULL AND public.mega_pig_archive_is_reset(v_last.payload,v_payload) THEN
    PERFORM public.mega_pig_auto_start(p_club,v_id,v_last.last_fetched_at,p_fetched_at);
  END IF;
  FOR v_cycle IN SELECT * FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled AND capture_paused_reason IS NULL
    AND finalized_at IS NULL AND p_fetched_at>=starts_at AND p_fetched_at<=ends_at
    AND (last_captured_at IS NULL OR p_fetched_at>=last_captured_at) FOR UPDATE LOOP
    SELECT coalesce(payload->>'source','BrawlAce') INTO v_anchor_source
      FROM public.club_mega_pig_observations WHERE id=v_cycle.initial_observation_id AND club_tag=p_club;
    v_pause:=NULL; v_reason:=NULL;
    IF v_anchor_source IS DISTINCT FROM v_payload->>'source' THEN
      v_pause:='source_changed';
      v_reason:='Source changed; confirm the new reading belongs to the same cycle before resuming.';
    ELSIF NOT v_cycle.auto_managed AND v_cycle.reported_total_wins IS NOT NULL AND (v_payload->>'totalWins')::integer<v_cycle.reported_total_wins THEN
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
      PERFORM public.mega_pig_archive_apply_payload(v_cycle.id,v_payload,p_fetched_at);
    END IF;
  END LOOP;
  RETURN v_id;
END $$;

-- Backfill cycles for past events from the stored readings (runs once; skipped
-- if any automatic cycle already exists).
DO $$
DECLARE v_club text; r record; v_prev_payload jsonb; v_prev_fetched timestamptz; v_cycle uuid; v_ends timestamptz;
BEGIN
  FOR v_club IN SELECT DISTINCT club_tag FROM public.club_mega_pig_observations LOOP
    CONTINUE WHEN EXISTS(SELECT 1 FROM public.club_mega_pig_cycles WHERE club_tag=v_club AND auto_managed);
    v_prev_payload:=NULL; v_prev_fetched:=NULL; v_cycle:=NULL; v_ends:=NULL;
    FOR r IN SELECT id,payload,first_fetched_at,last_fetched_at FROM public.club_mega_pig_observations
      WHERE club_tag=v_club AND first_fetched_at IS NOT NULL ORDER BY recorded_at,id LOOP
      IF v_prev_payload IS NOT NULL AND public.mega_pig_archive_is_reset(v_prev_payload,r.payload) THEN
        v_cycle:=public.mega_pig_auto_start(v_club,r.id,v_prev_fetched,r.first_fetched_at);
        v_ends:=r.first_fetched_at+interval '4 days';
      END IF;
      IF v_cycle IS NOT NULL AND r.first_fetched_at<=v_ends THEN
        PERFORM public.mega_pig_archive_apply_payload(v_cycle,r.payload,least(r.last_fetched_at,v_ends));
      END IF;
      v_prev_payload:=r.payload; v_prev_fetched:=r.last_fetched_at;
    END LOOP;
    PERFORM public.mega_pig_auto_finalize(v_club,clock_timestamp());
  END LOOP;
END $$;

-- Background fetch: no longer depends on an administrator opening the page.
CREATE OR REPLACE FUNCTION public.enqueue_mega_pig_fetch()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_token text; v_id bigint;
BEGIN
  SELECT value INTO v_token FROM public.settings WHERE key='scheduler_token';
  IF v_token IS NULL OR length(v_token)<16 THEN RETURN NULL; END IF;
  SELECT net.http_get(url:='https://brawlstatz.vercel.app/api/mega-pig-source/scheduled',
    headers:=jsonb_build_object('Authorization','Bearer '||v_token),timeout_milliseconds:=20000) INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_mega_pig_fetch(),public.mega_pig_archive_is_reset(jsonb,jsonb),
  public.mega_pig_archive_apply_payload(uuid,jsonb,timestamptz),public.mega_pig_auto_finalize(text,timestamptz,boolean),
  public.mega_pig_auto_start(text,uuid,timestamptz,timestamptz),public.mega_pig_archive_capture(text,jsonb,timestamptz,text)
  FROM PUBLIC,anon,authenticated,service_role;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='brawl-mega-pig-fetch';
    PERFORM cron.schedule('brawl-mega-pig-fetch','3-59/10 * * * *',$job$SELECT public.enqueue_mega_pig_fetch();$job$);
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
