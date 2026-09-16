BEGIN;

CREATE TABLE public.club_administration_settings (
  club_tag text PRIMARY KEY,
  grace_hours integer NOT NULL DEFAULT 0 CHECK(grace_hours BETWEEN 0 AND 168),
  recruitment_open boolean NOT NULL DEFAULT false,
  min_trophies integer NOT NULL DEFAULT 0 CHECK(min_trophies BETWEEN 0 AND 2000000),
  min_power11 integer NOT NULL DEFAULT 0 CHECK(min_power11 BETWEEN 0 AND 300),
  min_ranked_points integer CHECK(min_ranked_points BETWEEN 0 AND 1000000),
  language text NOT NULL DEFAULT '' CHECK(length(language)<=120),
  availability text NOT NULL DEFAULT '' CHECK(length(availability)<=240),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.member_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_tag text NOT NULL, player_tag text NOT NULL,
  kind text NOT NULL CHECK(kind IN('note','decision','departure_reason','correction','follow_up','absence_declared','absence_cancelled')),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  departure_event_id uuid REFERENCES public.membership_change_events(id),
  corrects_id uuid REFERENCES public.member_decision_log(id),
  follow_up_at timestamptz,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(club_tag,request_id),
  CHECK((kind='departure_reason')=(departure_event_id IS NOT NULL)),
  CHECK((kind='correction')=(corrects_id IS NOT NULL)),
  CHECK((kind='follow_up')=(follow_up_at IS NOT NULL))
);
CREATE INDEX member_decisions_player_time ON public.member_decision_log(club_tag,player_tag,created_at DESC,id DESC);
CREATE TABLE public.member_absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL, player_tag text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), cancelled_at timestamptz,
  request_id uuid NOT NULL, UNIQUE(club_tag,request_id),
  CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '90 days')
);
CREATE INDEX member_absences_active ON public.member_absences(club_tag,player_tag,ends_at) WHERE cancelled_at IS NULL;
CREATE TABLE public.recruitment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_tag text NOT NULL, player_tag text NOT NULL,
  message text NOT NULL CHECK(length(message)<=1000),
  language text NOT NULL CHECK(length(language)<=120), availability text NOT NULL CHECK(length(availability)<=240),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','reviewing','accepted','rejected','archived')),
  private_notes text NOT NULL DEFAULT '' CHECK(length(private_notes)<=1000),
  version integer NOT NULL DEFAULT 1, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(club_tag,request_id), CHECK(player_tag ~ '^#[0289PYLQGRJCUV]{2,19}$')
);
CREATE INDEX recruitment_applications_club_time ON public.recruitment_applications(club_tag,created_at DESC,id DESC);
CREATE INDEX recruitment_applications_player ON public.recruitment_applications(club_tag,player_tag,created_at DESC);
CREATE TABLE public.recruitment_application_limits (
  club_tag text NOT NULL, client_key text NOT NULL CHECK(client_key ~ '^[a-f0-9]{64}$'),
  day date NOT NULL, attempts integer NOT NULL CHECK(attempts>0), PRIMARY KEY(club_tag,client_key,day)
);
ALTER TABLE public.recruitment_candidates ADD COLUMN manual_compatibility jsonb NOT NULL DEFAULT '{"language":"unknown","time":"unknown"}'::jsonb
  CHECK(jsonb_typeof(manual_compatibility)='object' AND pg_column_size(manual_compatibility)<=2000);

DO $$ DECLARE v_table text; BEGIN
  FOREACH v_table IN ARRAY ARRAY['club_administration_settings','member_decision_log','member_absences','recruitment_applications','recruitment_application_limits'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',v_table);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',v_table);
  END LOOP;
