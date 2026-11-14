BEGIN;
-- Automatic overload protection for sync. During the 2026-11 outage the 2-minute
-- scheduler kept starting syncs on a disk with an exhausted IO budget; every
-- attempt timed out and added more load, so the database never recovered.
--
-- Every 5 minutes this guard checks for database overload:
--   * temp-file writes > 1.5 GB in the last hour (Disk IO budget drain), or
--   * 2 of the last 3 full syncs failed with a database-side error.
-- When overloaded it enters PROTECTION MODE: the scheduler slows from every
-- 2 minutes to every 10 (every tick is then a full sync, so battle logs keep
-- being saved while roster-only runs stop), and to every 20 if still overloaded
-- after an hour. It never disables syncing: stopping would lose battles, since
-- the Brawl Stars API only keeps each player's last 25.
-- After 45 healthy minutes it restores the normal schedule. Entering, escalating
-- and leaving protection mode post a Discord message via the private outbox.
--
-- It also trims sync_runs (a log only) older than 30 days in small batches,
-- keeping any run still referenced by events, alerts, leases or coverage.

CREATE TABLE IF NOT EXISTS public.sync_protection_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active boolean NOT NULL DEFAULT false,
  level integer NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2),
  since timestamptz,
  healthy_since timestamptz,
  normal_schedule text,
  reason text
);
INSERT INTO public.sync_protection_state(id) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE public.sync_protection_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_protection_state FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sync_protection_state TO service_role;

