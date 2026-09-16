-- Share provider pauses across Vercel instances. These settings stay private.
CREATE OR REPLACE FUNCTION public.defer_sync_upstream(p_provider text,p_until timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text; v_until timestamptz;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('brawl','rnt') OR p_until IS NULL OR NOT isfinite(p_until) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_upstream_cooldown';
  END IF;
  v_key := CASE p_provider WHEN 'brawl' THEN 'sync_upstream_cooldown_until' ELSE 'sync_ranked_cooldown_until' END;
  INSERT INTO public.settings(key,value) VALUES(v_key,p_until::text)
    ON CONFLICT(key) DO UPDATE SET value=greatest(nullif(settings.value,'')::timestamptz,p_until)::text
    RETURNING value::timestamptz INTO v_until;
  RETURN v_until;
END $$;
REVOKE ALL ON FUNCTION public.defer_sync_upstream(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.defer_sync_upstream(text,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
