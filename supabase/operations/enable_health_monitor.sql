-- Run as the project/database owner after migration010 and the existing adaptive
-- scheduler setup. pg_cron/net stay outside migrations/local restore rehearsals.
-- This update does not enqueue HTTP requests or alter existing job cadences.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('brawl-adaptive-sync','brawl-notifications','brawl-scheduler-log-retention'))<>3 THEN
    RAISE EXCEPTION 'enable_existing_adaptive_scheduler_first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_club_job(p_kind text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_token text; v_id bigint; v_until timestamptz;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('sync','notifications') THEN RAISE EXCEPTION 'invalid_club_job'; END IF;
  -- Pausing game ingestion must not pause delivery of capacity/queued alerts.
  IF p_kind='sync' AND NOT coalesce((SELECT value='true' FROM public.settings WHERE key='sync_scheduler_enabled'),false) THEN RETURN NULL; END IF;
  SELECT value INTO v_token FROM public.settings WHERE key='scheduler_token';
  IF v_token IS NULL OR length(v_token)<16 THEN RAISE EXCEPTION 'scheduler_token_missing'; END IF;
  IF p_kind='sync' THEN
    SELECT nullif(value,'')::timestamptz INTO v_until FROM public.settings WHERE key='sync_upstream_cooldown_until';
    IF v_until>clock_timestamp() OR EXISTS(SELECT 1 FROM public.sync_leases WHERE expires_at>clock_timestamp() AND run_id IS NOT NULL) THEN RETURN NULL; END IF;
    SELECT net.http_get(
      url:='https://brawlstatz.vercel.app/api/sync?mode=auto',
      headers:=jsonb_build_object('Authorization','Bearer '||v_token,'Idempotency-Key','supabase-auto:'||floor(extract(epoch FROM clock_timestamp())/120)::bigint),
      timeout_milliseconds:=70000
    ) INTO v_id;
  ELSE
    IF NOT coalesce((SELECT value='true' FROM public.settings WHERE key='notifications_enabled'),false) OR NOT EXISTS(
      SELECT 1 FROM public.notification_outbox WHERE attempts<8 AND
        ((status='pending' AND available_at<=clock_timestamp()) OR (status='in_flight' AND locked_until<=clock_timestamp()))
    ) THEN RETURN NULL; END IF;
    SELECT net.http_post(
      url:='https://brawlstatz.vercel.app/api/sync/deliver',body:='{}'::jsonb,
      headers:=jsonb_build_object('Authorization','Bearer '||v_token,'Content-Type','application/json'),
      timeout_milliseconds:=70000
    ) INTO v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_club_job(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.clean_club_scheduler_logs()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  DELETE FROM cron.job_run_details WHERE end_time<clock_timestamp()-interval '7 days'
    AND jobid IN (SELECT jobid FROM cron.job WHERE jobname IN ('brawl-adaptive-sync','brawl-notifications','brawl-scheduler-log-retention','brawl-capacity-health'));
$$;
REVOKE ALL ON FUNCTION public.clean_club_scheduler_logs() FROM PUBLIC,anon,authenticated,service_role;

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='brawl-capacity-health') THEN
    PERFORM cron.schedule('brawl-capacity-health','11 * * * *',$job$SELECT public.sample_database_capacity();$job$);
  END IF;
END $$;
COMMIT;
