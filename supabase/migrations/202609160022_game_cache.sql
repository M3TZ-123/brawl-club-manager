-- Bounded supplemental official API cache. No request can create arbitrary keys.
BEGIN;
CREATE TABLE public.game_api_cache (
  cache_key text PRIMARY KEY CHECK (cache_key = 'events' OR cache_key ~ '^rankings:(global|TN|DZ|MA|FR|EG|SA|US):(players|clubs)$'),
  payload jsonb, fetched_at timestamptz, expires_at timestamptz,
  lease_token uuid, lease_until timestamptz, retry_at timestamptz,
  CHECK (payload IS NULL OR pg_column_size(payload) <= 100000)
);
ALTER TABLE public.game_api_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_api_cache FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.game_api_cache TO service_role;

CREATE FUNCTION public.claim_game_cache(p_key text,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_row public.game_api_cache; v_now timestamptz:=clock_timestamp(); v_pause timestamptz;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'token_required'; END IF;
  INSERT INTO public.game_api_cache(cache_key) VALUES(p_key) ON CONFLICT DO NOTHING;
  SELECT * INTO v_row FROM public.game_api_cache WHERE cache_key=p_key FOR UPDATE;
  v_now:=clock_timestamp(); -- A contended insert/row lock may have waited.
  IF v_row.expires_at > v_now OR v_row.lease_until > v_now OR v_row.retry_at > v_now THEN
    RETURN jsonb_build_object('acquired',false,'entry',to_jsonb(v_row)-'lease_token');
  END IF;
  BEGIN SELECT value::timestamptz INTO v_pause FROM public.settings WHERE key='sync_upstream_cooldown_until';
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_pause:=NULL; END;
  IF v_pause > v_now THEN RETURN jsonb_build_object('acquired',false,'entry',to_jsonb(v_row)-'lease_token'); END IF;
  UPDATE public.game_api_cache SET lease_token=p_token,lease_until=v_now+interval '15 seconds' WHERE cache_key=p_key;
  RETURN jsonb_build_object('acquired',true,'entry',to_jsonb(v_row)-'lease_token');
END $$;

CREATE FUNCTION public.finish_game_cache(p_key text,p_token uuid,p_payload jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE public.game_api_cache SET
    payload=coalesce(p_payload,payload),
    fetched_at=CASE WHEN p_payload IS NULL THEN fetched_at ELSE clock_timestamp() END,
    expires_at=CASE WHEN p_payload IS NULL THEN expires_at ELSE clock_timestamp()+CASE WHEN p_key='events' THEN interval '5 minutes' ELSE interval '1 hour' END END,
    retry_at=CASE WHEN p_payload IS NULL THEN clock_timestamp()+interval '1 minute' ELSE NULL END,
    lease_token=NULL,lease_until=NULL
    WHERE cache_key=p_key AND lease_token=p_token AND lease_until>clock_timestamp();
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.claim_game_cache(text,uuid),public.finish_game_cache(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_game_cache(text,uuid),public.finish_game_cache(text,uuid,jsonb) TO service_role;
COMMIT;
