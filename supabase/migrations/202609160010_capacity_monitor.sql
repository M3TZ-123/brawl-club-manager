-- Operational budget, not a provider billing/quota measurement. pg_database_size
-- includes this database's relations/indexes; it does not measure Storage or egress.
-- Sampling is owner-only. No application/history data is removed or rescheduled.
BEGIN;

CREATE TABLE IF NOT EXISTS public.capacity_samples (
  sample_date date PRIMARY KEY,
  sampled_at timestamptz NOT NULL,
  database_bytes bigint NOT NULL CHECK (database_bytes >= 0),
  peak_database_bytes bigint NOT NULL CHECK (peak_database_bytes >= database_bytes),
  budget_bytes bigint NOT NULL CHECK (budget_bytes > 0),
  level text NOT NULL CHECK (level IN ('normal','warning','critical')),
  last_alert_at timestamptz,
  last_alert_level text CHECK (last_alert_level IN ('warning','critical')),
  CHECK (sample_date = (sampled_at AT TIME ZONE 'UTC')::date),
  CHECK ((last_alert_at IS NULL) = (last_alert_level IS NULL))
);
ALTER TABLE public.capacity_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capacity_samples FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.capacity_samples TO service_role;

INSERT INTO public.settings(key,value) VALUES('capacity_budget_bytes','500000000')
ON CONFLICT(key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.capacity_usage_level(p_database_bytes bigint,p_budget_bytes bigint)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF p_database_bytes IS NULL OR p_database_bytes<0 OR p_budget_bytes IS NULL OR p_budget_bytes<=0 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_capacity_measurement';
  END IF;
  RETURN CASE WHEN p_database_bytes::numeric*100>=p_budget_bytes::numeric*90 THEN 'critical'
    WHEN p_database_bytes::numeric*100>=p_budget_bytes::numeric*70 THEN 'warning' ELSE 'normal' END;
END $$;
REVOKE ALL ON FUNCTION public.capacity_usage_level(bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sample_database_capacity()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
SET lock_timeout='2s' SET statement_timeout='10s' AS $$
DECLARE
  v_previous public.capacity_samples%ROWTYPE;
  v_now timestamptz; v_day date; v_bytes bigint; v_budget bigint; v_budget_text text;
  v_level text; v_last_alert_at timestamptz; v_last_alert_level text;
  v_notify boolean := false; v_key text; v_title text; v_percent numeric;
BEGIN
  -- Concurrent cron/manual owner calls must not enqueue the same alert twice.
  IF NOT pg_try_advisory_xact_lock(702946194) THEN
    RETURN jsonb_build_object('sampled',false,'busy',true);
  END IF;
  SELECT value INTO v_budget_text FROM public.settings WHERE key='capacity_budget_bytes';
  IF v_budget_text IS NULL THEN v_budget := 500000000;
  ELSIF v_budget_text ~ '^[0-9]{1,18}$' THEN
    v_budget := v_budget_text::bigint;
    IF v_budget<=0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_capacity_budget'; END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_capacity_budget';
  END IF;

  v_bytes := pg_database_size(current_database());
  v_now := clock_timestamp();
  v_day := (v_now AT TIME ZONE 'UTC')::date;
  v_level := public.capacity_usage_level(v_bytes,v_budget);
  SELECT * INTO v_previous FROM public.capacity_samples ORDER BY sample_date DESC LIMIT 1;
  v_last_alert_at := v_previous.last_alert_at;
  v_last_alert_level := v_previous.last_alert_level;

  -- Thresholds describe the latest measurement. Alert cooldown survives a day
  -- boundary and recovery, so oscillation around a threshold cannot spam users.
  -- A rise from a previously alerted warning to critical is delivered immediately.
  v_notify := v_level<>'normal'
    AND coalesce((SELECT value='true' FROM public.settings WHERE key='notifications_enabled'),false)
    AND (v_last_alert_at IS NULL OR v_now>=v_last_alert_at+interval '24 hours'
      OR (v_level='critical' AND v_last_alert_level='warning'));
  IF v_notify THEN
    v_key := 'capacity:'||v_level||':'||v_now::text;
    v_title := CASE WHEN v_level='critical' THEN 'تنبيه حرج لسعة قاعدة البيانات' ELSE 'تنبيه سعة قاعدة البيانات' END;
    -- Notifications are publicly readable: keep exact sizes/percentages private.
    INSERT INTO public.notifications(type,title,message,dedupe_key,created_at)
      VALUES('capacity',v_title,'اقترب استخدام قاعدة البيانات من ميزانية التشغيل المحددة. يمكن للإدارة مراجعة تفاصيل السعة.',md5(v_key),v_now)
      ON CONFLICT DO NOTHING;
    v_percent := round(v_bytes::numeric*100/v_budget,1);
    INSERT INTO public.notification_outbox(event_key,payload,created_at,available_at)
      VALUES(v_key,jsonb_build_object('allowed_mentions',jsonb_build_object('parse',jsonb_build_array()),
        'embeds',jsonb_build_array(jsonb_build_object('title',v_title,
          'description',format('حجم قاعدة البيانات: %s بايت من ميزانية تشغيل %s بايت (%s%%). الميزانية المحددة ليست قياسًا لحصة المزود. لا تغيّر هذه المراقبة البيانات أو وتيرة المزامنة.',v_bytes,v_budget,v_percent),
          'color',CASE WHEN v_level='critical' THEN 15158332 ELSE 16763904 END,'timestamp',v_now))),v_now,v_now)
      ON CONFLICT(event_key) DO NOTHING;
    v_last_alert_at := v_now;
    v_last_alert_level := v_level;
  END IF;

  INSERT INTO public.capacity_samples(sample_date,sampled_at,database_bytes,peak_database_bytes,budget_bytes,level,last_alert_at,last_alert_level)
    VALUES(v_day,v_now,v_bytes,v_bytes,v_budget,v_level,v_last_alert_at,v_last_alert_level)
    ON CONFLICT(sample_date) DO UPDATE SET sampled_at=excluded.sampled_at,database_bytes=excluded.database_bytes,
      peak_database_bytes=greatest(capacity_samples.peak_database_bytes,excluded.database_bytes),
      budget_bytes=excluded.budget_bytes,level=excluded.level,last_alert_at=excluded.last_alert_at,last_alert_level=excluded.last_alert_level;
  -- Only this new monitoring table has retention here: at most one row for each
  -- of the current UTC date and preceding89 dates. Club history is untouched.
  DELETE FROM public.capacity_samples WHERE sample_date<v_day-89;
  RETURN jsonb_build_object('sampled',true,'sampledAt',v_now,'level',v_level,'alertEnqueued',v_notify);
END $$;
REVOKE ALL ON FUNCTION public.sample_database_capacity() FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
