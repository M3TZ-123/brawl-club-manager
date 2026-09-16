BEGIN;
CREATE TABLE public.recruitment_candidates (
  player_tag text PRIMARY KEY CHECK (player_tag ~ '^#[0289PYLQGRJCUV]{2,19}$'),
  status text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','shortlisted','contacted','joined','archived')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes)<=1000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  profile jsonb CHECK (profile IS NULL OR pg_column_size(profile)<=10000),profile_checked_at timestamptz,
  refresh_token uuid,refresh_until timestamptz,retry_at timestamptz
);
ALTER TABLE public.recruitment_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_candidates FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.recruitment_candidates TO service_role;
CREATE FUNCTION public.save_recruitment_candidate(p_tag text,p_status text,p_notes text,p_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_row public.recruitment_candidates;
BEGIN
  PERFORM pg_advisory_xact_lock(184772931,23);
  SELECT * INTO v_row FROM public.recruitment_candidates WHERE player_tag=p_tag FOR UPDATE;
  IF FOUND THEN
    IF p_version IS DISTINCT FROM v_row.version THEN RAISE EXCEPTION 'candidate_changed' USING ERRCODE='40001'; END IF;
    UPDATE public.recruitment_candidates SET status=p_status,notes=p_notes,version=version+1,updated_at=clock_timestamp() WHERE player_tag=p_tag RETURNING * INTO v_row;
  ELSE
    IF p_version IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'candidate_changed' USING ERRCODE='40001'; END IF;
    IF (SELECT count(*) FROM public.recruitment_candidates)>=100 THEN RAISE EXCEPTION 'candidate_limit' USING ERRCODE='54000'; END IF;
    INSERT INTO public.recruitment_candidates(player_tag,status,notes) VALUES(p_tag,p_status,p_notes) RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('player_tag',v_row.player_tag,'status',v_row.status,'notes',v_row.notes,'version',v_row.version,
    'created_at',v_row.created_at,'updated_at',v_row.updated_at,'profile',v_row.profile,'profile_checked_at',v_row.profile_checked_at);
END $$;
CREATE FUNCTION public.claim_recruitment_refresh(p_tag text,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_token IS NULL THEN RETURN false; END IF;
  UPDATE public.recruitment_candidates SET refresh_token=p_token,refresh_until=clock_timestamp()+interval '15 seconds'
    WHERE player_tag=p_tag AND (refresh_until IS NULL OR refresh_until<clock_timestamp())
    AND (retry_at IS NULL OR retry_at<clock_timestamp())
    AND (profile_checked_at IS NULL OR profile_checked_at<clock_timestamp()-interval '1 hour');
  RETURN FOUND;
END $$;
CREATE FUNCTION public.finish_recruitment_refresh(p_tag text,p_token uuid,p_profile jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE public.recruitment_candidates SET profile=coalesce(p_profile,profile),
    profile_checked_at=CASE WHEN p_profile IS NULL THEN profile_checked_at ELSE clock_timestamp() END,
    retry_at=CASE WHEN p_profile IS NULL THEN clock_timestamp()+interval '1 minute' ELSE NULL END,
    refresh_token=NULL,refresh_until=NULL
    WHERE player_tag=p_tag AND refresh_token=p_token AND refresh_until>clock_timestamp();
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.save_recruitment_candidate(text,text,text,integer),public.claim_recruitment_refresh(text,uuid),public.finish_recruitment_refresh(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_recruitment_candidate(text,text,text,integer),public.claim_recruitment_refresh(text,uuid),public.finish_recruitment_refresh(text,uuid,jsonb) TO service_role;
COMMIT;
