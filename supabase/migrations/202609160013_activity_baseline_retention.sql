-- A 90-day comparison needs a baseline at or before its starting instant.
-- Keep the same extra 24-hour observation tolerance used by sync_activity_summary_v2.
-- No cleanup runs during this migration; only the two existing definitions change.
BEGIN;

CREATE OR REPLACE FUNCTION public.run_sync_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_battles integer; v_days integer; v_activity integer; v_snapshots integer; v_notifications integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(702946183) THEN RETURN jsonb_build_object('skipped',true); END IF;
  DELETE FROM public.battle_history WHERE battle_time<now()-interval '90 days'; GET DIAGNOSTICS v_battles=ROW_COUNT;
  DELETE FROM public.daily_stats WHERE date<(now() AT TIME ZONE 'UTC')::date-365; GET DIAGNOSTICS v_days=ROW_COUNT;
  DELETE FROM public.activity_log WHERE recorded_at<now()-interval '91 days'; GET DIAGNOSTICS v_activity=ROW_COUNT;
  DELETE FROM public.brawler_snapshots WHERE recorded_at<now()-interval '90 days'; GET DIAGNOSTICS v_snapshots=ROW_COUNT;
  DELETE FROM public.notifications WHERE created_at<now()-interval '90 days'; GET DIAGNOSTICS v_notifications=ROW_COUNT;
  DELETE FROM public.notification_outbox WHERE status='sent' AND delivered_at<now()-interval '90 days';
  UPDATE public.notification_outbox SET status='failed',last_error_code='delivery_lease_expired',locked_by=NULL,locked_until=NULL
    WHERE status='in_flight' AND attempts>=8 AND locked_until<=now();
  RETURN jsonb_build_object('battles',v_battles,'dailyStats',v_days,'activity',v_activity,'snapshots',v_snapshots,'notifications',v_notifications);
END $$;

CREATE OR REPLACE FUNCTION public.cleanup_old_activity_logs() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN DELETE FROM public.activity_log WHERE recorded_at<now()-interval '91 days'; END $$;

-- CREATE OR REPLACE retains ownership and existing function grants.
NOTIFY pgrst,'reload schema';
COMMIT;
