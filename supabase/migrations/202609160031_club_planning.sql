BEGIN;

CREATE TABLE public.club_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  metric text NOT NULL CHECK (metric IN ('trophies','participants')),
  cycle text NOT NULL CHECK (cycle IN ('weekly','monthly','custom')),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  target integer NOT NULL CHECK (target BETWEEN 1 AND 50000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  progress bigint, cohort_count integer NOT NULL DEFAULT 0, known_members integer NOT NULL DEFAULT 0,
  history_limited boolean NOT NULL DEFAULT false,
  limited boolean NOT NULL DEFAULT true, possible_gap boolean NOT NULL DEFAULT false,
  achieved_at timestamptz, refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at>starts_at AND ends_at<=starts_at+interval '90 days')
);
CREATE INDEX club_goals_club ON public.club_goals(club_tag,created_at DESC);
CREATE TABLE public.club_goal_members (
  goal_id uuid NOT NULL REFERENCES public.club_goals(id) ON DELETE CASCADE,
  player_tag text NOT NULL, player_name text NOT NULL,
  baseline_trophies integer, baseline_at timestamptz,
  latest_trophies integer, latest_at timestamptz,
  participated boolean NOT NULL DEFAULT false, departed boolean NOT NULL DEFAULT false,
  possible_gap boolean NOT NULL DEFAULT false,
  PRIMARY KEY(goal_id,player_tag)
);
CREATE TABLE public.club_goal_snapshots (
  goal_id uuid NOT NULL REFERENCES public.club_goals(id) ON DELETE CASCADE,
  day date NOT NULL, observed_at timestamptz NOT NULL,
  progress bigint, known_members integer NOT NULL, limited boolean NOT NULL, possible_gap boolean NOT NULL,
  PRIMARY KEY(goal_id,day)
);
CREATE TABLE public.club_planned_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('mega_pig','ranked','tournament','custom')),
  cycle_label text NOT NULL CHECK (length(cycle_label) BETWEEN 1 AND 80),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  team_size integer NOT NULL CHECK (team_size BETWEEN 1 AND 30),
  ticket_allowance integer CHECK (ticket_allowance BETWEEN 0 AND 1000),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=1000),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at>starts_at AND ends_at<=starts_at+interval '31 days'),
  CHECK (kind='mega_pig' OR ticket_allowance IS NULL)
);
CREATE INDEX club_planned_events_club ON public.club_planned_events(club_tag,starts_at DESC);
CREATE TABLE public.club_event_entries (
  event_id uuid NOT NULL REFERENCES public.club_planned_events(id) ON DELETE CASCADE,
  player_tag text NOT NULL, player_name text NOT NULL,
  team integer NOT NULL CHECK (team BETWEEN 1 AND 30),
  slot text NOT NULL CHECK (slot IN ('starter','substitute')),
  attendance text NOT NULL CHECK (attendance IN ('invited','confirmed','present','absent')),
  wins integer CHECK (wins BETWEEN 0 AND 1000), tickets_remaining integer CHECK (tickets_remaining BETWEEN 0 AND 1000),
  observed_at timestamptz, notes text NOT NULL DEFAULT '' CHECK (length(notes)<=500),
  source text NOT NULL DEFAULT 'manual' CHECK (source='manual'),
  PRIMARY KEY(event_id,player_tag)
);
CREATE TABLE public.club_event_revisions (
  event_id uuid NOT NULL REFERENCES public.club_planned_events(id) ON DELETE CASCADE,
  version integer NOT NULL, saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL DEFAULT '' CHECK (length(reason)<=500), snapshot jsonb NOT NULL CHECK (pg_column_size(snapshot)<=100000),
  PRIMARY KEY(event_id,version)
);
ALTER TABLE public.club_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_goal_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_goal_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_planned_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_event_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_event_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_goals,public.club_goal_members,public.club_goal_snapshots,public.club_planned_events,public.club_event_entries,public.club_event_revisions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.club_goals,public.club_goal_members,public.club_goal_snapshots,public.club_planned_events,public.club_event_entries,public.club_event_revisions TO service_role;

