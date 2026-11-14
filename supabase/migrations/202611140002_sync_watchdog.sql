BEGIN;
-- Sync watchdog. On 2026-11-05 the full sync silently failed for 9 days while
-- the Disk IO budget was exhausted. The Brawl Stars API only exposes each
-- player's last 25 battles, so every hour without a sync can lose history.
-- This job alerts Discord (private outbox only, never the public notifications
-- table) when syncing is stale, keeps failing, is left paused, or when temp-file
-- disk writes spike (the early signal of IO budget exhaustion). It sends one
-- recovery message once healthy again. It reads state only; it never changes
-- sync data or cadence.

CREATE TABLE IF NOT EXISTS public.sync_watchdog_state (
  kind text PRIMARY KEY CHECK (kind IN ('stale','failing','paused','disk_io')),
  alerting boolean NOT NULL DEFAULT false,
  last_alert_at timestamptz,
  detail text
);
CREATE TABLE IF NOT EXISTS public.sync_watchdog_io_samples (
  sampled_at timestamptz PRIMARY KEY,
  temp_bytes bigint NOT NULL
);
ALTER TABLE public.sync_watchdog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_watchdog_io_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_watchdog_state, public.sync_watchdog_io_samples FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sync_watchdog_state TO service_role;

CREATE OR REPLACE FUNCTION public.check_sync_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET lock_timeout='2s' SET statement_timeout='20s' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_enabled boolean; v_paused_since timestamptz; v_last_full timestamptz; v_age interval;
  v_recent_failed integer; v_recent_total integer; v_last_error text;
  v_temp bigint; v_prev_temp bigint; v_temp_delta bigint;
  v_problem jsonb := '{}'::jsonb; v_kind text; v_state public.sync_watchdog_state%ROWTYPE;
  v_title text; v_desc text; v_sent text[] := '{}';
