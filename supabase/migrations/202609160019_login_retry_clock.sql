-- Count attempts atomically as before, but measure the retry interval after any
-- lock wait. A competing insert can otherwise create an expiry later than the
-- caller's initial timestamp, making CEIL report 601 rather than 600 seconds.
BEGIN;

CREATE OR REPLACE FUNCTION public.consume_admin_login_attempt(p_client_key TEXT)
RETURNS TABLE(allowed BOOLEAN, retry_after INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_count INTEGER;
  v_expiry TIMESTAMPTZ;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid rate-limit key' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.admin_login_attempts WHERE client_key IN (
    SELECT old.client_key FROM public.admin_login_attempts AS old
    WHERE old.expires_at <= v_now ORDER BY old.expires_at LIMIT 100
  );
  INSERT INTO public.admin_login_attempts AS attempts (client_key, attempt_count, expires_at)
  VALUES (p_client_key, 1, v_now + INTERVAL '10 minutes')
  ON CONFLICT (client_key) DO UPDATE SET
    attempt_count = CASE WHEN attempts.expires_at <= v_now THEN 1 ELSE LEAST(attempts.attempt_count + 1, 9) END,
    expires_at = CASE WHEN attempts.expires_at <= v_now THEN v_now + INTERVAL '10 minutes' ELSE attempts.expires_at END
  RETURNING attempt_count, expires_at INTO v_count, v_expiry;
  RETURN QUERY SELECT v_count <= 8,
    CASE WHEN v_count <= 8 THEN 0 ELSE LEAST(600, GREATEST(1, CEIL(EXTRACT(EPOCH FROM v_expiry - clock_timestamp()))::INTEGER)) END;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_admin_login_attempt(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_admin_login_attempt(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