CREATE FUNCTION public.club_planning_roster_ready(p_club text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_club text; v_marker text;
BEGIN
  SELECT upper(regexp_replace(btrim(value),'^%23','#','i')) INTO v_club FROM public.settings WHERE key='club_tag' FOR SHARE;
  IF v_club IS NOT NULL AND v_club<>'' AND (CASE WHEN left(v_club,1)='#' THEN v_club ELSE '#'||v_club END)<>p_club THEN RETURN false; END IF;
  SELECT value INTO v_marker FROM public.settings WHERE key IN ('last_roster_sync_time','last_sync_time') AND value<>'' ORDER BY key LIMIT 1;
  RETURN v_marker IS NOT NULL AND isfinite(v_marker::timestamptz) AND v_marker::timestamptz<=clock_timestamp();
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

CREATE FUNCTION public.club_planning_create_goal(p_club text,p_title text,p_metric text,p_cycle text,p_end timestamptz,p_target integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='5s' AS $$
DECLARE v_id uuid; v_at timestamptz; v_end timestamptz; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3101));
  IF NOT public.club_planning_roster_ready(p_club) THEN RAISE EXCEPTION 'planning_roster_not_ready' USING ERRCODE='55000'; END IF;
  v_at:=clock_timestamp();
  IF p_club IS NULL OR p_club !~ '^#[A-Z0-9]{1,20}$' OR p_title IS NULL OR btrim(p_title)='' OR length(p_title)>100
    OR p_metric IS NULL OR p_metric NOT IN ('trophies','participants') OR p_cycle IS NULL OR p_cycle NOT IN ('weekly','monthly','custom')
    OR p_target IS NULL OR p_target<1 OR p_target>50000000 THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.club_goals WHERE club_tag=p_club)>=120
    OR (SELECT count(*) FROM public.club_goals WHERE club_tag=p_club AND status='active' AND ends_at>v_at)>=10 THEN RAISE EXCEPTION 'planning_limit' USING ERRCODE='54000'; END IF;
  v_end:=CASE p_cycle WHEN 'weekly' THEN v_at+interval '7 days' WHEN 'monthly' THEN v_at+interval '30 days' ELSE p_end END;
  IF v_end IS NULL OR v_end<=v_at OR v_end>v_at+interval '90 days' THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.member_history WHERE is_current_member;
  IF v_count<1 OR v_count>30 OR (p_metric='participants' AND p_target>v_count) THEN RAISE EXCEPTION 'invalid_goal_roster' USING ERRCODE='22023'; END IF;
  INSERT INTO public.club_goals(club_tag,title,metric,cycle,starts_at,ends_at,target)
    VALUES(p_club,btrim(p_title),p_metric,p_cycle,v_at,v_end,p_target) RETURNING id INTO v_id;
  -- One statement freezes the roster and its latest saved account balances.
  INSERT INTO public.club_goal_members(goal_id,player_tag,player_name,baseline_trophies,baseline_at,latest_trophies,latest_at)
    SELECT v_id,h.player_tag,h.player_name,m.trophies,m.last_updated,m.trophies,m.last_updated
    FROM public.member_history h LEFT JOIN public.members m ON m.player_tag=h.player_tag AND m.last_updated<=v_at WHERE h.is_current_member;
  SELECT count(*) INTO v_count FROM public.club_goal_members WHERE goal_id=v_id;
  IF v_count<1 OR v_count>30 OR (p_metric='participants' AND p_target>v_count) THEN RAISE EXCEPTION 'invalid_goal_roster' USING ERRCODE='22023'; END IF;
  UPDATE public.club_goals SET cohort_count=v_count WHERE id=v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.club_planning_archive_goal(p_club text,p_id uuid,p_version integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
BEGIN
  UPDATE public.club_goals SET status='archived',version=version+1 WHERE id=p_id AND club_tag=p_club AND version=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_changed' USING ERRCODE='40001'; END IF;
END $$;

CREATE FUNCTION public.club_planning_refresh_goals(p_club text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='5s' AS $$
DECLARE g public.club_goals; v_at timestamptz:=clock_timestamp(); v_cutoff timestamptz; v_progress bigint; v_known integer; v_total integer; v_limited boolean; v_gap boolean; v_history_limited boolean;
BEGIN
  IF NOT public.club_planning_roster_ready(p_club) THEN RETURN; END IF;
  FOR g IN SELECT * FROM public.club_goals WHERE club_tag=p_club AND status='active'
    AND (refreshed_at IS NULL OR refreshed_at<clock_timestamp()-interval '30 seconds')
    AND (ends_at>clock_timestamp()-interval '7 days' OR refreshed_at IS NULL OR refreshed_at<ends_at) ORDER BY created_at LIMIT 120 FOR UPDATE SKIP LOCKED
  LOOP
    v_cutoff:=least(v_at,g.ends_at);
    v_history_limited:=g.history_limited OR (g.metric='participants' AND coalesce(g.refreshed_at,g.starts_at)<v_cutoff-interval '28 days');
    UPDATE public.club_goal_members c SET latest_trophies=q.trophies,latest_at=q.observed_at
    FROM (SELECT cohort.player_tag,balance.trophies,balance.observed_at FROM public.club_goal_members cohort
      CROSS JOIN LATERAL (
        SELECT values_at.trophies,values_at.observed_at FROM (
          SELECT a.trophies,a.recorded_at observed_at FROM public.activity_log a WHERE a.player_tag=cohort.player_tag AND a.recorded_at<=v_cutoff AND a.recorded_at>=g.starts_at
          UNION ALL SELECT m.trophies,m.last_updated FROM public.members m WHERE m.player_tag=cohort.player_tag AND m.last_updated<=v_cutoff AND m.last_updated>=g.starts_at
        ) values_at ORDER BY observed_at DESC LIMIT 1
      ) balance WHERE cohort.goal_id=g.id) q
    WHERE c.goal_id=g.id AND c.player_tag=q.player_tag AND (c.latest_at IS NULL OR q.observed_at>=c.latest_at)
      AND (c.latest_trophies,c.latest_at) IS DISTINCT FROM (q.trophies,q.observed_at);
    WITH observed AS MATERIALIZED (
      SELECT c.player_tag,
        c.participated OR EXISTS(SELECT 1 FROM public.battle_history b WHERE b.player_tag=c.player_tag AND b.battle_time>=g.starts_at AND b.battle_time<=v_cutoff) participated,
        NOT EXISTS(SELECT 1 FROM public.member_history h WHERE h.player_tag=c.player_tag AND h.is_current_member) departed,
        c.possible_gap OR EXISTS(SELECT 1 FROM public.sync_battle_gaps gap WHERE gap.club_tag=p_club AND gap.player_tag=c.player_tag AND gap.gap_start_at<=v_cutoff AND gap.gap_end_at>=g.starts_at) possible_gap
      FROM public.club_goal_members c WHERE c.goal_id=g.id
    )
    UPDATE public.club_goal_members c SET participated=o.participated,departed=o.departed,possible_gap=o.possible_gap
    FROM observed o WHERE c.goal_id=g.id AND c.player_tag=o.player_tag
      AND (c.participated,c.departed,c.possible_gap) IS DISTINCT FROM (o.participated,o.departed,o.possible_gap);
    SELECT count(*),bool_or(c.possible_gap) INTO v_total,v_gap FROM public.club_goal_members c WHERE goal_id=g.id;
    IF g.metric='trophies' THEN
      SELECT count(*) FILTER(WHERE baseline_trophies IS NOT NULL AND latest_at>=g.starts_at),
        sum(latest_trophies::bigint-baseline_trophies) FILTER(WHERE baseline_trophies IS NOT NULL AND latest_at>=g.starts_at),
        bool_or(baseline_trophies IS NULL OR baseline_at<g.starts_at-interval '35 minutes' OR latest_at IS NULL OR latest_at<v_cutoff-interval '35 minutes')
      INTO v_known,v_progress,v_limited FROM public.club_goal_members WHERE goal_id=g.id;
      v_limited:=coalesce(v_limited,true) OR v_known<v_total;
    ELSE
      SELECT count(*) FILTER(WHERE c.participated),count(*) FILTER(WHERE coverage.baseline_started_at<=g.starts_at AND coverage.last_observed_at>=v_cutoff-interval '35 minutes' AND NOT c.possible_gap)
      INTO v_progress,v_known FROM public.club_goal_members c LEFT JOIN public.sync_battle_coverage coverage ON coverage.club_tag=p_club AND coverage.player_tag=c.player_tag WHERE c.goal_id=g.id;
      v_limited:=v_known<v_total OR v_gap OR v_history_limited;
      IF v_progress=0 AND v_known=0 THEN v_progress:=NULL; END IF;
    END IF;
    UPDATE public.club_goals SET progress=v_progress,known_members=v_known,limited=v_limited,possible_gap=v_gap,history_limited=v_history_limited,refreshed_at=v_at,
      achieved_at=CASE WHEN achieved_at IS NOT NULL THEN achieved_at WHEN v_progress>=target AND (metric='participants' OR NOT v_limited) THEN v_at ELSE NULL END WHERE id=g.id;
    INSERT INTO public.club_goal_snapshots(goal_id,day,observed_at,progress,known_members,limited,possible_gap)
      VALUES(g.id,(v_cutoff AT TIME ZONE 'UTC')::date,v_at,v_progress,v_known,v_limited,v_gap)
      ON CONFLICT(goal_id,day) DO UPDATE SET observed_at=excluded.observed_at,progress=excluded.progress,known_members=excluded.known_members,limited=excluded.limited,possible_gap=excluded.possible_gap;
  END LOOP;
END $$;

CREATE FUNCTION public.club_planning_save_event(p_club text,p_id uuid,p_version integer,p_event jsonb,p_entries jsonb,p_reason text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='5s' AS $$
DECLARE old public.club_planned_events; v_id uuid; v_start timestamptz; v_end timestamptz; v_size integer; v_allowance integer; v_version integer; entry jsonb; v_tag text; v_seen timestamptz; v_wins integer; v_tickets integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club,3101));
  IF p_club IS NULL OR p_club !~ '^#[A-Z0-9]{1,20}$' OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entries)>30
    OR length(coalesce(p_reason,''))>500 THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_entries)>0 AND NOT public.club_planning_roster_ready(p_club) THEN RAISE EXCEPTION 'planning_roster_not_ready' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_event) k WHERE k NOT IN ('title','kind','cycleLabel','startsAt','endsAt','teamSize','ticketAllowance','status','notes')) THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  IF coalesce(p_event->>'title','')='' OR length(p_event->>'title')>100 OR coalesce(p_event->>'cycleLabel','')='' OR length(p_event->>'cycleLabel')>80
    OR coalesce(p_event->>'kind','') NOT IN ('mega_pig','ranked','tournament','custom') OR coalesce(p_event->>'status','') NOT IN ('planned','completed','cancelled')
    OR length(coalesce(p_event->>'notes',''))>1000 THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  v_start:=(p_event->>'startsAt')::timestamptz; v_end:=(p_event->>'endsAt')::timestamptz; v_size:=(p_event->>'teamSize')::integer; v_allowance:=(p_event->>'ticketAllowance')::integer;
  IF v_start IS NULL OR v_end IS NULL OR NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_end<=v_start OR v_end>v_start+interval '31 days'
    OR (p_id IS NULL AND v_start<clock_timestamp()-interval '90 days') OR v_start>clock_timestamp()+interval '365 days' OR v_size IS NULL OR v_size NOT BETWEEN 1 AND 30
    OR (p_event->>'status'='completed' AND v_end>clock_timestamp())
    OR (v_allowance IS NOT NULL AND (v_allowance NOT BETWEEN 0 AND 1000 OR p_event->>'kind'<>'mega_pig')) THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
  IF p_id IS NULL THEN
    IF p_version IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'planning_changed' USING ERRCODE='40001'; END IF;
    IF (SELECT count(*) FROM public.club_planned_events WHERE club_tag=p_club)>=100 THEN RAISE EXCEPTION 'planning_limit' USING ERRCODE='54000'; END IF;
    v_id:=gen_random_uuid(); v_version:=1;
  ELSE
    SELECT * INTO old FROM public.club_planned_events WHERE id=p_id AND club_tag=p_club FOR UPDATE;
    IF NOT FOUND OR p_version IS DISTINCT FROM old.version THEN RAISE EXCEPTION 'planning_changed' USING ERRCODE='40001'; END IF;
    IF EXISTS(SELECT 1 FROM public.club_event_entries WHERE event_id=p_id AND (wins IS NOT NULL OR tickets_remaining IS NOT NULL OR attendance IN ('present','absent')))
      AND (old.kind IS DISTINCT FROM p_event->>'kind' OR old.cycle_label IS DISTINCT FROM p_event->>'cycleLabel' OR old.starts_at IS DISTINCT FROM v_start OR old.ends_at IS DISTINCT FROM v_end)
      THEN RAISE EXCEPTION 'event_cycle_locked' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.club_event_entries before LEFT JOIN jsonb_array_elements(p_entries) after ON after->>'playerTag'=before.player_tag
      WHERE before.event_id=p_id AND (before.wins IS NOT NULL OR before.tickets_remaining IS NOT NULL OR before.attendance IN ('present','absent'))
      AND (before.wins IS DISTINCT FROM (after->>'wins')::integer OR before.tickets_remaining IS DISTINCT FROM (after->>'ticketsRemaining')::integer OR before.attendance IS DISTINCT FROM after->>'attendance'))
      AND btrim(coalesce(p_reason,''))='' THEN RAISE EXCEPTION 'correction_reason_required' USING ERRCODE='22023'; END IF;
    v_id:=p_id; v_version:=old.version+1;
  END IF;
  IF (SELECT count(DISTINCT e->>'playerTag') FROM jsonb_array_elements(p_entries) e)<>jsonb_array_length(p_entries) THEN RAISE EXCEPTION 'duplicate_event_player' USING ERRCODE='22023'; END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) k WHERE k NOT IN ('playerTag','team','slot','attendance','wins','ticketsRemaining','observedAt','notes')) THEN RAISE EXCEPTION 'invalid_planning' USING ERRCODE='22023'; END IF;
    v_tag:=entry->>'playerTag'; v_seen:=(entry->>'observedAt')::timestamptz; v_wins:=(entry->>'wins')::integer; v_tickets:=(entry->>'ticketsRemaining')::integer;
    IF NOT EXISTS(SELECT 1 FROM public.member_history WHERE player_tag=v_tag AND is_current_member)
      AND NOT EXISTS(SELECT 1 FROM public.club_event_entries WHERE event_id=p_id AND player_tag=v_tag) THEN RAISE EXCEPTION 'invalid_event_player' USING ERRCODE='22023'; END IF;
    IF coalesce(entry->>'team','') !~ '^[0-9]+$' OR (entry->>'team')::integer NOT BETWEEN 1 AND 30 OR coalesce(entry->>'slot','') NOT IN ('starter','substitute')
      OR coalesce(entry->>'attendance','') NOT IN ('invited','confirmed','present','absent') OR length(coalesce(entry->>'notes',''))>500
      OR (v_wins IS NOT NULL AND v_wins NOT BETWEEN 0 AND 1000) OR (v_tickets IS NOT NULL AND (v_tickets NOT BETWEEN 0 AND 1000 OR (v_allowance IS NOT NULL AND v_tickets>v_allowance)))
      OR (v_allowance IS NOT NULL AND v_wins IS NOT NULL AND v_wins+coalesce(v_tickets,0)>v_allowance)
      OR ((v_wins IS NOT NULL OR v_tickets IS NOT NULL) AND p_event->>'kind'<>'mega_pig')
      OR (v_seen IS NOT NULL AND (NOT isfinite(v_seen) OR v_seen<v_start OR v_seen>v_end OR v_seen>clock_timestamp()+interval '5 minutes'))
      OR ((v_wins IS NOT NULL OR v_tickets IS NOT NULL OR entry->>'attendance' IN ('present','absent')) AND v_seen IS NULL)
      THEN RAISE EXCEPTION 'invalid_event_observation' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_entries) e WHERE e->>'slot'='starter' GROUP BY e->>'team' HAVING count(*)>v_size) THEN RAISE EXCEPTION 'team_too_large' USING ERRCODE='22023'; END IF;
  INSERT INTO public.club_planned_events(id,club_tag,title,kind,cycle_label,starts_at,ends_at,team_size,ticket_allowance,status,notes,version)
    VALUES(v_id,p_club,btrim(p_event->>'title'),p_event->>'kind',btrim(p_event->>'cycleLabel'),v_start,v_end,v_size,v_allowance,p_event->>'status',coalesce(p_event->>'notes',''),v_version)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,cycle_label=excluded.cycle_label,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      team_size=excluded.team_size,ticket_allowance=excluded.ticket_allowance,status=excluded.status,notes=excluded.notes,version=excluded.version,updated_at=clock_timestamp();
  -- Replace the list only after every entry passes validation; the transaction
  -- keeps corrections, teams and their revision in one atomic change.
  DELETE FROM public.club_event_entries WHERE event_id=v_id;
  INSERT INTO public.club_event_entries(event_id,player_tag,player_name,team,slot,attendance,wins,tickets_remaining,observed_at,notes)
    SELECT v_id,e->>'playerTag',coalesce(h.player_name,e->>'playerTag'),(e->>'team')::integer,e->>'slot',e->>'attendance',(e->>'wins')::integer,(e->>'ticketsRemaining')::integer,(e->>'observedAt')::timestamptz,coalesce(e->>'notes','')
    FROM jsonb_array_elements(p_entries) e LEFT JOIN public.member_history h ON h.player_tag=e->>'playerTag';
  INSERT INTO public.club_event_revisions(event_id,version,reason,snapshot) VALUES(v_id,v_version,coalesce(p_reason,''),jsonb_build_object('event',p_event,'entries',p_entries));
  DELETE FROM public.club_event_revisions WHERE event_id=v_id AND version<=v_version-20;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.club_planning_roster_ready(text),public.club_planning_create_goal(text,text,text,text,timestamptz,integer),public.club_planning_archive_goal(text,uuid,integer),public.club_planning_refresh_goals(text),public.club_planning_save_event(text,uuid,integer,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.club_planning_roster_ready(text),public.club_planning_create_goal(text,text,text,text,timestamptz,integer),public.club_planning_archive_goal(text,uuid,integer),public.club_planning_refresh_goals(text),public.club_planning_save_event(text,uuid,integer,jsonb,jsonb,text) TO service_role;
COMMIT;