BEGIN
  IF NOT pg_try_advisory_xact_lock(702946201) THEN RETURN jsonb_build_object('skipped',true); END IF;

  v_enabled := coalesce((SELECT value='true' FROM settings WHERE key='sync_scheduler_enabled'),false);
  SELECT nullif(value,'')::timestamptz INTO v_last_full FROM settings WHERE key='last_full_sync_time';
  v_age := v_now - coalesce(v_last_full,'-infinity'::timestamptz);

  -- 1. Stale: full syncs are due every ~10 minutes.
  IF v_enabled AND v_age > interval '40 minutes' THEN
    v_problem := v_problem || jsonb_build_object('stale',
      format('No successful full sync for %s (last: %s UTC). Battles older than each player''s last 25 are being lost.',
        CASE WHEN v_last_full IS NULL THEN 'ever' ELSE to_char(v_age,'DD"d "HH24"h "MI"m"') END,
        coalesce(to_char(v_last_full AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),'never')));
  END IF;

  -- 2. Failing: most recent full runs in the last hour did not succeed.
  SELECT count(*) FILTER (WHERE status IN ('failed','superseded')), count(*),
         (array_agg(coalesce(error_code,status) ORDER BY started_at DESC))[1]
    INTO v_recent_failed, v_recent_total, v_last_error
    FROM (SELECT status,error_code,started_at FROM sync_runs
          WHERE scope='full' AND started_at > v_now - interval '1 hour' AND status<>'running'
          ORDER BY started_at DESC LIMIT 3) r;
  IF v_enabled AND v_recent_total >= 3 AND v_recent_failed = v_recent_total THEN
    v_problem := v_problem || jsonb_build_object('failing',
      format('The last %s full sync runs failed (latest error: %s). Check Supabase health and Vercel logs.', v_recent_total, v_last_error));
  END IF;

  -- 3. Paused: scheduler switched off for more than 3 hours.
  INSERT INTO sync_watchdog_state(kind,alerting,detail) VALUES('paused',false,NULL) ON CONFLICT DO NOTHING;
  IF NOT v_enabled THEN
    SELECT coalesce(nullif(detail,'')::timestamptz, v_now) INTO v_paused_since FROM sync_watchdog_state WHERE kind='paused';
    UPDATE sync_watchdog_state SET detail=v_paused_since::text WHERE kind='paused' AND (detail IS NULL OR detail='');
    IF v_now - v_paused_since > interval '3 hours' THEN
      v_problem := v_problem || jsonb_build_object('paused',
        format('Sync has been paused since %s UTC (settings.sync_scheduler_enabled=false). No battles are being recorded.',
          to_char(v_paused_since AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')));
    END IF;
  ELSE
    UPDATE sync_watchdog_state SET detail=NULL WHERE kind='paused' AND NOT alerting;
  END IF;

  -- 4. Disk IO: temp-file writes over the last hour (the 2026-11 root cause).
  SELECT temp_bytes INTO v_temp FROM pg_stat_database WHERE datname=current_database();
  INSERT INTO sync_watchdog_io_samples VALUES(v_now,v_temp);
  SELECT temp_bytes INTO v_prev_temp FROM sync_watchdog_io_samples
    WHERE sampled_at <= v_now - interval '55 minutes' ORDER BY sampled_at DESC LIMIT 1;
  DELETE FROM sync_watchdog_io_samples WHERE sampled_at < v_now - interval '3 hours';
  v_temp_delta := CASE WHEN v_prev_temp IS NULL OR v_temp < v_prev_temp THEN 0 ELSE v_temp - v_prev_temp END;
  IF v_temp_delta > 3::bigint*1024*1024*1024 THEN
    v_problem := v_problem || jsonb_build_object('disk_io',
      format('Database wrote %s of temporary files in the last hour. This drains the Supabase Disk IO budget and will slow or stop syncing.',
        pg_size_pretty(v_temp_delta)));
  END IF;

  -- Alert on new problems (repeat every 6h while ongoing); send recovery once.
  FOREACH v_kind IN ARRAY ARRAY['stale','failing','paused','disk_io'] LOOP
    INSERT INTO sync_watchdog_state(kind) VALUES(v_kind) ON CONFLICT DO NOTHING;
    SELECT * INTO v_state FROM sync_watchdog_state WHERE kind=v_kind FOR UPDATE;
    IF v_problem ? v_kind THEN
      IF NOT v_state.alerting OR v_state.last_alert_at IS NULL OR v_now - v_state.last_alert_at > interval '6 hours' THEN
        v_title := CASE v_kind WHEN 'stale' THEN '⚠️ BrawlStatz sync is stale'
          WHEN 'failing' THEN '⚠️ BrawlStatz sync keeps failing'
          WHEN 'paused' THEN '⏸️ BrawlStatz sync is still paused'
          ELSE '⚠️ BrawlStatz database disk load is high' END;
        v_desc := v_problem->>v_kind;
        INSERT INTO notification_outbox(event_key,payload,created_at,available_at)
          VALUES('watchdog:'||v_kind||':'||v_now::text, jsonb_build_object(
            'username','BrawlStatz Watchdog','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
            'embeds',jsonb_build_array(jsonb_build_object('title',v_title,'description',v_desc,'color',15158332,'timestamp',v_now))),
            v_now,v_now)
          ON CONFLICT(event_key) DO NOTHING;
        v_sent := v_sent || v_kind;
        UPDATE sync_watchdog_state SET alerting=true,last_alert_at=v_now WHERE kind=v_kind;
      END IF;
    ELSIF v_state.alerting THEN
      INSERT INTO notification_outbox(event_key,payload,created_at,available_at)
        VALUES('watchdog:'||v_kind||':recovered:'||v_now::text, jsonb_build_object(
          'username','BrawlStatz Watchdog','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
          'embeds',jsonb_build_array(jsonb_build_object('title','✅ BrawlStatz recovered ('||v_kind||')',
            'description','This problem is no longer detected. Last full sync: '||coalesce(to_char(v_last_full AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),'unknown')||' UTC.',
            'color',3066993,'timestamp',v_now))),
          v_now,v_now)
        ON CONFLICT(event_key) DO NOTHING;
      v_sent := v_sent || (v_kind||'_recovered');
      UPDATE sync_watchdog_state SET alerting=false WHERE kind=v_kind;
    END IF;
  END LOOP;

  DELETE FROM cron.job_run_details WHERE end_time < v_now - interval '7 days'
    AND jobid IN (SELECT jobid FROM cron.job WHERE jobname='brawl-sync-watchdog');
  RETURN jsonb_build_object('checkedAt',v_now,'problems',v_problem,'alertsSent',to_jsonb(v_sent));
END $$;
REVOKE ALL ON FUNCTION public.check_sync_health() FROM PUBLIC,anon,authenticated,service_role;

-- Delivery: the existing brawl-notifications job picks up pending outbox rows,
-- but only while notifications_enabled='true'.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='brawl-sync-watchdog';
    PERFORM cron.schedule('brawl-sync-watchdog','*/10 * * * *',$job$SELECT public.check_sync_health();$job$);
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