END $$;
-- The log has no destructive application operation, including through service-role SQL.
CREATE FUNCTION public.reject_member_decision_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'decision_log_is_append_only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER member_decisions_append_only BEFORE UPDATE OR DELETE ON public.member_decision_log
FOR EACH ROW EXECUTE FUNCTION public.reject_member_decision_mutation();
CREATE TRIGGER member_decisions_no_truncate BEFORE TRUNCATE ON public.member_decision_log
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_member_decision_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON public.member_decision_log FROM service_role;

CREATE FUNCTION public.administration_club_tag() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tag text; BEGIN
  SELECT '#'||upper(regexp_replace(regexp_replace(btrim(value),'^%23','#','i'),'^#','')) INTO v_tag FROM public.settings WHERE key='club_tag';
  IF v_tag IS NULL OR v_tag !~ '^#[A-Z0-9]{1,20}$' THEN RAISE EXCEPTION 'club_not_configured' USING ERRCODE='22023'; END IF;
  RETURN v_tag;
END $$;

CREATE FUNCTION public.save_club_administration(p_values jsonb,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_club text:=public.administration_club_tag(); v_row public.club_administration_settings;
BEGIN
  PERFORM pg_advisory_xact_lock(184772931,30);
  SELECT * INTO v_row FROM public.club_administration_settings WHERE club_tag=v_club FOR UPDATE;
  IF coalesce(v_row.version,0) IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'administration_changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.club_administration_settings(club_tag,grace_hours,recruitment_open,min_trophies,min_power11,min_ranked_points,language,availability)
  VALUES(v_club,(p_values->>'grace_hours')::integer,(p_values->>'recruitment_open')::boolean,(p_values->>'min_trophies')::integer,
    (p_values->>'min_power11')::integer,(p_values->>'min_ranked_points')::integer,p_values->>'language',p_values->>'availability')
  ON CONFLICT(club_tag) DO UPDATE SET grace_hours=excluded.grace_hours,recruitment_open=excluded.recruitment_open,
    min_trophies=excluded.min_trophies,min_power11=excluded.min_power11,min_ranked_points=excluded.min_ranked_points,
    language=excluded.language,availability=excluded.availability,version=club_administration_settings.version+1,updated_at=clock_timestamp()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END $$;

CREATE FUNCTION public.append_member_decision(p_tag text,p_kind text,p_body text,p_request_id uuid,
  p_departure_event_id uuid DEFAULT NULL,p_corrects_id uuid DEFAULT NULL,p_follow_up_at timestamptz DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_club text:=public.administration_club_tag(); v_id uuid; v_old public.member_decision_log;
BEGIN
  PERFORM pg_advisory_xact_lock(184772931,30);
  SELECT * INTO v_old FROM public.member_decision_log WHERE club_tag=v_club AND request_id=p_request_id;
  IF FOUND THEN
    IF ROW(v_old.player_tag,v_old.kind,v_old.body,v_old.departure_event_id,v_old.corrects_id,v_old.follow_up_at)
      IS DISTINCT FROM ROW(p_tag,p_kind,p_body,p_departure_event_id,p_corrects_id,p_follow_up_at) THEN RAISE EXCEPTION 'request_changed' USING ERRCODE='40001'; END IF;
    RETURN v_old.id;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.member_history WHERE player_tag=p_tag) THEN RAISE EXCEPTION 'member_missing' USING ERRCODE='22023'; END IF;
  IF p_kind NOT IN('note','decision','departure_reason','correction','follow_up') OR p_kind IS NULL THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE='22023'; END IF;
  IF p_departure_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.membership_change_events WHERE id=p_departure_event_id AND club_tag=v_club AND player_tag=p_tag AND event_type='leave') THEN RAISE EXCEPTION 'departure_mismatch' USING ERRCODE='22023'; END IF;
  IF p_corrects_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.member_decision_log WHERE id=p_corrects_id AND club_tag=v_club AND player_tag=p_tag) THEN RAISE EXCEPTION 'correction_mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.member_decision_log(club_tag,player_tag,kind,body,departure_event_id,corrects_id,follow_up_at,request_id)
    VALUES(v_club,p_tag,p_kind,p_body,p_departure_event_id,p_corrects_id,p_follow_up_at,p_request_id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.declare_member_absence(p_tag text,p_start timestamptz,p_end timestamptz,p_reason text,p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_club text:=public.administration_club_tag(); v_old public.member_absences; v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(184772931,30);
  SELECT * INTO v_old FROM public.member_absences WHERE club_tag=v_club AND request_id=p_request_id;
  IF FOUND THEN
    IF ROW(v_old.player_tag,v_old.starts_at,v_old.ends_at,v_old.reason) IS DISTINCT FROM ROW(p_tag,p_start,p_end,p_reason) THEN RAISE EXCEPTION 'request_changed' USING ERRCODE='40001'; END IF;
    RETURN v_old.id;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.member_history WHERE player_tag=p_tag AND is_current_member) THEN RAISE EXCEPTION 'current_member_required' USING ERRCODE='22023'; END IF;
  IF p_start<clock_timestamp()-interval '366 days' OR p_start>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'invalid_absence' USING ERRCODE='22023'; END IF;
  INSERT INTO public.member_absences(club_tag,player_tag,starts_at,ends_at,reason,request_id) VALUES(v_club,p_tag,p_start,p_end,p_reason,p_request_id) RETURNING id INTO v_id;
  INSERT INTO public.member_decision_log(club_tag,player_tag,kind,body,request_id)
    VALUES(v_club,p_tag,'absence_declared',jsonb_build_object('starts_at',p_start,'ends_at',p_end,'reason',p_reason)::text,p_request_id);
  RETURN v_id;
END $$;
CREATE FUNCTION public.cancel_member_absence(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_club text:=public.administration_club_tag(); v_row public.member_absences;
BEGIN
  UPDATE public.member_absences SET cancelled_at=clock_timestamp() WHERE id=p_id AND club_tag=v_club AND cancelled_at IS NULL RETURNING * INTO v_row;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.member_decision_log(club_tag,player_tag,kind,body,request_id)
    VALUES(v_club,v_row.player_tag,'absence_cancelled',jsonb_build_object('absence_id',p_id,'starts_at',v_row.starts_at,'ends_at',v_row.ends_at)::text,gen_random_uuid());
  RETURN true;
END $$;

-- Administrative alert eligibility only. This function never changes activity metrics.
CREATE FUNCTION public.member_inactivity_exempt(p_club_tag text,p_player_tag text,p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT EXISTS(SELECT 1 FROM public.member_absences a WHERE a.club_tag=p_club_tag AND a.player_tag=p_player_tag
  AND a.cancelled_at IS NULL AND a.starts_at<=p_at AND a.ends_at>p_at)
OR EXISTS(SELECT 1 FROM public.club_administration_settings s WHERE s.club_tag=p_club_tag AND s.grace_hours>0
  AND (SELECT max(e.occurred_at) FROM public.membership_change_events e WHERE e.club_tag=p_club_tag AND e.player_tag=p_player_tag
    AND e.event_type IN('join','initial_seen') AND e.source='recorded' AND e.occurred_at<=p_at)>p_at-make_interval(hours=>s.grace_hours));
$$;

CREATE FUNCTION public.submit_recruitment_application(p_club_tag text,p_tag text,p_message text,p_language text,p_availability text,p_client_key text,p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_club text:=public.administration_club_tag(); v_day date; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(184772931,30);
  IF p_club_tag IS DISTINCT FROM v_club THEN RAISE EXCEPTION 'club_changed' USING ERRCODE='40001'; END IF;
  IF NOT coalesce((SELECT recruitment_open FROM public.club_administration_settings WHERE club_tag=v_club),false) THEN RAISE EXCEPTION 'applications_closed' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.recruitment_applications WHERE club_tag=v_club AND request_id=p_request_id) THEN RETURN true; END IF;
  v_day:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
  DELETE FROM public.recruitment_application_limits WHERE day<v_day-2;
  DELETE FROM public.recruitment_applications WHERE status IN('rejected','archived') AND updated_at<clock_timestamp()-interval '90 days';
  IF (SELECT count(*) FROM public.recruitment_application_limits)>=2000 AND NOT EXISTS(SELECT 1 FROM public.recruitment_application_limits WHERE club_tag=v_club AND client_key=p_client_key AND day=v_day) THEN RAISE EXCEPTION 'application_rate_limit' USING ERRCODE='54000'; END IF;
  INSERT INTO public.recruitment_application_limits(club_tag,client_key,day,attempts) VALUES(v_club,p_client_key,v_day,1)
    ON CONFLICT(club_tag,client_key,day) DO UPDATE SET attempts=least(4,recruitment_application_limits.attempts+1) RETURNING attempts INTO v_count;
  IF v_count>3 OR (SELECT count(*) FROM public.recruitment_applications WHERE club_tag=v_club AND created_at>=(v_day::timestamp AT TIME ZONE 'UTC'))>=50 THEN RETURN false; END IF;
  -- Duplicate player submissions receive the same acknowledgement, never private status.
  IF EXISTS(SELECT 1 FROM public.recruitment_applications WHERE club_tag=v_club AND player_tag=p_tag AND created_at>clock_timestamp()-interval '7 days') THEN RETURN true; END IF;
  IF (SELECT count(*) FROM public.recruitment_applications WHERE club_tag=v_club)>=500 THEN RETURN false; END IF;
  INSERT INTO public.recruitment_applications(club_tag,player_tag,message,language,availability,request_id)
    VALUES(v_club,p_tag,p_message,p_language,p_availability,p_request_id);
  RETURN true;
END $$;

CREATE FUNCTION public.review_recruitment_application(p_id uuid,p_status text,p_notes text,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_club text:=public.administration_club_tag(); v_row public.recruitment_applications%ROWTYPE;
BEGIN
  UPDATE public.recruitment_applications SET status=p_status,private_notes=p_notes,version=version+1,updated_at=clock_timestamp()
    WHERE id=p_id AND club_tag=v_club AND version=p_version RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'application_changed' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',v_row.id,'player_tag',v_row.player_tag,'message',v_row.message,'language',v_row.language,
    'availability',v_row.availability,'status',v_row.status,'private_notes',v_row.private_notes,'version',v_row.version,
    'created_at',v_row.created_at,'updated_at',v_row.updated_at);
END $$;
CREATE FUNCTION public.save_recruitment_candidate_details(p_tag text,p_status text,p_notes text,p_version integer,p_manual jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(jsonb_typeof(p_manual)='object' AND p_manual->>'language' IN('unknown','compatible','incompatible') AND p_manual->>'time' IN('unknown','compatible','incompatible')
    AND length(coalesce(p_manual->>'languages',''))<=120 AND length(coalesce(p_manual->>'availability',''))<=240,false) THEN RAISE EXCEPTION 'invalid_compatibility' USING ERRCODE='22023'; END IF;
  v_result:=public.save_recruitment_candidate(p_tag,p_status,p_notes,p_version);
  UPDATE public.recruitment_candidates SET manual_compatibility=jsonb_build_object('language',p_manual->>'language','time',p_manual->>'time','languages',coalesce(p_manual->>'languages',''),'availability',coalesce(p_manual->>'availability','')) WHERE player_tag=p_tag;
  RETURN v_result||jsonb_build_object('manual_compatibility',p_manual);
END $$;

DO $$ DECLARE v_function regprocedure; BEGIN
  FOR v_function IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname IN('reject_member_decision_mutation','administration_club_tag','save_club_administration','append_member_decision','declare_member_absence','cancel_member_absence','member_inactivity_exempt','submit_recruitment_application','review_recruitment_application','save_recruitment_candidate_details') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_function);
  END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