CREATE OR REPLACE FUNCTION public.sync_protection_notify(p_key text,p_title text,p_desc text,p_color integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  INSERT INTO notification_outbox(event_key,payload,created_at,available_at)
  VALUES('protection:'||p_key||':'||clock_timestamp()::text, jsonb_build_object(
    'username','BrawlStatz Watchdog','allowed_mentions',jsonb_build_object('parse','[]'::jsonb),
    'embeds',jsonb_build_array(jsonb_build_object('title',p_title,'description',p_desc,'color',p_color,'timestamp',clock_timestamp()))),
    clock_timestamp(),clock_timestamp())
  ON CONFLICT(event_key) DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public.sync_protection_notify(text,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sync_protection_guard()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET lock_timeout='2s' SET statement_timeout='30s' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_state public.sync_protection_state%ROWTYPE;
  v_job bigint; v_schedule text;
  v_temp bigint; v_prev_temp bigint; v_temp_delta bigint := 0;
  v_db_failed integer; v_total integer;
  v_overloaded boolean; v_reason text; v_trimmed integer := 0; v_action text := 'none';
BEGIN
  IF NOT pg_try_advisory_xact_lock(702946202) THEN RETURN jsonb_build_object('skipped',true); END IF;
  SELECT * INTO v_state FROM sync_protection_state WHERE id FOR UPDATE;
  SELECT jobid,schedule INTO v_job,v_schedule FROM cron.job WHERE jobname='brawl-adaptive-sync';
  IF v_job IS NULL THEN RETURN jsonb_build_object('skipped',true,'reason','scheduler_missing'); END IF;

  -- Disk IO signal: temp bytes written over roughly the last hour.
  SELECT temp_bytes INTO v_temp FROM pg_stat_database WHERE datname=current_database();
  INSERT INTO sync_watchdog_io_samples VALUES(v_now,v_temp) ON CONFLICT DO NOTHING;
  SELECT temp_bytes INTO v_prev_temp FROM sync_watchdog_io_samples
    WHERE sampled_at <= v_now - interval '55 minutes' ORDER BY sampled_at DESC LIMIT 1;
  IF v_prev_temp IS NOT NULL AND v_temp >= v_prev_temp THEN v_temp_delta := v_temp - v_prev_temp; END IF;

  -- Database-side sync failures (game API rate limits are not database overload).
  SELECT count(*) FILTER (WHERE status IN ('failed','superseded')
           AND coalesce(error_code,'') IN ('database_timeout','lease_expired','database_unavailable')), count(*)
    INTO v_db_failed, v_total
    FROM (SELECT status,error_code FROM sync_runs
          WHERE scope='full' AND status<>'running' AND started_at > v_now - interval '45 minutes'
          ORDER BY started_at DESC LIMIT 3) r;

  v_overloaded := v_temp_delta > 1536::bigint*1024*1024 OR (v_total >= 2 AND v_db_failed >= 2);
  v_reason := CASE WHEN v_temp_delta > 1536::bigint*1024*1024
      THEN format('database wrote %s of temp files in the last hour', pg_size_pretty(v_temp_delta))
    WHEN v_db_failed >= 2 THEN format('%s of the last %s full syncs failed with database errors', v_db_failed, v_total) END;

  IF v_overloaded THEN
    UPDATE sync_protection_state SET healthy_since=NULL WHERE id;
    IF NOT v_state.active THEN
      UPDATE sync_protection_state SET active=true,level=1,since=v_now,normal_schedule=v_schedule,reason=v_reason WHERE id;
      PERFORM cron.alter_job(v_job, schedule := '*/10 * * * *');
      PERFORM sync_protection_notify('on','🛡️ BrawlStatz protection mode ON',
        'Database overload detected: '||v_reason||'. Sync slowed from every 2 to every 10 minutes (full syncs only, battles are still saved) so the database can recover. It will return to normal automatically.',16763904);
      v_action := 'entered';
    ELSIF v_state.level = 1 AND v_now - v_state.since > interval '60 minutes' THEN
      UPDATE sync_protection_state SET level=2,reason=v_reason WHERE id;
      PERFORM cron.alter_job(v_job, schedule := '*/20 * * * *');
      PERFORM sync_protection_notify('escalated','🛡️ BrawlStatz protection mode escalated',
        'Still overloaded after an hour: '||v_reason||'. Sync slowed to every 20 minutes. Check the Supabase dashboard (Disk IO / Unhealthy status).',15158332);
      v_action := 'escalated';
    END IF;
  ELSIF v_state.active THEN
    IF v_state.healthy_since IS NULL THEN
      UPDATE sync_protection_state SET healthy_since=v_now WHERE id;
      v_action := 'healthy_wait';
    ELSIF v_now - v_state.healthy_since >= interval '45 minutes' THEN
      PERFORM cron.alter_job(v_job, schedule := coalesce(v_state.normal_schedule,'*/2 * * * *'));
      UPDATE sync_protection_state SET active=false,level=0,since=NULL,healthy_since=NULL,reason=NULL WHERE id;
      PERFORM sync_protection_notify('off','✅ BrawlStatz protection mode OFF',
        'The database has been healthy for 45 minutes. Normal sync schedule ('||coalesce(v_state.normal_schedule,'*/2 * * * *')||') restored.',3066993);
      v_action := 'restored';
    END IF;
  END IF;

  -- Small, bounded log trim (never touches club data).
  WITH old AS (
    SELECT r.id FROM sync_runs r
    WHERE r.started_at < v_now - interval '30 days' AND r.status<>'running'
      AND NOT EXISTS (SELECT 1 FROM sync_leases l WHERE l.run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM membership_change_events e WHERE e.run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM sync_battle_coverage c WHERE c.last_run_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM sync_battle_gaps g WHERE g.run_id=r.id)
    ORDER BY r.started_at LIMIT CASE WHEN v_overloaded THEN 0 ELSE 500 END
  ) DELETE FROM sync_runs s USING old WHERE s.id=old.id;
  GET DIAGNOSTICS v_trimmed=ROW_COUNT;

  DELETE FROM cron.job_run_details WHERE end_time < v_now - interval '7 days'
    AND jobid IN (SELECT jobid FROM cron.job WHERE jobname='brawl-sync-protection');
  RETURN jsonb_build_object('checkedAt',v_now,'overloaded',v_overloaded,'reason',v_reason,
    'tempLastHour',v_temp_delta,'action',v_action,'trimmedRuns',v_trimmed);
END $$;
REVOKE ALL ON FUNCTION public.sync_protection_guard() FROM PUBLIC,anon,authenticated,service_role;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='brawl-sync-protection';
    PERFORM cron.schedule('brawl-sync-protection','*/5 * * * *',$job$SELECT public.sync_protection_guard();$job$);
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
